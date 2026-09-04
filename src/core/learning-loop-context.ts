/** PR3: pure, bounded context selection from canonical personal pages. */
import { createHash } from 'node:crypto';
import { canonicalJson } from './remediation-step.ts';
import { parseFactsFence, type ParsedFact } from './facts-fence.ts';
import { learningClaimFingerprint, parseLearningLoopFence, type LearningClaimIdentity, type LearningLoopKnowledge, type LearningScope, type LearningTrigger } from './learning-loop-knowledge.ts';

export const CONTEXT_REQUEST_VERSION = 1 as const;
export const MAX_RELEVANCE_TURNS = 4;
export const MAX_RELEVANCE_BYTES = 2_000;
export const MAX_CONTEXT_ITEMS = 5;
export const MAX_CONTEXT_TOKENS = 800;

export type ContextScope = LearningScope;
export interface ContextRequestV1 {
  version: 1; run_id: string; provider: 'codex'; provider_session_id: string;
  brain_id: string; source_id: string; scope: ContextScope;
  forge_repository: string | null; project: string | null; task_class: string;
  relevance_window: string[];
}
export type CanonicalContextRequest = Required<Omit<ContextRequestV1, 'version'>> & { version: 1 };
export interface ContextItem {
  pointer: { brain_id: string; source_id: string; canonical_slug: string; row_num: number };
  claim: string; class: Exclude<LearningClaimIdentity['class'], 'business_candidate' | 'friction'>;
  scope: ContextScope; target: string | null; trigger: LearningTrigger;
}
export interface ContextBundle { request_hash: string; items: ContextItem[]; token_estimate: number }
export interface ContextSuppliedTelemetry {
  event_type: 'context_supplied'; version: 1; run_id: string; provider: 'codex';
  provider_session_id: string; request_hash: string;
  pointers: ContextItem['pointer'][];
  claims: Array<{ claim_fingerprint: string; class: ContextItem['class']; scope: ContextScope; target: string | null; trigger: LearningTrigger }>;
  item_count: number; token_estimate: number;
}

function fail(message: string): never { throw new Error(`learning-loop context: ${message}`); }
function clean(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return fail(`${field} is invalid`);
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}
const REPO_RE = /^[^/\s:]+\/[^/\s:]+\/[^/\s:]+$/;
const PROJECT_RE = /^project:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
function scope(value: unknown): ContextScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('scope is invalid');
  const s = value as Record<string, unknown>;
  if (s.kind === 'global' && Object.keys(s).length === 1) return { kind: 'global' };
  if ((s.kind === 'repository' || s.kind === 'project') && typeof s.target === 'string' && Object.keys(s).length === 2) {
    const target = clean(s.target, 'scope.target');
    if (s.kind === 'repository' && REPO_RE.test(target.slice(5)) && target.startsWith('repo:')) return { kind: 'repository', target };
    if (s.kind === 'project' && PROJECT_RE.test(target)) return { kind: 'project', target };
  }
  return fail('scope is ambiguous or malformed');
}
function window(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_RELEVANCE_TURNS) return fail('relevance window exceeds four turns');
  const result = value.map((v) => {
    if (typeof v !== 'string' || !v.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v)) return fail('relevance turn is invalid');
    return v.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  });
  if (Buffer.byteLength(result.join('\n'), 'utf8') > MAX_RELEVANCE_BYTES) return fail('relevance window exceeds 2,000 UTF-8 bytes');
  return result;
}
export function normalizeContextRequest(input: ContextRequestV1): CanonicalContextRequest {
  const v = input as unknown as Record<string, unknown>;
  const allowed = ['version','run_id','provider','provider_session_id','brain_id','source_id','scope','forge_repository','project','task_class','relevance_window'];
  if (Object.keys(v).some((k) => !allowed.includes(k)) || (v.version !== undefined && v.version !== 1)) return fail('request shape or version is invalid');
  if (!Object.prototype.hasOwnProperty.call(v, 'version') || !Object.prototype.hasOwnProperty.call(v, 'forge_repository') || !Object.prototype.hasOwnProperty.call(v, 'project') || (v.forge_repository !== null && typeof v.forge_repository !== 'string') || (v.project !== null && typeof v.project !== 'string')) return fail('request requires explicit version and scope fields');
  if (v.provider !== 'codex') return fail('provider is not authorized');
  const run_id = clean(v.run_id, 'run_id'); const provider_session_id = clean(v.provider_session_id, 'provider_session_id');
  const brain_id = clean(v.brain_id, 'brain_id'); const source_id = clean(v.source_id, 'source_id');
  const selectedScope = scope(v.scope);
  const forge = v.forge_repository == null ? null : clean(v.forge_repository, 'forge_repository');
  const project = v.project == null ? null : clean(v.project, 'project');
  if (selectedScope.kind === 'global' && (forge !== null || project !== null)) return fail('global scope has contradictory target');
  if (selectedScope.kind === 'repository' && (forge === null || project !== null || selectedScope.target !== `repo:${forge}` || !REPO_RE.test(forge))) return fail('repository scope target is contradictory');
  if (selectedScope.kind === 'project' && (project === null || forge !== null || selectedScope.target !== project || !PROJECT_RE.test(project))) return fail('project scope target is contradictory');
  return { version: 1, run_id, provider: 'codex', provider_session_id, brain_id, source_id, scope: selectedScope, forge_repository: forge, project, task_class: clean(v.task_class, 'task_class'), relevance_window: window(v.relevance_window) };
}
export function contextRequestHash(input: ContextRequestV1): string {
  return createHash('sha256').update(canonicalJson(normalizeContextRequest(input)), 'utf8').digest('hex');
}

