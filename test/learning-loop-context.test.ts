import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildContextBundle, contextRequestHash, makeContextSuppliedTelemetry, normalizeContextRequest, type ContextRequestV1 } from '../src/core/learning-loop-context.ts';
import { completeLearningLoopContextEvent, replayLearningLoop } from '../src/core/learning-loop.ts';
import { encodeLearningLoopKnowledge, learningBlockedClaimKey, makeLearningClaimIdentity, type LearningClaimIdentity } from '../src/core/learning-loop-knowledge.ts';

const base: ContextRequestV1 = { version: 1, run_id: 'run-1', provider: 'codex', provider_session_id: 'session-1', brain_id: 'brain-a', source_id: 'personal', scope: { kind: 'repository', target: 'repo:github.com/acme/repo' }, forge_repository: 'github.com/acme/repo', project: null, task_class: 'coding', relevance_window: ['Fix parser\r\n', 'Keep scope explicit'] };
type Row = { identity: LearningClaimIdentity; active?: boolean; display?: string; context?: string };
const identity = (claim: string, cls: LearningClaimIdentity['class'] = 'preference', scope = base.scope, trigger: LearningClaimIdentity['trigger'] = null) => makeLearningClaimIdentity({ claim, class: cls, scope, target: scope.kind === 'global' ? null : scope.target, trigger });
function page(rows: Row[], opts: { brain?: string; source?: string; slug?: string; blocked?: string[]; malformed?: boolean } = {}) {
  const brain_id = opts.brain ?? 'brain-a'; const source_id = opts.source ?? 'personal'; const canonical_slug = opts.slug ?? 'personal/preferences';
  const managed_rows = Object.fromEntries(rows.map((row, index) => [row.identity.claim_fingerprint!, { identity: row.identity, row_num: index + 1, active: row.active ?? true, run_id: 'run-1' }]));
  const state = { brain_id, source_id, canonical_slug, managed_rows, blocked_identities: opts.blocked ?? [], correction_lineages: {}, reversal_attempts: {}, immutable_commit_markers: [], pending_delivery: null };
  const table = rows.map((row, index) => `| ${index + 1} | ${row.display ?? row.identity.claim} | preference | 1 | private | high | 2026-01-01 | | learning | ${row.context ?? ''} |`).join('\n');
  const facts = `# Personal\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n${table}\n<!--- gbrain:facts:end -->`;
  const encoded = encodeLearningLoopKnowledge(state);
  return { brain_id, source_id, canonical_slug, content: `${facts}\n<!-- gbrain:learning-loop:v1:begin -->\n${opts.malformed ? encoded.slice(1) : encoded}\n<!-- gbrain:learning-loop:v1:end -->` };
}

describe('Personal Learning Loop PR3 context request', () => {
  test('uses literal canonical hash vectors and normalizes Unicode/newlines', () => {
    expect(contextRequestHash(base)).toBe('cc5ea7ec58319a33524b85d4ef4d13a49ded0bdddf9ec250e0395bcfbb980719');
    expect(contextRequestHash({ ...base, relevance_window: ['Fix parser\n', 'Keep scope explicit'] })).toBe(contextRequestHash(base));
    expect(contextRequestHash({ ...base, task_class: 'caf\u00e9' })).toBe(contextRequestHash({ ...base, task_class: 'cafe\u0301' }));
    const project: ContextRequestV1 = { ...base, scope: { kind: 'project', target: 'project:alpha' }, forge_repository: null, project: 'project:alpha' };
    expect(contextRequestHash(project)).toBe('11464d8772cc19f996f967b6024fcc2d4f0c8fcec36d1a78031c3e5d73d29643');
  });

  test('fails closed on missing, malformed, contradictory, and overflowing input', () => {
    expect(() => normalizeContextRequest({ ...base, version: 2 as 1 })).toThrow();
    const missing = { ...base } as Record<string, unknown>; delete missing.project;
    expect(() => normalizeContextRequest(missing as unknown as ContextRequestV1)).toThrow();
    expect(() => normalizeContextRequest({ ...base, project: 'project:alpha' })).toThrow();
    expect(() => normalizeContextRequest({ ...base, scope: { kind: 'repository', target: 'repo:gitlab.com/acme/repo' } })).toThrow();
    expect(() => normalizeContextRequest({ ...base, relevance_window: Array(5).fill('x') })).toThrow();
    expect(() => normalizeContextRequest({ ...base, relevance_window: ['x'.repeat(2_001)] })).toThrow();
  });

  test('uses only explicit request fields and never ambient identity', () => {
    const source = readFileSync(join(import.meta.dir, '../src/core/learning-loop-context.ts'), 'utf8');
    const operation = readFileSync(join(import.meta.dir, '../src/core/operations.ts'), 'utf8').split('const learning_loop_request_context_v1')[1]!.split('const learning_loop_candidate')[0]!;
    expect(source).not.toContain('process.env'); expect(source).not.toContain('cwd('); expect(source).not.toContain('.git');
    expect(operation).not.toContain('getPage('); expect(operation).not.toContain('process.env'); expect(operation).not.toContain('cwd(');
    expect(operation).toContain('assertRootBindingUnchanged'); expect(operation).toContain('readFileSync');
    expect(operation).toContain('input.source_id !== auth.sourceId');
    expect(operation.indexOf('withCanonicalSourceBoundary')).toBeLessThan(operation.indexOf('withLearningLoopLedgerMutation'));
  });
});

