import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeAI, withAIInvocationGuard } from '../../src/core/ai/invocation-guard.ts';
import { createGuardedGeneration } from '../../src/core/ai/guarded-generation.ts';
import { withQueueZeroPaidSpend } from '../../src/core/minions/zero-paid-spend.ts';
import { writeWrapperScript } from '../../src/commands/autopilot.ts';

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

  test('both inline and process-isolated job execution install the policy', () => {
    const worker = readFileSync(join(ROOT, 'src/core/minions/worker.ts'), 'utf8');
    const child = readFileSync(join(ROOT, 'src/core/minions/run-child.ts'), 'utf8');
    expect(worker).toContain('withQueueZeroPaidSpend');
    expect(child).toContain('withQueueZeroPaidSpend');
  });

  test('autopilot installation bakes the opt-in into the daemon environment', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-zero-spend-'));
    try {
      const guarded = readFileSync(
        writeWrapperScript(ROOT, 'linux-cron', {
          zeroPaidSpend: true,
          gbrainDirForTest: home,
        }),
        'utf8',
      );
      expect(guarded).toContain('export GBRAIN_QUEUE_ZERO_PAID_SPEND=1');

      const ordinary = readFileSync(writeWrapperScript(ROOT, 'linux-cron', {
        gbrainDirForTest: home,
      }), 'utf8');
      expect(ordinary).not.toContain('export GBRAIN_QUEUE_ZERO_PAID_SPEND=1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
