import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  activateLearningClaim,
  armLearningLoop,
  bindLearningLoopSession,
  parseAuthoritativeUserRows,
  recordLearningAuthority,
  recordLearningCandidate,
  recordSessionEvaluation,
  readLearningLoopLedger,
  resolveAuthoritativeTranscript,
  setLearningLoopMode,
  type LedgerOptions,
} from '../src/core/learning-loop.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeBrainIdFromConfig } from '../src/core/upgrade-checkpoint.ts';
import { makeLearningClaimIdentity, parseLearningLoopFence, renderLearningLoopFence, type LearningLoopKnowledge } from '../src/core/learning-loop-knowledge.ts';
import { withEnv } from './helpers/with-env.ts';

const noLock = async <T>(work: () => Promise<T>): Promise<T> => work();

let pglite: PGLiteEngine;
beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({ type: 'pglite' } as never);
  await pglite.initSchema();
}, 60_000);
afterAll(async () => { await pglite?.disconnect(); }, 60_000);

function fakeEngine(initialMode: string | null = null): BrainEngine {
  const values = new Map<string, string>();
  if (initialMode !== null) values.set('learning_loop.mode', initialMode);
  values.set('learning_loop.corpus.codex.root', '/tmp');
  values.set('learning_loop.corpus.codex.source_id', 'source');
  return {
    getConfig: async (key: string) => values.get(key) ?? null,
    setConfig: async (key: string, value: string) => { values.set(key, value); },
    unsetConfig: async (key: string) => values.delete(key) ? 1 : 0,
  } as unknown as BrainEngine;
}

function opts(root: string): LedgerOptions {
  return { root, mutationLock: noLock, lifecycleLock: noLock };
}

async function v2Fixture(suffix: string) {
  const root = mkdtempSync(join(tmpdir(), `learning-loop-recovery-v2-${suffix}-`));
  return withEnv({ GBRAIN_HOME: root }, async () => {
    const canonicalRoot = join(root, 'canonical');
    const corpusRoot = join(root, 'corpus');
    const slug = 'topics/recovery';
    mkdirSync(join(canonicalRoot, 'topics'), { recursive: true });
    mkdirSync(corpusRoot, { recursive: true });
    const config = { database_path: join(root, 'brain') } as never;
    const brainId = computeBrainIdFromConfig(config);
    const initial: LearningLoopKnowledge = {
      brain_id: brainId, source_id: 'default', canonical_slug: slug,
      managed_rows: {}, blocked_identities: [], correction_lineages: {}, reversal_attempts: {},
      immutable_commit_markers: [], pending_delivery: null,
    };
    writeFileSync(join(canonicalRoot, `${slug}.md`), `---\ntype: concept\ntitle: Recovery\nslug: ${slug}\n---\n\n# Recovery\n\n${renderLearningLoopFence(initial)}\n`);
    await pglite.executeRaw('DELETE FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]);
    await pglite.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [canonicalRoot, 'default']);
    await setLearningLoopMode(pglite, config, 'canary', { config });
    await pglite.setConfig('learning_loop.corpus.codex.root', corpusRoot);
    await pglite.setConfig('learning_loop.corpus.codex.source_id', 'default');
    const session = `recovery-${suffix}`;
    const at = '2026-08-31T00:00:00.000Z';
    const body = [
      { timestamp: at, type: 'session_meta', payload: { id: session } },
      { timestamp: at, type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'Recovery claim' }] } },
      { timestamp: at, type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(180) }] } },
      { timestamp: at, type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'unrelated' }] } },
      { timestamp: at, type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'y'.repeat(180) }] } },
      { timestamp: at, type: 'event_msg', payload: { type: 'task_complete', completed_at: at } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    writeFileSync(join(corpusRoot, `${session}.jsonl`), body);
    const adapter = { client_id: 'recovery-v2', source_id: 'default', provider: 'codex' as const };
    const armed = await armLearningLoop({ command_id: `arm:${suffix}`, engine: pglite, config, authorized_adapter: adapter, destination: { source_id: 'default', canonical_slug: slug }, contract_version: 2 }, { config });
    await bindLearningLoopSession(pglite, `bind:${suffix}`, adapter, session, { config });
    const receipt = await resolveAuthoritativeTranscript({ engine: pglite, config, provider: 'codex', provider_session_id: session, source_id: 'default' });
    await recordSessionEvaluation({ engine: pglite, mode: 'canary', adapter, receipt }, { config });
    const rows = parseAuthoritativeUserRows(body, session, receipt.content_hash);
    const identity = makeLearningClaimIdentity({ claim: 'Recovery claim', class: 'preference', scope: { kind: 'global' }, target: null, trigger: null });
    const locator = { provider_session_id: session, line: rows[0].line, message_index: rows[0].message_index, message_hash: rows[0].message_hash };
    await recordLearningCandidate({ engine: pglite, config, run_id: armed.run_id, source_id: 'default', identity, locators: [locator] });
    await recordLearningAuthority({ engine: pglite, config, run_id: armed.run_id, source_id: 'default', identity, authority: 'direct_user', locators: [locator] });
    return { root, canonicalRoot, slug, config, armed, identity };
  });
}

