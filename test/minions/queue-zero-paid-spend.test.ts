import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeAI, withAIInvocationGuard } from '../../src/core/ai/invocation-guard.ts';
import { inspectZeroPaidSpendStatus } from '../../src/core/ai/zero-paid-spend-status.ts';
import { createGuardedGeneration } from '../../src/core/ai/guarded-generation.ts';
import {
  applyQueueZeroPaidSpendFlag,
  queueZeroPaidSpendEnabled,
  withQueueZeroPaidSpend,
  resolveZeroPaidSpendChoice,
} from '../../src/core/minions/zero-paid-spend.ts';
import { shellHandler } from '../../src/core/minions/handlers/shell.ts';
import { buildChildArgs } from '../../src/core/minions/job-isolation.ts';
import { buildWorkerArgs } from '../../src/core/minions/supervisor.ts';
import { writeWrapperScript } from '../../src/commands/autopilot.ts';
import { withEnv } from '../helpers/with-env.ts';
import { loadConfigFileOnly, saveConfig } from '../../src/core/config.ts';

const ROOT = join(import.meta.dir, '../..');
const usage = () => ({ inputTokens: 1, outputTokens: 1 });

describe('queue zero-paid-spend enforcement', () => {
  test('refuses a paid provider before its transport runs', async () => {
    let transportCalls = 0;
    let nestedBudgetAdmissions = 0;
    await expect(withQueueZeroPaidSpend(
      () => withAIInvocationGuard(
        async () => {
          nestedBudgetAdmissions += 1;
          return { async settle() {} };
        },
        () => invokeAI(
          { operation: 'test.paid-route', kind: 'chat', model: 'anthropic:claude-sonnet-4-6' },
          async () => { transportCalls += 1; return { ok: true }; },
          usage,
        ),
      ),
      { GBRAIN_QUEUE_ZERO_PAID_SPEND: '1' },
    )).rejects.toThrow('queue_zero_paid_spend');
    expect(transportCalls).toBe(0);
    expect(nestedBudgetAdmissions).toBe(0);
  });

  test('allows explicit local inference while blocking ambiguous proxies', async () => {
    let localCalls = 0;
    await withQueueZeroPaidSpend(
      () => invokeAI(
        { operation: 'test.local-route', kind: 'chat', model: 'ollama:gemma3:12b', endpoint: 'http://127.0.0.1:11434/v1' },
        async () => { localCalls += 1; return { ok: true }; },
        usage,
      ),
      { GBRAIN_QUEUE_ZERO_PAID_SPEND: '1' },
    );
    expect(localCalls).toBe(1);

    await expect(withQueueZeroPaidSpend(
      () => invokeAI(
        { operation: 'test.proxy-route', kind: 'chat', model: 'litellm:gemma3:12b' },
        async () => ({ ok: true }),
        usage,
      ),
      { GBRAIN_QUEUE_ZERO_PAID_SPEND: '1' },
    )).rejects.toThrow('queue_zero_paid_spend');
  });

  test('production generation cannot bypass a policy when no budget guard exists', async () => {
    const generate = createGuardedGeneration(() => 100);
    let transportCalls = 0;
    await expect(withQueueZeroPaidSpend(
      () => generate(
        'anthropic:claude-sonnet-4-6',
        async () => { transportCalls += 1; return { usage: { inputTokens: 1, outputTokens: 1 } }; },
        {},
      ),
      { GBRAIN_QUEUE_ZERO_PAID_SPEND: '1' },
    )).rejects.toThrow('queue_zero_paid_spend');
    expect(transportCalls).toBe(0);
  });

  test('local provider names still fail closed for cloud tags and remote endpoints', async () => {
    for (const call of [
      { operation: 'test.ollama-cloud', kind: 'chat' as const, model: 'ollama:glm-5.3-flash:cloud', endpoint: 'http://127.0.0.1:11434/v1' },
      { operation: 'test.ollama-hyphen-cloud', kind: 'chat' as const, model: 'ollama:qwen3-coder:480b-cloud', endpoint: 'http://127.0.0.1:11434/v1' },
      { operation: 'test.remote-ollama', kind: 'chat' as const, model: 'ollama:qwen2.5-coder:14b', endpoint: 'https://ollama.example.com/v1' },
      { operation: 'test.unresolved-ollama', kind: 'chat' as const, model: 'ollama:qwen2.5-coder:14b' },
    ]) {
      let transportCalls = 0;
      await expect(withQueueZeroPaidSpend(
        () => invokeAI(call, async () => { transportCalls += 1; return { ok: true }; }, usage),
        { GBRAIN_QUEUE_ZERO_PAID_SPEND: '1' },
      )).rejects.toThrow('queue_zero_paid_spend');
      expect(transportCalls).toBe(0);
    }
  });

  // This test used to assert that worker.ts and run-child.ts each mention
  // withQueueZeroPaidSpend — an inventory of the executors we happened to know
  // about. core/cycle/inline-drain.ts is a third executor of the same queue
  // rows and was absent from that list, so a queued subagent job billed a paid
  // route while the suite stayed green. Enforcement now lives in invokeAI, so
  // the property to assert is that NO executor has to opt in.
  test('enforcement holds with no wrapper installed by the caller', async () => {
    let transportCalls = 0;
    await withEnv({ GBRAIN_QUEUE_ZERO_PAID_SPEND: '1' }, async () => {
      await expect(invokeAI(
        { operation: 'inline-drain.unwrapped', kind: 'chat', model: 'anthropic:claude-sonnet-4-6', endpoint: 'https://api.anthropic.com/v1' },
        async () => { transportCalls += 1; return { ok: true }; },
        usage,
      )).rejects.toThrow('queue_zero_paid_spend');
    });
    expect(transportCalls).toBe(0);
  });

  // The boundary WITHHOLDS a permission, so an unrecognized value must fail
  // closed. `GBRAIN_ALLOW_SHELL_JOBS` grants one and fails closed by staying
  // off; copying its `=== '1'` idiom here copied the wrong failure direction,
  // and `=true` in ~/.gbrain/env (sourced with `set -a`) spent real money.
  test('an unrecognized env value enforces rather than silently disabling', async () => {
    for (const value of ['true', 'TRUE', 'yes', 'on', 'enabled', ' 1', '01']) {
      let transportCalls = 0;
      await withEnv({ GBRAIN_QUEUE_ZERO_PAID_SPEND: value }, async () => {
        await expect(invokeAI(
          { operation: 'test.near-miss', kind: 'chat', model: 'anthropic:claude-sonnet-4-6', endpoint: 'https://api.anthropic.com/v1' },
          async () => { transportCalls += 1; return { ok: true }; },
          usage,
        )).rejects.toThrow('queue_zero_paid_spend');
      });
      expect(transportCalls).toBe(0);
    }
    // Explicit off values still mean off.
    for (const value of ['0', 'false', 'no', 'off', '']) {
      let transportCalls = 0;
      await withEnv({ GBRAIN_QUEUE_ZERO_PAID_SPEND: value }, async () => {
        await invokeAI(
          { operation: 'test.explicit-off', kind: 'chat', model: 'anthropic:claude-sonnet-4-6', endpoint: 'https://api.anthropic.com/v1' },
          async () => { transportCalls += 1; return { ok: true }; },
          usage,
        );
      });
      expect(transportCalls).toBe(1);
    }
  });

  // `--zero-paid-spend=1` passes the CLI validator (it legalizes an `=value`
  // suffix), so an exact-match reader started an unguarded worker for an
  // operator who believed they had asked for the boundary.
  test('the flag is honored with a value suffix, and refuses to guess', () => {
    for (const arg of ['--zero-paid-spend', '--zero-paid-spend=1', '--zero-paid-spend=true', '--zero-paid-spend=yes']) {
      const env: NodeJS.ProcessEnv = {};
      expect(applyQueueZeroPaidSpendFlag(['jobs', 'work', arg], env)).toBe(true);
    }
    for (const arg of ['--no-zero-paid-spend', '--zero-paid-spend=0', '--zero-paid-spend=false']) {
      const env: NodeJS.ProcessEnv = { GBRAIN_QUEUE_ZERO_PAID_SPEND: '1' };
      expect(applyQueueZeroPaidSpendFlag(['jobs', 'work', arg], env)).toBe(false);
    }
    expect(() => resolveZeroPaidSpendChoice(['--zero-paid-spend=maybe'])).toThrow('refusing to guess');
  });

  // GBRAIN_HOME, not a test-only parameter: writeWrapperScript creates the
  // wrapper and an env template under the gbrain home, so an unscoped call
  // here writes into the developer's real ~/.gbrain.
  test('autopilot installation bakes the opt-in into the daemon environment', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-zero-spend-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, () => {
        const guarded = readFileSync(
          writeWrapperScript(ROOT, 'linux-cron', { zeroPaidSpend: true }),
          'utf8',
        );
        expect(guarded).toContain('export GBRAIN_QUEUE_ZERO_PAID_SPEND=1');
        expect(inspectZeroPaidSpendStatus().wrapper_declaration).toBe('declares_on');

        const ordinary = readFileSync(writeWrapperScript(ROOT, 'linux-cron'), 'utf8');
        expect(ordinary).not.toContain('export GBRAIN_QUEUE_ZERO_PAID_SPEND=1');

        // The wrapper and its env template landed in the scoped home, not the
        // developer's ~/.gbrain. GBRAIN_HOME is the PARENT: configDir() appends
        // '.gbrain' itself.
        expect(existsSync(join(home, '.gbrain', 'autopilot-run.sh'))).toBe(true);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The boundary used to live ONLY as an export line inside the generated
  // wrapper. src/commands/migrations/v0_11_0.ts runs `gbrain autopilot
  // --install --yes`, and five more places tell the operator to re-run
  // `gbrain autopilot --install` as a fix-it — each of which regenerated the
  // wrapper without the flag and silently deleted enforcement. The operator's
  // choice is now durable, so a bare reinstall reproduces it.
  test('a bare reinstall preserves an enforced boundary', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-zero-spend-reinstall-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, () => {
        // The operator opted in once.
        saveConfig({ ...(loadConfigFileOnly() ?? {} as any), autopilot: { zero_paid_spend: true } });

        // A later reinstall that says nothing about spend — the migration's shape.
        const reinstalled = readFileSync(writeWrapperScript(ROOT, 'linux-cron'), 'utf8');
        expect(reinstalled).toContain('export GBRAIN_QUEUE_ZERO_PAID_SPEND=1');

        // And an explicit opt-out still wins over the persisted choice.
        const off = readFileSync(
          writeWrapperScript(ROOT, 'linux-cron', { zeroPaidSpend: false }),
          'utf8',
        );
        expect(off).not.toContain('export GBRAIN_QUEUE_ZERO_PAID_SPEND=1');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // A shell job's command runs in a child process, where the in-process
  // AsyncLocalStorage policy above has no reach: `curl api.anthropic.com` from
  // a queued shell job spends money no matter what the policy admits. There is
  // no way to police that transport from here, so the worker fails closed.
  test('refuses a shell job outright while zero-paid-spend is enforced', async () => {
    // Shell jobs are separately enabled here: the refusal must come from the
    // spend boundary, not from the handler already being disabled.
    await withEnv(
      { GBRAIN_ALLOW_SHELL_JOBS: '1', GBRAIN_QUEUE_ZERO_PAID_SPEND: '1' },
      async () => {
        await expect(shellHandler({
          id: 1,
          data: { command: 'curl', args: ['https://api.anthropic.com/v1/messages'] },
        } as any)).rejects.toThrow('queue_zero_paid_spend');
      },
    );
  });

  // Before this, `gbrain jobs work --zero-paid-spend` was accepted by CLI flag
  // validation and then ignored: the operator got a clean start and no
  // enforcement. The flag has to reach the worker that runs the queue, not
  // only `autopilot --install`.
  test('the worker opt-in flag actually turns enforcement on', () => {
    const off: NodeJS.ProcessEnv = {};
    expect(applyQueueZeroPaidSpendFlag(['jobs', 'work'], off)).toBe(false);
    expect(queueZeroPaidSpendEnabled(off)).toBe(false);

    const on: NodeJS.ProcessEnv = {};
    expect(applyQueueZeroPaidSpendFlag(['jobs', 'work', '--zero-paid-spend'], on)).toBe(true);
    expect(on.GBRAIN_QUEUE_ZERO_PAID_SPEND).toBe('1');
    expect(queueZeroPaidSpendEnabled(on)).toBe(true);

    // An env-only opt-in (the autopilot wrapper's channel) stays on without the flag.
    const inherited: NodeJS.ProcessEnv = { GBRAIN_QUEUE_ZERO_PAID_SPEND: '1' };
    expect(applyQueueZeroPaidSpendFlag(['jobs', 'work'], inherited)).toBe(true);
  });

  // Was: a grep for >=3 `applyQueueZeroPaidSpendFlag(` occurrences in jobs.ts.
  // A reviewer rewrote every call to `applyQueueZeroPaidSpendFlag([])` —
  // disconnecting the flag from argv entirely — and the suite stayed green.
  // The string existing is not the flag reaching a worker, so assert the
  // resolution behavior on real argv instead.
  test('argv reaches the boundary for each queued-work entry point', () => {
    for (const argv of [
      ['work', '--concurrency', '2', '--zero-paid-spend'],
      ['supervisor', '--zero-paid-spend', '--queue', 'default'],
      ['run-child', '--job-id', '7', '--zero-paid-spend'],
    ]) {
      const env: NodeJS.ProcessEnv = {};
      expect(applyQueueZeroPaidSpendFlag(argv, env)).toBe(true);
      expect(env.GBRAIN_QUEUE_ZERO_PAID_SPEND).toBe('1');
    }
  });

  test('the opt-in travels to spawned workers and isolated children', () => {
    expect(buildChildArgs(7, { GBRAIN_QUEUE_ZERO_PAID_SPEND: '1' })).toContain('--zero-paid-spend');
    expect(buildChildArgs(7, {})).not.toContain('--zero-paid-spend');

    const base = {
      concurrency: 1,
      queue: 'default',
      maxRssMb: 0,
      nice_requested: undefined,
      jobIsolation: 'inline' as const,
    };
    expect(buildWorkerArgs({ ...base, zeroPaidSpend: true })).toContain('--zero-paid-spend');
    expect(buildWorkerArgs(base)).not.toContain('--zero-paid-spend');
  });
});
