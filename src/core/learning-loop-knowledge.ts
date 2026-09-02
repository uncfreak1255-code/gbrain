import { createHash } from 'node:crypto';
import { canonicalJson } from './remediation-step.ts';

export type LearningClass = 'constraint' | 'preference' | 'goal' | 'lesson' | 'friction' | 'open_loop' | 'business_candidate';
export type LearningScope = { kind: 'global' } | { kind: 'repository'; target: string } | { kind: 'project'; target: string };
export type LearningTrigger = null | { kind: string; id: string; state: 'pending' };
export interface LearningClaimIdentity { claim: string; class: LearningClass; scope: LearningScope; target: string | null; trigger: LearningTrigger; claim_fingerprint?: string; }
export interface TranscriptUserRow { provider: 'codex'; provider_session_id: string; transcript_hash: string; line: number; message_index: number; message_hash: string; role: 'user'; text: string; }
export function normalizeLearningClaim(claim: string): string {
  return claim.replace(/\r\n?/g, '\n').normalize('NFC').replace(/\s+/gu, ' ').trim();
}
export function learningClaimFingerprint(identity: Omit<LearningClaimIdentity, 'claim_fingerprint'>): string {
  return createHash('sha256').update(canonicalJson({ ...identity, claim: normalizeLearningClaim(identity.claim) })).digest('hex');
}
export function makeLearningClaimIdentity(input: Omit<LearningClaimIdentity, 'claim_fingerprint'>): LearningClaimIdentity {
  const normalized = { ...input, claim: normalizeLearningClaim(input.claim) };
  return { ...normalized, claim_fingerprint: learningClaimFingerprint(normalized) };
}
function transcriptText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => {
    if (!item || typeof item !== 'object') return '';
    const row = item as Record<string, unknown>;
    return typeof row.text === 'string' ? row.text : typeof row.content === 'string' ? row.content : '';
  }).join('');
  if (value && typeof value === 'object') return transcriptText((value as Record<string, unknown>).content ?? (value as Record<string, unknown>).text);
  return '';
}
export function parseAuthoritativeUserRows(text: string, provider_session_id: string, transcript_hash: string): TranscriptUserRow[] {
  if (!/^[a-f0-9]{64}$/.test(transcript_hash) || !provider_session_id) return [];
  const rows: TranscriptUserRow[] = []; let messageIndex = 0;
  text.split(/\n/).forEach((line, i) => { try {
    const v = JSON.parse(line) as Record<string, unknown>;
    const payload = (v.payload && typeof v.payload === 'object' ? v.payload : v.message && typeof v.message === 'object' ? v.message : v) as Record<string, unknown>;
    if (payload.role !== 'user') return;
    const value = transcriptText(payload.content ?? payload.text);
    if (!value.trim()) return;
    rows.push({ provider: 'codex', provider_session_id, transcript_hash, line: i + 1, message_index: messageIndex++, message_hash: createHash('sha256').update(value.normalize('NFKC').trim()).digest('hex'), role: 'user', text: value });
  } catch { /* non-message lines are not authority */ } });
  return rows;
}

export const LEARNING_LOOP_FENCE_BEGIN = '<!-- gbrain:learning-loop:v1:begin -->';
export const LEARNING_LOOP_FENCE_END = '<!-- gbrain:learning-loop:v1:end -->';
export const LEARNING_LOOP_FENCE_RE = /<!-- gbrain:learning-loop:v1:begin -->\n([\s\S]*?)\n<!-- gbrain:learning-loop:v1:end -->/g;
const transitionPermits = new WeakSet<object>();
export type LearningTransitionPermit = { readonly __learningTransition: true; readonly previous_hash: string; readonly next_hash: string };
/** Minted only by a reducer after it has validated both complete states. */
export function createLearningTransitionPermit(previous: LearningLoopKnowledge, next: LearningLoopKnowledge): LearningTransitionPermit {
  if (previous.brain_id !== next.brain_id || previous.source_id !== next.source_id || previous.canonical_slug !== next.canonical_slug) {
    throw new Error('learning-loop metadata: transition target mismatch');
  }
  const permit = Object.freeze({ __learningTransition: true as const, previous_hash: learningLoopKnowledgeHash(previous), next_hash: learningLoopKnowledgeHash(next) });
  transitionPermits.add(permit);
  return permit;
}
// The Phase 4 lineage reducer is the only planned permit minter. Phase 2 keeps
// the verifier closed so no generic in-process caller can authorize a change.
export function isLearningTransitionPermit(value: unknown, previous?: LearningLoopKnowledge, next?: LearningLoopKnowledge): value is LearningTransitionPermit { if (!value || typeof value !== 'object' || !transitionPermits.has(value)) return false; const permit=value as LearningTransitionPermit; return previous !== undefined && next !== undefined && permit.previous_hash===learningLoopKnowledgeHash(previous) && permit.next_hash===learningLoopKnowledgeHash(next) && previous.brain_id===next.brain_id && previous.source_id===next.source_id && previous.canonical_slug===next.canonical_slug; }