describe('Learning Loop mode-transition recovery', () => {
  test('persists one exact intent before canonical work and recovers it idempotently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'learning-loop-recovery-'));
    const engine = fakeEngine();
    const config = { database_path: join(root, 'brain') } as never;
    const ledgerOpts = opts(root);
    try {
      await setLearningLoopMode(engine, config, 'canary', ledgerOpts);
      const armed = await armLearningLoop({
        command_id: 'arm-recovery-v1',
        engine,
        authorized_adapter: { client_id: 'recovery-test', source_id: 'source', provider: 'codex' },
        destination: { source_id: 'source', canonical_slug: 'topics/recovery' },
      }, ledgerOpts);

      let intentAtCrash: string | null = null;
      await expect(setLearningLoopMode(engine, config, 'off', {
        ...ledgerOpts,
        afterIntentPersist: () => {
          intentAtCrash = null;
          return engine.getConfig('learning_loop.mode_transition_intent_v1').then(value => { intentAtCrash = value; throw new Error('simulated process exit'); });
        },
      })).rejects.toThrow('simulated process exit');
      expect(await engine.getConfig('learning_loop.mode')).toBe('canary');
      expect(intentAtCrash).not.toBeNull();
      expect(await engine.getConfig('learning_loop.mode_transition_intent_v1')).toBe(intentAtCrash);
      expect(readLearningLoopLedger(ledgerOpts).filter(event => event.event_type === 'run_aborted')).toHaveLength(0);

      const recovered = await setLearningLoopMode(engine, config, 'off', ledgerOpts);
      expect(recovered).toEqual({ previous_mode: 'canary', mode: 'off' });
      expect(await engine.getConfig('learning_loop.mode_transition_intent_v1')).toBeNull();
      const terminal = readLearningLoopLedger(ledgerOpts).filter(event => event.event_type === 'run_aborted');
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ run_id: armed.run_id, reason: 'mode_changed' });

      const retry = await setLearningLoopMode(engine, config, 'off', ledgerOpts);
      expect(retry).toEqual({ previous_mode: 'off', mode: 'off' });
      expect(readLearningLoopLedger(ledgerOpts).filter(event => event.event_type === 'run_aborted')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('drains a canonical pending transition before delivering one exact terminal event', async () => {
    const fixture = await v2Fixture('pending');
    try {
      await withEnv({ GBRAIN_HOME: fixture.root }, async () => {
        const path = join(fixture.canonicalRoot, `${fixture.slug}.md`);
        await expect(activateLearningClaim({
          engine: pglite, config: fixture.config, run_id: fixture.armed.run_id, source_id: 'default', canonical_slug: fixture.slug,
          identity: fixture.identity, authority: 'direct_user', afterCanonicalStage: () => { throw new Error('simulated activation exit'); },
        })).rejects.toThrow('simulated activation exit');
        expect(parseLearningLoopFence(readFileSync(path, 'utf8'))?.value.pending_delivery).not.toBeNull();
        expect(readLearningLoopLedger({ config: fixture.config }).filter(event => event.event_type === 'learning_transition')).toHaveLength(0);

        await expect(setLearningLoopMode(pglite, fixture.config, 'off', { config: fixture.config })).resolves.toEqual({ previous_mode: 'canary', mode: 'off' });
        expect(await pglite.getConfig('learning_loop.mode_transition_intent_v1')).toBeNull();
        expect(parseLearningLoopFence(readFileSync(path, 'utf8'))?.value.pending_delivery).toBeNull();
        const events = readLearningLoopLedger({ config: fixture.config });
        expect(events.filter(event => event.event_type === 'learning_transition')).toHaveLength(1);
        expect(events.filter(event => event.event_type === 'run_aborted')).toHaveLength(1);
        expect(events.filter(event => event.event_type === 'learning_transition' || event.event_type === 'run_aborted').map(event => event.semantic_sequence)).toEqual([1, 2]);

        await expect(setLearningLoopMode(pglite, fixture.config, 'off', { config: fixture.config })).resolves.toEqual({ previous_mode: 'off', mode: 'off' });
        expect(readLearningLoopLedger({ config: fixture.config }).filter(event => event.event_type === 'run_aborted')).toHaveLength(1);
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  test('retains the exact intent when canonical recovery fails, then resumes after repair', async () => {
    const fixture = await v2Fixture('fallback');
    try {
      await withEnv({ GBRAIN_HOME: fixture.root }, async () => {
        const path = join(fixture.canonicalRoot, `${fixture.slug}.md`);
        const original = readFileSync(path, 'utf8');
        await expect(setLearningLoopMode(pglite, fixture.config, 'off', {
          config: fixture.config,
          afterIntentPersist: () => { writeFileSync(path, 'tampered canonical'); },
        })).rejects.toThrow(/managed|fence|canonical/i);
        expect(await pglite.getConfig('learning_loop.mode')).toBe('off');
        const retained = await pglite.getConfig('learning_loop.mode_transition_intent_v1');
        expect(retained).not.toBeNull();
        expect(readLearningLoopLedger({ config: fixture.config }).filter(event => event.event_type === 'run_aborted')).toHaveLength(0);

        writeFileSync(path, original);
        await expect(setLearningLoopMode(pglite, fixture.config, 'off', { config: fixture.config })).resolves.toEqual({ previous_mode: 'off', mode: 'off' });
        expect(await pglite.getConfig('learning_loop.mode_transition_intent_v1')).toBeNull();
        expect(readLearningLoopLedger({ config: fixture.config }).filter(event => event.event_type === 'run_aborted')).toHaveLength(1);
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);
});