describe('Personal Learning Loop PR3 retrieval and telemetry', () => {
  test('includes global and exact repository scope, but excludes wrong brain, forge, repository, and project', () => {
    const global = identity('Always protect secrets', 'constraint', { kind: 'global' }); const exact = identity('Keep coding scope explicit');
    const wrongRepo = identity('Keep coding scope for other repo', 'lesson', { kind: 'repository', target: 'repo:github.com/acme/other' });
    const wrongForge = identity('Keep coding scope on other forge', 'lesson', { kind: 'repository', target: 'repo:gitlab.com/acme/repo' });
    const wrongProject = identity('Keep coding scope in project', 'lesson', { kind: 'project', target: 'project:alpha' });
    const bundle = buildContextBundle(base, [page([global, exact, wrongRepo, wrongForge, wrongProject].map((i) => ({ identity: i }))), page([{ identity: exact }], { brain: 'brain-b' })], 'personal');
    expect(bundle.items.map((item) => item.claim)).toEqual(['Always protect secrets', 'Keep coding scope explicit']);
  });

  test('excludes unauthorized, inactive, blocked, superseded, malformed, unrelated, and terminal loop state', () => {
    const blocked = identity('Keep coding blocked', 'lesson'); const inactive = identity('Keep coding inactive', 'goal');
    const superseded = identity('Keep coding superseded', 'lesson'); const unrelated = identity('Prefer watercolor', 'preference'); const friction = identity('Coding caused friction', 'friction');
    const pending = identity('Fix coding parser', 'open_loop', base.scope, { kind: 'task', id: 'loop-1', state: 'pending' });
    const p = page([{ identity: blocked }, { identity: inactive, active: false, display: '~~Keep coding inactive~~' }, { identity: superseded, active: false, display: '~~Keep coding superseded~~', context: 'superseded by #1' }, { identity: unrelated }, { identity: friction }, { identity: pending }], { blocked: [learningBlockedClaimKey(blocked)] });
    expect(() => buildContextBundle(base, [p], 'other')).toThrow('authorization');
    expect(buildContextBundle(base, [p, page([{ identity: pending }], { malformed: true })], 'personal').items.map((item) => item.claim)).toEqual(['Fix coding parser']);
    const terminal = structuredClone(p); terminal.content = terminal.content.replace('"state":"pending"', '"state":"completed"');
    expect(buildContextBundle(base, [terminal], 'personal').items).toEqual([]);
  });

  test('orders classes, caps five items and 800 tokens, and returns at most one pending loop', () => {
    const rows = [identity('Coding constraint', 'constraint'), identity('Coding goal', 'goal'), identity('Coding lesson', 'lesson'), identity('Coding preference', 'preference'), identity('Coding loop one', 'open_loop', base.scope, { kind: 'task', id: 'one', state: 'pending' }), identity('Coding loop two', 'open_loop', base.scope, { kind: 'task', id: 'two', state: 'pending' }), identity(`Coding ${'x'.repeat(3_196)}`, 'constraint')];
    const bundle = buildContextBundle(base, [page(rows.map((i) => ({ identity: i })))], 'personal');
    expect(bundle.items.map((item) => item.class)).toEqual(['constraint', 'goal', 'lesson', 'preference', 'open_loop']);
    expect(bundle.items).toHaveLength(5); expect(bundle.token_estimate).toBeLessThanOrEqual(800);
    expect(bundle.items.filter((item) => item.class === 'open_loop')).toHaveLength(1);
    expect(bundle.items.some((item) => item.claim.length > 3_000)).toBe(false);
  });

  test('emits exact pointer/claim telemetry without request text and replays deterministically', () => {
    const p = page([{ identity: identity('Keep coding changes small') }]);
    const bundle = buildContextBundle(base, [p], 'personal'); expect(buildContextBundle(base, [p], 'personal')).toEqual(bundle);
    const telemetry = makeContextSuppliedTelemetry(base, bundle);
    expect(telemetry.pointers).toEqual(bundle.items.map((item) => item.pointer)); expect(telemetry.claims[0]?.claim_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(telemetry.item_count).toBe(bundle.items.length); expect(telemetry.token_estimate).toBe(bundle.token_estimate);
    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain('Fix parser'); expect(serialized).not.toContain('Keep coding changes small'); expect(serialized).not.toContain('relevance_window');
  });

  test('context telemetry is content-hashed evidence outside semantic ordering', () => {
    const bundle = buildContextBundle(base, [page([{ identity: identity('Keep coding changes small') }])], 'personal');
    const telemetry = makeContextSuppliedTelemetry(base, bundle);
    const event = completeLearningLoopContextEvent({
      schema_version: 1, ...telemetry, brain_id: base.brain_id, source_id: base.source_id, occurred_at: '2026-01-01T00:00:00.000Z',
    });
    expect(event).not.toHaveProperty('semantic_sequence');
    expect(event.event_id).toMatch(/^[a-f0-9]{64}$/);
    expect(completeLearningLoopContextEvent({
      schema_version: 1, ...telemetry, brain_id: base.brain_id, source_id: base.source_id, occurred_at: '2026-01-01T00:00:00.000Z',
    })).toEqual(event);
    expect(() => replayLearningLoop([{ ...event, semantic_sequence: 1 } as never])).toThrow();
  });
});
