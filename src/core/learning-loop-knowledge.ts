import { createHash } from 'node:crypto';
import { canonicalJson } from './remediation-step.ts';

export type LearningClass = 'constraint' | 'preference' | 'goal' | 'lesson' | 'friction' | 'open_loop' | 'business_candidate';
export type LearningScope = { kind: 'global' } | { kind: 'repository'; target: string } | { kind: 'project'; target: string };
export type LearningTrigger = null | { kind: string; id: string; state: 'pending' };
export interface LearningClaimIdentity { claim: string; class: LearningClass; scope: LearningScope; target: string | null; trigger: LearningTrigger; claim_fingerprint?: string; }
/** The only durable representation of a claim in the canonical page fence. */
export interface LearningManagedRow {
  identity: LearningClaimIdentity;
  row_num: number;
  active: boolean;
  run_id: string;
}
export type BlockedClaimKey = string & { readonly __blockedClaimKey: unique symbol };
export interface LearningPointer { identity: BlockedClaimKey; canonical_slug: string; row_num: number; }
export interface CorrectionLineage {
  blocked_identity: BlockedClaimKey;
  active_replacements: readonly LearningPointer[];
  replacement_set_fingerprint: string;
  lineage_generation: number;
}

/**
 * Durable state for one explicit direct-user reversal.  These values are
 * canonical-page metadata, not a second queue or an in-memory workflow.
 * Every phase is monotonic and can be replayed after a process interruption.
 */
export type LearningReversalPhase =
  | 'started'
  | 'retired_checkpointed'
  | 'rebuild_verified'
  | 'commit_intent'
  | 'committed'
  | 'superseded'
  | 'failed';

export interface LearningReversalCheckpoint {
  lineage_generation: number;
  replacement_set_fingerprint: string;
  active_replacements: readonly LearningPointer[];
  /** Highest accepted V2 learning event sequence included in this snapshot. */
  learning_event_sequence?: number;
}

export interface LearningReversalAttempt {
  root_reversal_id: string;
  attempt_no: number;
  phase: LearningReversalPhase;
  blocked_identity: BlockedClaimKey;
  authority_event_id: string;
  predecessor_generation: number;
  predecessor_set_fingerprint: string;
  predecessor_replacements: readonly LearningPointer[];
  /** Every obligation that still has to be retired by this attempt. */
  inherited_replacements?: readonly LearningPointer[];
  checkpoint?: LearningReversalCheckpoint;
  rebuild_proof?: { proof_id: string; checkpoint_hash: string };
  commit_intent?: {
    checkpoint_hash: string;
    final_state_hash: string;
    reinstated: LearningPointer;
  };
  successor_id?: string;
  predecessor_id?: string;
  failure_code?: string;
}

export type LearningReversalCommand =
  | { kind: 'start'; attempt: LearningReversalAttempt }
  | { kind: 'retired_checkpointed'; checkpoint: LearningReversalCheckpoint }
  | { kind: 'rebuild_verified'; proof_id: string; checkpoint_hash: string }
  | { kind: 'commit_intent'; checkpoint_hash: string; final_state_hash: string; reinstated: LearningPointer }
  | { kind: 'committed'; marker: string }
  | { kind: 'failed'; code: string }
  | { kind: 'supersede'; successor: LearningReversalAttempt };
export function learningBlockedClaimKey(identity: LearningClaimIdentity): BlockedClaimKey {
  const normalized = makeLearningClaimIdentity({
    claim: identity.claim,
    class: identity.class,
    scope: identity.scope,
    target: identity.target,
    trigger: identity.trigger,
  });
  return createHash('sha256').update(canonicalJson({
    claim: normalized.claim, class: normalized.class, scope: normalized.scope,
    target: normalized.target, trigger: normalized.trigger,
  })).digest('hex') as BlockedClaimKey;
}
export function replacementPointerEncoding(pointer: LearningPointer): string { return canonicalJson(pointer); }
export function replacementSetFingerprint(pointers: readonly LearningPointer[]): string {
  const sorted = [...pointers].map(replacementPointerEncoding).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  return createHash('sha256').update(canonicalJson(sorted)).digest('hex');
}
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

