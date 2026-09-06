import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MIN_TRANSCRIPT_BYTES,
  MAX_LEDGER_BYTES,
  _testing,
  TARGET_COHORT_SIZE,
  LearningLoopError,
  abortLearningLoop,
  armLearningLoop,
  bindLearningLoopSession,
  classifyTranscript,
  discoverBaselineSnapshot,
  learningLoopLedgerPath,
  orderBaselineCandidates,
  readLearningLoopLedger,
  recordSessionEvaluation,
  replayLearningLoop,
  resolveAuthoritativeTranscript,
  resolveLearningLoopMode,
  setLearningLoopMode,
  withLearningLoopLifecycleLock,
  type AdapterIdentity,
  type TranscriptReceipt,
} from '../src/core/learning-loop.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeBrainIdFromConfig } from '../src/core/upgrade-checkpoint.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

const roots: string[] = [];
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function engineWith(values: Record<string, string | null>): Pick<BrainEngine, 'getConfig'> {
  return { getConfig: async (key: string) => values[key] ?? null };
}

function corpusEngine(root: string, sourceId = 'personal'): Pick<BrainEngine, 'getConfig'> {
  return engineWith({
    'learning_loop.mode': 'canary',
    'learning_loop.corpus.codex.root': root,
    'learning_loop.corpus.codex.source_id': sourceId,
  });
}

const testEngine = {} as BrainEngine;
const testMutationLock = async <T>(work: () => Promise<T>): Promise<T> => work();
function ledger(root: string) {
  return { root, mutationLock: testMutationLock, lifecycleLock: testMutationLock };
}

const adapter: AdapterIdentity = { client_id: 'codex-adapter', source_id: 'personal', provider: 'codex' };
const destination = { source_id: 'personal', canonical_slug: 'personal/preferences' };

function armInput(corpus: string, commandId: string) {
  return { command_id: commandId, engine: corpusEngine(corpus) as BrainEngine, authorized_adapter: adapter, destination };
}

function receipt(id: string, overrides: Partial<TranscriptReceipt> = {}): TranscriptReceipt {
  return {
    provider: 'codex',
    provider_session_id: id,
    relative_path: `${id}.jsonl`,
    completed_at: '2026-08-01T00:00:00.000Z',
    content_hash: createHash('sha256').update(`body:${id}`).digest('hex'),
    size_bytes: 512,
    user_turn_count: 2,
    assistant_turn_count: 2,
    ...overrides,
  };
}

function codexTranscript(
  sessionId: string,
  padding = 'x'.repeat(90),
  completedAt = '2026-08-01T00:00:00.000Z',
  completed = true,
): string {
  const rows: Array<Record<string, unknown>> = [
    { timestamp: completedAt, type: 'session_meta', payload: { id: sessionId, timestamp: completedAt } },
    { timestamp: completedAt, type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: `first user ${padding}` }] } },
    { timestamp: completedAt, type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'first assistant' }] } },
    { timestamp: completedAt, type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'second user' }] } },
    { timestamp: completedAt, type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'second assistant' }] } },
  ];
  if (completed) {
    rows.push({ timestamp: completedAt, type: 'event_msg', payload: { type: 'task_complete', completed_at: completedAt } });
  }
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function bindSession(root: string, sessionId: string, owner = adapter) {
  return bindLearningLoopSession(testEngine, `bind:${sessionId}`, owner, sessionId, ledger(root));
}