function tokenEstimate(claim: string): number { return Math.max(1, Math.ceil(Buffer.byteLength(claim, 'utf8') / 4)); }
function applicable(request: ContextScope, item: ContextScope): boolean { return item.kind === 'global' || (request.kind !== 'global' && canonicalJson(request) === canonicalJson(item)); }
function managedFor(row: ParsedFact, page: { brain_id: string; source_id: string; canonical_slug: string }, knowledge: LearningLoopKnowledge): ContextItem | null {
  for (const raw of Object.values(knowledge.managed_rows)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const managed = raw as Record<string, unknown>; const identity = managed.identity;
    if (!identity || typeof identity !== 'object' || Array.isArray(identity) || managed.row_num !== row.rowNum) continue;
    const i = identity as LearningClaimIdentity;
    if (i.claim !== row.claim || managed.active !== row.active || i.class === 'business_candidate' || i.class === 'friction' || knowledge.blocked_identities.includes(i.claim_fingerprint ?? '')) return null;
    if (i.class === 'open_loop' && (!i.trigger || i.trigger.state !== 'pending')) return null;
    if (i.scope.kind === 'global' && i.target !== null) return null;
    return {
      pointer: {
        brain_id: page.brain_id,
        source_id: page.source_id,
        canonical_slug: page.canonical_slug,
        row_num: row.rowNum,
      },
      claim: i.claim,
      class: i.class,
      scope: i.scope,
      target: i.target,
      trigger: i.trigger,
    };
  }
  return null;
}
export function buildContextBundle(input: ContextRequestV1, pages: readonly { brain_id: string; source_id: string; canonical_slug: string; content: string }[], authorizedSourceId: string): ContextBundle {
  const request = normalizeContextRequest(input); if (authorizedSourceId !== request.source_id) return fail('source authorization failed');
  const candidates: ContextItem[] = [];
  for (const page of pages) {
    if (page.brain_id !== request.brain_id || page.source_id !== request.source_id || typeof page.content !== 'string') continue;
    try {
      const fence = parseLearningLoopFence(page.content); if (!fence || fence.value.brain_id !== page.brain_id || fence.value.source_id !== page.source_id || fence.value.canonical_slug !== page.canonical_slug) continue;
      for (const row of parseFactsFence(page.content).facts) {
        if (!row.active || row.supersededBy !== undefined || row.forgotten) continue;
        const item = managedFor(row, page, fence.value); if (item && applicable(request.scope, item.scope)) candidates.push(item);
      }
    } catch { /* malformed canonical state is excluded */ }
  }
  const terms = new Set([request.task_class, ...request.relevance_window].join(' ').toLocaleLowerCase().normalize('NFC').split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
  const relevance = (item: ContextItem) => item.claim.toLocaleLowerCase().normalize('NFC').split(/[^\p{L}\p{N}_-]+/u).filter(Boolean).reduce((n, word) => n + (terms.has(word) ? 1 : 0), 0);
  const rank = (item: ContextItem) => ({ constraint: 0, goal: 1, lesson: 2, preference: 3, open_loop: 4 }[item.class]);
  const relevant = candidates.filter((item) => item.class === 'constraint' || relevance(item) > 0);
  relevant.sort((a, b) => rank(a) - rank(b) || relevance(b) - relevance(a) || Buffer.from(canonicalJson(a.pointer)).compare(Buffer.from(canonicalJson(b.pointer))));
  const items: ContextItem[] = []; let tokens = 0; let loop = false;
  for (const item of relevant) { const n = tokenEstimate(item.claim); if ((item.class === 'open_loop' && loop) || items.length >= MAX_CONTEXT_ITEMS || tokens + n > MAX_CONTEXT_TOKENS) continue; items.push(item); tokens += n; if (item.class === 'open_loop') loop = true; }
  return { request_hash: contextRequestHash(request), items, token_estimate: tokens };
}
export function makeContextSuppliedTelemetry(input: ContextRequestV1, bundle: ContextBundle): ContextSuppliedTelemetry {
  const request = normalizeContextRequest(input); const hash = contextRequestHash(request); if (bundle.request_hash !== hash) return fail('bundle request hash mismatch');
  return { event_type: 'context_supplied', version: 1, run_id: request.run_id, provider: request.provider, provider_session_id: request.provider_session_id, request_hash: hash, pointers: bundle.items.map((i) => i.pointer), claims: bundle.items.map((i) => ({ claim_fingerprint: learningClaimFingerprint({ claim: i.claim, class: i.class, scope: i.scope, target: i.target, trigger: i.trigger }), class: i.class, scope: i.scope, target: i.target, trigger: i.trigger })), item_count: bundle.items.length, token_estimate: bundle.token_estimate };
}
