import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  learningBlockedClaimKey,
  reduceLearningLoopLineage,
  replacementSetFingerprint,
  type LearningLoopKnowledge,
  makeLearningClaimIdentity, parseLearningLoopFence, renderLearningLoopFence,
} from '../src/core/learning-loop-knowledge.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { armLearningLoop, bindLearningLoopSession, correctLearningClaim, activateLearningClaim, reverseLearningClaim, recordLearningAuthority, recordLearningCandidate, recordSessionEvaluation, resolveAuthoritativeTranscript, parseAuthoritativeUserRows, setLearningLoopMode, readLearningLoopLedger, type AdapterIdentity } from '../src/core/learning-loop.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { computeBrainIdFromConfig } from '../src/core/upgrade-checkpoint.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { withEnv } from './helpers/with-env.ts';

const base: LearningLoopKnowledge = {
  brain_id: 'brain', source_id: 'personal', canonical_slug: 'topics/example',
  managed_rows: {}, blocked_identities: [], correction_lineages: {}, reversal_attempts: {},
  immutable_commit_markers: [], pending_delivery: null,
};
const identity = (claim: string) => ({ claim, class: 'preference' as const, scope: { kind: 'global' as const }, target: null, trigger: null });
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ type: 'pglite' } as never); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

async function fixture(suffix: string) {
  const root = mkdtempSync(join(tmpdir(), `learning-correction-${suffix}-`));
  return withEnv({ GBRAIN_HOME: root }, async () => {
    const canonicalRoot = join(root, 'canonical'); const corpusRoot = join(root, 'corpus'); mkdirSync(join(canonicalRoot, 'topics'), { recursive: true }); mkdirSync(corpusRoot, { recursive: true });
    const config = { database_path: join(root, 'brain') } as never; const brainId = computeBrainIdFromConfig(config); const slug = 'topics/correction';
    const initial: LearningLoopKnowledge = { brain_id: brainId, source_id: 'default', canonical_slug: slug, managed_rows: {}, blocked_identities: [], correction_lineages: {}, reversal_attempts: {}, immutable_commit_markers: [], pending_delivery: null };
    writeFileSync(join(canonicalRoot, `${slug}.md`), `---\ntype: concept\ntitle: Correction\nslug: ${slug}\n---\n\n# Correction\n\n${renderLearningLoopFence(initial)}\n`);
    await engine.executeRaw('DELETE FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]); await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [canonicalRoot, 'default']); await setLearningLoopMode(engine, config, 'canary', { config }); await engine.setConfig('learning_loop.corpus.codex.root', corpusRoot); await engine.setConfig('learning_loop.corpus.codex.source_id', 'default');
    const session = `correction-${suffix}`; const at = '2026-08-31T00:00:00.000Z'; const body = [{ timestamp: at, type: 'session_meta', payload: { id: session } }, ...['A','B'].flatMap(claim => [{ timestamp: at, type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: claim }] } }, { timestamp: at, type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(180) }] } }]), { timestamp: at, type: 'event_msg', payload: { type: 'task_complete', completed_at: at } }].map(row => JSON.stringify(row)).join('\n') + '\n'; writeFileSync(join(corpusRoot, `${session}.jsonl`), body);
    const adapter: AdapterIdentity = { client_id: 'correction-test', source_id: 'default', provider: 'codex' }; const armed = await armLearningLoop({ command_id: `arm:${suffix}`, engine, config, authorized_adapter: adapter, destination: { source_id: 'default', canonical_slug: slug }, contract_version: 2 }); await bindLearningLoopSession(engine, `bind:${suffix}`, adapter, session, { config }); const receipt = await resolveAuthoritativeTranscript({ engine, config, provider: 'codex', provider_session_id: session, source_id: 'default' }); await recordSessionEvaluation({ engine, mode: 'canary', adapter, receipt }, { config }); const rows = parseAuthoritativeUserRows(body, session, receipt.content_hash);
    const make = (claim: string, row: typeof rows[number]) => makeLearningClaimIdentity({ claim, class: 'preference', scope: { kind: 'global' }, target: null, trigger: null }); const a = make('A', rows[0]); const b = make('B', rows[1]); const loc = (row: typeof rows[number]) => ({ provider_session_id: session, line: row.line, message_index: row.message_index, message_hash: row.message_hash });
    await recordLearningCandidate({ engine, config, run_id: armed.run_id, source_id: 'default', identity: a, locators: [loc(rows[0])] }); await recordLearningAuthority({ engine, config, run_id: armed.run_id, source_id: 'default', identity: a, authority: 'direct_user', locators: [loc(rows[0])] });
    return { root, config, canonicalRoot, slug, armed, a, b, bLocator: loc(rows[1]) };
  });
}

