import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LearningLoopError,
  armLearningLoop,
  canonicalSha256,
  decodeExactEventRecordV1,
  makeExactEventRecordV1,
  readLearningLoopLedger,
  replayLearningLoop,
  resolveAuthoritativeTranscript,
  resolveCodexCorpusBinding,
  resolveLearningLoopDestinationBinding,
  validateExactEventSequence,
} from '../src/core/learning-loop.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const roots: string[] = [];
const tempRoot = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Learning Loop V2 exact identity', () => {
  const payload = { brain_id: 'brain-a', run_id: 'run-a', occurred_at: '2026-01-01T00:00:00.000Z', semantic_sequence: 1, event_type: 'lesson_activated' };
  const record = () => makeExactEventRecordV1({ event_payload: payload, brain_id: 'brain-a', run_id: 'run-a', occurred_at: payload.occurred_at, semantic_sequence: 1 });

  test('rejects a record whose event id is not derived from payload', () => {
    const tampered = record();
    tampered.event_id = '0'.repeat(64);
    expect(() => decodeExactEventRecordV1(tampered)).toThrow(LearningLoopError);
  });

  test('accepts exact payload identity and rejects envelope disagreement', () => {
    const valid = makeExactEventRecordV1({ event_payload: payload, brain_id: 'brain-a', run_id: 'run-a', occurred_at: payload.occurred_at, semantic_sequence: 1 });
    expect(decodeExactEventRecordV1(valid)).toEqual(valid);
    expect(() => decodeExactEventRecordV1({ ...valid, semantic_sequence: 2 })).toThrow(LearningLoopError);
  });

  test('requires contiguous per-run sequences', () => {
    const make = (n: number, run_id = 'run-a') => {
      const p = { ...payload, run_id, semantic_sequence: n };
      return makeExactEventRecordV1({ event_payload: p, brain_id: 'brain-a', run_id, occurred_at: p.occurred_at, semantic_sequence: n });
    };
    expect(() => validateExactEventSequence([make(1), make(3)])).toThrow(LearningLoopError);
    expect(() => validateExactEventSequence([make(1), make(2)])).not.toThrow();
    expect(() => validateExactEventSequence([make(1), make(1)])).toThrow(LearningLoopError);
    expect(() => validateExactEventSequence([make(2), make(1)])).toThrow(LearningLoopError);
    expect(() => validateExactEventSequence([make(1, 'run-a'), make(1, 'run-b')])).not.toThrow();
  });

  test('freezes canonical configured-root hash vectors', () => {
    expect(canonicalSha256({
      schema_version: 1,
      binding_kind: 'corpus_codex',
      root: { plane: 'db_config', key: 'learning_loop.corpus.codex.root', value: '/Volumes/brain/codex' },
      source: { plane: 'file_config', key: 'learning_loop.corpus.codex.source_id', value: 'personal' },
    })).toBe('bc9dbd01e8a6ceeee83b29b5f48b8c51d50b6df482ac53600557b8dc32cfdf8d');
    expect(canonicalSha256({
      schema_version: 1,
      binding_kind: 'destination',
      source_id: 'personal',
      topology: 'source_local_path',
      root: { plane: 'sources_row', key: 'sources.local_path', value: '/Volumes/brain/personal' },
    })).toBe('9b279d2a2807f561a98a604d5b471b9e0402687c0befdab19822c01088fa2d7b');
  });

  test('binds corpus config precedence and rejects database read failure', async () => {
    const root = tempRoot('learning-loop-binding-');
    const config = { engine: 'pglite' as const, learning_loop: { corpus: { codex: { root, source_id: 'personal' } } } };
    const file = await resolveCodexCorpusBinding({ getConfig: async () => null }, 'personal', config);
    const db = await resolveCodexCorpusBinding({ getConfig: async (key) => key.endsWith('.root') ? root : 'personal' }, 'personal', config);
    expect(file.canonical_realpath).toBe(db.canonical_realpath);
    expect(file.configured_root_hash).not.toBe(db.configured_root_hash);
    await expect(resolveCodexCorpusBinding({ getConfig: async () => { throw new Error('down'); } }, 'personal', config))
      .rejects.toMatchObject({ code: 'binding_unavailable' });
  });

  test('selects explicit destination topology and default-only fallback', async () => {
    const local = tempRoot('learning-loop-destination-local-');
    const sync = tempRoot('learning-loop-destination-sync-');
    const localEngine = {
      getConfig: async () => sync,
      executeRaw: async () => [{ local_path: local }],
    } as unknown as Pick<BrainEngine, 'getConfig' | 'executeRaw'>;
    expect((await resolveLearningLoopDestinationBinding(localEngine, 'brain-a', 'personal', 'personal/preferences')).topology)
      .toBe('source_local_path');

    const fallbackEngine = {
      getConfig: async (key: string) => key === 'sync.repo_path' ? sync : null,
      executeRaw: async () => [{ local_path: null }],
    } as unknown as Pick<BrainEngine, 'getConfig' | 'executeRaw'>;
    expect((await resolveLearningLoopDestinationBinding(fallbackEngine, 'brain-a', 'default', 'personal/preferences')).topology)
      .toBe('sync_repo_path');
    await expect(resolveLearningLoopDestinationBinding(fallbackEngine, 'brain-a', 'personal', 'personal/preferences'))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  test('arms and replays V2 without the legacy destination field', async () => {
    const corpus = tempRoot('learning-loop-v2-corpus-');
    const destination = tempRoot('learning-loop-v2-destination-');
    const ledger = tempRoot('learning-loop-v2-ledger-');
    const values: Record<string, string | null> = {
      'learning_loop.mode': 'canary',
      'learning_loop.corpus.codex.root': corpus,
      'learning_loop.corpus.codex.source_id': 'personal',
    };
    const engine = {
      getConfig: async (key: string) => values[key] ?? null,
      executeRaw: async () => [{ local_path: destination }],
    } as unknown as BrainEngine;
    const lock = async <T>(work: () => Promise<T>) => work();
    const armed = await armLearningLoop({
      command_id: 'v2-arm',
      contract_version: 2,
      engine,
      authorized_adapter: { client_id: 'codex-adapter', source_id: 'personal', provider: 'codex' },
      destination: { source_id: 'personal', canonical_slug: 'personal/preferences' },
    }, { root: ledger, mutationLock: lock, lifecycleLock: lock });
    expect('destination' in armed).toBe(false);
    expect(armed.corpus_binding.source_id).toBe('personal');
    expect(replayLearningLoop([armed]).active_run_id).toBe(armed.run_id);
    expect(() => replayLearningLoop([{ ...armed, destination: { brain_id: 'x', source_id: 'personal', canonical_slug: 'personal/preferences' } } as never]))
      .toThrow(LearningLoopError);

    const { event_id: _eventId, ...eventBody } = armed;
    const exactBody = { ...eventBody, brain_id: armed.destination_binding.brain_id, semantic_sequence: 1 };
    const exact = makeExactEventRecordV1({
      event_payload: exactBody,
      brain_id: exactBody.brain_id,
      run_id: armed.run_id,
      occurred_at: armed.occurred_at,
      semantic_sequence: 1,
    });
    expect(replayLearningLoop([exact]).active_run_id).toBe(armed.run_id);
    expect(() => replayLearningLoop([{ ...exact, semantic_sequence: 2 }])).toThrow(LearningLoopError);
    expect(readLearningLoopLedger({ root: ledger })).toHaveLength(1);
  });

  test('V2 binding rejects rebind and database-error fallback before transcript reads', async () => {
    const corpusA = tempRoot('learning-loop-v2-corpus-a-');
    const corpusB = tempRoot('learning-loop-v2-corpus-b-');
    const destination = tempRoot('learning-loop-v2-destination-race-');
    const ledger = tempRoot('learning-loop-v2-ledger-race-');
    let rootReads = 0;
    const engine = {
      getConfig: async (key: string) => {
        if (key === 'learning_loop.mode') return 'canary';
        if (key === 'learning_loop.corpus.codex.root') return rootReads++ === 0 ? corpusA : corpusB;
        if (key === 'learning_loop.corpus.codex.source_id') return 'personal';
        return null;
      },
      executeRaw: async () => [{ local_path: destination }],
    } as unknown as BrainEngine;
    const lock = async <T>(work: () => Promise<T>) => work();
    await expect(armLearningLoop({
      command_id: 'v2-rebind', contract_version: 2, engine,
      authorized_adapter: { client_id: 'codex-adapter', source_id: 'personal', provider: 'codex' },
      destination: { source_id: 'personal', canonical_slug: 'personal/preferences' },
    }, { root: ledger, mutationLock: lock, lifecycleLock: lock })).rejects.toMatchObject({ code: 'assertion_mismatch' });
    expect(readLearningLoopLedger({ root: ledger })).toEqual([]);

    const frozen = await resolveCodexCorpusBinding({ getConfig: async (key) => key.endsWith('.root') ? corpusA : 'personal' }, 'personal');
    await expect(resolveAuthoritativeTranscript({
      engine: { getConfig: async () => { throw new Error('db unavailable'); } },
      config: { engine: 'pglite', learning_loop: { corpus: { codex: { root: corpusB, source_id: 'personal' } } } },
      expected_corpus_binding: frozen,
      provider: 'codex', provider_session_id: 'missing', source_id: 'personal',
    })).rejects.toMatchObject({ code: 'binding_unavailable' });
  });
});