describe('mode and authoritative transcript boundary', () => {
  test('mode defaults to off and accepts only the three contract values', async () => {
    expect(await resolveLearningLoopMode(engineWith({}))).toBe('off');
    expect(await resolveLearningLoopMode(engineWith({ 'learning_loop.mode': 'capture' }))).toBe('capture');
    expect(await resolveLearningLoopMode(engineWith({ 'learning_loop.mode': 'canary' }))).toBe('canary');
    expect(await resolveLearningLoopMode(engineWith({ 'learning_loop.mode': 'on' }))).toBe('off');
    expect(await resolveLearningLoopMode({ getConfig: async () => { throw new Error('db unavailable'); } })).toBe('off');
  });

  test('GBrain reads one authoritative file, computes UTF-8 bytes/hash, and counts roles', async () => {
    const root = tempRoot('learning-loop-corpus-');
    const id = 'session-good';
    const body = codexTranscript(id, '🙂漢字'.repeat(40));
    writeFileSync(join(root, `${id}.jsonl`), body);
    const engine = corpusEngine(root);
    const result = await resolveAuthoritativeTranscript({ engine, provider: 'codex', provider_session_id: id, source_id: 'personal' });
    expect(result.size_bytes).toBe(Buffer.byteLength(body, 'utf8'));
    expect(result.content_hash).toBe(createHash('sha256').update(Buffer.from(body)).digest('hex'));
    expect(result.user_turn_count).toBe(2);
    expect(result.assistant_turn_count).toBe(2);
    expect(classifyTranscript(result)).toEqual({ eligible: true, reason: 'eligible' });
  });

  test('adapter path, size, and hash are assertions and cannot override GBrain', async () => {
    const root = tempRoot('learning-loop-assert-');
    const id = 'session-assert';
    writeFileSync(join(root, `${id}.jsonl`), codexTranscript(id));
    const engine = corpusEngine(root);
    await expect(resolveAuthoritativeTranscript({
      engine, provider: 'codex', provider_session_id: id, source_id: 'personal', asserted_relative_path: '../other.jsonl',
    })).rejects.toMatchObject({ code: 'assertion_mismatch' });
    await expect(resolveAuthoritativeTranscript({
      engine, provider: 'codex', provider_session_id: id, source_id: 'personal', asserted_size_bytes: 1,
    })).rejects.toMatchObject({ code: 'assertion_mismatch' });
    await expect(resolveAuthoritativeTranscript({
      engine, provider: 'codex', provider_session_id: id, source_id: 'personal', asserted_content_hash: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'assertion_mismatch' });
    await expect(resolveAuthoritativeTranscript({
      engine, provider: 'codex', provider_session_id: id, source_id: 'personal', asserted_completed_at: '2026-08-02T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'assertion_mismatch' });
  });

  test('an interrupted transcript without a final task_complete record is rejected', async () => {
    const root = tempRoot('learning-loop-incomplete-');
    const id = 'session-incomplete';
    writeFileSync(join(root, `${id}.jsonl`), codexTranscript(id, undefined, undefined, false));
    await expect(resolveAuthoritativeTranscript({
      engine: corpusEngine(root), provider: 'codex', provider_session_id: id, source_id: 'personal',
    })).rejects.toMatchObject({ code: 'transcript_conflict' });
  });

  test('the configured corpus is source-owned', async () => {
    const root = tempRoot('learning-loop-source-');
    writeFileSync(join(root, 'source-session.jsonl'), codexTranscript('source-session'));
    await expect(resolveAuthoritativeTranscript({
      engine: corpusEngine(root, 'source-a'), provider: 'codex', provider_session_id: 'source-session', source_id: 'source-b',
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  test('session impersonation, ambiguous matches, and symlink escape fail closed', async () => {
    const root = tempRoot('learning-loop-boundary-');
    const outside = tempRoot('learning-loop-outside-');
    writeFileSync(join(root, 'session-wrong.jsonl'), codexTranscript('different-session'));
    const engine = corpusEngine(root);
    await expect(resolveAuthoritativeTranscript({ engine, provider: 'codex', provider_session_id: 'session-wrong', source_id: 'personal' }))
      .rejects.toMatchObject({ code: 'transcript_conflict' });

    writeFileSync(join(root, 'session-dup.jsonl'), codexTranscript('session-dup'));
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'session-dup.jsonl'), codexTranscript('session-dup'));
    await expect(resolveAuthoritativeTranscript({ engine, provider: 'codex', provider_session_id: 'session-dup', source_id: 'personal' }))
      .rejects.toMatchObject({ code: 'transcript_ambiguous' });

    writeFileSync(join(outside, 'session-escape.jsonl'), codexTranscript('session-escape'));
    symlinkSync(outside, join(root, 'escape'));
    await expect(resolveAuthoritativeTranscript({ engine, provider: 'codex', provider_session_id: 'session-escape', source_id: 'personal' }))
      .rejects.toMatchObject({ code: 'transcript_not_found' });
  });

  test('an ancestor swap after open cannot redirect the authoritative read', () => {
    const root = tempRoot('learning-loop-race-root-');
    const outside = tempRoot('learning-loop-race-outside-');
    const nested = join(root, 'nested');
    mkdirSync(nested);
    const path = join(nested, 'race.jsonl');
    writeFileSync(path, codexTranscript('race'));
    writeFileSync(join(outside, 'race.jsonl'), codexTranscript('race', 'outside'));
    expect(() => _testing.readConfinedFileOnce(root, path, () => {
      renameSync(nested, join(root, 'moved'));
      symlinkSync(outside, nested);
    })).toThrow(/cannot be read safely/);
  });

  test('nested Windows transcript paths normalize to stable ledger paths', () => {
    const rel = win32.relative('C:\\corpus', 'C:\\corpus\\2026\\09\\session.jsonl');
    expect(_testing.normalizeRelativePath(rel, win32.sep)).toBe('2026/09/session.jsonl');
  });

  test('eligibility boundaries are deterministic', () => {
    expect(classifyTranscript(receipt('small', { size_bytes: MIN_TRANSCRIPT_BYTES - 1 }))).toEqual({ eligible: false, reason: 'transcript_too_small' });
    expect(classifyTranscript(receipt('few-user', { user_turn_count: 1 }))).toEqual({ eligible: false, reason: 'insufficient_user_turns' });
    expect(classifyTranscript(receipt('few-assistant', { assistant_turn_count: 1 }))).toEqual({ eligible: false, reason: 'insufficient_assistant_turns' });
    expect(classifyTranscript(receipt('edge', { size_bytes: MIN_TRANSCRIPT_BYTES }))).toEqual({ eligible: true, reason: 'eligible' });
  });
});

describe('append-only run, replay, and cohort reducer', () => {
  test('command payload canonical encoding has a fixed golden hash', () => {
    expect(_testing.commandPayloadHash({
      authorized_adapter: adapter,
      destination: { ...destination, brain_id: 'personal-brain' },
    })).toBe(
      '9f4808a557a00890d252072bfc75bddc8493d9207ad9d771200f09f8f33620f4',
    );
  });

  test('concurrent arm requests cannot create overlapping active runs', async () => {
    const root = tempRoot('learning-loop-concurrent-arm-');
    const corpus = tempRoot('learning-loop-concurrent-arm-corpus-');
    const outcomes = await Promise.allSettled([
      armLearningLoop(armInput(corpus, 'concurrent-arm-1'), ledger(root)),
      armLearningLoop(armInput(corpus, 'concurrent-arm-2'), ledger(root)),
    ]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const state = replayLearningLoop(readLearningLoopLedger({ root }));
    expect(state.runs.size).toBe(1);
    expect(state.active_run_id).not.toBeNull();
  });

  test('real database locks exclude concurrent ledger mutation and mode transition', async () => {
    const corpus = tempRoot('learning-loop-real-lock-corpus-');
    await setLearningLoopMode(engine, { engine: 'pglite' }, 'canary');
    await engine.setConfig('learning_loop.corpus.codex.root', corpus);
    await engine.setConfig('learning_loop.corpus.codex.source_id', 'personal');
    const ledgerRoot = tempRoot('learning-loop-real-ledger-lock-');
      await bindLearningLoopSession(engine, 'bind:real-lock-first', adapter, 'real-lock-first', { root: ledgerRoot });
      await bindLearningLoopSession(engine, 'bind:real-lock-second', adapter, 'real-lock-second', { root: ledgerRoot });
      let releaseLedger!: () => void;
      let enteredLedger!: () => void;
      const ledgerHeld = new Promise<void>((resolve) => { enteredLedger = resolve; });
      const ledgerRelease = new Promise<void>((resolve) => { releaseLedger = resolve; });
      const first = recordSessionEvaluation({
        engine, mode: 'capture', adapter, receipt: receipt('real-lock-first'),
      }, {
        root: ledgerRoot,
        beforeMutation: async () => { enteredLedger(); await ledgerRelease; },
      });
      await ledgerHeld;
      await expect(recordSessionEvaluation({
        engine, mode: 'capture', adapter, receipt: receipt('real-lock-second'),
      }, { root: ledgerRoot })).rejects.toMatchObject({ code: 'ledger_busy' });
      releaseLedger();
      await first;
      expect(readLearningLoopLedger({ root: ledgerRoot })).toHaveLength(3);

      const lifecycleRoot = tempRoot('learning-loop-real-lifecycle-lock-');
      let releaseArm!: () => void;
      let enteredArm!: () => void;
      let blockedOnce = false;
      const armHeld = new Promise<void>((resolve) => { enteredArm = resolve; });
      const armRelease = new Promise<void>((resolve) => { releaseArm = resolve; });
      const arming = armLearningLoop({
        command_id: 'real-lifecycle-arm', engine, authorized_adapter: adapter, destination,
      }, {
        root: lifecycleRoot,
        beforeMutation: async () => {
          if (blockedOnce) return;
          blockedOnce = true;
          enteredArm();
          await armRelease;
        },
      });
      await armHeld;
      await expect(withLearningLoopLifecycleLock(engine, async () => {
        await setLearningLoopMode(engine, { engine: 'pglite' }, 'off', { root: lifecycleRoot });
      }, { root: lifecycleRoot })).rejects.toMatchObject({ code: 'ledger_busy' });
      releaseArm();
      const armed = await arming;
      expect(await engine.getConfig('learning_loop.mode')).toBe('canary');
    expect(replayLearningLoop(readLearningLoopLedger({ root: lifecycleRoot })).active_run_id).toBe(armed.run_id);
  }, 30000);

  test('production ledger and lock scopes isolate brains that share GBRAIN_HOME', async () => {
    const home = tempRoot('learning-loop-shared-home-');
    const brainAPath = tempRoot('learning-loop-brain-a-');
    const brainBPath = tempRoot('learning-loop-brain-b-');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const optsA = { config: { database_path: brainAPath }, mutationLock: testMutationLock };
      const optsB = { config: { database_path: brainBPath }, mutationLock: testMutationLock };
      await bindLearningLoopSession(testEngine, 'bind:brain-a', adapter, 'brain-a-session', optsA);
      await bindLearningLoopSession(testEngine, 'bind:brain-b', adapter, 'brain-b-session', optsB);

      expect(learningLoopLedgerPath(optsA)).not.toBe(learningLoopLedgerPath(optsB));
      expect(_testing.ledgerScopeId(optsA)).not.toBe(_testing.ledgerScopeId(optsB));
      expect(readLearningLoopLedger(optsA).map((event) => event.event_type)).toEqual(['adapter_session_bound']);
      expect(readLearningLoopLedger(optsB).map((event) => event.event_type)).toEqual(['adapter_session_bound']);
      expect(readLearningLoopLedger(optsA)[0]).toMatchObject({ provider_session_id: 'brain-a-session' });
      expect(readLearningLoopLedger(optsB)[0]).toMatchObject({ provider_session_id: 'brain-b-session' });
      expect(() => learningLoopLedgerPath()).toThrow(/explicit active-brain configuration/);
    });
  });

  test('production arm derives destination brain identity from the active configuration', async () => {
    const home = tempRoot('learning-loop-arm-brain-home-');
    const corpus = tempRoot('learning-loop-arm-brain-corpus-');
    const config = { engine: 'pglite' as const, database_path: tempRoot('learning-loop-arm-brain-db-') };
    const otherConfig = { engine: 'pglite' as const, database_path: tempRoot('learning-loop-other-brain-db-') };
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const armed = await armLearningLoop({
        command_id: 'arm-computed-brain',
        engine: corpusEngine(corpus) as BrainEngine,
        config,
        authorized_adapter: adapter,
        destination,
      }, { config, mutationLock: testMutationLock, lifecycleLock: testMutationLock });
      expect(armed.destination.brain_id).toBe(computeBrainIdFromConfig(config));
      await expect(armLearningLoop({
        command_id: 'arm-mismatched-brain',
        engine: corpusEngine(corpus) as BrainEngine,
        config,
        authorized_adapter: adapter,
        destination,
      }, { config: otherConfig, mutationLock: testMutationLock, lifecycleLock: testMutationLock }))
        .rejects.toMatchObject({ code: 'invalid_input' });
    });

    const root = tempRoot('learning-loop-arm-root-scope-');
    const armed = await armLearningLoop(armInput(corpus, 'arm-root-scope'), ledger(root));
    expect(armed.destination.brain_id).toBe(_testing.ledgerScopeId({ root }));
    expect(armed.destination.brain_id).not.toBe('caller-controlled-brain');
    expect(readLearningLoopLedger({ root })).toHaveLength(1);
  });

  test('mode change completes when a concurrent owner abort wins first', async () => {
    const root = tempRoot('learning-loop-mode-abort-race-');
    const corpus = tempRoot('learning-loop-mode-abort-corpus-');
    await setLearningLoopMode(engine, { engine: 'pglite' }, 'canary');
    await engine.setConfig('learning_loop.corpus.codex.root', corpus);
    await engine.setConfig('learning_loop.corpus.codex.source_id', 'personal');
    await armLearningLoop({
      command_id: 'arm-mode-abort-race', engine, authorized_adapter: adapter, destination,
    }, ledger(root));
    let releaseModeAbort!: () => void;
    let modeAbortEntered!: () => void;
    const modeAbortHeld = new Promise<void>((resolve) => { modeAbortEntered = resolve; });
    const modeAbortRelease = new Promise<void>((resolve) => { releaseModeAbort = resolve; });

    const changingMode = setLearningLoopMode(engine, { engine: 'pglite' }, 'off', {
      ...ledger(root),
      beforeMutation: async () => {
        modeAbortEntered();
        await modeAbortRelease;
      },
    });
    await modeAbortHeld;
    await abortLearningLoop(engine, 'owner-abort-wins-race', 'owner_abort', ledger(root));
    releaseModeAbort();

    await expect(changingMode).resolves.toEqual({ previous_mode: 'canary', mode: 'off' });
    expect(await engine.getConfig('learning_loop.mode')).toBe('off');
    expect(replayLearningLoop(readLearningLoopLedger({ root })).active_run_id).toBeNull();
  });

  test('adapter submission rechecks mode after transcript discovery before recording', async () => {
    const home = tempRoot('learning-loop-submit-mode-home-');
    const corpus = tempRoot('learning-loop-submit-mode-corpus-');
    const config = { engine: 'pglite' as const, database_path: tempRoot('learning-loop-submit-mode-db-') };
    const sessionId = 'mode-race-session';
    const nested = join(corpus, '2026', '09');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, `${sessionId}.jsonl`), codexTranscript(sessionId));

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await setLearningLoopMode(engine, config, 'capture', { config });
      await engine.setConfig('learning_loop.corpus.codex.root', corpus);
      await engine.setConfig('learning_loop.corpus.codex.source_id', 'personal');
      await bindLearningLoopSession(engine, `bind:${sessionId}`, adapter, sessionId, {
        config, mutationLock: testMutationLock,
      });

      let releaseTranscriptDiscovery!: () => void;
      let transcriptDiscoveryStarted!: () => void;
      const transcriptDiscoveryHeld = new Promise<void>((resolve) => { transcriptDiscoveryStarted = resolve; });
      const transcriptDiscoveryRelease = new Promise<void>((resolve) => { releaseTranscriptDiscovery = resolve; });
      const getConfig = engine.getConfig.bind(engine);
      let modeReads = 0;
      const handlerEngine = new Proxy(engine, {
        get(target, property) {
          if (property === 'getConfig') {
            return async (key: string) => {
              if (key === 'learning_loop.mode') {
                modeReads += 1;
                if (modeReads === 1) return 'capture';
              }
              if (key === 'learning_loop.corpus.codex.root') {
                transcriptDiscoveryStarted();
                await transcriptDiscoveryRelease;
              }
              return getConfig(key);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PGLiteEngine;
      const ctx = {
        remote: true,
        dryRun: false,
        config,
        engine: handlerEngine,
        logger: { info() {}, warn() {}, error() {} },
        sourceId: 'personal',
        auth: { token: 'redacted', clientId: adapter.client_id, scopes: ['write'], sourceId: 'personal' },
      } as OperationContext;

      const submitting = operationsByName.learning_loop_submit_session_v1.handler(ctx, {
        provider: 'codex',
        provider_session_id: sessionId,
        source_id: 'personal',
        completion_state: 'completed',
        completed_at: '2026-08-01T00:00:00.000Z',
      });
      await transcriptDiscoveryHeld;
      await setLearningLoopMode(engine, config, 'off', { config });
      releaseTranscriptDiscovery();

      await expect(submitting).resolves.toEqual({ status: 'disabled', mode: 'off' });
      expect(modeReads).toBe(2);
      expect(readLearningLoopLedger({ config }).filter((event) => event.event_type === 'session_evaluated')).toHaveLength(0);
    });
  });

  test('capture submission cannot join a canary armed during transcript discovery', async () => {
    const home = tempRoot('learning-loop-submit-canary-race-home-');
    const corpus = tempRoot('learning-loop-submit-canary-race-corpus-');
    const config = { engine: 'pglite' as const, database_path: tempRoot('learning-loop-submit-canary-race-db-') };
    const sessionId = 'capture-before-canary-session';
    const nested = join(corpus, '2026', '09');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, `${sessionId}.jsonl`), codexTranscript(sessionId));

    await withEnv({ GBRAIN_HOME: home }, async () => {
      await setLearningLoopMode(engine, config, 'capture', { config });
      await engine.setConfig('learning_loop.corpus.codex.root', corpus);
      await engine.setConfig('learning_loop.corpus.codex.source_id', 'personal');
      await bindLearningLoopSession(engine, `bind:${sessionId}`, adapter, sessionId, {
        config, mutationLock: testMutationLock,
      });

      let releaseTranscriptDiscovery!: () => void;
      let transcriptDiscoveryStarted!: () => void;
      const transcriptDiscoveryHeld = new Promise<void>((resolve) => { transcriptDiscoveryStarted = resolve; });
      const transcriptDiscoveryRelease = new Promise<void>((resolve) => { releaseTranscriptDiscovery = resolve; });
      const getConfig = engine.getConfig.bind(engine);
      let modeReads = 0;
      const handlerEngine = new Proxy(engine, {
        get(target, property) {
          if (property === 'getConfig') {
            return async (key: string) => {
              if (key === 'learning_loop.mode') {
                modeReads += 1;
                if (modeReads === 1) return 'capture';
              }
              if (key === 'learning_loop.corpus.codex.root') {
                transcriptDiscoveryStarted();
                await transcriptDiscoveryRelease;
              }
              return getConfig(key);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PGLiteEngine;
      const ctx = {
        remote: true,
        dryRun: false,
        config,
        engine: handlerEngine,
        logger: { info() {}, warn() {}, error() {} },
        sourceId: 'personal',
        auth: { token: 'redacted', clientId: adapter.client_id, scopes: ['write'], sourceId: 'personal' },
      } as OperationContext;

      const submitting = operationsByName.learning_loop_submit_session_v1.handler(ctx, {
        provider: 'codex',
        provider_session_id: sessionId,
        source_id: 'personal',
        completion_state: 'completed',
        completed_at: '2026-08-01T00:00:00.000Z',
      });
      await transcriptDiscoveryHeld;
      await setLearningLoopMode(engine, config, 'canary', { config });
      await armLearningLoop({
        command_id: 'arm-during-capture-submission',
        engine,
        config,
        authorized_adapter: adapter,
        destination,
      }, { config });
      releaseTranscriptDiscovery();

      const result = await submitting;
      expect(result).toMatchObject({ status: 'recorded' });
      expect(modeReads).toBe(2);
      const evaluated = readLearningLoopLedger({ config }).find((event) => event.event_type === 'session_evaluated');
      expect(evaluated).toMatchObject({ run_id: null, cohort_member: false });
      expect(replayLearningLoop(readLearningLoopLedger({ config })).runs.values().next().value?.cohort).toHaveLength(0);
    });
  });

  test('same session/hash is idempotent and a changed hash fails closed', async () => {
    const root = tempRoot('learning-loop-idem-');
    await bindSession(root, 'same');
    const first = await recordSessionEvaluation({ engine: testEngine, mode: 'capture', adapter, completed_at: '2026-08-01T00:00:00Z', receipt: receipt('same') }, ledger(root));
    const retry = await recordSessionEvaluation({ engine: testEngine, mode: 'capture', adapter, completed_at: '2026-08-01T00:00:00Z', receipt: receipt('same') }, ledger(root));
    expect(first.status).toBe('recorded');
    expect(retry.status).toBe('idempotent');
    expect(readLearningLoopLedger({ root })).toHaveLength(2);
    await expect(recordSessionEvaluation({
      engine: testEngine, mode: 'capture', adapter, completed_at: '2026-08-01T00:00:00Z',
      receipt: receipt('same', { content_hash: 'f'.repeat(64) }),
    }, ledger(root))).rejects.toThrow(new LearningLoopError('transcript_conflict', 'Session transcript hash changed'));
  });

  test('trusted-local adapter bindings are immutable and reject cross-session submission', async () => {
    const root = tempRoot('learning-loop-binding-');
    const bound = await bindSession(root, 'owned-session');
    expect((await bindSession(root, 'owned-session')).event_id).toBe(bound.event_id);
    await expect(bindLearningLoopSession(
      testEngine,
      'bind:owned-session:impostor',
      { ...adapter, client_id: 'impostor' },
      'owned-session',
      ledger(root),
    )).rejects.toMatchObject({ code: 'forbidden' });
    await expect(bindLearningLoopSession(
      testEngine,
      'bind:owned-session',
      adapter,
      'different-session',
      ledger(root),
    )).rejects.toMatchObject({ code: 'command_conflict' });
    await expect(recordSessionEvaluation({
      engine: testEngine, mode: 'capture', adapter, receipt: receipt('unbound-session'),
    }, ledger(root))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(recordSessionEvaluation({
      engine: testEngine, mode: 'capture', adapter: { ...adapter, client_id: 'impostor' }, receipt: receipt('owned-session'),
    }, ledger(root))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(recordSessionEvaluation({
      engine: testEngine, mode: 'capture', adapter, receipt: receipt('owned-session'),
    }, ledger(root))).resolves.toMatchObject({ status: 'recorded' });
  });

  test('only one run is active, ineligible sessions do not enter, and cohort seals at exactly ten', async () => {
    const root = tempRoot('learning-loop-cohort-');
    const corpus = tempRoot('learning-loop-cohort-corpus-');
    const armed = await armLearningLoop(armInput(corpus, 'arm-cohort-1'), { ...ledger(root), now: () => new Date('2026-08-10T00:00:00Z') });
    await expect(armLearningLoop(armInput(corpus, 'arm-cohort-2'), ledger(root))).rejects.toThrow(/already active/);
    await bindSession(root, 'ineligible');
    await recordSessionEvaluation({
      engine: testEngine, mode: 'canary', adapter, completed_at: '2026-08-10T01:00:00Z',
      receipt: receipt('ineligible', { size_bytes: 10 }),
    }, ledger(root));
    for (let i = 1; i <= 11; i += 1) {
      await bindSession(root, `eligible-${i}`);
      await recordSessionEvaluation({
        engine: testEngine, mode: 'canary', adapter, completed_at: `2026-08-10T${String(i + 1).padStart(2, '0')}:00:00Z`, receipt: receipt(`eligible-${i}`),
      }, ledger(root));
    }
    const state = replayLearningLoop(readLearningLoopLedger({ root }));
    const run = state.runs.get(armed.run_id)!;
    expect(run.cohort).toHaveLength(TARGET_COHORT_SIZE);
    expect(run.sealed).toBe(true);
    expect(run.cohort.map((item) => item.provider_session_id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `eligible-${index + 1}`),
    );
    expect(state.session_events.get('codex\u0000eligible-11')?.cohort_member).toBe(false);
    expect(state.session_events.get('codex\u0000ineligible')?.cohort_member).toBe(false);
  });

  test('wrong adapter cannot admit, abort permits a fresh run, and old events stay isolated', async () => {
    const root = tempRoot('learning-loop-abort-');
    const corpus = tempRoot('learning-loop-abort-corpus-');
    await bindSession(root, 'already-recorded');
    await bindSession(root, 'blocked');
    await recordSessionEvaluation({ engine: testEngine, mode: 'capture', adapter, receipt: receipt('already-recorded') }, ledger(root));
    const first = await armLearningLoop(armInput(corpus, 'arm-abort-1'), ledger(root));
    await expect(recordSessionEvaluation({
      engine: testEngine, mode: 'canary', adapter: { ...adapter, client_id: 'impostor' }, receipt: receipt('already-recorded'),
    }, ledger(root))).rejects.toThrow(/does not match/);
    await expect(recordSessionEvaluation({
      engine: testEngine, mode: 'canary', adapter: { ...adapter, client_id: 'impostor' }, completed_at: '2026-08-20T00:00:00Z', receipt: receipt('blocked'),
    }, ledger(root))).rejects.toThrow(/does not match/);
    await abortLearningLoop(testEngine, 'abort-1', 'owner_abort', ledger(root));
    const second = await armLearningLoop(armInput(corpus, 'arm-abort-2'), ledger(root));
    expect(second.run_id).not.toBe(first.run_id);
    const state = replayLearningLoop(readLearningLoopLedger({ root }));
    expect(state.runs.get(first.run_id)?.terminal).toBe(true);
    expect(state.active_run_id).toBe(second.run_id);
  });

  test('arm and abort command retries are idempotent and changed payloads conflict', async () => {
    const root = tempRoot('learning-loop-command-idem-');
    const corpus = tempRoot('learning-loop-command-idem-corpus-');
    const first = await armLearningLoop(armInput(corpus, 'stable-arm'), ledger(root));
    const retry = await armLearningLoop(armInput(corpus, 'stable-arm'), ledger(root));
    expect(retry.run_id).toBe(first.run_id);
    expect(readLearningLoopLedger({ root })).toHaveLength(1);
    rmSync(corpus, { recursive: true, force: true });
    expect((await armLearningLoop(armInput(corpus, 'stable-arm'), ledger(root))).run_id).toBe(first.run_id);
    await expect(armLearningLoop({
      ...armInput(corpus, 'stable-arm'), destination: { ...destination, canonical_slug: 'personal/other' },
    }, ledger(root))).rejects.toMatchObject({ code: 'command_conflict' });

    const aborted = await abortLearningLoop(testEngine, 'stable-abort', 'owner_abort', ledger(root));
    const abortRetry = await abortLearningLoop(testEngine, 'stable-abort', 'owner_abort', ledger(root));
    expect(abortRetry.event_id).toBe(aborted.event_id);
    expect(readLearningLoopLedger({ root })).toHaveLength(2);
    await expect(abortLearningLoop(testEngine, 'stable-abort', 'mode_changed', ledger(root)))
      .rejects.toThrow(new LearningLoopError('command_conflict', 'Abort command id was reused with a different payload'));
  });

  test('ledger mutation does not create a second filesystem lock surface', async () => {
    const root = tempRoot('learning-loop-existing-lock-');
    const corpus = tempRoot('learning-loop-existing-lock-corpus-');
    const armed = await armLearningLoop(armInput(corpus, 'existing-db-lock'), ledger(root));
    expect(armed.event_type).toBe('run_armed');
    expect(existsSync(join(root, 'events.lock'))).toBe(false);
    expect(readLearningLoopLedger({ root })).toHaveLength(1);
  });

  test('baseline candidate order is byte-stable and arm freezes the historical manifest', async () => {
    const ordered = orderBaselineCandidates([
      { provider: 'codex', provider_session_id: 'z', completed_at: '2026-08-01T00:00:00Z', content_hash: 'b' },
      { provider: 'codex', provider_session_id: 'ä', completed_at: '2026-08-01T00:00:00Z', content_hash: 'a' },
      { provider: 'codex', provider_session_id: 'a', completed_at: '2026-08-02T00:00:00Z', content_hash: 'c' },
      { provider: 'codex', provider_session_id: 'z', completed_at: '2026-08-01T00:00:00Z', content_hash: 'a' },
    ]);
    expect(ordered.map((item) => `${item.provider_session_id}:${item.content_hash}`)).toEqual(['a:c', 'z:a', 'z:b', 'ä:a']);

    const root = tempRoot('learning-loop-baseline-');
    const corpus = tempRoot('learning-loop-baseline-corpus-');
    for (let i = 1; i <= 12; i += 1) {
      const completedAt = `2026-08-${String(i).padStart(2, '0')}T00:00:00.000Z`;
      writeFileSync(join(corpus, `history-${i}.jsonl`), codexTranscript(`history-${i}`, undefined, completedAt));
    }
    const armed = await armLearningLoop(armInput(corpus, 'arm-baseline-1'), { ...ledger(root), now: () => new Date('2026-09-01T00:00:00Z') });
    expect(armed.baseline_discovery.candidate_count).toBe(12);
    expect(armed.baseline_discovery.selected_candidates).toHaveLength(10);
    expect(armed.baseline_discovery.selected_candidates[0].provider_session_id).toBe('history-12');
    const frozenHash = armed.baseline_discovery.source_manifest_hash;
    expect(replayLearningLoop(readLearningLoopLedger({ root })).runs.get(armed.run_id)?.armed.baseline_discovery.source_manifest_hash).toBe(frozenHash);
  });

  test('baseline discovery freezes no selection below ten and exactly ten at the boundary', async () => {
    for (const count of [0, 9, 10]) {
      const root = tempRoot(`learning-loop-baseline-${count}-`);
      const corpus = tempRoot(`learning-loop-baseline-${count}-corpus-`);
      for (let i = 0; i < count; i += 1) {
        const id = `boundary-${count}-${i}`;
        writeFileSync(join(corpus, `${id}.jsonl`), codexTranscript(id, undefined, `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`));
      }
      const armed = await armLearningLoop(armInput(corpus, `arm-boundary-${count}`), {
        ...ledger(root), now: () => new Date('2026-09-01T00:00:00Z'),
      });
      expect(armed.baseline_discovery.candidate_count).toBe(count);
      expect(armed.baseline_discovery.status).toBe(count === 10 ? 'complete' : 'insufficient');
      expect(armed.baseline_discovery.selected_candidates).toHaveLength(count === 10 ? 10 : 0);
    }
  });

  test('baseline walk fails closed on an unreadable corpus root and skips a denied child', async () => {
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    expect(() => _testing.handleBaselineWalkError(denied, '/corpus', '/corpus'))
      .toThrow(new LearningLoopError('binding_unavailable', 'Baseline corpus root is unreadable'));
    expect(() => _testing.handleBaselineWalkError(denied, '/corpus/child', '/corpus')).not.toThrow();
    expect(() => _testing.handleBaselineWalkError(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), '/corpus/child', '/corpus'))
      .toThrow(/ENOENT/);

    const corpus = tempRoot('learning-loop-baseline-eacces-');
    const child = join(corpus, 'denied');
    mkdirSync(child);
    writeFileSync(join(corpus, 'keep.jsonl'), codexTranscript('keep', undefined, '2026-08-01T00:00:00.000Z'));
    writeFileSync(join(child, 'hidden.jsonl'), codexTranscript('hidden', undefined, '2026-08-02T00:00:00.000Z'));
    chmodSync(child, 0);
    try {
      const childSkip = await discoverBaselineSnapshot({
        engine: corpusEngine(corpus),
        source_id: 'personal',
        cutoff_at: '2026-09-01T00:00:00.000Z',
      });
      expect(childSkip.candidate_count).toBe(1);
      expect(childSkip.status).toBe('insufficient');
    } finally {
      chmodSync(child, 0o755);
    }
  });

  test('replay is deterministic and corruption or an interrupted line fails closed', async () => {
    const root = tempRoot('learning-loop-replay-');
    const corpus = tempRoot('learning-loop-replay-corpus-');
    await armLearningLoop(armInput(corpus, 'arm-replay-1'), ledger(root));
    await bindSession(root, 'one');
    await recordSessionEvaluation({ engine: testEngine, mode: 'canary', adapter, completed_at: '2026-08-20T00:00:00Z', receipt: receipt('one') }, ledger(root));
    const events = readLearningLoopLedger({ root });
    const a = replayLearningLoop(events);
    const b = replayLearningLoop(JSON.parse(JSON.stringify(events)));
    expect({ active: a.active_run_id, cohorts: [...a.runs.values()].map((run) => run.cohort) })
      .toEqual({ active: b.active_run_id, cohorts: [...b.runs.values()].map((run) => run.cohort) });

    const path = learningLoopLedgerPath({ root });
    writeFileSync(path, readFileSync(path, 'utf8') + '{"partial":');
    expect(() => readLearningLoopLedger({ root })).toThrow(/partial final line/);
  });

  test('replay fails closed before reading an oversized ledger', () => {
    const root = tempRoot('learning-loop-ledger-bound-');
    const path = learningLoopLedgerPath({ root });
    mkdirSync(root, { recursive: true });
    writeFileSync(path, '');
    truncateSync(path, MAX_LEDGER_BYTES + 1);
    expect(() => readLearningLoopLedger({ root })).toThrow(/bounded replay limit/);
  });
});