export type LearningLoopKnowledge = {
  brain_id: string; source_id: string; canonical_slug: string;
  managed_rows: Readonly<Record<string, unknown>>;
  blocked_identities: readonly string[]; correction_lineages: Readonly<Record<string, unknown>>;
  reversal_attempts: Readonly<Record<string, unknown>>; immutable_commit_markers: readonly string[];
  pending_delivery: unknown;
  protected_state_hash?: string;
};
const KEYS = new Set(['brain_id','source_id','canonical_slug','managed_rows','blocked_identities','correction_lineages','reversal_attempts','immutable_commit_markers','pending_delivery','protected_state_hash']);
function fail(message: string): never { throw new Error(`learning-loop metadata: ${message}`); }
function object(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`); return value as Record<string, unknown>; }
export function encodeLearningLoopKnowledge(value: LearningLoopKnowledge): string {
  const obj = object(value, 'value');
  for (const key of Object.keys(obj)) if (!KEYS.has(key)) fail(`unknown field ${key}`);
  for (const key of ['brain_id','source_id','canonical_slug']) if (typeof obj[key] !== 'string' || !obj[key]) fail(`${key} must be non-empty`);
  if (!Array.isArray(obj.blocked_identities) || !obj.blocked_identities.every(x => typeof x === 'string')) fail('blocked_identities must be strings');
  if (!Array.isArray(obj.immutable_commit_markers) || !obj.immutable_commit_markers.every(x => typeof x === 'string')) fail('immutable_commit_markers must be strings');
  object(obj.managed_rows, 'managed_rows');
  object(obj.correction_lineages, 'correction_lineages');
  object(obj.reversal_attempts, 'reversal_attempts');
  if (typeof obj.protected_state_hash !== 'undefined' && !/^[0-9a-f]{64}$/.test(String(obj.protected_state_hash))) fail('protected_state_hash must be sha256');
  return canonicalJson(value);
}
export function decodeLearningLoopKnowledge(raw: string): LearningLoopKnowledge {
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { fail('invalid JSON'); }
  const obj = object(parsed, 'value');
  for (const key of Object.keys(obj)) if (!KEYS.has(key)) fail(`unknown field ${key}`);
  for (const key of ['brain_id','source_id','canonical_slug','managed_rows','blocked_identities','correction_lineages','reversal_attempts','immutable_commit_markers','pending_delivery']) if (!(key in obj)) fail(`missing field ${key}`);
  encodeLearningLoopKnowledge(obj as LearningLoopKnowledge);
  return obj as LearningLoopKnowledge;
}
export function renderLearningLoopFence(value: LearningLoopKnowledge): string { return `${LEARNING_LOOP_FENCE_BEGIN}\n${encodeLearningLoopKnowledge(value)}\n${LEARNING_LOOP_FENCE_END}`; }
export function parseLearningLoopFence(markdown: string): { value: LearningLoopKnowledge; raw: string } | null {
  const matches = [...markdown.matchAll(LEARNING_LOOP_FENCE_RE)];
  const beginCount = markdown.split(LEARNING_LOOP_FENCE_BEGIN).length - 1;
  const endCount = markdown.split(LEARNING_LOOP_FENCE_END).length - 1;
  if (beginCount !== matches.length || endCount !== matches.length) fail('malformed fence');
  if (!matches.length) return null;
  if (matches.length !== 1) fail('duplicate fence');
  const value = decodeLearningLoopKnowledge(matches[0][1]);
  if (encodeLearningLoopKnowledge(value) !== matches[0][1]) fail('non-canonical JSON');
  const raw = matches[0][0]; return { value, raw };
}
export function learningLoopKnowledgeHash(value: LearningLoopKnowledge): string { return createHash('sha256').update(encodeLearningLoopKnowledge(value)).digest('hex'); }
