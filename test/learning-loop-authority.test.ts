import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyTranscript,
  activateLearningClaim,
  armLearningLoop,
  bindLearningLoopSession,
  isActivatableClass,
  isCandidateOnlyClass,
  makeExactEventRecordV1,
  parseAuthoritativeUserRows,
  qualifiesByRepetition,
  readLearningLoopLedger,
  recordLearningAuthority,
  recordLearningCandidate,
  recordSessionEvaluation,
  replayLearningLoop,
  resolveAuthoritativeTranscript,
  resolveAuthoritativeUserRow,
  resolveCodexCorpusBinding,
  validateExactEventSequence,
  validateLearningClaimIdentity,
  setLearningLoopMode,
  type AdapterIdentity,
  type TranscriptReceipt,
} from '../src/core/learning-loop.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { makeLearningClaimIdentity, parseLearningLoopFence, renderLearningLoopFence, type LearningLoopKnowledge } from '../src/core/learning-loop-knowledge.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeBrainIdFromConfig } from '../src/core/upgrade-checkpoint.ts';
import { withEnv } from './helpers/with-env.ts';

const adapter: AdapterIdentity = { client_id: 'authority-test', source_id: 'personal', provider: 'codex' };
const noLock = async <T>(work: () => Promise<T>): Promise<T> => work();
const testEngine = {} as BrainEngine;
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const opts = (root: string) => ({ root, mutationLock: noLock, lifecycleLock: noLock });
const claim = 'I prefer tea';
let activationEngine: PGLiteEngine;

beforeAll(async () => {
  activationEngine = new PGLiteEngine();
  await activationEngine.connect({ type: 'pglite' } as never);
  await activationEngine.initSchema();
}, 60_000);

afterAll(async () => { await activationEngine.disconnect(); }, 60_000);
function identity() {
  return makeLearningClaimIdentity({ claim, class: 'preference', scope: { kind: 'global' }, target: null, trigger: null });
}
function transcript(session: string): string {
  const at = '2026-08-31T00:00:00.000Z';
  const rows = [
    { type: 'session_meta', payload: { id: session } },
    { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: claim }] } },
    { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(180) }] } },
    { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'unrelated user text' }] } },
    { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'y'.repeat(180) }] } },
    { type: 'event_msg', payload: { type: 'task_complete', completed_at: at } },
  ];
  return rows.map(row => JSON.stringify({ timestamp: at, ...row })).join('\n') + '\n';
}
function corpusEngine(root: string): Pick<BrainEngine, 'getConfig'> {
  return { getConfig: async (key: string) => ({
    'learning_loop.mode': 'canary',
    'learning_loop.corpus.codex.root': root,
    'learning_loop.corpus.codex.source_id': 'personal',
  } as Record<string, string>)[key] ?? null };
}

async function preparedActivation(base: string, suffix: string) {
  const canonicalRoot = join(base, `canonical-${suffix}`);
  const corpusRoot = join(base, `corpus-${suffix}`);
  const brainHome = join(base, `home-${suffix}`);
  const slug = `topics/preference-${suffix}`;
  mkdirSync(join(canonicalRoot, 'topics'), { recursive: true });
  mkdirSync(corpusRoot, { recursive: true });
  mkdirSync(brainHome, { recursive: true });
  const config = { database_path: join(base, `brain-${suffix}`) } as never;
  const brainId = computeBrainIdFromConfig(config);
  const initialKnowledge: LearningLoopKnowledge = {
    brain_id: brainId, source_id: 'default', canonical_slug: slug,
    managed_rows: {}, blocked_identities: [], correction_lineages: {},
    reversal_attempts: {}, immutable_commit_markers: [], pending_delivery: null,
  };
  const initialCanonical = `---\ntype: concept\ntitle: Preference ${suffix}\nslug: ${slug}\n---\n\n# Preference ${suffix}\n\n${renderLearningLoopFence(initialKnowledge)}\n`;
  writeFileSync(join(canonicalRoot, `${slug}.md`), initialCanonical);
  await activationEngine.executeRaw('DELETE FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]);
  await activationEngine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [canonicalRoot, 'default']);
  await setLearningLoopMode(activationEngine, config, 'canary', { config });
  await activationEngine.setConfig('learning_loop.corpus.codex.root', corpusRoot);
  await activationEngine.setConfig('learning_loop.corpus.codex.source_id', 'default');
  const session = `activation-${suffix}`;
  const body = transcript(session);
  writeFileSync(join(corpusRoot, `${session}.jsonl`), body);
  const loopAdapter: AdapterIdentity = { client_id: 'authority-activation-test', source_id: 'default', provider: 'codex' };
  const loopOpts = { config };
  const armed = await armLearningLoop({
    command_id: `arm:${suffix}`, engine: activationEngine, config,
    authorized_adapter: loopAdapter, destination: { source_id: 'default', canonical_slug: slug }, contract_version: 2,
  }, loopOpts);
  await bindLearningLoopSession(activationEngine, `bind:${suffix}`, loopAdapter, session, loopOpts);
  const receipt = await resolveAuthoritativeTranscript({ engine: activationEngine, config, provider: 'codex', provider_session_id: session, source_id: 'default' });
  await recordSessionEvaluation({ engine: activationEngine, mode: 'canary', adapter: loopAdapter, receipt }, loopOpts);
  const row = parseAuthoritativeUserRows(body, session, receipt.content_hash)[0];
  const locator = { provider_session_id: session, line: row.line, message_index: row.message_index, message_hash: row.message_hash };
  const claimIdentity = makeLearningClaimIdentity({ claim, class: 'preference', scope: { kind: 'global' }, target: null, trigger: null });
  await recordLearningCandidate({ engine: activationEngine, config, run_id: armed.run_id, source_id: 'default', identity: claimIdentity, locators: [locator] });
  await recordLearningAuthority({ engine: activationEngine, config, run_id: armed.run_id, source_id: 'default', identity: claimIdentity, authority: 'direct_user', locators: [locator] });
  return { brainHome, canonicalRoot, slug, config, armed, claimIdentity };
}