type CorrectionFixture = Awaited<ReturnType<typeof fixture>>;

async function authorizeReplacement(f: CorrectionFixture): Promise<void> {
  await recordLearningCandidate({ engine, config: f.config, run_id: f.armed.run_id, source_id: 'default', identity: f.b, locators: [f.bLocator] });
  await recordLearningAuthority({ engine, config: f.config, run_id: f.armed.run_id, source_id: 'default', identity: f.b, authority: 'direct_user', locators: [f.bLocator] });
}

function correctionInput(f: CorrectionFixture) {
  return { engine, config: f.config, run_id: f.armed.run_id, source_id: 'default', canonical_slug: f.slug, predecessor: f.a, replacement: f.b, authority: 'direct_user' as const };
}

function canonicalPath(f: CorrectionFixture): string {
  return join(f.canonicalRoot, `${f.slug}.md`);
}

describe('Phase 5 correction lineage reducer', () => {
  test('correction blocks predecessor, keeps replacement active, sorts pointers, and advances once', () => {
    const predecessor = identity('A');
    const replacement = identity('B');
    const result = reduceLearningLoopLineage(base, {
      kind: 'correct', predecessor,
      replacement: { identity: learningBlockedClaimKey(replacement), canonical_slug: base.canonical_slug, row_num: 2 },
    });
    const key = learningBlockedClaimKey(predecessor);
    const lineage = result.next.correction_lineages[key] as any;
    expect(result.next.blocked_identities).toEqual([key]);
    expect(lineage.lineage_generation).toBe(1);
    expect(lineage.active_replacements).toHaveLength(1);
    expect(lineage.replacement_set_fingerprint).toBe(replacementSetFingerprint(lineage.active_replacements));
    expect(result.permit.previous_hash).not.toBe(result.permit.next_hash);
  });

  test('repeating the same correction is idempotent and does not advance generation', () => {
    const predecessor = identity('A');
    const replacement = { identity: learningBlockedClaimKey(identity('B')), canonical_slug: base.canonical_slug, row_num: 2 };
    const first = reduceLearningLoopLineage(base, { kind: 'correct', predecessor, replacement });
    const second = reduceLearningLoopLineage(first.next, { kind: 'correct', predecessor, replacement });
    const key = learningBlockedClaimKey(predecessor);
    expect((second.next.correction_lineages[key] as any).active_replacements).toHaveLength(1);
    expect((second.next.correction_lineages[key] as any).lineage_generation).toBe(1);
  });

  test('activation then correction retires A and leaves exactly B in the active replacement set', () => {
    const a = identity('A');
    const b = identity('B');
    const aKey = learningBlockedClaimKey(a);
    const bKey = learningBlockedClaimKey(b);
    const activated = reduceLearningLoopLineage(base, { kind: 'activate', identity: a, pointer: { identity: aKey, canonical_slug: base.canonical_slug, row_num: 1 } });
    const corrected = reduceLearningLoopLineage(activated.next, { kind: 'correct', predecessor: a, replacement: { identity: bKey, canonical_slug: base.canonical_slug, row_num: 2 } });
    const lineage = corrected.next.correction_lineages[aKey] as any;
    expect(lineage.active_replacements).toEqual([{ identity: bKey, canonical_slug: base.canonical_slug, row_num: 2 }]);
    expect(lineage.replacement_set_fingerprint).toBe(replacementSetFingerprint(lineage.active_replacements));
    expect(lineage.lineage_generation).toBe(2);
    expect(corrected.next.blocked_identities).toEqual([aKey]);
  });

  test('linked replacement correction propagates through ancestor lineages', () => {
    const a = identity('A');
    const b = identity('B');
    const c = identity('C');
    const aKey = learningBlockedClaimKey(a);
    const bKey = learningBlockedClaimKey(b);
    const cKey = learningBlockedClaimKey(c);
    const activated = reduceLearningLoopLineage(base, {
      kind: 'activate', identity: a,
      pointer: { identity: aKey, canonical_slug: base.canonical_slug, row_num: 1 },
    });
    const correctedAB = reduceLearningLoopLineage(activated.next, {
      kind: 'correct', predecessor: a,
      replacement: { identity: bKey, canonical_slug: base.canonical_slug, row_num: 2 },
    });
    const correctedBC = reduceLearningLoopLineage(correctedAB.next, {
      kind: 'correct', predecessor: b,
      replacement: { identity: cKey, canonical_slug: base.canonical_slug, row_num: 3 },
    });
    const aLineage = correctedBC.next.correction_lineages[aKey] as any;
    const bLineage = correctedBC.next.correction_lineages[bKey] as any;
    expect(aLineage.active_replacements).toEqual([{ identity: cKey, canonical_slug: base.canonical_slug, row_num: 3 }]);
    expect(aLineage.lineage_generation).toBe(3);
    expect(bLineage.active_replacements).toEqual([{ identity: cKey, canonical_slug: base.canonical_slug, row_num: 3 }]);
    expect(bLineage.lineage_generation).toBe(1);
  });

  test('PGLite activate A then correct A to an authorized B', async () => {
    const f = await fixture('integration');
    try { await withEnv({ GBRAIN_HOME: f.root }, async () => {
      await activateLearningClaim({ engine, config: f.config, run_id: f.armed.run_id, source_id: 'default', canonical_slug: f.slug, identity: f.a, authority: 'direct_user' });
      await authorizeReplacement(f);
      const corrected = await correctLearningClaim(correctionInput(f));
      const fence = parseLearningLoopFence(corrected.canonical)!; const aKey = learningBlockedClaimKey(f.a); const lineage = fence.value.correction_lineages[aKey] as any;
      expect(fence.value.blocked_identities).toContain(aKey); expect(lineage.active_replacements).toEqual([{ identity: learningBlockedClaimKey(f.b), canonical_slug: f.slug, row_num: 2 }]); expect(lineage.lineage_generation).toBe(2);
      expect(parseFactsFence(corrected.canonical).facts).toEqual(expect.arrayContaining([
        expect.objectContaining({ rowNum: 1, claim: 'A', active: false }),
        expect.objectContaining({ rowNum: 2, claim: 'B', active: true }),
      ]));
      expect(readLearningLoopLedger({ config: f.config }).filter(event => event.event_type === 'learning_transition' || event.event_type === 'learning_correction').map(event => event.semantic_sequence)).toEqual([1, 2]);
      await expect(activateLearningClaim({ engine, config: f.config, run_id: f.armed.run_id, source_id: 'default', canonical_slug: f.slug, identity: f.a, authority: 'direct_user' })).rejects.toMatchObject({ code: 'forbidden' });
    }); } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);

  test('PGLite correction delivery crash seams recover once and preserve the block', async () => {
    const cases = [
      { suffix: 'stage', hook: 'afterCanonicalStage', pending: true, delivered: 0 },
      { suffix: 'append', hook: 'afterLedgerAppend', pending: true, delivered: 1 },
      { suffix: 'clear', hook: 'afterCanonicalClear', pending: false, delivered: 1 },
    ] as const;
    for (const crash of cases) {
      const f = await fixture(`crash-${crash.suffix}`);
      try { await withEnv({ GBRAIN_HOME: f.root }, async () => {
        await activateLearningClaim({ engine, config: f.config, run_id: f.armed.run_id, source_id: 'default', canonical_slug: f.slug, identity: f.a, authority: 'direct_user' });
        await authorizeReplacement(f);
        await expect(correctLearningClaim({ ...correctionInput(f), [crash.hook]: () => { throw new Error(`simulated ${crash.suffix}`); } })).rejects.toThrow(`simulated ${crash.suffix}`);
        const interrupted = parseLearningLoopFence(readFileSync(canonicalPath(f), 'utf8'))!;
        expect(interrupted.value.pending_delivery !== null).toBe(crash.pending);
        expect(readLearningLoopLedger({ config: f.config }).filter(event => event.event_type === 'learning_correction')).toHaveLength(crash.delivered);
        const recovered = await correctLearningClaim(correctionInput(f));
        const finalCanonical = readFileSync(canonicalPath(f), 'utf8');
        expect(recovered.canonical).toBe(finalCanonical);
        expect(parseLearningLoopFence(finalCanonical)!.value.pending_delivery).toBeNull();
        expect(parseFactsFence(finalCanonical).facts).toEqual(expect.arrayContaining([
          expect.objectContaining({ rowNum: 1, claim: 'A', active: false }),
          expect.objectContaining({ rowNum: 2, claim: 'B', active: true }),
        ]));
        expect(readLearningLoopLedger({ config: f.config }).filter(event => event.event_type === 'learning_correction')).toHaveLength(1);
        expect((await engine.getPage(f.slug, { sourceId: 'default' }))?.compiled_truth).toContain('B');
      }); } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  }, 60_000);

  test('database rebuild reads exact canonical bytes and cannot reactivate blocked A', async () => {
    const f = await fixture('rebuild');
    try { await withEnv({ GBRAIN_HOME: f.root }, async () => {
      await activateLearningClaim({ engine, config: f.config, run_id: f.armed.run_id, source_id: 'default', canonical_slug: f.slug, identity: f.a, authority: 'direct_user' });
      await authorizeReplacement(f);
      await correctLearningClaim(correctionInput(f));
      const path = canonicalPath(f); const canonical = readFileSync(path, 'utf8');
      await engine.executeRaw('DELETE FROM pages WHERE source_id = $1 AND slug = $2', ['default', f.slug]);
      expect(await engine.getPage(f.slug, { sourceId: 'default' })).toBeNull();
      const rebuilt = await importFromFile(engine, path, 'topics/correction.md', { sourceId: 'default', noEmbed: true });
      expect(rebuilt.status).not.toBe('skipped');
      expect(readFileSync(path, 'utf8')).toBe(canonical);
      const page = await engine.getPage(f.slug, { sourceId: 'default' });
      expect(page?.compiled_truth).toContain('B');
      const rebuiltFence = parseLearningLoopFence(canonical)!;
      expect(rebuiltFence.value.blocked_identities).toContain(learningBlockedClaimKey(f.a));
      await expect(activateLearningClaim({ engine, config: f.config, run_id: f.armed.run_id, source_id: 'default', canonical_slug: f.slug, identity: f.a, authority: 'direct_user' })).rejects.toMatchObject({ code: 'forbidden' });
    }); } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);

  test('PGLite reversal retires the replacement, rebuilds, and reinstates exact direct authority', async () => {
    const f = await fixture('reversal');
    try { await withEnv({ GBRAIN_HOME: f.root }, async () => {
      await activateLearningClaim({ engine, config: f.config, run_id: f.armed.run_id, source_id: 'default', canonical_slug: f.slug, identity: f.a, authority: 'direct_user' });
      await authorizeReplacement(f);
      await correctLearningClaim(correctionInput(f));
      const authority = readLearningLoopLedger({ config: f.config }).find(event => event.event_type === 'learning_authority' && event.identity.claim_fingerprint === f.a.claim_fingerprint);
      expect(authority?.event_id).toBeTruthy();
      const reversed = await reverseLearningClaim({ engine, config: f.config, run_id: f.armed.run_id, source_id: 'default', canonical_slug: f.slug, identity: f.a, authority_event_id: authority!.event_id, root_reversal_id: 'reversal-test' });
      const finalFence = parseLearningLoopFence(reversed.canonical)!;
      const blocked = learningBlockedClaimKey(f.a);
      const lineage = finalFence.value.correction_lineages[blocked] as any;
      expect(reversed.phase).toBe('committed');
      expect(finalFence.value.blocked_identities).not.toContain(blocked);
      expect(lineage.active_replacements).toHaveLength(1);
      expect(lineage.active_replacements[0]).toMatchObject({ identity: blocked, canonical_slug: f.slug });
      expect(parseFactsFence(reversed.canonical).facts).toEqual(expect.arrayContaining([
        expect.objectContaining({ claim: 'A', active: false }),
        expect.objectContaining({ claim: 'B', active: false }),
        expect.objectContaining({ claim: 'A', active: true }),
      ]));
      expect(finalFence.value.reversal_attempts['reversal-test:1']).toMatchObject({ phase: 'committed' });
      const retry = await reverseLearningClaim({ engine, config: f.config, run_id: f.armed.run_id, source_id: 'default', canonical_slug: f.slug, identity: f.a, authority_event_id: authority!.event_id, root_reversal_id: 'reversal-test' });
      expect(retry.phase).toBe('committed');
      expect(retry.canonical).toBe(reversed.canonical);
    }); } finally { rmSync(f.root, { recursive: true, force: true }); }
  }, 60_000);
});