function reversalAttemptKey(attempt: LearningReversalAttempt): string {
  return `${attempt.root_reversal_id}:${attempt.attempt_no}`;
}

function validReversalPointer(value: unknown): value is LearningPointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pointer = value as Partial<LearningPointer>;
  return /^[a-f0-9]{64}$/.test(String(pointer.identity ?? ''))
    && typeof pointer.canonical_slug === 'string'
    && pointer.canonical_slug.length > 0
    && Number.isSafeInteger(pointer.row_num)
    && Number(pointer.row_num) > 0
    && Object.keys(pointer).every(key => ['identity', 'canonical_slug', 'row_num'].includes(key));
}

function validReversalCheckpoint(value: unknown): value is LearningReversalCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Partial<LearningReversalCheckpoint>;
  if (!Number.isSafeInteger(checkpoint.lineage_generation) || Number(checkpoint.lineage_generation) < 1
    || !/^[a-f0-9]{64}$/.test(String(checkpoint.replacement_set_fingerprint ?? ''))
    || !Array.isArray(checkpoint.active_replacements)
    || !checkpoint.active_replacements.every(validReversalPointer)
    || (checkpoint.learning_event_sequence !== undefined
      && (!Number.isSafeInteger(checkpoint.learning_event_sequence) || Number(checkpoint.learning_event_sequence) < 0))
    || Object.keys(checkpoint).some(key => !['lineage_generation', 'replacement_set_fingerprint', 'active_replacements', 'learning_event_sequence'].includes(key))) return false;
  return replacementSetFingerprint(checkpoint.active_replacements) === checkpoint.replacement_set_fingerprint;
}

function reversalCheckpointHash(value: LearningReversalCheckpoint): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function assertReversalStart(attempt: LearningReversalAttempt): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(attempt.root_reversal_id)
    || attempt.phase !== 'started'
    || !Number.isSafeInteger(attempt.attempt_no)
    || attempt.attempt_no < 1
    || !/^[a-f0-9]{64}$/.test(attempt.blocked_identity)
    || typeof attempt.authority_event_id !== 'string'
    || attempt.authority_event_id.length === 0
    || !Number.isSafeInteger(attempt.predecessor_generation)
    || attempt.predecessor_generation < 1
    || !/^[a-f0-9]{64}$/.test(attempt.predecessor_set_fingerprint)
    || !Array.isArray(attempt.predecessor_replacements)
    || !attempt.predecessor_replacements.every(validReversalPointer)
    || (attempt.inherited_replacements !== undefined && (!Array.isArray(attempt.inherited_replacements) || !attempt.inherited_replacements.every(validReversalPointer)))
    || Object.keys(attempt).some(key => !['root_reversal_id', 'attempt_no', 'phase', 'blocked_identity', 'authority_event_id', 'predecessor_generation', 'predecessor_set_fingerprint', 'predecessor_replacements', 'inherited_replacements', 'checkpoint', 'rebuild_proof', 'commit_intent', 'successor_id', 'predecessor_id', 'failure_code'].includes(key))) {
    throw new Error('learning-loop metadata: invalid reversal start');
  }
  if (replacementSetFingerprint(attempt.predecessor_replacements) !== attempt.predecessor_set_fingerprint) {
    throw new Error('learning-loop metadata: reversal predecessor set fingerprint mismatch');
  }
}

/**
 * Common reducer for reversal metadata. It is intentionally the only place
 * that advances a persisted attempt phase. Callers may retry a byte-identical
 * command, but cannot skip, rewind, or rewrite an attempt.
 */