describe('Phase 4 authority foundations', () => {
  test('only user rows become stable evidence', () => {
    const rows = parseAuthoritativeUserRows('{"role":"assistant","text":"ignore"}\n{"role":"user","text":"keep"}\nnot-json', 's1', 'a'.repeat(64));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ role:'user', line:2, provider_session_id:'s1' });
  });
  test('class activation policy and distinct-session repetition are deterministic', () => {
    expect(isActivatableClass('preference')).toBe(true); expect(isActivatableClass('friction')).toBe(false); expect(isCandidateOnlyClass('business_candidate')).toBe(true);
    expect(qualifiesByRepetition([{identity_hash:'a',provider_session_id:'s1',eligible:true},{identity_hash:'a',provider_session_id:'s1',eligible:true}])).toBe(false);
    expect(qualifiesByRepetition([{identity_hash:'a',provider_session_id:'s1',eligible:true},{identity_hash:'a',provider_session_id:'s2',eligible:true}])).toBe(true);
    expect(qualifiesByRepetition([{identity_hash:'a',provider_session_id:'s1',eligible:true},{identity_hash:'b',provider_session_id:'s2',eligible:true}])).toBe(false);
  });
  test('eligibility remains structural and fail-closed', () => { expect(classifyTranscript({provider:'codex',provider_session_id:'s',relative_path:'s',completed_at:'2026-01-01T00:00:00.000Z',content_hash:'a'.repeat(64),size_bytes:10,user_turn_count:2,assistant_turn_count:2}).eligible).toBe(false); });

  test('candidate and authority derive evidence from frozen user bytes, not caller-supplied rows', async () => {
    const root = temp('learning-loop-authority-');
    const corpus = temp('learning-loop-authority-corpus-');
    const session = 'authority-session';
    try {
      await withEnv({ GBRAIN_HOME: root }, async () => {
      const body = transcript(session);
      writeFileSync(join(corpus, `${session}.jsonl`), body);
      const engine = corpusEngine(corpus) as BrainEngine;
      const receipt: TranscriptReceipt = await resolveAuthoritativeTranscript({ engine, provider: 'codex', provider_session_id: session, source_id: 'personal' });
      const binding = await resolveCodexCorpusBinding(engine, 'personal');
      const rows = parseAuthoritativeUserRows(body, session, receipt.content_hash);
      const good = { provider_session_id: session, line: rows[0].line, message_index: rows[0].message_index, message_hash: rows[0].message_hash };
      const forged = { ...good, line: rows[1].line, message_index: rows[1].message_index, message_hash: rows[1].message_hash };
      const unrelated = await resolveAuthoritativeUserRow({ engine, expected_corpus_binding: binding, source_id: 'personal', locator: forged });
      expect(unrelated.row.text).not.toBe(claim);
      await expect(resolveAuthoritativeUserRow({ engine, expected_corpus_binding: binding, source_id: 'personal', locator: good })).resolves.toMatchObject({ row: { text: claim } });
      writeFileSync(join(corpus, `${session}.jsonl`), body.replace(claim, 'I prefer coffee'));
      await expect(resolveAuthoritativeTranscript({ engine, provider: 'codex', provider_session_id: session, source_id: 'personal' })).resolves.toMatchObject({ provider_session_id: session });
      // The accepted session hash is frozen in the ledger; reusing its old locator must fail.
      await expect(resolveAuthoritativeUserRow({ engine, expected_corpus_binding: binding, source_id: 'personal', locator: good })).rejects.toMatchObject({ code: 'assertion_mismatch' });
      expect(binding.source_id).toBe('personal');
      });
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(corpus, { recursive: true, force: true }); }
  });

  test('exact replay rejects envelope, payload, hash, and sequence identity drift', () => {
    const payload = { schema_version: 1, event_type: 'learning_transition', brain_id: 'brain', run_id: 'run', occurred_at: '2026-01-01T00:00:00.000Z', semantic_sequence: 1 };
    const record = makeExactEventRecordV1({ event_payload: payload, brain_id: 'brain', run_id: 'run', occurred_at: payload.occurred_at, semantic_sequence: 1 });
    expect(() => validateExactEventSequence([record])).not.toThrow();
    expect(() => validateExactEventSequence([record, record])).toThrow(/duplicate/);
    expect(() => validateExactEventSequence([{ ...record, semantic_sequence: 2 }])).toThrow(/disagree|contiguous/);
    expect(() => validateExactEventSequence([{ ...record, event_payload_sha256: '0'.repeat(64) }])).toThrow(/hash/);
    expect(() => validateExactEventSequence([{ ...record, run_id: 'other' }])).toThrow(/disagree/);
  });

  test('replay rejects a self-consistent learning transition with an extra field', () => {
    const payload = {
      schema_version: 1, event_type: 'learning_transition', transition_version: 1,
      brain_id: 'brain', run_id: 'run', semantic_sequence: 1,
      source_id: 'personal', canonical_slug: 'personal/preferences', transition: 'activate',
      identity: identity(), authority: 'direct_user', fact_row: 1, occurred_at: '2026-01-01T00:00:00.000Z',
      unexpected: 'caller-evidence',
    };
    const record = makeExactEventRecordV1({ event_payload: payload, brain_id: 'brain', run_id: 'run', occurred_at: payload.occurred_at, semantic_sequence: 1 });
    expect(() => replayLearningLoop([record as never])).toThrow(/unknown|variant|ledger/i);
  });

  test('activation retries recover each canonical delivery crash seam exactly once', async () => {
    const base = temp('learning-loop-activation-recovery-');
    const cases = [
      { suffix: 'after-stage', hook: 'afterCanonicalStage', pending: true, delivered: 0 },
      { suffix: 'after-append', hook: 'afterLedgerAppend', pending: true, delivered: 1 },
      { suffix: 'after-clear', hook: 'afterCanonicalClear', pending: false, delivered: 1 },
    ] as const;
    try {
      for (const crash of cases) {
        await withEnv({ GBRAIN_HOME: join(base, `home-${crash.suffix}`) }, async () => {
          const fixture = await preparedActivation(base, crash.suffix);
          const activation = {
            engine: activationEngine, config: fixture.config, run_id: fixture.armed.run_id,
            source_id: 'default', canonical_slug: fixture.slug,
            identity: fixture.claimIdentity, authority: 'direct_user' as const,
          };
          await expect(activateLearningClaim({
            ...activation,
            [crash.hook]: () => { throw new Error(`simulated crash ${crash.suffix}`); },
          })).rejects.toThrow(`simulated crash ${crash.suffix}`);

          const path = join(fixture.canonicalRoot, `${fixture.slug}.md`);
          const interrupted = parseLearningLoopFence(readFileSync(path, 'utf8'))!;
          expect(interrupted.value.pending_delivery !== null).toBe(crash.pending);
          expect(readLearningLoopLedger({ config: fixture.config }).filter(event => event.event_type === 'learning_transition')).toHaveLength(crash.delivered);

          const recovered = await activateLearningClaim(activation);
          const canonical = readFileSync(path, 'utf8');
          const fence = parseLearningLoopFence(canonical)!;
          expect(fence.value.pending_delivery).toBeNull();
          expect(fence.value.managed_rows[fixture.claimIdentity.claim_fingerprint!]).toMatchObject({ identity: fixture.claimIdentity, active: true, run_id: fixture.armed.run_id });
          const transitions = readLearningLoopLedger({ config: fixture.config }).filter(event => event.event_type === 'learning_transition');
          expect(transitions).toHaveLength(1);
          expect(recovered.event.event_id).toBe(transitions[0].event_id);
          const page = await activationEngine.getPage(fixture.slug, { sourceId: 'default' });
          expect(page?.compiled_truth).toContain(claim);
          expect(canonical).toContain(claim);
        });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  test('claim identity rejects malformed scope, target, and trigger vectors', () => {
    const valid = identity();
    expect(() => validateLearningClaimIdentity(valid)).not.toThrow();
    for (const bad of [
      { ...valid, scope: { kind: 'repository' } },
      { ...valid, scope: { kind: 'unknown', target: 'x' } },
      { ...valid, scope: { kind: 'project', target: 'acme project' }, target: 'acme project' },
      { ...valid, target: 7 },
      { ...valid, trigger: { kind: 'job', id: 'x', state: 'done' } },
      { ...valid, claim_fingerprint: '0'.repeat(64) },
    ]) expect(() => validateLearningClaimIdentity(bad)).toThrow(/canonical|identity/);
  });
});