export function reduceLearningLoopReversal(
  previous: LearningLoopKnowledge,
  command: LearningReversalCommand,
): { next: LearningLoopKnowledge; attempt: LearningReversalAttempt } {
  const attempts = { ...previous.reversal_attempts } as Record<string, LearningReversalAttempt>;
  if (command.kind === 'start') {
    assertReversalStart(command.attempt);
    const key = reversalAttemptKey(command.attempt);
    const prior = attempts[key];
    if (prior) {
      if (!sameJson(prior, command.attempt)) throw new Error('learning-loop metadata: reversal attempt identity conflict');
      return { next: previous, attempt: prior };
    }
    // A root may have only one non-terminal attempt. A successor is created
    // through the atomic supersede command below, never by a second root start.
    for (const existing of Object.values(attempts)) {
      if (existing.root_reversal_id === command.attempt.root_reversal_id
        && !['committed', 'superseded', 'failed'].includes(existing.phase)) {
        throw new Error('learning-loop metadata: reversal root already has an active attempt');
      }
    }
    attempts[key] = command.attempt;
    return { next: { ...previous, reversal_attempts: attempts }, attempt: command.attempt };
  }

  if (command.kind === 'supersede') {
    assertReversalStart(command.successor);
    const successorKey = reversalAttemptKey(command.successor);
    const existingSuccessor = attempts[successorKey];
    const predecessorKey = command.successor.predecessor_id;
    const predecessor = predecessorKey ? attempts[predecessorKey] : undefined;
    if (existingSuccessor || predecessor?.phase === 'superseded') {
      if (existingSuccessor && predecessor?.phase === 'superseded'
        && predecessor.successor_id === successorKey && sameJson(existingSuccessor, command.successor)) {
        return { next: previous, attempt: existingSuccessor };
      }
      throw new Error('learning-loop metadata: reversal successor identity conflict');
    }
  }

  const activeEntries = Object.entries(attempts).filter(([, value]) => !['committed', 'superseded', 'failed'].includes(value.phase));
  if (activeEntries.length !== 1) throw new Error('learning-loop metadata: reversal active attempt is ambiguous or missing');
  const [activeKey, current] = activeEntries[0];

  if (command.kind === 'supersede') {
    if (current.phase === 'committed' || current.phase === 'failed' || current.phase === 'superseded'
      || command.successor.root_reversal_id !== current.root_reversal_id
      || command.successor.attempt_no <= current.attempt_no
      || command.successor.predecessor_id !== activeKey) {
      throw new Error('learning-loop metadata: invalid reversal successor');
    }
    attempts[activeKey] = { ...current, phase: 'superseded', successor_id: reversalAttemptKey(command.successor) };
    attempts[reversalAttemptKey(command.successor)] = command.successor;
    return { next: { ...previous, reversal_attempts: attempts }, attempt: command.successor };
  }

  if (command.kind === 'failed') {
    if (['committed', 'superseded', 'failed'].includes(current.phase) || !command.code || command.code.length > 160) {
      throw new Error('learning-loop metadata: invalid reversal failure');
    }
    const nextAttempt = { ...current, phase: 'failed' as const, failure_code: command.code };
    attempts[activeKey] = nextAttempt;
    return { next: { ...previous, reversal_attempts: attempts }, attempt: nextAttempt };
  }

  const expectedPrevious: Record<Exclude<LearningReversalPhase, 'started' | 'superseded' | 'failed'>, LearningReversalPhase> = {
    retired_checkpointed: 'started',
    rebuild_verified: 'retired_checkpointed',
    commit_intent: 'rebuild_verified',
    committed: 'commit_intent',
  };
  if (current.phase === command.kind) {
    const matches = command.kind === 'retired_checkpointed'
      ? sameJson(current.checkpoint, command.checkpoint)
      : command.kind === 'rebuild_verified'
        ? sameJson(current.rebuild_proof, { proof_id: command.proof_id, checkpoint_hash: command.checkpoint_hash })
        : command.kind === 'commit_intent'
          ? sameJson(current.commit_intent, { checkpoint_hash: command.checkpoint_hash, final_state_hash: command.final_state_hash, reinstated: command.reinstated })
          : false;
    if (!matches) throw new Error('learning-loop metadata: reversal phase retry conflicts with the durable payload');
    return { next: previous, attempt: current };
  }
  if (current.phase !== expectedPrevious[command.kind]) {
    throw new Error('learning-loop metadata: invalid reversal phase transition');
  }

  let nextAttempt: LearningReversalAttempt;
  if (command.kind === 'retired_checkpointed') {
    if (!validReversalCheckpoint(command.checkpoint)
      || command.checkpoint.lineage_generation <= current.predecessor_generation) {
      throw new Error('learning-loop metadata: invalid reversal checkpoint');
    }
    nextAttempt = { ...current, phase: command.kind, checkpoint: command.checkpoint };
  } else if (command.kind === 'rebuild_verified') {
    if (!current.checkpoint || !command.proof_id || command.proof_id.length > 160
      || command.checkpoint_hash !== reversalCheckpointHash(current.checkpoint)) {
      throw new Error('learning-loop metadata: invalid reversal rebuild proof');
    }
    nextAttempt = { ...current, phase: command.kind, rebuild_proof: { proof_id: command.proof_id, checkpoint_hash: command.checkpoint_hash } };
  } else if (command.kind === 'commit_intent') {
    if (!current.checkpoint || command.checkpoint_hash !== reversalCheckpointHash(current.checkpoint)
      || !validReversalPointer(command.reinstated)
      || command.reinstated.identity !== current.blocked_identity
      || !/^[a-f0-9]{64}$/.test(command.final_state_hash)) {
      throw new Error('learning-loop metadata: invalid reversal commit intent');
    }
    nextAttempt = { ...current, phase: command.kind, commit_intent: { checkpoint_hash: command.checkpoint_hash, final_state_hash: command.final_state_hash, reinstated: command.reinstated } };
  } else {
    if (!current.commit_intent || !command.marker || command.marker.length > 256) throw new Error('learning-loop metadata: missing reversal commit intent');
    const existingMarker = previous.immutable_commit_markers.find(marker => marker === command.marker);
    if (existingMarker === undefined && previous.immutable_commit_markers.some(marker => marker.startsWith(`${activeKey}:`))) {
      throw new Error('learning-loop metadata: immutable reversal commit marker conflict');
    }
    nextAttempt = { ...current, phase: 'committed' };
  }
  attempts[activeKey] = nextAttempt;
  const markers = command.kind === 'committed' && !previous.immutable_commit_markers.includes(command.marker)
    ? [...previous.immutable_commit_markers, command.marker].sort()
    : [...previous.immutable_commit_markers];
  const blocked = command.kind === 'committed'
    ? previous.blocked_identities.filter(key => key !== current.blocked_identity)
    : [...previous.blocked_identities];
  return { next: { ...previous, reversal_attempts: attempts, immutable_commit_markers: markers, blocked_identities: blocked }, attempt: nextAttempt };
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

/**
 * Return the stable preimage for the protected canonical state.  The hash is
 * deliberately independent of `pending_delivery` (which is a delivery
 * journal) and of the hash field itself.  Callers pass only the parsed fact
 * rows whose row numbers are named by `managed_rows`; ordinary facts remain
 * legal to edit without changing the protected-state identity.
 */
export function learningLoopProtectedStateHash(
  value: LearningLoopKnowledge,
  managedFactRows: readonly unknown[] = [],
): string {
  const managedRowNumbers = new Set(Object.values(value.managed_rows).flatMap(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const rowNum = Number((raw as Record<string, unknown>).row_num);
    return Number.isSafeInteger(rowNum) && rowNum > 0 ? [rowNum] : [];
  }));
  const facts = managedFactRows
    .filter(raw => raw && typeof raw === 'object' && !Array.isArray(raw))
    .filter(raw => managedRowNumbers.has(Number((raw as Record<string, unknown>).rowNum ?? (raw as Record<string, unknown>).row_num)))
    .map(raw => raw as Record<string, unknown>)
    .sort((left, right) => Number(left.rowNum ?? left.row_num) - Number(right.rowNum ?? right.row_num));
  const preimage = {
    managed_fact_rows: facts,
    managed_rows: value.managed_rows,
    blocked_identities: value.blocked_identities,
    correction_lineages: value.correction_lineages,
    reversal_attempts: value.reversal_attempts,
    immutable_commit_markers: value.immutable_commit_markers,
  };
  return createHash('sha256').update(canonicalJson(preimage), 'utf8').digest('hex');
}

export function learningLoopHasProtectedState(value: LearningLoopKnowledge): boolean {
  return Object.keys(value.managed_rows).length > 0
    || value.blocked_identities.length > 0
    || Object.keys(value.correction_lineages).length > 0
    || Object.keys(value.reversal_attempts).length > 0
    || value.immutable_commit_markers.length > 0
    || value.pending_delivery !== null;
}

export type LearningLineageCommand =
  | { kind: 'activate'; identity: LearningClaimIdentity; pointer: LearningPointer }
  | { kind: 'correct'; predecessor: LearningClaimIdentity; replacement: LearningPointer };
export function reduceLearningLoopLineage(previous: LearningLoopKnowledge, command: LearningLineageCommand): {
  next: LearningLoopKnowledge; permit: LearningTransitionPermit;
} {
  const key = command.kind === 'activate' ? learningBlockedClaimKey(command.identity) : learningBlockedClaimKey(command.predecessor);
  const existing = (previous.correction_lineages[key] ?? {}) as Partial<CorrectionLineage>;
  const pointers = [...(existing.active_replacements ?? [])] as LearningPointer[];
  const replacement = command.kind === 'activate' ? command.pointer : command.replacement;
  const predecessorKey = learningBlockedClaimKey(command.kind === 'activate' ? command.identity : command.predecessor);
  if (command.kind === 'correct') {
    // Retire the predecessor pointer, then add the complete successor set.
    for (let i = pointers.length - 1; i >= 0; i--) if (pointers[i].identity === predecessorKey) pointers.splice(i, 1);
  }
  const alreadyPresent = pointers.some(p => canonicalJson(p) === canonicalJson(replacement));
  if (!alreadyPresent) pointers.push(replacement);
  pointers.sort((a, b) => Buffer.from(replacementPointerEncoding(a)).compare(Buffer.from(replacementPointerEncoding(b))));
  const lineage: CorrectionLineage = {
    blocked_identity: key, active_replacements: pointers,
    replacement_set_fingerprint: replacementSetFingerprint(pointers),
    lineage_generation: alreadyPresent && command.kind === 'correct' ? (existing.lineage_generation ?? 0) : (existing.lineage_generation ?? 0) + 1,
  };
  const blocked = command.kind === 'correct' && !previous.blocked_identities.includes(key) ? [...previous.blocked_identities, key].sort() : [...previous.blocked_identities];
  const lineages: Record<string, CorrectionLineage> = { ...previous.correction_lineages, [key]: lineage } as Record<string, CorrectionLineage>;

  // A correction of a linked replacement changes every ancestor's complete
  // active obligation set.  An active reversal also retains retired rows as
  // obligations, so a later accepted correction or recreation must reappear
  // in that ancestor lineage and make its checkpoint stale.
  if (command.kind === 'correct' || command.kind === 'activate') {
    for (const [lineageKey, raw] of Object.entries(lineages)) {
      if (lineageKey === key || !raw || !Array.isArray(raw.active_replacements)) continue;
      const attemptObligations = Object.values(previous.reversal_attempts)
        .filter((attempt): attempt is Partial<LearningReversalAttempt> => Boolean(attempt && typeof attempt === 'object' && !Array.isArray(attempt)))
        .filter(attempt => attempt.blocked_identity === lineageKey && !['committed', 'superseded', 'failed'].includes(String(attempt.phase)))
        .flatMap(attempt => [...(attempt.predecessor_replacements ?? []), ...(attempt.inherited_replacements ?? [])]);
      const tracksPointer = raw.active_replacements.some(pointer => pointer.identity === predecessorKey && pointer.canonical_slug === replacement.canonical_slug)
        || attemptObligations.some(pointer => pointer.identity === predecessorKey && pointer.canonical_slug === replacement.canonical_slug);
      if (!tracksPointer) continue;
      const propagated = raw.active_replacements
        .filter(pointer => !(pointer.identity === predecessorKey && pointer.canonical_slug === replacement.canonical_slug))
        .concat(replacement);
      const unique = propagated.filter((pointer, index, all) => all.findIndex(candidate => canonicalJson(candidate) === canonicalJson(pointer)) === index)
        .sort((left, right) => Buffer.from(replacementPointerEncoding(left)).compare(Buffer.from(replacementPointerEncoding(right))));
      if (canonicalJson(unique) === canonicalJson(raw.active_replacements)) continue;
      lineages[lineageKey] = {
        ...raw,
        active_replacements: unique,
        replacement_set_fingerprint: replacementSetFingerprint(unique),
        lineage_generation: (raw.lineage_generation ?? 0) + 1,
      };
    }
  }
  const next: LearningLoopKnowledge = { ...previous, blocked_identities: blocked, correction_lineages: lineages };
  return { next, permit: createLearningTransitionPermit(previous, next) };
}
const KEYS = new Set(['brain_id','source_id','canonical_slug','managed_rows','blocked_identities','correction_lineages','reversal_attempts','immutable_commit_markers','pending_delivery','protected_state_hash']);
function fail(message: string): never { throw new Error(`learning-loop metadata: ${message}`); }
function object(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`); return value as Record<string, unknown>; }
const LEARNING_CLASSES = new Set<LearningClass>(['constraint','preference','goal','lesson','friction','open_loop','business_candidate']);
const PROJECT_TARGET_RE = /^project:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REPOSITORY_TARGET_RE = /^repo:[^/\s:]+\/[^/\s:]+\/[^/\s:]+$/;
function canonicalManagedIdentity(value: unknown): LearningClaimIdentity {
  const identity = object(value, 'managed row identity');
  if (Object.keys(identity).some(key => !['claim','class','scope','target','trigger','claim_fingerprint'].includes(key))) fail('managed row identity unknown field');
  if (typeof identity.claim !== 'string' || !identity.claim || identity.claim.length > 4096
    || /[\r\n\u0000-\u001f\u007f]/.test(identity.claim)
    || identity.claim.normalize('NFC') !== identity.claim
    || normalizeLearningClaim(identity.claim) !== identity.claim) fail('managed row identity claim is not canonical');
  if (!LEARNING_CLASSES.has(identity.class as LearningClass)) fail('managed row identity class is invalid');
  const scope = object(identity.scope, 'managed row identity scope');
  if (Object.keys(scope).some(key => !['kind','target'].includes(key))) fail('managed row identity scope unknown field');
  if (scope.kind === 'global') {
    if (Object.keys(scope).length !== 1 || identity.target !== null) fail('managed row identity global target is contradictory');
  } else if (scope.kind === 'repository') {
    if (Object.keys(scope).length !== 2 || typeof scope.target !== 'string' || !REPOSITORY_TARGET_RE.test(scope.target) || identity.target !== scope.target) fail('managed row identity repository target is contradictory or malformed');
  } else if (scope.kind === 'project') {
    if (Object.keys(scope).length !== 2 || typeof scope.target !== 'string' || !PROJECT_TARGET_RE.test(scope.target) || identity.target !== scope.target) fail('managed row identity project target is contradictory or malformed');
  } else fail('managed row identity scope is ambiguous');
  const trigger = identity.trigger;
  if (identity.class === 'open_loop') {
    const t = object(trigger, 'managed row identity trigger');
    if (Object.keys(t).length !== 3 || t.state !== 'pending' || typeof t.kind !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(t.kind)
      || typeof t.id !== 'string' || !t.id || /[\r\n\u0000-\u001f\u007f]/.test(t.id)) fail('managed row identity trigger is invalid');
  } else if (trigger !== null) fail('managed row identity trigger must be null');
  const normalized = makeLearningClaimIdentity({ claim: identity.claim, class: identity.class as LearningClass, scope: scope as LearningScope, target: identity.target as string | null, trigger: trigger as LearningTrigger });
  if (identity.claim_fingerprint !== normalized.claim_fingerprint) fail('managed row identity fingerprint mismatch');
  return identity as unknown as LearningClaimIdentity;
}
function validateManagedRows(value: Record<string, unknown>): void {
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/.test(key)) fail('managed row key must be sha256');
    const row = object(raw, 'managed row');
    if (Object.keys(row).some(field => !['identity','row_num','active','run_id'].includes(field))) fail('managed row unknown field');
    const identity = canonicalManagedIdentity(row.identity);
    if (key !== identity.claim_fingerprint) fail('managed row key does not match identity fingerprint');
    if (!Number.isSafeInteger(row.row_num) || Number(row.row_num) < 1 || typeof row.active !== 'boolean' || typeof row.run_id !== 'string' || !row.run_id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(row.run_id)) fail('managed row state is invalid');
  }
}
export function makeLearningManagedRow(identity: LearningClaimIdentity, row_num: number, active: boolean, run_id: string): LearningManagedRow {
  canonicalManagedIdentity(identity);
  const row = { identity, row_num, active, run_id };
  validateManagedRows({ [identity.claim_fingerprint!]: row });
  return row;
}
export function validateLearningManagedRows(value: unknown): asserts value is Readonly<Record<string, LearningManagedRow>> {
  validateManagedRows(object(value, 'managed_rows'));
}
function validateLineages(value: Record<string, unknown>): void {
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/.test(key)) fail('correction lineage key must be sha256');
    const row = object(raw, 'correction lineage');
    if (Object.keys(row).some(k => !['blocked_identity','active_replacements','replacement_set_fingerprint','lineage_generation'].includes(k))) fail('correction lineage unknown field');
    if (row.blocked_identity !== key || !/^[a-f0-9]{64}$/.test(String(row.blocked_identity))) fail('correction lineage blocked identity mismatch');
    if (!Array.isArray(row.active_replacements) || !Number.isSafeInteger(row.lineage_generation) || Number(row.lineage_generation) < 1 || !/^[a-f0-9]{64}$/.test(String(row.replacement_set_fingerprint))) fail('correction lineage fields invalid');
    const pointers = row.active_replacements as unknown[];
    const encodings: string[] = [];
    for (const pointer of pointers) {
      const p = object(pointer, 'replacement pointer');
      if (Object.keys(p).some(k => !['identity','canonical_slug','row_num'].includes(k)) || !/^[a-f0-9]{64}$/.test(String(p.identity)) || typeof p.canonical_slug !== 'string' || !p.canonical_slug || !Number.isSafeInteger(p.row_num) || Number(p.row_num) < 1) fail('replacement pointer invalid');
      encodings.push(canonicalJson(p));
    }
    const sorted = [...encodings].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    if (canonicalJson(encodings) !== canonicalJson(sorted) || new Set(encodings).size !== encodings.length || replacementSetFingerprint(pointers as LearningPointer[]) !== row.replacement_set_fingerprint) fail('replacement set is not complete, sorted, or correctly fingerprinted');
  }
}
function validateReversalAttempts(value: Record<string, unknown>): void {
  for (const [key, raw] of Object.entries(value)) {
    const attempt = object(raw, 'reversal attempt') as Partial<LearningReversalAttempt>;
    if (key !== `${attempt.root_reversal_id}:${attempt.attempt_no}`) fail('reversal attempt key mismatch');
    if (typeof attempt.root_reversal_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(attempt.root_reversal_id)
      || !Number.isSafeInteger(attempt.attempt_no) || Number(attempt.attempt_no) < 1
      || !['started','retired_checkpointed','rebuild_verified','commit_intent','committed','superseded','failed'].includes(String(attempt.phase))
      || !/^[a-f0-9]{64}$/.test(String(attempt.blocked_identity ?? ''))
      || typeof attempt.authority_event_id !== 'string' || !attempt.authority_event_id
      || !Number.isSafeInteger(attempt.predecessor_generation) || Number(attempt.predecessor_generation) < 1
      || !/^[a-f0-9]{64}$/.test(String(attempt.predecessor_set_fingerprint ?? ''))
      || !Array.isArray(attempt.predecessor_replacements) || !attempt.predecessor_replacements.every(validReversalPointer)
      || replacementSetFingerprint(attempt.predecessor_replacements) !== attempt.predecessor_set_fingerprint) {
      fail('reversal attempt fields invalid');
    }
    if (attempt.inherited_replacements !== undefined && (!Array.isArray(attempt.inherited_replacements) || !attempt.inherited_replacements.every(validReversalPointer))) fail('reversal inherited obligations invalid');
    if (attempt.checkpoint !== undefined && !validReversalCheckpoint(attempt.checkpoint)) fail('reversal checkpoint invalid');
    if (attempt.rebuild_proof !== undefined && (typeof attempt.rebuild_proof !== 'object' || !attempt.rebuild_proof || typeof attempt.rebuild_proof.proof_id !== 'string' || !attempt.rebuild_proof.proof_id || !/^[a-f0-9]{64}$/.test(attempt.rebuild_proof.checkpoint_hash ?? ''))) fail('reversal proof invalid');
    if (attempt.commit_intent !== undefined && (typeof attempt.commit_intent !== 'object' || !attempt.commit_intent || !/^[a-f0-9]{64}$/.test(attempt.commit_intent.checkpoint_hash ?? '') || !/^[a-f0-9]{64}$/.test(attempt.commit_intent.final_state_hash ?? '') || !validReversalPointer(attempt.commit_intent.reinstated) || attempt.commit_intent.reinstated.identity !== attempt.blocked_identity)) fail('reversal commit intent invalid');
    if (attempt.phase === 'retired_checkpointed' || attempt.phase === 'rebuild_verified' || attempt.phase === 'commit_intent' || attempt.phase === 'committed') {
      if (!attempt.checkpoint) fail('non-started reversal attempt missing checkpoint');
    }
    if (attempt.phase === 'rebuild_verified' || attempt.phase === 'commit_intent' || attempt.phase === 'committed') {
      if (!attempt.rebuild_proof) fail('verified reversal attempt missing proof');
    }
    if (attempt.phase === 'commit_intent' || attempt.phase === 'committed') {
      if (!attempt.commit_intent) fail('committing reversal attempt missing intent');
    }
    if (attempt.phase === 'superseded' && (!attempt.successor_id || typeof attempt.successor_id !== 'string')) fail('superseded reversal attempt missing successor');
    if (attempt.phase === 'failed' && (!attempt.failure_code || typeof attempt.failure_code !== 'string')) fail('failed reversal attempt missing failure code');
  }
}
export function encodeLearningLoopKnowledge(value: LearningLoopKnowledge): string {
  const obj = object(value, 'value');
  for (const key of Object.keys(obj)) if (!KEYS.has(key)) fail(`unknown field ${key}`);
  for (const key of ['brain_id','source_id','canonical_slug']) if (typeof obj[key] !== 'string' || !obj[key]) fail(`${key} must be non-empty`);
  if (!Array.isArray(obj.blocked_identities) || !obj.blocked_identities.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x))) fail('blocked_identities must be sorted sha256 keys');
  const blocked = obj.blocked_identities as string[];
  if (blocked.some((key, index) => index > 0 && Buffer.from(blocked[index - 1]).compare(Buffer.from(key)) >= 0)) fail('blocked_identities must be unique and sorted');
  if (!Array.isArray(obj.immutable_commit_markers) || !obj.immutable_commit_markers.every(x => typeof x === 'string')) fail('immutable_commit_markers must be strings');
  validateManagedRows(object(obj.managed_rows, 'managed_rows'));
  validateLineages(object(obj.correction_lineages, 'correction_lineages'));
  validateReversalAttempts(object(obj.reversal_attempts, 'reversal_attempts'));
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
export function learningLoopKnowledgeHash(value: LearningLoopKnowledge): string {
  const { protected_state_hash: _protectedStateHash, ...transitionState } = value;
  return createHash('sha256').update(encodeLearningLoopKnowledge(transitionState), 'utf8').digest('hex');
}
