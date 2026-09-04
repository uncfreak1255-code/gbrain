/**
 * Personal Learning Loop V1, PR 1 substrate.
 *
 * This module owns only capture controls, authoritative transcript reads,
 * structural eligibility, the append-only event ledger, and replay-derived
 * run/cohort state. It does not inject context, write personal knowledge,
 * score outcomes, or activate a canary.
 */

import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { createLearningLoopConfigMutationPermit, createLearningLoopLifecycleHolder, type BrainEngine } from './engine.ts';
import type { GBrainConfig } from './config.ts';
import { gbrainPath } from './config.ts';
import { canonicalJson } from './remediation-step.ts';
import { parseConversation } from './conversation-parser/parse.ts';
import { pruneDir } from './sync.ts';
import { VERSION } from '../version.ts';
import { LockUnavailableError, withRefreshingLock } from './db-lock.ts';
import { computeBrainIdFromConfig } from './upgrade-checkpoint.ts';
import { isPathContained } from './path-confine.ts';
import { parseLearningLoopFence, renderLearningLoopFence, createLearningTransitionPermit, reduceLearningLoopLineage, reduceLearningLoopReversal, replacementSetFingerprint, learningBlockedClaimKey, type LearningLoopKnowledge, type LearningPointer, type LearningReversalAttempt, type LearningReversalCheckpoint } from './learning-loop-knowledge.ts';
import { parseFactsFence, renderFactsTable, upsertFactRow } from './facts-fence.ts';
import { inspectExpectedManagedState, writeCanonicalPage, reconcileCanonicalReadback, withCanonicalSourceBoundary, type SourceQualifiedCanonicalTarget, type SourceWriteLease } from './canonical-page-write.ts';
import { importFromContent } from './import-file.ts';
import { learningClaimFingerprint, normalizeLearningClaim, parseAuthoritativeUserRows } from './learning-loop-knowledge.ts';
import { makeLearningManagedRow, type LearningClaimIdentity, type TranscriptUserRow } from './learning-loop-knowledge.ts';
export { parseAuthoritativeUserRows } from './learning-loop-knowledge.ts';

export type LearningLoopMode = 'off' | 'capture' | 'canary';
export const LEARNING_LOOP_SCHEMA_VERSION = 1 as const;
export const ELIGIBILITY_CLASSIFIER_VERSION = 'structural-v1' as const;
export const TARGET_COHORT_SIZE = 10 as const;
export const MIN_TRANSCRIPT_BYTES = 256 as const;
export const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface AdapterIdentity {
  client_id: string;
  source_id: string;
  provider: 'codex';
}

export interface TranscriptReceipt {
  provider: 'codex';
  provider_session_id: string;
  relative_path: string;
  completed_at: string;
  content_hash: string;
  size_bytes: number;
  user_turn_count: number;
  assistant_turn_count: number;
}

export interface BaselineCandidate {
  provider: 'codex';
  provider_session_id: string;
  completed_at: string;
  content_hash: string;
}

interface EventBase {
  schema_version: typeof LEARNING_LOOP_SCHEMA_VERSION;
  event_id: string;
  occurred_at: string;
}

export interface RunArmedEvent extends EventBase {
  event_type: 'run_armed';
  command_id: string;
  command_payload_hash: string;
  run_id: string;
  contract_version: 1;
  implementation_version: string;
  provider_allow_list: ['codex'];
  target_cohort_size: typeof TARGET_COHORT_SIZE;
  eligibility_classifier_version: typeof ELIGIBILITY_CLASSIFIER_VERSION;
  authorized_adapter: AdapterIdentity;
  destination: { brain_id: string; source_id: string; canonical_slug: string };
  baseline_discovery: {
    cutoff_at: string;
    status: 'complete' | 'insufficient' | 'ambiguous';
    source_manifest_hash: string;
    candidate_count: number;
    selected_candidates: BaselineCandidate[];
  };
}

/** Version 2 freezes the inputs which identify both evidence and its target. */
export interface RootBindingV1 {
  configured_root_hash: string;
  canonical_realpath: string;
  device: number;
  inode: number;
  binding_hash: string;
}
export interface CorpusBindingV1 extends RootBindingV1 { source_id: string }
export interface DestinationBindingV1 extends RootBindingV1 {
  brain_id: string;
  source_id: string;
  canonical_slug: string;
  topology: 'source_local_path' | 'sync_repo_path';
}
export interface ExactEventRecordV1 {
  schema_version: 1;
  event_id: string;
  event_payload_canonical_json: string;
  event_payload_sha256: string;
  brain_id: string;
  run_id: string;
  occurred_at: string;
  semantic_sequence: number;
}
export interface RunArmedEventV2 extends Omit<RunArmedEvent, 'contract_version' | 'destination'> {
  contract_version: 2;
  corpus_binding: CorpusBindingV1;
  destination_binding: DestinationBindingV1;
}

export type CorpusConfiguredRootPreimageV1 = {
  schema_version: 1;
  binding_kind: 'corpus_codex';
  root: { plane: 'db_config' | 'file_config'; key: 'learning_loop.corpus.codex.root'; value: string };
  source: { plane: 'db_config' | 'file_config'; key: 'learning_loop.corpus.codex.source_id'; value: string };
};
export type DestinationConfiguredRootPreimageV1 = {
  schema_version: 1;
  binding_kind: 'destination';
  source_id: string;
  topology: 'source_local_path' | 'sync_repo_path';
  root:
    | { plane: 'sources_row'; key: 'sources.local_path'; value: string }
    | { plane: 'db_config'; key: 'sync.repo_path'; value: string };
};
export type CanonicalRootPreimageV1 = CorpusConfiguredRootPreimageV1 | DestinationConfiguredRootPreimageV1;

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LearningLoopError('ledger_corrupt', 'Expected an object');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) throw new LearningLoopError('ledger_corrupt', 'Unknown exact-record field');
  return object;
}

export function decodeExactEventRecordV1(value: unknown): ExactEventRecordV1 {
  const o = strictObject(value, ['schema_version', 'event_id', 'event_payload_canonical_json', 'event_payload_sha256', 'brain_id', 'run_id', 'occurred_at', 'semantic_sequence']);
  if (o.schema_version !== 1 || typeof o.event_id !== 'string' || typeof o.event_payload_canonical_json !== 'string' ||
      !/^[a-f0-9]{64}$/.test(String(o.event_payload_sha256)) || typeof o.brain_id !== 'string' || typeof o.run_id !== 'string' ||
      typeof o.occurred_at !== 'string' || !Number.isSafeInteger(o.semantic_sequence) || (o.semantic_sequence as number) < 1) {
    throw new LearningLoopError('ledger_corrupt', 'Invalid ExactEventRecordV1');
  }
  let payload: unknown;
  try { payload = JSON.parse(o.event_payload_canonical_json); } catch { throw new LearningLoopError('ledger_corrupt', 'Exact event payload is not JSON'); }
  if (canonicalJson(payload) !== o.event_payload_canonical_json || canonicalSha256(payload) !== o.event_payload_sha256 ||
      canonicalSha256(payload) !== o.event_id) {
    throw new LearningLoopError('ledger_corrupt', 'Exact event payload bytes or hash disagree');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new LearningLoopError('ledger_corrupt', 'Exact event payload must be an object');
  const p = payload as Record<string, unknown>;
  if (p.brain_id !== o.brain_id || p.run_id !== o.run_id || p.occurred_at !== o.occurred_at || p.semantic_sequence !== o.semantic_sequence) {
    throw new LearningLoopError('ledger_corrupt', 'Exact event identity disagrees with its envelope');
  }
  return o as unknown as ExactEventRecordV1;
}

export function makeExactEventRecordV1(input: {
  event_payload: unknown; brain_id: string; run_id: string; occurred_at: string; semantic_sequence: number;
}): ExactEventRecordV1 {
  const bytes = canonicalJson(input.event_payload);
  const event_id = createHash('sha256').update(bytes, 'utf8').digest('hex');
  return decodeExactEventRecordV1({ schema_version: 1, event_id, event_payload_canonical_json: bytes,
    event_payload_sha256: createHash('sha256').update(bytes, 'utf8').digest('hex'), brain_id: input.brain_id,
    run_id: input.run_id, occurred_at: input.occurred_at, semantic_sequence: input.semantic_sequence });
}

export interface RunAbortedEvent extends EventBase {
  event_type: 'run_aborted';
  command_id: string;
  command_payload_hash: string;
  run_id: string;
  reason: 'owner_abort' | 'mode_changed';
  /** Present on an exact mode-transition delivery record. */
  brain_id?: string;
  semantic_sequence?: number;
  source_id?: string;
  canonical_slug?: string;
}

export interface AdapterSessionBoundEvent extends EventBase {
  event_type: 'adapter_session_bound';
  command_id: string;
  command_payload_hash: string;
  adapter: AdapterIdentity;
  provider_session_id: string;
}

export interface SessionEvaluatedEvent extends EventBase {
  event_type: 'session_evaluated';
  run_id: string | null;
  provider: 'codex';
  provider_session_id: string;
  completed_at: string;
  completion_state: 'completed';
  adapter: AdapterIdentity;
  authoritative: TranscriptReceipt;
  classifier_version: typeof ELIGIBILITY_CLASSIFIER_VERSION;
  eligible: boolean;
  reason: EligibilityReason;
  cohort_member: boolean;
  cohort_position: number | null;
  cohort_sealed: boolean;
}

export interface LearningCandidateEvent extends EventBase { event_type: 'learning_candidate'; candidate_version: 1; run_id: string; identity: LearningClaimIdentity; evidence: TranscriptUserRow[]; eligible_session_ids: string[]; }
export interface LearningAuthorityEvent extends EventBase { event_type: 'learning_authority'; authority_version: 1; run_id: string; identity: LearningClaimIdentity; authority: 'direct_user' | 'repetition'; evidence: TranscriptUserRow[]; session_ids: [string, string] | [string]; }
export interface LearningTransitionEvent extends EventBase { event_type: 'learning_transition'; transition_version: 1; brain_id: string; run_id: string; semantic_sequence: number; source_id: string; canonical_slug: string; transition: 'activate'; identity: LearningClaimIdentity; authority: 'direct_user' | 'repetition'; fact_row: number; }
export interface LearningCorrectionEvent extends EventBase { event_type: 'learning_correction'; correction_version: 1; brain_id: string; run_id: string; semantic_sequence: number; source_id: string; canonical_slug: string; predecessor: LearningClaimIdentity; replacement: LearningClaimIdentity; authority: 'direct_user' | 'repetition'; blocked_claim_key: string; predecessor_fact_row: number; replacement_fact_row: number; lineage_generation: number; replacement_set_fingerprint: string; }

export interface ContextSuppliedEvent extends EventBase { event_type: 'context_supplied'; version: 1; brain_id: string; run_id: string; semantic_sequence: number; provider: 'codex'; provider_session_id: string; source_id: string; request_hash: string; pointers: readonly { brain_id: string; source_id: string; canonical_slug: string; row_num: number }[]; claims: readonly { claim_fingerprint: string; class: string; scope: unknown; target: string | null; trigger: unknown }[]; item_count: number; token_estimate: number; }
export type LearningLoopEvent = RunArmedEvent | RunArmedEventV2 | RunAbortedEvent | AdapterSessionBoundEvent | SessionEvaluatedEvent | LearningCandidateEvent | LearningAuthorityEvent | LearningTransitionEvent | LearningCorrectionEvent | ContextSuppliedEvent;
export type EligibilityReason =
  | 'eligible'
  | 'transcript_too_small'
  | 'insufficient_user_turns'
  | 'insufficient_assistant_turns';

export interface RunProjection {
  run_id: string;
  terminal: boolean;
  armed: RunArmedEvent | RunArmedEventV2;
  cohort: Array<{ provider: 'codex'; provider_session_id: string; content_hash: string }>;
  sealed: boolean;
}

export interface LearningLoopProjection {
  events: LearningLoopEvent[];
  active_run_id: string | null;
  runs: Map<string, RunProjection>;
  session_hashes: Map<string, string>;
  session_events: Map<string, SessionEvaluatedEvent>;
  session_bindings: Map<string, AdapterSessionBoundEvent>;
}

export class LearningLoopError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'forbidden'
      | 'mode_off'
      | 'no_active_run'
      | 'run_active'
      | 'ledger_busy'
      | 'ledger_corrupt'
      | 'transcript_not_found'
      | 'transcript_ambiguous'
      | 'transcript_conflict'
      | 'command_conflict'
      | 'assertion_mismatch'
      | 'binding_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'LearningLoopError';
  }
}

export interface LedgerOptions {
  root?: string;
  /** Explicit active-brain identity input. Required outside the test-only root seam. */
  config?: Pick<GBrainConfig, 'database_url' | 'database_path'>;
  now?: () => Date;
  /** Test seam only. Production mutations use GBrain's refreshing database lock. */
  mutationLock?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Test seam only. Production lifecycle transitions use GBrain's refreshing lock. */
  lifecycleLock?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Test seam for real-lock contention coverage. */
  beforeMutation?: () => Promise<void>;
  /** Test seam for a process exit immediately after the mode intent is durable. */
  afterIntentPersist?: () => void | Promise<void>;
  /** Set only after a caller's post-discovery mode check. */
  precheckedMode?: LearningLoopMode;
}

/**
 * One bounded, crash-recoverable mode transition. It is deliberately stored
 * in the existing config plane and contains only exact delivery bytes; it is
 * not a learning queue or a source of authority.
 */
export interface ModeTransitionIntentV1 {
  schema_version: 1;
  run_id: string;
  command_id: string;
  requested_mode: 'off' | 'capture';
  reason: 'mode_changed';
  event: ExactEventRecordV1;
  brain_id: string;
  source_id: string;
  canonical_slug: string;
  corpus_binding?: CorpusBindingV1;
  destination_binding?: DestinationBindingV1;
  expected_prior_pending: ExactEventRecordV1 | null;
  intent_hash: string;
}

function modeTransitionIntentHash(value: Omit<ModeTransitionIntentV1, 'intent_hash'>): string {
  return canonicalSha256(value);
}

function decodeModeTransitionIntent(raw: string | null): ModeTransitionIntentV1 | null {
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new LearningLoopError('ledger_corrupt', 'Learning Loop mode transition intent is not JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LearningLoopError('ledger_corrupt', 'Learning Loop mode transition intent must be an object');
  const value = parsed as Record<string, unknown>;
  const allowed = ['schema_version', 'run_id', 'command_id', 'requested_mode', 'reason', 'event', 'brain_id', 'source_id', 'canonical_slug', 'corpus_binding', 'destination_binding', 'expected_prior_pending', 'intent_hash'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || value.schema_version !== 1 || typeof value.run_id !== 'string' || !value.run_id
    || !COMMAND_ID_RE.test(String(value.command_id)) || (value.requested_mode !== 'off' && value.requested_mode !== 'capture') || value.reason !== 'mode_changed'
    || typeof value.brain_id !== 'string' || !value.brain_id || typeof value.source_id !== 'string' || !value.source_id
    || typeof value.canonical_slug !== 'string' || !value.canonical_slug || !/^[a-f0-9]{64}$/.test(String(value.intent_hash))) {
    throw new LearningLoopError('ledger_corrupt', 'Learning Loop mode transition intent has an invalid shape');
  }
  const event = decodeExactEventRecordV1(value.event);
  const payload = JSON.parse(event.event_payload_canonical_json) as Record<string, unknown>;
  if (payload.event_type !== 'run_aborted' || payload.run_id !== value.run_id || payload.reason !== 'mode_changed'
    || payload.brain_id !== value.brain_id || payload.source_id !== value.source_id || payload.canonical_slug !== value.canonical_slug
    || event.brain_id !== value.brain_id || event.run_id !== value.run_id) {
    throw new LearningLoopError('ledger_corrupt', 'Mode transition event does not match its frozen identity');
  }
  const pending = value.expected_prior_pending === null ? null : decodeExactEventRecordV1(value.expected_prior_pending);
  if (pending && (pending.brain_id !== value.brain_id || pending.run_id !== value.run_id)) throw new LearningLoopError('ledger_corrupt', 'Mode transition predecessor does not match its frozen identity');
  if (value.corpus_binding !== undefined && !validCorpusBinding(value.corpus_binding)) throw new LearningLoopError('ledger_corrupt', 'Mode transition corpus binding is invalid');
  if (value.destination_binding !== undefined && !validDestinationBinding(value.destination_binding)) throw new LearningLoopError('ledger_corrupt', 'Mode transition destination binding is invalid');
  const withoutHash = { ...value } as Omit<ModeTransitionIntentV1, 'intent_hash'>;
  delete (withoutHash as Record<string, unknown>).intent_hash;
  if (modeTransitionIntentHash(withoutHash) !== value.intent_hash) throw new LearningLoopError('ledger_corrupt', 'Mode transition intent hash mismatch');
  return value as unknown as ModeTransitionIntentV1;
}

function ledgerScopeId(opts: LedgerOptions): string {
  if (opts.root) {
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(opts.root);
    } catch {
      canonicalRoot = resolve(opts.root);
    }
    return createHash('sha256').update(`root:${canonicalRoot}`).digest('hex').slice(0, 16);
  }
  if (!opts.config) {
    throw new LearningLoopError('invalid_input', 'Learning Loop ledger access requires explicit active-brain configuration');
  }
  return computeBrainIdFromConfig(opts.config);
}

function ledgerRoot(opts: LedgerOptions = {}): string {
  return opts.root ?? gbrainPath('learning-loop', ledgerScopeId(opts));
}

export function learningLoopLedgerPath(opts: LedgerOptions = {}): string {
  return join(ledgerRoot(opts), 'events-v1.jsonl');
}

export async function resolveLearningLoopMode(
  engine: Pick<BrainEngine, 'getConfig'>,
  config?: GBrainConfig,
): Promise<LearningLoopMode> {
  let dbValue: string | null;
  try {
    dbValue = await engine.getConfig('learning_loop.mode');
  } catch {
    return 'off';
  }
  const value = dbValue ?? config?.learning_loop?.mode ?? 'off';
  return value === 'capture' || value === 'canary' ? value : 'off';
}

export async function resolveCodexCorpus(
  engine: Pick<BrainEngine, 'getConfig'>,
  sourceId: string,
  config?: GBrainConfig,
): Promise<{ root: string; source_id: string }> {
  const configuredRoot = await engine.getConfig('learning_loop.corpus.codex.root').catch(() => null)
    ?? config?.learning_loop?.corpus?.codex?.root;
  const configuredSource = await engine.getConfig('learning_loop.corpus.codex.source_id').catch(() => null)
    ?? config?.learning_loop?.corpus?.codex?.source_id;
  if (!configuredRoot || !configuredSource || configuredSource !== sourceId) {
    throw new LearningLoopError('forbidden', 'No source-owned Codex transcript corpus is configured for this adapter');
  }
  try {
    const root = realpathSync(configuredRoot);
    if (!lstatSync(root).isDirectory()) throw new Error('not a directory');
    return { root, source_id: configuredSource };
  } catch {
    throw new LearningLoopError('transcript_not_found', 'Configured Codex transcript corpus root is unavailable');
  }
}

function configuredPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !value.startsWith('/')) {
    throw new LearningLoopError('forbidden', 'Learning Loop binding requires a non-empty absolute path');
  }
  return value;
}

function freezeRoot(preimage: CanonicalRootPreimageV1): Omit<RootBindingV1, 'binding_hash'> {
  const value = configuredPath(preimage.root.value);
  let canonical_realpath: string;
  try { canonical_realpath = realpathSync(value); } catch { throw new LearningLoopError('binding_unavailable', 'Learning Loop binding root is unavailable'); }
  let st: ReturnType<typeof statSync>;
  try { st = statSync(canonical_realpath); } catch { throw new LearningLoopError('binding_unavailable', 'Learning Loop binding root cannot be stated'); }
  if (!st.isDirectory()) throw new LearningLoopError('forbidden', 'Learning Loop binding root is not a directory');
  const configured_root_hash = canonicalSha256(preimage);
  return { configured_root_hash, canonical_realpath, device: st.dev, inode: st.ino };
}

export async function resolveCodexCorpusBinding(
  engine: Pick<BrainEngine, 'getConfig'>,
  sourceId: string,
  config?: GBrainConfig,
): Promise<CorpusBindingV1> {
  const read = async (key: string, fileValue: unknown): Promise<{ plane: 'db_config' | 'file_config'; value: string }> => {
    let db: string | null;
    try { db = await engine.getConfig(key); } catch { throw new LearningLoopError('binding_unavailable', `Unable to read ${key}`); }
    if (db !== null) return { plane: 'db_config', value: configuredPath(db) };
    return { plane: 'file_config', value: configuredPath(fileValue) };
  };
  const root = await read('learning_loop.corpus.codex.root', config?.learning_loop?.corpus?.codex?.root);
  let dbSource: string | null;
  try { dbSource = await engine.getConfig('learning_loop.corpus.codex.source_id'); } catch { throw new LearningLoopError('binding_unavailable', 'Unable to read corpus source'); }
  const source = dbSource !== null ? { plane: 'db_config' as const, value: dbSource } : { plane: 'file_config' as const, value: config?.learning_loop?.corpus?.codex?.source_id };
  if (typeof source.value !== 'string' || source.value.length === 0 || source.value.includes('\0') || source.value !== sourceId) throw new LearningLoopError('forbidden', 'Codex corpus source does not match adapter source');
  const preimage: CorpusConfiguredRootPreimageV1 = { schema_version: 1, binding_kind: 'corpus_codex', root: { plane: root.plane, key: 'learning_loop.corpus.codex.root', value: root.value }, source: { plane: source.plane, key: 'learning_loop.corpus.codex.source_id', value: source.value } };
  const frozen = freezeRoot(preimage);
  const binding = { source_id: sourceId, ...frozen };
  return { ...binding, binding_hash: canonicalSha256(binding) };
}

export function assertRootBindingUnchanged(binding: RootBindingV1, current: RootBindingV1): void {
  if (canonicalJson(binding) !== canonicalJson(current)) throw new LearningLoopError('assertion_mismatch', 'Learning Loop root binding changed');
}

export async function resolveLearningLoopDestinationBinding(
  engine: Pick<BrainEngine, 'getConfig' | 'executeRaw'>,
  brainId: string,
  sourceId: string,
  canonicalSlug: string,
): Promise<DestinationBindingV1> {
  if (!nonEmpty(brainId) || !nonEmpty(sourceId) || !nonEmpty(canonicalSlug) || canonicalSlug.includes('\0')) throw new LearningLoopError('invalid_input', 'Invalid Learning Loop destination');
  let rows: Array<{ local_path?: string | null }>;
  try { rows = await engine.executeRaw<{ local_path?: string | null }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]); }
  catch { throw new LearningLoopError('binding_unavailable', 'Unable to read destination source binding'); }
  const local = rows[0]?.local_path;
  let topology: DestinationBindingV1['topology'];
  let root: DestinationConfiguredRootPreimageV1['root'];
  if (local !== null && local !== undefined) {
    root = { plane: 'sources_row', key: 'sources.local_path', value: configuredPath(local) }; topology = 'source_local_path';
  } else if (sourceId === 'default') {
    let repo: string | null;
    try { repo = await engine.getConfig('sync.repo_path'); } catch { throw new LearningLoopError('binding_unavailable', 'Unable to read sync repository binding'); }
    root = { plane: 'db_config', key: 'sync.repo_path', value: configuredPath(repo) }; topology = 'sync_repo_path';
  } else throw new LearningLoopError('forbidden', 'Learning Loop destination source has no local path');
  const preimage: CanonicalRootPreimageV1 = { schema_version: 1, binding_kind: 'destination', source_id: sourceId, topology, root };
  const frozen = freezeRoot(preimage);
  const base = { brain_id: brainId, source_id: sourceId, canonical_slug: canonicalSlug, topology, ...frozen };
  return { ...base, binding_hash: canonicalSha256(base) };
}

export const resolveDestinationBinding = resolveLearningLoopDestinationBinding;

/** Replay-only validator for the V2 exact delivery stream. V1 events are ignored. */
export function validateExactEventSequence(records: readonly ExactEventRecordV1[]): void {
  const next = new Map<string, number>();
  const seen = new Map<string, string>();
  for (const raw of records) {
    const record = decodeExactEventRecordV1(raw);
    const key = `${record.brain_id}\u0000${record.run_id}`;
    const identity = canonicalJson(record);
    const prior = seen.get(`${key}\u0000${record.semantic_sequence}`);
    if (prior !== undefined && prior !== identity) throw new LearningLoopError('ledger_corrupt', 'Exact sequence has conflicting records');
    if (prior !== undefined) throw new LearningLoopError('ledger_corrupt', 'Exact sequence contains a duplicate');
    seen.set(`${key}\u0000${record.semantic_sequence}`, identity);
    const expected = next.get(key) ?? 1;
    if (record.semantic_sequence !== expected) throw new LearningLoopError('ledger_corrupt', 'Exact sequence is not contiguous');
    next.set(key, expected + 1);
  }
}

function isSessionFilename(name: string, sessionId: string): boolean {
  const extension = extname(name).toLowerCase();
  if (extension !== '.jsonl') return false;
  const stem = name.slice(0, -extension.length);
  return stem === sessionId || (extension === '.jsonl' && stem.endsWith(`-${sessionId}`));
}

function findSessionFiles(root: string, sessionId: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (pruneDir(entry.name, dir)) visit(path);
      } else if (entry.isFile() && isSessionFilename(entry.name, sessionId)) {
        found.push(path);
      }
    }
  };
  visit(root);
  return found.sort(compareUtf8);
}

function normalizeRelativePath(path: string, separator = sep): string {
  return path.split(separator).join('/');
}

function readConfinedFileOnce(root: string, path: string, afterOpen?: () => void): {
  bytes: Buffer;
  relative_path: string;
} {
  let fd: number | null = null;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('symlink');
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error('not a file');
    afterOpen?.();
    const resolved = realpathSync(path);
    if (!isPathContained(resolved, root)) throw new Error('escape');
    const rel = normalizeRelativePath(relative(root, resolved));
    if (!rel) throw new Error('escape');
    const linked = statSync(resolved);
    if (opened.dev !== linked.dev || opened.ino !== linked.ino) throw new Error('identity changed');
    return { bytes: readFileSync(fd), relative_path: rel };
  } catch {
    throw new LearningLoopError('transcript_not_found', 'Authoritative transcript cannot be read safely');
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const record = part as Record<string, unknown>;
    return typeof record.text === 'string' ? record.text : '';
  }).filter(Boolean).join('\n');
}

function countCodexJsonlRoles(text: string): { user: number; assistant: number } {
  let user = 0;
  let assistant = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const payload = row.type === 'response_item' && row.payload && typeof row.payload === 'object'
      ? row.payload as Record<string, unknown>
      : row;
    const role = payload.role;
    const body = extractText(payload.content ?? payload.text).trim();
    if (!body) continue;
    if (role === 'user') user += 1;
    if (role === 'assistant') assistant += 1;
  }
  return { user, assistant };
}

function codexSessionIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.type !== 'session_meta' || !row.payload || typeof row.payload !== 'object') continue;
      const id = (row.payload as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    } catch { /* malformed rows are ignored by the role parser */ }
  }
  return ids;
}

function codexSessionMetadata(text: string): { ids: Set<string>; completed_at: string | null } {
  const ids = new Set<string>();
  let terminalCompletedAt: string | null = null;
  let terminalCount = 0;
  let terminalIsFinalRow = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    terminalIsFinalRow = false;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const payload = row.payload as Record<string, unknown>;
      if (row.type === 'session_meta' && payload && typeof payload === 'object') {
        if (typeof payload.id === 'string' && payload.id.length > 0) ids.add(payload.id);
      }
      if (row.type === 'event_msg' && payload && typeof payload === 'object' && payload.type === 'task_complete') {
        terminalCount += 1;
        const completedAt = typeof payload.completed_at === 'string' ? payload.completed_at : null;
        terminalCompletedAt = completedAt !== null && Number.isFinite(Date.parse(completedAt))
          ? new Date(completedAt).toISOString()
          : null;
        terminalIsFinalRow = true;
      }
    } catch {
      return { ids, completed_at: null };
    }
  }
  return {
    ids,
    completed_at: terminalCount === 1 && terminalIsFinalRow ? terminalCompletedAt : null,
  };
}

function countTextRoles(text: string): { user: number; assistant: number } {
  const parsed = parseConversation(text);
  let user = 0;
  let assistant = 0;
  for (const message of parsed.messages) {
    if (!message.text.trim()) continue;
    const speaker = message.speaker.trim().toLowerCase();
    if (speaker === 'user') user += 1;
    if (speaker === 'assistant') assistant += 1;
  }
  return { user, assistant };
}

export async function resolveAuthoritativeTranscript(input: {
  engine: Pick<BrainEngine, 'getConfig'>;
  config?: GBrainConfig;
  expected_corpus_binding?: CorpusBindingV1;
  provider: 'codex';
  provider_session_id: string;
  source_id: string;
  asserted_relative_path?: string;
  asserted_completed_at?: string;
  asserted_size_bytes?: number;
  asserted_content_hash?: string;
}): Promise<TranscriptReceipt> {
  if (input.provider !== 'codex' || !SESSION_ID_RE.test(input.provider_session_id)) {
    throw new LearningLoopError('invalid_input', 'Invalid provider or provider session id');
  }
  let root: string;
  if (input.expected_corpus_binding) {
    const current = await resolveCodexCorpusBinding(input.engine, input.source_id, input.config);
    assertRootBindingUnchanged(input.expected_corpus_binding, current);
    root = current.canonical_realpath;
  } else {
    ({ root } = await resolveCodexCorpus(input.engine, input.source_id, input.config));
  }
  const matches = findSessionFiles(root, input.provider_session_id);
  if (matches.length === 0) throw new LearningLoopError('transcript_not_found', 'No transcript matches the authorized session');
  if (matches.length !== 1) throw new LearningLoopError('transcript_ambiguous', 'More than one transcript matches the authorized session');
  const { bytes, relative_path: rel } = readConfinedFileOnce(root, matches[0]);
  if (input.asserted_relative_path !== undefined && input.asserted_relative_path !== rel) {
    throw new LearningLoopError('assertion_mismatch', 'Adapter transcript path assertion does not match GBrain resolution');
  }
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  if (input.asserted_size_bytes !== undefined && input.asserted_size_bytes !== bytes.length) {
    throw new LearningLoopError('assertion_mismatch', 'Adapter transcript size assertion does not match GBrain bytes');
  }
  if (input.asserted_content_hash !== undefined && input.asserted_content_hash !== contentHash) {
    throw new LearningLoopError('assertion_mismatch', 'Adapter transcript hash assertion does not match GBrain bytes');
  }
  const text = bytes.toString('utf8');
  const metadata = codexSessionMetadata(text);
  if (metadata.ids.size !== 1 || !metadata.ids.has(input.provider_session_id) || metadata.completed_at === null) {
    throw new LearningLoopError('transcript_conflict', 'Codex transcript metadata does not match the submitted session');
  }
  if (
    input.asserted_completed_at !== undefined
    && (!Number.isFinite(Date.parse(input.asserted_completed_at))
      || new Date(input.asserted_completed_at).toISOString() !== metadata.completed_at)
  ) {
    throw new LearningLoopError('assertion_mismatch', 'Adapter completion time assertion does not match GBrain transcript metadata');
  }
  const counts = countCodexJsonlRoles(text);
  return {
    provider: 'codex',
    provider_session_id: input.provider_session_id,
    relative_path: rel,
    completed_at: metadata.completed_at,
    content_hash: contentHash,
    size_bytes: bytes.length,
    user_turn_count: counts.user,
    assistant_turn_count: counts.assistant,
  };
}

export type TranscriptMessageLocator = {
  provider_session_id: string;
  line: number;
  message_index: number;
  message_hash: string;
};

/** Re-open the authoritative transcript and derive one exact user message. */
export async function resolveAuthoritativeUserRow(input: {
  engine: Pick<BrainEngine, 'getConfig'>;
  config?: GBrainConfig;
  expected_corpus_binding: CorpusBindingV1;
  source_id: string;
  locator: TranscriptMessageLocator;
}): Promise<{ receipt: TranscriptReceipt; row: TranscriptUserRow }> {
  const receipt = await resolveAuthoritativeTranscript({
    engine: input.engine,
    config: input.config,
    expected_corpus_binding: input.expected_corpus_binding,
    provider: 'codex',
    provider_session_id: input.locator.provider_session_id,
    source_id: input.source_id,
  });
  const currentBinding = await resolveCodexCorpusBinding(input.engine, input.source_id, input.config);
  assertRootBindingUnchanged(input.expected_corpus_binding, currentBinding);
  const opened = readConfinedFileOnce(currentBinding.canonical_realpath, join(currentBinding.canonical_realpath, receipt.relative_path));
  const currentHash = createHash('sha256').update(opened.bytes).digest('hex');
  if (currentHash !== receipt.content_hash) throw new LearningLoopError('transcript_conflict', 'Authoritative transcript changed during evidence resolution');
  const rows = parseAuthoritativeUserRows(opened.bytes.toString('utf8'), receipt.provider_session_id, currentHash);
  const row = rows.find(candidate => candidate.line === input.locator.line && candidate.message_index === input.locator.message_index);
  if (!row || row.message_hash !== input.locator.message_hash) {
    throw new LearningLoopError('assertion_mismatch', 'Authoritative user-message locator does not match GBrain transcript bytes');
  }
  return { receipt, row };
}

export function classifyTranscript(receipt: TranscriptReceipt): { eligible: boolean; reason: EligibilityReason } {
  if (receipt.size_bytes < MIN_TRANSCRIPT_BYTES) return { eligible: false, reason: 'transcript_too_small' };
  if (receipt.user_turn_count < 2) return { eligible: false, reason: 'insufficient_user_turns' };
  if (receipt.assistant_turn_count < 2) return { eligible: false, reason: 'insufficient_assistant_turns' };
  return { eligible: true, reason: 'eligible' };
}

export function isActivatableClass(kind: import('./learning-loop-knowledge.ts').LearningClass): boolean {
  return kind === 'constraint' || kind === 'preference' || kind === 'goal' || kind === 'lesson' || kind === 'open_loop';
}
export function isCandidateOnlyClass(kind: import('./learning-loop-knowledge.ts').LearningClass): boolean {
  return kind === 'friction' || kind === 'business_candidate';
}
export function validateLearningClaimIdentity(value: unknown): asserts value is LearningClaimIdentity {
  if (!validIdentity(value)) throw new LearningLoopError('invalid_input', 'Learning Loop claim identity is not canonical or its fingerprint does not match');
}
export function qualifiesByRepetition(rows: readonly { identity_hash: string; provider_session_id: string; eligible: boolean }[]): boolean {
  const sessionsByIdentity = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.eligible) continue;
    const sessions = sessionsByIdentity.get(row.identity_hash) ?? new Set<string>();
    sessions.add(row.provider_session_id);
    sessionsByIdentity.set(row.identity_hash, sessions);
  }
  return [...sessionsByIdentity.values()].some(sessions => sessions.size >= 2);
}

function activeV2AdmissionRun(state: LearningLoopProjection, runId: string): RunProjection & { armed: RunArmedEventV2 } {
  const run = state.runs.get(runId);
  if (!run || run.terminal || state.active_run_id !== runId || run.armed.contract_version !== 2) {
    throw new LearningLoopError('no_active_run', 'Learning admission requires the active V2 run');
  }
  return run as RunProjection & { armed: RunArmedEventV2 };
}

async function deriveLearningEvidence(input: {
  engine: BrainEngine;
  config?: GBrainConfig;
  state: LearningLoopProjection;
  run: RunProjection & { armed: RunArmedEventV2 };
  source_id: string;
  identity: LearningClaimIdentity;
  locators: readonly TranscriptMessageLocator[];
}): Promise<{ rows: TranscriptUserRow[]; session_ids: string[]; occurred_at: string }> {
  if (input.source_id !== input.run.armed.authorized_adapter.source_id || input.source_id !== input.run.armed.corpus_binding.source_id) {
    throw new LearningLoopError('assertion_mismatch', 'Evidence source does not match the frozen run');
  }
  if (!Array.isArray(input.locators) || input.locators.length === 0 || input.locators.length > 2) {
    throw new LearningLoopError('invalid_input', 'Learning evidence requires one or two exact message locators');
  }
  const rows: TranscriptUserRow[] = [];
  const completed: string[] = [];
  for (const locator of input.locators) {
    if (!locator || !SESSION_ID_RE.test(locator.provider_session_id) || !Number.isSafeInteger(locator.line) || locator.line < 1
      || !Number.isSafeInteger(locator.message_index) || locator.message_index < 0 || !/^[a-f0-9]{64}$/.test(locator.message_hash)
      || Object.keys(locator).some(key => !['provider_session_id', 'line', 'message_index', 'message_hash'].includes(key))) {
      throw new LearningLoopError('invalid_input', 'Learning evidence locator is invalid');
    }
    const resolved = await resolveAuthoritativeUserRow({
      engine: input.engine,
      config: input.config,
      expected_corpus_binding: input.run.armed.corpus_binding,
      source_id: input.source_id,
      locator,
    });
    const accepted = input.state.session_events.get(`codex\u0000${locator.provider_session_id}`);
    if (!accepted?.eligible || accepted.run_id !== input.run.run_id || accepted.authoritative.content_hash !== resolved.receipt.content_hash) {
      throw new LearningLoopError('forbidden', 'Evidence session is not an accepted eligible session with unchanged transcript bytes');
    }
    if (normalizeLearningClaim(resolved.row.text) !== input.identity.claim) {
      throw new LearningLoopError('forbidden', 'Authoritative user message does not exactly state the normalized learning claim');
    }
    rows.push(resolved.row);
    completed.push(resolved.receipt.completed_at);
  }
  const session_ids = [...new Set(rows.map(row => row.provider_session_id))];
  return { rows, session_ids, occurred_at: completed.sort(compareUtf8).at(-1)! };
}

export async function recordLearningCandidate(input: {
  engine: BrainEngine;
  config?: GBrainConfig;
  run_id: string;
  source_id: string;
  identity: LearningClaimIdentity;
  locators: readonly TranscriptMessageLocator[];
}): Promise<LearningCandidateEvent> {
  validateLearningClaimIdentity(input.identity);
  return withLearningLoopAdmission(input.engine, { config: input.config }, async (state, mode) => {
    if (mode !== 'canary') throw new LearningLoopError('mode_off', 'Learning candidate admission requires canary mode');
    const run = activeV2AdmissionRun(state, input.run_id);
    const evidence = await deriveLearningEvidence({ ...input, state, run });
    const body = {
      schema_version: LEARNING_LOOP_SCHEMA_VERSION,
      event_type: 'learning_candidate' as const,
      candidate_version: 1 as const,
      occurred_at: evidence.occurred_at,
      run_id: input.run_id,
      identity: input.identity,
      evidence: evidence.rows,
      eligible_session_ids: evidence.session_ids,
    };
    const event = completeEvent(body) as LearningCandidateEvent;
    const prior = state.events.find(item => item.event_id === event.event_id);
    return prior ? { value: prior as LearningCandidateEvent } : { value: event, event };
  });
}

export async function recordLearningAuthority(input: {
  engine: BrainEngine;
  config?: GBrainConfig;
  run_id: string;
  source_id: string;
  identity: LearningClaimIdentity;
  authority: 'direct_user' | 'repetition';
  locators: readonly TranscriptMessageLocator[];
}): Promise<LearningAuthorityEvent> {
  validateLearningClaimIdentity(input.identity);
  return withLearningLoopAdmission(input.engine, { config: input.config }, async (state, mode) => {
    if (mode !== 'canary') throw new LearningLoopError('mode_off', 'Learning authority admission requires canary mode');
    const run = activeV2AdmissionRun(state, input.run_id);
    const evidence = await deriveLearningEvidence({ ...input, state, run });
    if (input.authority === 'direct_user' && evidence.session_ids.length !== 1) throw new LearningLoopError('forbidden', 'Direct user authority requires one exact session');
    if (input.authority === 'repetition' && !qualifiesByRepetition(evidence.session_ids.map(provider_session_id => ({ identity_hash: input.identity.claim_fingerprint!, provider_session_id, eligible: true })))) {
      throw new LearningLoopError('forbidden', 'Repetition authority requires two distinct eligible sessions');
    }
    if (input.authority !== 'direct_user' && input.authority !== 'repetition') throw new LearningLoopError('invalid_input', 'Learning authority kind is invalid');
    const candidate = state.events.find((event): event is LearningCandidateEvent => event.event_type === 'learning_candidate'
      && event.run_id === input.run_id && canonicalJson(event.identity) === canonicalJson(input.identity));
    if (!candidate) throw new LearningLoopError('forbidden', 'Authority requires an exact accepted candidate');
    const body = {
      schema_version: LEARNING_LOOP_SCHEMA_VERSION,
      event_type: 'learning_authority' as const,
      authority_version: 1 as const,
      occurred_at: evidence.occurred_at,
      run_id: input.run_id,
      identity: input.identity,
      authority: input.authority,
      evidence: evidence.rows,
      session_ids: evidence.session_ids as [string] | [string, string],
    };
    const event = completeEvent(body) as LearningAuthorityEvent;
    const prior = state.events.find(item => item.event_id === event.event_id);
    return prior ? { value: prior as LearningAuthorityEvent } : { value: event, event };
  });
}

export interface ActivateLearningClaimInput {
  engine: BrainEngine;
  config?: GBrainConfig;
  run_id: string;
  source_id: string;
  canonical_slug: string;
  identity: LearningClaimIdentity;
  authority: 'direct_user' | 'repetition';
  /** Optional test seam for the canonical source lock. */
  mutationLock?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Test-only crash seams around the canonical delivery protocol. */
  afterCanonicalStage?: () => void;
  afterLedgerAppend?: () => void;
  afterCanonicalClear?: () => void;
}

/** Activate one already-authorized claim. All checks happen before the page rename. */
export async function activateLearningClaim(input: ActivateLearningClaimInput): Promise<{ event: LearningTransitionEvent; canonical: string; row_num: number }> {
  validateLearningClaimIdentity(input.identity);
  if (!isActivatableClass(input.identity.class) || input.identity.class === 'friction' || input.identity.class === 'business_candidate') {
    throw new LearningLoopError('forbidden', 'Learning class is not activatable');
  }
  if (input.identity.class === 'lesson' && input.authority !== 'repetition') throw new LearningLoopError('forbidden', 'Lessons require repeated eligible sessions');
  if ((input.identity.class === 'constraint' || input.identity.class === 'preference' || input.identity.class === 'goal' || input.identity.class === 'open_loop') && input.authority !== 'direct_user') throw new LearningLoopError('forbidden', 'This class requires direct user authority');
  if (input.identity.class === 'open_loop' && !input.identity.trigger) throw new LearningLoopError('forbidden', 'Open loops require an exact pending trigger');
  const snapshotBinding = activeV2DestinationBinding({ config: input.config });
  if (!snapshotBinding || snapshotBinding.source_id !== input.source_id || snapshotBinding.canonical_slug !== input.canonical_slug) throw new LearningLoopError('assertion_mismatch', 'Activation target is not the active frozen destination');
  const snapshotTarget: SourceQualifiedCanonicalTarget = { brain_id: snapshotBinding.brain_id, source_id: snapshotBinding.source_id, canonical_slug: snapshotBinding.canonical_slug, configured_root: snapshotBinding.canonical_realpath };
  return withCanonicalSourceBoundary(input.engine, snapshotTarget, async lease => withLearningLoopLifecycleLock(input.engine, async () => {
    const admissionState = typeof input.engine.transaction === 'function'
      ? await input.engine.transaction(async tx => ({ mode: await resolveLearningLoopMode(tx, input.config), intent: await tx.getConfig('learning_loop.mode_transition_intent_v1') }))
      : { mode: await resolveLearningLoopMode(input.engine, input.config), intent: await input.engine.getConfig('learning_loop.mode_transition_intent_v1') };
    const mode = admissionState.mode;
    if (mode !== 'canary') throw new LearningLoopError('mode_off', 'Learning Loop activation requires canary mode');
    if (admissionState.intent !== null) throw new LearningLoopError('forbidden', 'Learning Loop activation is blocked by a mode transition intent');
    const state = replayLearningLoop(readLearningLoopLedger({ config: input.config }));
    const run = state.runs.get(input.run_id);
    if (!run || run.terminal || run.armed.contract_version !== 2) throw new LearningLoopError('no_active_run', 'Activation requires an active V2 run');
    const binding = run.armed.destination_binding;
    if (binding.brain_id !== computeBrainIdFromConfig(input.config ?? {}) || binding.source_id !== input.source_id || binding.canonical_slug !== input.canonical_slug) throw new LearningLoopError('assertion_mismatch', 'Activation destination does not match the frozen run');
    const currentCorpus = await resolveCodexCorpusBinding(input.engine, run.armed.corpus_binding.source_id, input.config);
    const currentDestination = await resolveLearningLoopDestinationBinding(input.engine, binding.brain_id, binding.source_id, binding.canonical_slug);
    assertRootBindingUnchanged(run.armed.corpus_binding, currentCorpus);
    assertRootBindingUnchanged(binding, currentDestination);
    const target: SourceQualifiedCanonicalTarget = { brain_id: binding.brain_id, source_id: binding.source_id, canonical_slug: binding.canonical_slug, configured_root: binding.canonical_realpath };
    const inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' });
    const fence = parseLearningLoopFence(inspected.canonical);
    if (!fence) throw new LearningLoopError('forbidden', 'Managed canonical state is unavailable');
    if (fence.value.pending_delivery !== null) {
      const pending = decodeExactEventRecordV1(fence.value.pending_delivery);
      const pendingEvent = eventFromExactRecord(pending);
      if (pendingEvent.event_type !== 'learning_transition' || pendingEvent.transition !== 'activate'
        || pendingEvent.run_id !== input.run_id || pendingEvent.brain_id !== binding.brain_id
        || pendingEvent.source_id !== input.source_id || pendingEvent.canonical_slug !== input.canonical_slug
        || canonicalJson(pendingEvent.identity) !== canonicalJson(input.identity) || pendingEvent.authority !== input.authority) {
        throw new LearningLoopError('ledger_corrupt', 'Canonical pending delivery does not match this exact activation');
      }
      const prior = state.events.find(event => event.event_id === pendingEvent.event_id);
      if (prior && canonicalJson(prior) !== canonicalJson(pendingEvent)) throw new LearningLoopError('ledger_corrupt', 'Pending delivery conflicts with the durable ledger');
      if (!prior) appendEvent(pending, { config: input.config });
      const delivered = readLearningLoopLedger({ config: input.config }).find(event => event.event_id === pendingEvent.event_id);
      if (!delivered || canonicalJson(delivered) !== canonicalJson(pendingEvent)) throw new LearningLoopError('ledger_corrupt', 'Pending delivery was not read back exactly');
      const clearedState = { ...fence.value, pending_delivery: null };
      const clearPermit = createLearningTransitionPermit(fence.value, clearedState);
      const clearedBody = inspected.canonical.replace(fence.raw, renderLearningLoopFence(clearedState));
      const clearedCanonical = await writeCanonicalPage(target, clearedBody, { mode: 'learning_transition', sourceLease: lease, transitionPermit: clearPermit, expectedManaged: 'expected' });
      const clearReadback = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      if (clearReadback.canonical !== clearedCanonical) throw new LearningLoopError('assertion_mismatch', 'Recovered canonical readback changed before derived reconciliation');
      await importFromContent(input.engine, input.canonical_slug, clearReadback.canonical, { sourceId: input.source_id, noEmbed: true, canonicalPermit: clearReadback.permit, canonicalReadback: clearReadback.canonical });
      return { event: pendingEvent, canonical: clearReadback.canonical, row_num: pendingEvent.fact_row };
    }
    const blockedKey = learningBlockedClaimKey(input.identity);
    if (fence.value.blocked_identities.includes(blockedKey) || fence.value.blocked_identities.includes(input.identity.claim_fingerprint!)) throw new LearningLoopError('forbidden', 'Claim is correction-blocked');
    const priorTransition = state.events.find((e): e is LearningTransitionEvent => e.event_type === 'learning_transition' && e.run_id === input.run_id && e.source_id === input.source_id && e.canonical_slug === input.canonical_slug && e.identity.claim_fingerprint === input.identity.claim_fingerprint);
    if (priorTransition) {
      const path = join(binding.canonical_realpath, `${input.canonical_slug}.md`);
      const canonical = readFileSync(path, 'utf8');
      const readback = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      if (readback.canonical !== canonical) throw new LearningLoopError('assertion_mismatch', 'Idempotent canonical readback changed');
      await importFromContent(input.engine, input.canonical_slug, canonical, { sourceId: input.source_id, noEmbed: true, canonicalPermit: readback.permit, canonicalReadback: canonical });
      return { event: priorTransition, canonical, row_num: priorTransition.fact_row };
    }
    const candidate = state.events.find((e): e is LearningCandidateEvent => e.event_type === 'learning_candidate' && e.run_id === input.run_id && e.identity.claim_fingerprint === input.identity.claim_fingerprint);
    const authority = state.events.find((e): e is LearningAuthorityEvent => e.event_type === 'learning_authority' && e.run_id === input.run_id && e.authority === input.authority && e.identity.claim_fingerprint === input.identity.claim_fingerprint);
    if (!candidate || !authority || canonicalJson(candidate.identity) !== canonicalJson(input.identity) || canonicalJson(authority.identity) !== canonicalJson(input.identity)) throw new LearningLoopError('forbidden', 'Candidate and authority must exactly match the activation identity');
      const factKind = input.identity.class === 'constraint' ? 'belief' : input.identity.class === 'preference' ? 'preference' : input.identity.class === 'goal' || input.identity.class === 'open_loop' ? 'commitment' : 'fact';
      const appended = upsertFactRow(inspected.canonical, { claim: input.identity.claim, kind: factKind, confidence: 1, visibility: 'private', notability: 'high', source: `learning-loop:${input.run_id}`, context: `learning_class:${input.identity.class}`, active: true });
      const lineage = reduceLearningLoopLineage(fence.value, { kind: 'activate', identity: input.identity, pointer: { identity: blockedKey, canonical_slug: input.canonical_slug, row_num: appended.rowNum } });
      const next: LearningLoopKnowledge = { ...lineage.next, managed_rows: { ...lineage.next.managed_rows, [input.identity.claim_fingerprint!]: makeLearningManagedRow(input.identity, appended.rowNum, true, input.run_id) }, pending_delivery: null };
      const sequence = state.events.filter(e => (e.event_type === 'learning_transition' || e.event_type === 'learning_correction') && e.brain_id === binding.brain_id && e.run_id === input.run_id).length + 1;
      const occurred_at = new Date().toISOString();
      const payload = { schema_version: 1 as const, event_type: 'learning_transition' as const, transition_version: 1 as const, brain_id: binding.brain_id, run_id: input.run_id, semantic_sequence: sequence, source_id: input.source_id, canonical_slug: input.canonical_slug, transition: 'activate' as const, identity: input.identity, authority: input.authority, fact_row: appended.rowNum, occurred_at };
      const event = completeEvent(payload) as LearningTransitionEvent;
      const pending = makeExactEventRecordV1({ event_payload: payload, brain_id: binding.brain_id, run_id: input.run_id, occurred_at, semantic_sequence: sequence });
      const pendingState = { ...next, pending_delivery: pending };
      const permit = createLearningTransitionPermit(fence.value, pendingState);
      const staged = renderLearningLoopFence(pendingState);
      const withFence = appended.body.replace(fence.raw, staged);
      const canonical = await writeCanonicalPage(target, withFence, { mode: 'learning_transition', sourceLease: lease, transitionPermit: permit, expectedManaged: 'expected' });
      input.afterCanonicalStage?.();
      appendEvent(pending, { config: input.config });
      input.afterLedgerAppend?.();
      const delivered = readLearningLoopLedger({ config: input.config }).find(item => item.event_id === event.event_id);
      if (!delivered || canonicalJson(delivered) !== canonicalJson(event)) {
        throw new LearningLoopError('ledger_corrupt', 'Canonical pending delivery was not read back exactly from the durable ledger');
      }
      const currentFence = parseLearningLoopFence(canonical);
      if (!currentFence) throw new LearningLoopError('ledger_corrupt', 'Activation canonical fence disappeared before clear');
      const cleared = canonical.replace(currentFence.raw, renderLearningLoopFence({ ...next, pending_delivery: null }));
      const clearPermit = createLearningTransitionPermit(parseLearningLoopFence(canonical)!.value, { ...next, pending_delivery: null });
      const clearedCanonical = await writeCanonicalPage(target, cleared, { mode: 'learning_transition', sourceLease: lease, transitionPermit: clearPermit, expectedManaged: 'expected' });
      input.afterCanonicalClear?.();
      const clearReadback = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      if (clearReadback.canonical !== clearedCanonical) throw new LearningLoopError('assertion_mismatch', 'Canonical clear readback changed before derived reconciliation');
      await importFromContent(input.engine, input.canonical_slug, clearReadback.canonical, { sourceId: input.source_id, noEmbed: true, canonicalPermit: clearReadback.permit, canonicalReadback: clearReadback.canonical });
    return { event, canonical: clearReadback.canonical, row_num: appended.rowNum };
  }, { config: input.config, mutationLock: input.mutationLock }));
}

export interface CorrectLearningClaimInput {
  engine: BrainEngine; config?: GBrainConfig; run_id: string; source_id: string; canonical_slug: string;
  predecessor: LearningClaimIdentity; replacement: LearningClaimIdentity;
  authority: 'direct_user' | 'repetition'; mutationLock?: <T>(work: () => Promise<T>) => Promise<T>;
  afterCanonicalStage?: () => void; afterLedgerAppend?: () => void; afterCanonicalClear?: () => void;
}

/** Atomically strike a managed predecessor and append its authoritative replacement. */
export async function correctLearningClaim(input: CorrectLearningClaimInput): Promise<{ event: LearningCorrectionEvent; canonical: string }> {
  validateLearningClaimIdentity(input.predecessor); validateLearningClaimIdentity(input.replacement);
  if (!['direct_user', 'repetition'].includes(input.authority)) throw new LearningLoopError('invalid_input', 'Correction authority is mandatory');
  if (input.replacement.class === 'lesson' ? input.authority !== 'repetition' : ['constraint','preference','goal','open_loop'].includes(input.replacement.class) && input.authority !== 'direct_user') throw new LearningLoopError('forbidden', 'Replacement authority does not satisfy its class predicate');
  if (!isActivatableClass(input.replacement.class) || input.replacement.class === 'friction' || input.replacement.class === 'business_candidate') throw new LearningLoopError('forbidden', 'Replacement class is not activatable');
  if (input.predecessor.claim_fingerprint === input.replacement.claim_fingerprint) throw new LearningLoopError('invalid_input', 'Correction replacement must differ from predecessor');
  const binding = activeV2DestinationBinding({ config: input.config });
  if (!binding || binding.source_id !== input.source_id || binding.canonical_slug !== input.canonical_slug) throw new LearningLoopError('assertion_mismatch', 'Correction target is not the active frozen destination');
  const target: SourceQualifiedCanonicalTarget = { brain_id: binding.brain_id, source_id: binding.source_id, canonical_slug: binding.canonical_slug, configured_root: binding.canonical_realpath };
  return withCanonicalSourceBoundary(input.engine, target, async lease => withLearningLoopLifecycleLock(input.engine, async () => {
    const admissionState = typeof input.engine.transaction === 'function'
      ? await input.engine.transaction(async tx => ({ mode: await resolveLearningLoopMode(tx, input.config), intent: await tx.getConfig('learning_loop.mode_transition_intent_v1') }))
      : { mode: await resolveLearningLoopMode(input.engine, input.config), intent: await input.engine.getConfig('learning_loop.mode_transition_intent_v1') };
    if (admissionState.mode !== 'canary') throw new LearningLoopError('mode_off', 'Learning Loop correction requires canary mode');
    if (admissionState.intent !== null) throw new LearningLoopError('forbidden', 'Learning Loop correction is blocked by a mode transition intent');
    const state = replayLearningLoop(readLearningLoopLedger({ config: input.config }));
    const run = state.runs.get(input.run_id);
    if (!run || run.terminal || run.armed.contract_version !== 2) throw new LearningLoopError('no_active_run', 'Correction requires an active V2 run');
    const frozen = run.armed.destination_binding;
    if (frozen.brain_id !== computeBrainIdFromConfig(input.config ?? {}) || frozen.source_id !== input.source_id || frozen.canonical_slug !== input.canonical_slug) throw new LearningLoopError('assertion_mismatch', 'Correction destination does not match the frozen run');
    const currentCorpus = await resolveCodexCorpusBinding(input.engine, run.armed.corpus_binding.source_id, input.config);
    const currentDestination = await resolveLearningLoopDestinationBinding(input.engine, frozen.brain_id, frozen.source_id, frozen.canonical_slug);
    assertRootBindingUnchanged(run.armed.corpus_binding, currentCorpus);
    assertRootBindingUnchanged(frozen, currentDestination);
    const currentTarget: SourceQualifiedCanonicalTarget = { brain_id: frozen.brain_id, source_id: frozen.source_id, canonical_slug: frozen.canonical_slug, configured_root: frozen.canonical_realpath };
    if (currentTarget.configured_root !== target.configured_root || currentTarget.brain_id !== target.brain_id) throw new LearningLoopError('assertion_mismatch', 'Correction target changed during admission');
    const inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' });
    const fence = parseLearningLoopFence(inspected.canonical); if (!fence) throw new LearningLoopError('forbidden', 'Managed canonical state is unavailable');
    if (fence.value.pending_delivery !== null) {
      const pending = decodeExactEventRecordV1(fence.value.pending_delivery); const pendingEvent = eventFromExactRecord(pending);
      if (pendingEvent.event_type !== 'learning_correction' || pendingEvent.run_id !== input.run_id || pendingEvent.source_id !== input.source_id || pendingEvent.canonical_slug !== input.canonical_slug || canonicalJson(pendingEvent.predecessor) !== canonicalJson(input.predecessor) || canonicalJson(pendingEvent.replacement) !== canonicalJson(input.replacement) || pendingEvent.authority !== input.authority) throw new LearningLoopError('ledger_corrupt', 'Pending correction does not match this exact request');
      const prior = state.events.find(e => e.event_id === pendingEvent.event_id); if (prior && canonicalJson(prior) !== canonicalJson(pendingEvent)) throw new LearningLoopError('ledger_corrupt', 'Pending correction conflicts with durable ledger');
      if (!prior) appendEvent(pending, { config: input.config });
      const delivered = readLearningLoopLedger({ config: input.config }).find(e => e.event_id === pendingEvent.event_id); if (!delivered || canonicalJson(delivered) !== canonicalJson(pendingEvent)) throw new LearningLoopError('ledger_corrupt', 'Pending correction readback mismatch');
      const clearedState = { ...fence.value, pending_delivery: null }; const cleared = await writeCanonicalPage(target, inspected.canonical.replace(fence.raw, renderLearningLoopFence(clearedState)), { mode: 'learning_transition', sourceLease: lease, transitionPermit: createLearningTransitionPermit(fence.value, clearedState), expectedManaged: 'expected' });
      const readback = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      if (readback.canonical !== cleared) throw new LearningLoopError('assertion_mismatch', 'Recovered correction canonical readback changed before derived reconciliation');
      await importFromContent(input.engine, input.canonical_slug, readback.canonical, { sourceId: input.source_id, noEmbed: true, canonicalPermit: readback.permit, canonicalReadback: readback.canonical });
      return { event: pendingEvent, canonical: readback.canonical };
    }
    const priorCorrection = state.events.find((e): e is LearningCorrectionEvent => e.event_type === 'learning_correction' && e.run_id === input.run_id && e.source_id === input.source_id && e.canonical_slug === input.canonical_slug && canonicalJson(e.predecessor) === canonicalJson(input.predecessor) && canonicalJson(e.replacement) === canonicalJson(input.replacement) && e.authority === input.authority);
    if (priorCorrection) { const readback = inspectExpectedManagedState(target, lease, { expected: 'expected' }); await importFromContent(input.engine, input.canonical_slug, readback.canonical, { sourceId: input.source_id, noEmbed: true, canonicalPermit: readback.permit, canonicalReadback: readback.canonical }); return { event: priorCorrection, canonical: readback.canonical }; }
    const predecessorKey = learningBlockedClaimKey(input.predecessor);
    const candidate = state.events.find((e): e is LearningCandidateEvent => e.event_type === 'learning_candidate' && e.run_id === input.run_id && e.identity.claim_fingerprint === input.replacement.claim_fingerprint);
    const authority = state.events.find((e): e is LearningAuthorityEvent => e.event_type === 'learning_authority' && e.run_id === input.run_id && e.identity.claim_fingerprint === input.replacement.claim_fingerprint && e.authority === input.authority);
    if (!candidate || !authority || canonicalJson(candidate.identity) !== canonicalJson(input.replacement) || canonicalJson(authority.identity) !== canonicalJson(input.replacement)) throw new LearningLoopError('forbidden', 'Correction replacement requires exact candidate and authority');
    const priorRow = (fence.value.managed_rows[input.predecessor.claim_fingerprint!] ?? {}) as Record<string, unknown>;
    const predecessorRow = Number(priorRow.row_num);
    if (!Number.isSafeInteger(predecessorRow) || predecessorRow < 1) throw new LearningLoopError('forbidden', 'Correction predecessor is not an active managed row');
    const parsed = parseFactsFence(inspected.canonical);
    const old = parsed.facts.find(row => row.rowNum === predecessorRow);
    if (!old || !old.active || (priorRow.identity as LearningClaimIdentity)?.claim !== input.predecessor.claim
      || canonicalJson((priorRow.identity as LearningClaimIdentity)) !== canonicalJson(input.predecessor)) throw new LearningLoopError('forbidden', 'Correction predecessor is not active');
    const struck = parsed.facts.map(row => row.rowNum === predecessorRow ? { ...row, active: false, context: `superseded by #${Math.max(...parsed.facts.map(f => f.rowNum), predecessorRow) + 1}` } : row);
    const bodyWithoutFence = inspected.canonical.replace(/<!--- gbrain:facts:begin -->[\s\S]*?<!--- gbrain:facts:end -->/, renderFactsTable(struck));
    const appended = upsertFactRow(bodyWithoutFence, { claim: input.replacement.claim, kind: input.replacement.class === 'constraint' ? 'belief' : input.replacement.class === 'preference' ? 'preference' : 'commitment', confidence: 1, visibility: 'private', notability: 'high', source: `learning-loop:${input.run_id}`, context: `learning_class:${input.replacement.class}`, active: true });
    const lineage = reduceLearningLoopLineage(fence.value, { kind: 'correct', predecessor: input.predecessor, replacement: { identity: learningBlockedClaimKey(input.replacement), canonical_slug: input.canonical_slug, row_num: appended.rowNum } });
    const retiredPredecessor = { ...priorRow, active: false };
    const next: LearningLoopKnowledge = { ...lineage.next, managed_rows: { ...lineage.next.managed_rows, [input.predecessor.claim_fingerprint!]: retiredPredecessor, [input.replacement.claim_fingerprint!]: makeLearningManagedRow(input.replacement, appended.rowNum, true, input.run_id) }, pending_delivery: null };
    const sequence = state.events.filter(e => (e.event_type === 'learning_transition' || e.event_type === 'learning_correction') && e.brain_id === binding.brain_id && e.run_id === input.run_id).length + 1;
    const occurred_at = new Date().toISOString();
    const payload = { schema_version: 1 as const, event_type: 'learning_correction' as const, correction_version: 1 as const, brain_id: binding.brain_id, run_id: input.run_id, semantic_sequence: sequence, source_id: input.source_id, canonical_slug: input.canonical_slug, predecessor: input.predecessor, replacement: input.replacement, authority: input.authority, blocked_claim_key: predecessorKey, predecessor_fact_row: predecessorRow, replacement_fact_row: appended.rowNum, lineage_generation: (lineage.next.correction_lineages[predecessorKey] as { lineage_generation: number }).lineage_generation, replacement_set_fingerprint: (lineage.next.correction_lineages[predecessorKey] as { replacement_set_fingerprint: string }).replacement_set_fingerprint, occurred_at };
    const event = completeEvent(payload) as LearningCorrectionEvent;
    const pending = makeExactEventRecordV1({ event_payload: payload, brain_id: binding.brain_id, run_id: input.run_id, occurred_at, semantic_sequence: sequence });
    const pendingState = { ...next, pending_delivery: pending };
    const staged = appended.body.replace(fence.raw, renderLearningLoopFence(pendingState));
    const canonical = await writeCanonicalPage(target, staged, { mode: 'learning_transition', sourceLease: lease, transitionPermit: createLearningTransitionPermit(fence.value, pendingState), expectedManaged: 'expected' });
    input.afterCanonicalStage?.();
    appendEvent(pending, { config: input.config });
    input.afterLedgerAppend?.();
    const delivered = readLearningLoopLedger({ config: input.config }).find(item => item.event_id === event.event_id);
    if (!delivered || canonicalJson(delivered) !== canonicalJson(event)) throw new LearningLoopError('ledger_corrupt', 'Correction event was not read back exactly');
    const clearedState = { ...next, pending_delivery: null };
    const currentFence = parseLearningLoopFence(canonical);
    if (!currentFence) throw new LearningLoopError('ledger_corrupt', 'Correction canonical fence disappeared before clear');
    const cleared = await writeCanonicalPage(target, canonical.replace(currentFence.raw, renderLearningLoopFence(clearedState)), { mode: 'learning_transition', sourceLease: lease, transitionPermit: createLearningTransitionPermit(pendingState, clearedState), expectedManaged: 'expected' });
    input.afterCanonicalClear?.();
    const readback = inspectExpectedManagedState(target, lease, { expected: 'expected' });
    if (readback.canonical !== cleared) throw new LearningLoopError('assertion_mismatch', 'Correction canonical clear readback changed before derived reconciliation');
    await importFromContent(input.engine, input.canonical_slug, readback.canonical, { sourceId: input.source_id, noEmbed: true, canonicalPermit: readback.permit, canonicalReadback: readback.canonical });
    return { event, canonical: readback.canonical };
  }, { config: input.config, mutationLock: input.mutationLock }));
}

export interface ReverseLearningClaimInput {
  engine: BrainEngine;
  config?: GBrainConfig;
  run_id: string;
  source_id: string;
  canonical_slug: string;
  /** Exact blocked identity to reinstate. No field may be inferred. */
  identity: LearningClaimIdentity;
  /** A durable direct-user authority event already present in the ledger. */
  authority_event_id: string;
  /** Stable retry identity. Defaults to the authority event identity. */
  root_reversal_id?: string;
  mutationLock?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Test seams. Each hook runs after the corresponding canonical phase is durable. */
  afterRetirement?: () => void;
  afterRebuild?: () => void;
  afterCommitIntent?: () => void;
  afterCanonicalStage?: () => void;
  afterLedgerAppend?: () => void;
  afterCanonicalClear?: () => void;
}

function learningFactKind(identity: LearningClaimIdentity): 'belief' | 'preference' | 'commitment' | 'fact' {
  if (identity.class === 'constraint') return 'belief';
  if (identity.class === 'preference') return 'preference';
  if (identity.class === 'goal' || identity.class === 'open_loop') return 'commitment';
  return 'fact';
}

function reversalAttemptValues(knowledge: LearningLoopKnowledge, rootId: string, blocked: string): LearningReversalAttempt[] {
  return Object.values(knowledge.reversal_attempts).filter((value): value is LearningReversalAttempt => {
    if (!value || typeof value !== 'object') return false;
    const attempt = value as Partial<LearningReversalAttempt>;
    return attempt.root_reversal_id === rootId && attempt.blocked_identity === blocked;
  });
}

function mergePointers(a: readonly LearningPointer[], b: readonly LearningPointer[]): LearningPointer[] {
  const out = [...a];
  for (const pointer of b) if (!out.some(existing => canonicalJson(existing) === canonicalJson(pointer))) out.push(pointer);
  out.sort((left, right) => compareUtf8(canonicalJson(left), canonicalJson(right)));
  return out;
}

function reversalTarget(binding: DestinationBindingV1): SourceQualifiedCanonicalTarget {
  return {
    brain_id: binding.brain_id,
    source_id: binding.source_id,
    canonical_slug: binding.canonical_slug,
    configured_root: binding.canonical_realpath,
  };
}

/**
 * Deliver one pre-existing canonical pending event before beginning a
 * reversal. This is the same exact-byte recovery rule used by activation and
 * correction; a reversal never regenerates a pending event.
 */
async function recoverPendingBeforeReversal(
  input: ReverseLearningClaimInput,
  target: SourceQualifiedCanonicalTarget,
  lease: Parameters<typeof withCanonicalSourceBoundary>[2] extends (value: infer T) => unknown ? T : never,
): Promise<string> {
  const inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' });
  const fence = parseLearningLoopFence(inspected.canonical);

  if (!fence || fence.value.pending_delivery === null) return inspected.canonical;
  const pending = decodeExactEventRecordV1(fence.value.pending_delivery);
  const event = eventFromExactRecord(pending);
  if (event.event_type !== 'learning_transition' && event.event_type !== 'learning_correction') {
    throw new LearningLoopError('ledger_corrupt', 'Reversal found an unsupported canonical pending event');
  }
  const prior = readLearningLoopLedger({ config: input.config }).find(item => item.event_id === event.event_id);
  if (prior && canonicalJson(prior) !== canonicalJson(event)) throw new LearningLoopError('ledger_corrupt', 'Canonical pending event conflicts with the ledger');
  if (!prior) appendEvent(pending, { config: input.config });
  input.afterLedgerAppend?.();
  const delivered = readLearningLoopLedger({ config: input.config }).find(item => item.event_id === event.event_id);
  if (!delivered || canonicalJson(delivered) !== canonicalJson(event)) throw new LearningLoopError('ledger_corrupt', 'Canonical pending event failed exact readback');
  const cleared = { ...fence.value, pending_delivery: null };
  const clearedBody = inspected.canonical.replace(fence.raw, renderLearningLoopFence(cleared));
  const clearedCanonical = await writeCanonicalPage(target, clearedBody, {
    mode: 'learning_transition', sourceLease: lease,
    transitionPermit: createLearningTransitionPermit(fence.value, cleared), expectedManaged: 'expected',
  });
  input.afterCanonicalClear?.();
  const readback = inspectExpectedManagedState(target, lease, { expected: 'expected' });
  if (readback.canonical !== clearedCanonical) throw new LearningLoopError('assertion_mismatch', 'Pending recovery canonical readback changed');
  await importFromContent(input.engine, input.canonical_slug, readback.canonical, {
    sourceId: input.source_id, noEmbed: true, canonicalPermit: readback.permit, canonicalReadback: readback.canonical,
  });
  return readback.canonical;
}

function writeReversalKnowledge(
  target: SourceQualifiedCanonicalTarget,
  lease: SourceWriteLease,
  canonical: string,
  previous: LearningLoopKnowledge,
  next: LearningLoopKnowledge,
): Promise<string> {
  const parsed = parseLearningLoopFence(canonical);
  if (!parsed) throw new LearningLoopError('forbidden', 'Managed canonical state is unavailable');
  const body = canonical.replace(parsed.raw, renderLearningLoopFence(next));
  return writeCanonicalPage(target, body, {
    mode: 'learning_transition', sourceLease: lease,
    transitionPermit: createLearningTransitionPermit(previous, next), expectedManaged: 'expected',
  });
}

/**
 * Reinstate one exact correction-blocked claim through the durable reversal
 * state machine. Every phase is stored in the canonical fence, so retrying a
 * process after any hook or import failure resumes from the last phase.
 */
export async function reverseLearningClaim(input: ReverseLearningClaimInput): Promise<{ phase: LearningReversalAttempt['phase']; root_reversal_id: string; canonical: string }> {
  validateLearningClaimIdentity(input.identity);
  if (!input.authority_event_id || !input.run_id || !input.source_id || !input.canonical_slug) throw new LearningLoopError('invalid_input', 'Reversal identity and authority are required');
  const blocked = learningBlockedClaimKey(input.identity);
  const rootId = input.root_reversal_id ?? `reversal:${input.authority_event_id}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(rootId)) throw new LearningLoopError('invalid_input', 'Invalid reversal root identity');
  const snapshot = activeV2DestinationBinding({ config: input.config });
  if (!snapshot || snapshot.source_id !== input.source_id || snapshot.canonical_slug !== input.canonical_slug) throw new LearningLoopError('assertion_mismatch', 'Reversal target is not the active frozen destination');
  const snapshotTarget = reversalTarget(snapshot);
  return withCanonicalSourceBoundary(input.engine, snapshotTarget, async lease => withLearningLoopLifecycleLock(input.engine, async () => {
    const admission = typeof input.engine.transaction === 'function'
      ? await input.engine.transaction(async tx => ({ mode: await resolveLearningLoopMode(tx, input.config), intent: await tx.getConfig('learning_loop.mode_transition_intent_v1') }))
      : { mode: await resolveLearningLoopMode(input.engine, input.config), intent: await input.engine.getConfig('learning_loop.mode_transition_intent_v1') };
    if (admission.mode !== 'canary') throw new LearningLoopError('mode_off', 'Learning Loop reversal requires canary mode');
    if (admission.intent !== null) throw new LearningLoopError('forbidden', 'Learning Loop reversal is blocked by a mode transition intent');
    let state = replayLearningLoop(readLearningLoopLedger({ config: input.config }));
    const run = state.runs.get(input.run_id);
    if (!run || run.terminal || state.active_run_id !== input.run_id || run.armed.contract_version !== 2) throw new LearningLoopError('no_active_run', 'Reversal requires an active V2 run');
    const binding = run.armed.destination_binding;
    if (binding.brain_id !== computeBrainIdFromConfig(input.config ?? {}) || binding.source_id !== input.source_id || binding.canonical_slug !== input.canonical_slug) throw new LearningLoopError('assertion_mismatch', 'Reversal destination does not match the frozen run');
    const currentCorpus = await resolveCodexCorpusBinding(input.engine, run.armed.corpus_binding.source_id, input.config);
    const currentDestination = await resolveLearningLoopDestinationBinding(input.engine, binding.brain_id, binding.source_id, binding.canonical_slug);
    assertRootBindingUnchanged(run.armed.corpus_binding, currentCorpus);
    assertRootBindingUnchanged(binding, currentDestination);
    const target = reversalTarget(binding);
    let canonical = await recoverPendingBeforeReversal(input, target, lease);
    let inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' });
    if (inspected.canonical !== canonical) canonical = inspected.canonical;
    let fence = parseLearningLoopFence(canonical);
    if (!fence) throw new LearningLoopError('forbidden', 'Managed canonical state is unavailable');
    const existingAttempts = reversalAttemptValues(fence.value, rootId, blocked);
    const committedAttempt = existingAttempts.find(value => value.phase === 'committed');
    if (committedAttempt && !fence.value.blocked_identities.includes(blocked)) return { phase: committedAttempt.phase, root_reversal_id: rootId, canonical };
    if (!fence.value.blocked_identities.includes(blocked)) throw new LearningLoopError('forbidden', 'Reversal requires the exact correction-blocked identity');
    const lineage = fence.value.correction_lineages[blocked];
    if (!lineage || typeof lineage !== 'object' || !Array.isArray((lineage as Record<string, unknown>).active_replacements) || !Number.isSafeInteger((lineage as Record<string, unknown>).lineage_generation)) throw new LearningLoopError('ledger_corrupt', 'Correction lineage is unavailable for reversal');
    let activeLineage = lineage as { active_replacements: LearningPointer[]; replacement_set_fingerprint: string; lineage_generation: number };
    if (replacementSetFingerprint(activeLineage.active_replacements) !== activeLineage.replacement_set_fingerprint) throw new LearningLoopError('ledger_corrupt', 'Correction lineage fingerprint is invalid');
    if (activeLineage.active_replacements.some(pointer => pointer.canonical_slug !== input.canonical_slug)) throw new LearningLoopError('assertion_mismatch', 'Reversal cannot cross canonical pages');
    const authority = state.events.find((event): event is LearningAuthorityEvent => event.event_id === input.authority_event_id);
    if (!authority || authority.event_type !== 'learning_authority' || authority.authority !== 'direct_user' || authority.run_id !== input.run_id || canonicalJson(authority.identity) !== canonicalJson(input.identity)) throw new LearningLoopError('forbidden', 'Reversal requires an exact direct-user authority event');

    let attempts = reversalAttemptValues(fence.value, rootId, blocked);
    let attempt = attempts.find(value => !['committed', 'failed'].includes(value.phase) && value.phase !== 'superseded');
    if (!attempts.length) {
      const started: LearningReversalAttempt = {
        root_reversal_id: rootId, attempt_no: 1, phase: 'started', blocked_identity: blocked,
        authority_event_id: input.authority_event_id, predecessor_generation: activeLineage.lineage_generation,
        predecessor_set_fingerprint: activeLineage.replacement_set_fingerprint,
        predecessor_replacements: activeLineage.active_replacements,
        inherited_replacements: activeLineage.active_replacements,
      };
      const reduced = reduceLearningLoopReversal(fence.value, { kind: 'start', attempt: started });
      canonical = await writeReversalKnowledge(target, lease, canonical, fence.value, reduced.next);
      input.afterCanonicalStage?.();
      inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      canonical = inspected.canonical;
      fence = parseLearningLoopFence(canonical)!;
      attempt = started;
    } else if (!attempt) {
      const terminal = attempts.find(value => value.phase === 'committed');
      if (terminal) return { phase: terminal.phase, root_reversal_id: rootId, canonical };
      throw new LearningLoopError('forbidden', 'Reversal attempt is terminal and cannot be retried');
    }

    for (;;) {
      const obligations = mergePointers(attempt.predecessor_replacements, attempt.inherited_replacements ?? []);
    if (attempt.phase === 'started') {
      const parsedFacts = parseFactsFence(canonical);
      if (parsedFacts.warnings.some(warning => warning.includes('UNBALANCED'))) throw new LearningLoopError('forbidden', 'Facts fence is unavailable for reversal');
      const rowNumbers = new Set(obligations.map(pointer => pointer.row_num));
      if (obligations.some(pointer => !parsedFacts.facts.some(row => row.rowNum === pointer.row_num))) throw new LearningLoopError('forbidden', 'Reversal replacement set is not present in canonical facts');
      const retiredFacts = parsedFacts.facts.map(row => rowNumbers.has(row.rowNum) ? { ...row, active: false, context: `reversal:${rootId}` } : row);
      const currentActive = activeLineage.active_replacements.filter(pointer => !rowNumbers.has(pointer.row_num));
      if (currentActive.length > 0) throw new LearningLoopError('assertion_mismatch', 'Reversal replacement set changed before retirement');
      const checkpoint: LearningReversalCheckpoint = {
        lineage_generation: activeLineage.lineage_generation + 1,
        replacement_set_fingerprint: replacementSetFingerprint(currentActive),
        active_replacements: currentActive,
        learning_event_sequence: Math.max(0, ...state.events
          .filter((event): event is LearningTransitionEvent | LearningCorrectionEvent => (event.event_type === 'learning_transition' || event.event_type === 'learning_correction')
            && event.brain_id === binding.brain_id && event.run_id === input.run_id)
          .map(event => event.semantic_sequence)),
      };
      const retiredKnowledgeBase: LearningLoopKnowledge = {
        ...fence.value,
        managed_rows: Object.fromEntries(Object.entries(fence.value.managed_rows).map(([key, value]) => rowNumbers.has(Number((value as Record<string, unknown>)?.row_num)) ? [key, { ...(value as Record<string, unknown>), active: false }] : [key, value])),
        correction_lineages: { ...fence.value.correction_lineages, [blocked]: { blocked_identity: blocked, active_replacements: currentActive, replacement_set_fingerprint: checkpoint.replacement_set_fingerprint, lineage_generation: checkpoint.lineage_generation } },
      };
      const reduced = reduceLearningLoopReversal(retiredKnowledgeBase, { kind: 'retired_checkpointed', checkpoint });
      const body = canonical.replace(fence.raw, renderLearningLoopFence(reduced.next)).replace(/<!--- gbrain:facts:begin -->[\s\S]*?<!--- gbrain:facts:end -->/, renderFactsTable(retiredFacts));
      const written = await writeCanonicalPage(target, body, { mode: 'learning_transition', sourceLease: lease, transitionPermit: createLearningTransitionPermit(fence.value, reduced.next), expectedManaged: 'expected' });
      input.afterCanonicalStage?.(); input.afterRetirement?.();
      const readback = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      if (readback.canonical !== written) throw new LearningLoopError('assertion_mismatch', 'Retirement canonical readback changed');
      await importFromContent(input.engine, input.canonical_slug, written, { sourceId: input.source_id, noEmbed: true, canonicalPermit: readback.permit, canonicalReadback: written });
      canonical = written;
      inspected = readback;
      fence = parseLearningLoopFence(canonical)!;
      attempt = fence.value.reversal_attempts[`${rootId}:${attempt.attempt_no}`] as LearningReversalAttempt;
    }

    if (attempt.phase === 'retired_checkpointed') {
      const checkpoint = attempt.checkpoint!;
      const proofId = canonicalSha256({ root_reversal_id: rootId, attempt_no: attempt.attempt_no, predecessor_replacements: attempt.predecessor_replacements, checkpoint, canonical: canonicalSha256(canonical) });
      const reduced = reduceLearningLoopReversal(fence.value, { kind: 'rebuild_verified', proof_id: proofId, checkpoint_hash: canonicalSha256(checkpoint) });
      canonical = await writeReversalKnowledge(target, lease, canonical, fence.value, reduced.next);
      input.afterRebuild?.(); input.afterCanonicalStage?.();
      inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' }); fence = parseLearningLoopFence(inspected.canonical)!; attempt = reduced.attempt;
    }

    if (attempt.phase === 'rebuild_verified') {
      const checkpoint = attempt.checkpoint!;
      const parsedFacts = parseFactsFence(canonical);
      const rowNum = Math.max(0, ...parsedFacts.facts.map(row => row.rowNum)) + 1;
      const reinstated: LearningPointer = { identity: blocked, canonical_slug: input.canonical_slug, row_num: rowNum };
      const finalStateHash = canonicalSha256({ blocked_identity: blocked, reinstated, checkpoint });
      const reduced = reduceLearningLoopReversal(fence.value, { kind: 'commit_intent', checkpoint_hash: canonicalSha256(checkpoint), final_state_hash: finalStateHash, reinstated });
      canonical = await writeReversalKnowledge(target, lease, canonical, fence.value, reduced.next);
      input.afterCommitIntent?.(); input.afterCanonicalStage?.();
      inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' }); fence = parseLearningLoopFence(inspected.canonical)!; attempt = reduced.attempt;
    }

    if (attempt.phase === 'commit_intent') {
      const intent = attempt.commit_intent!;
      const checkpoint = attempt.checkpoint!;
      const currentLineage = fence.value.correction_lineages[blocked] as { active_replacements: LearningPointer[]; replacement_set_fingerprint: string; lineage_generation: number };
      const checkpointMatches = currentLineage.lineage_generation === checkpoint.lineage_generation
        && currentLineage.replacement_set_fingerprint === checkpoint.replacement_set_fingerprint
        && canonicalJson(currentLineage.active_replacements) === canonicalJson(checkpoint.active_replacements);
      if (!checkpointMatches) {
        if (checkpoint.learning_event_sequence === undefined) {
          throw new LearningLoopError('assertion_mismatch', 'Reversal checkpoint watermark is unavailable');
        }
        const checkpointSequence = checkpoint.learning_event_sequence;
        const acceptedDrift = state.events
          .filter((event): event is LearningTransitionEvent | LearningCorrectionEvent => event.event_type === 'learning_transition' || event.event_type === 'learning_correction')
          .filter(event => event.run_id === input.run_id
            && event.source_id === input.source_id
            && event.canonical_slug === input.canonical_slug
            && event.semantic_sequence > checkpointSequence)
          .filter(event => {
            const pointerIdentity = event.event_type === 'learning_correction'
              ? event.replacement.claim_fingerprint
              : event.identity.claim_fingerprint;
            const rowNum = event.event_type === 'learning_correction' ? event.replacement_fact_row : event.fact_row;
            return currentLineage.active_replacements.some(pointer => pointer.identity === pointerIdentity
              && pointer.canonical_slug === event.canonical_slug && pointer.row_num === rowNum);
          })
          .sort((left, right) => right.semantic_sequence - left.semantic_sequence)[0];
        if (!acceptedDrift) throw new LearningLoopError('assertion_mismatch', 'Reversal checkpoint changed before final commit');
        const predecessorKey = `${rootId}:${attempt.attempt_no}`;
        const successor: LearningReversalAttempt = {
          root_reversal_id: rootId,
          attempt_no: attempt.attempt_no + 1,
          phase: 'started',
          blocked_identity: blocked as LearningReversalAttempt['blocked_identity'],
          authority_event_id: input.authority_event_id,
          predecessor_generation: currentLineage.lineage_generation,
          predecessor_set_fingerprint: currentLineage.replacement_set_fingerprint,
          predecessor_replacements: currentLineage.active_replacements,
          inherited_replacements: mergePointers(attempt.inherited_replacements ?? attempt.predecessor_replacements, currentLineage.active_replacements),
          predecessor_id: predecessorKey,
        };
        const reduced = reduceLearningLoopReversal(fence.value, { kind: 'supersede', successor });
        const written = await writeReversalKnowledge(target, lease, canonical, fence.value, reduced.next);
        input.afterCanonicalStage?.();
        const readback = inspectExpectedManagedState(target, lease, { expected: 'expected' });
        if (readback.canonical !== written) throw new LearningLoopError('assertion_mismatch', 'Reversal successor canonical readback changed');
        canonical = readback.canonical;
        inspected = readback;
        fence = parseLearningLoopFence(canonical)!;
        activeLineage = fence.value.correction_lineages[blocked] as { active_replacements: LearningPointer[]; replacement_set_fingerprint: string; lineage_generation: number };
        attempt = reduced.attempt;
        state = replayLearningLoop(readLearningLoopLedger({ config: input.config }));
        continue;
      }
      const parsedFacts = parseFactsFence(canonical);
      if (parsedFacts.facts.some(row => row.rowNum === intent.reinstated.row_num)) throw new LearningLoopError('assertion_mismatch', 'Reversal reinstatement row already exists with an unexpected state');
      const appended = upsertFactRow(canonical, { claim: input.identity.claim, kind: learningFactKind(input.identity), confidence: 1, visibility: 'private', notability: 'high', source: `learning-loop:${input.run_id}`, context: `reversal:${rootId}`, rowNum: intent.reinstated.row_num, active: true });
      if (appended.rowNum !== intent.reinstated.row_num) throw new LearningLoopError('assertion_mismatch', 'Reversal reinstatement row number changed');
      const managedRows = { ...fence.value.managed_rows, [input.identity.claim_fingerprint!]: makeLearningManagedRow(input.identity, appended.rowNum, true, input.run_id) };
      const finalLineage = { blocked_identity: blocked, active_replacements: [intent.reinstated], replacement_set_fingerprint: replacementSetFingerprint([intent.reinstated]), lineage_generation: checkpoint.lineage_generation + 1 };
      const finalBase: LearningLoopKnowledge = { ...fence.value, managed_rows: managedRows, correction_lineages: { ...fence.value.correction_lineages, [blocked]: finalLineage } };
      const marker = `${rootId}:${attempt.attempt_no}:${intent.final_state_hash}`;
      const reduced = reduceLearningLoopReversal(finalBase, { kind: 'committed', marker });
      const written = await writeReversalKnowledge(target, lease, appended.body, fence.value, reduced.next);
      input.afterCanonicalStage?.();
      const readback = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      if (readback.canonical !== written) throw new LearningLoopError('assertion_mismatch', 'Reversal final canonical readback changed');
      await importFromContent(input.engine, input.canonical_slug, written, { sourceId: input.source_id, noEmbed: true, canonicalPermit: readback.permit, canonicalReadback: written });
      input.afterCanonicalClear?.();
      canonical = readback.canonical;
      return { phase: 'committed', root_reversal_id: rootId, canonical };
    }
    if (attempt.phase === 'committed') return { phase: attempt.phase, root_reversal_id: rootId, canonical };
      throw new LearningLoopError('forbidden', `Reversal ended in nonterminal phase ${attempt.phase}`);
    }
  }, { config: input.config, mutationLock: input.mutationLock }));
}

interface BaselineManifestEntry extends BaselineCandidate {
  relative_path: string;
  size_bytes: number;
  user_turn_count: number;
  assistant_turn_count: number;
  eligible: boolean;
  reason: EligibilityReason;
}

interface BaselineManifestError {
  relative_path: string;
  error: 'invalid_or_unreadable' | 'duplicate_session_identity';
}

/** Skip an unreadable child tree; a denied corpus root must not arm empty. */
function handleBaselineWalkError(error: unknown, dir: string, root: string): void {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'EACCES' && code !== 'EPERM') throw error;
  if (dir === root) {
    throw new LearningLoopError('binding_unavailable', 'Baseline corpus root is unreadable');
  }
}

export async function discoverBaselineSnapshot(input: {
  engine: Pick<BrainEngine, 'getConfig'>;
  config?: GBrainConfig;
  expected_corpus_binding?: CorpusBindingV1;
  source_id: string;
  cutoff_at: string;
}): Promise<RunArmedEvent['baseline_discovery']> {
  const cutoffMs = Date.parse(input.cutoff_at);
  if (!Number.isFinite(cutoffMs)) throw new LearningLoopError('invalid_input', 'Baseline cutoff must be ISO 8601');
  let root: string;
  if (input.expected_corpus_binding) {
    const current = await resolveCodexCorpusBinding(input.engine, input.source_id, input.config);
    assertRootBindingUnchanged(input.expected_corpus_binding, current);
    root = current.canonical_realpath;
  } else {
    ({ root } = await resolveCodexCorpus(input.engine, input.source_id, input.config));
  }
  const paths: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      handleBaselineWalkError(error, dir, root);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (pruneDir(entry.name, dir)) visit(path);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.jsonl') {
        paths.push(path);
      }
    }
  };
  visit(root);
  paths.sort((a, b) => compareUtf8(relative(root, a), relative(root, b)));

  let ambiguous = false;
  const manifest: Array<BaselineManifestEntry | BaselineManifestError> = [];
  const seen = new Set<string>();
  for (const path of paths) {
    try {
      const { bytes, relative_path: rel } = readConfinedFileOnce(root, path);
      const text = bytes.toString('utf8');
      const metadata = codexSessionMetadata(text);
      const id = [...metadata.ids][0];
      if (metadata.ids.size !== 1 || !id || !SESSION_ID_RE.test(id) || metadata.completed_at === null) {
        ambiguous = true;
        continue;
      }
      const identity = `codex\u0000${id}`;
      if (seen.has(identity)) {
        ambiguous = true;
        manifest.push({ relative_path: rel, error: 'duplicate_session_identity' });
        continue;
      }
      seen.add(identity);
      const counts = countCodexJsonlRoles(text);
      const receipt: TranscriptReceipt = {
        provider: 'codex', provider_session_id: id, relative_path: rel,
        completed_at: metadata.completed_at,
        content_hash: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length,
        user_turn_count: counts.user, assistant_turn_count: counts.assistant,
      };
      const classification = classifyTranscript(receipt);
      manifest.push({
        provider: 'codex', provider_session_id: id, completed_at: receipt.completed_at,
        content_hash: receipt.content_hash, relative_path: rel, size_bytes: receipt.size_bytes,
        user_turn_count: receipt.user_turn_count, assistant_turn_count: receipt.assistant_turn_count,
        eligible: classification.eligible, reason: classification.reason,
      });
    } catch {
      ambiguous = true;
      manifest.push({ relative_path: normalizeRelativePath(relative(root, path)), error: 'invalid_or_unreadable' });
    }
  }
  manifest.sort((a, b) => compareUtf8(a.relative_path, b.relative_path));
  const candidates = orderBaselineCandidates(manifest
    .filter((entry): entry is BaselineManifestEntry => 'eligible' in entry && entry.eligible && Date.parse(entry.completed_at) < cutoffMs)
    .map(({ provider, provider_session_id, completed_at, content_hash }) => ({ provider, provider_session_id, completed_at, content_hash })));
  const status = ambiguous ? 'ambiguous' : candidates.length < TARGET_COHORT_SIZE ? 'insufficient' : 'complete';
  return {
    cutoff_at: new Date(cutoffMs).toISOString(),
    status,
    source_manifest_hash: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
    candidate_count: candidates.length,
    selected_candidates: status === 'complete' ? candidates.slice(0, TARGET_COHORT_SIZE) : [],
  };
}

function eventId(event: Omit<LearningLoopEvent, 'event_id'>): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

function completeEvent<T extends Omit<LearningLoopEvent, 'event_id'>>(event: T): LearningLoopEvent {
  return { ...event, event_id: eventId(event) } as unknown as LearningLoopEvent;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validIso(value: unknown): value is string {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function validAdapter(value: unknown): value is AdapterIdentity {
  if (!value || typeof value !== 'object') return false;
  const adapter = value as Partial<AdapterIdentity>;
  return adapter.provider === 'codex' && nonEmpty(adapter.client_id) && nonEmpty(adapter.source_id);
}

function validIdentity(value: unknown): value is LearningClaimIdentity {
  if (!value || typeof value !== 'object') return false;
  const x = value as LearningClaimIdentity;
  if (typeof x.claim !== 'string' || x.claim.length === 0 || x.claim.length > 4096 || /[\r\n\u0000-\u001f\u007f]/.test(x.claim) || x.claim.normalize('NFC') !== x.claim || normalizeLearningClaim(x.claim) !== x.claim || !isLearningClass(x.class) || !x.scope || typeof x.target !== 'string' && x.target !== null || !('trigger' in x)) return false;
  if (Object.keys(x).some(k => !['claim','class','scope','target','trigger','claim_fingerprint'].includes(k))) return false;
  if (x.scope.kind === 'global' && (x.target !== null || Object.keys(x.scope).length !== 1)) return false;
  if (x.scope.kind === 'repository' && (Object.keys(x.scope).length !== 2 || !/^repo:[^/\s:]+\/[^/\s:]+\/[^/\s:]+$/.test(x.scope.target) || x.target !== x.scope.target)) return false;
  if (x.scope.kind === 'project' && (Object.keys(x.scope).length !== 2 || typeof x.scope.target !== 'string' || !/^project:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(x.scope.target) || x.target !== x.scope.target)) return false;
  if (!['global', 'repository', 'project'].includes(x.scope.kind)) return false;
  if (x.class === 'open_loop' && (!x.trigger || typeof x.trigger !== 'object' || Object.keys(x.trigger).length !== 3 || Object.keys(x.trigger).some(k => !['kind','id','state'].includes(k)) || !/^[a-z][a-z0-9_-]{0,31}$/.test(x.trigger.kind) || !x.trigger.id || /[\r\n\u0000-\u001f\u007f]/.test(x.trigger.id) || x.trigger.state !== 'pending')) return false;
  if (x.class !== 'open_loop' && x.trigger !== null) return false;
  if (x.scope.kind !== 'global' && (typeof x.scope.target !== 'string' || !x.scope.target)) return false;
  return x.claim_fingerprint === learningClaimFingerprint({ claim: x.claim, class: x.class, scope: x.scope, target: x.target, trigger: x.trigger });
}
function isLearningClass(value: unknown): value is LearningClaimIdentity['class'] {
  return ['constraint','preference','goal','lesson','friction','open_loop','business_candidate'].includes(value as string);
}
function validEvidence(rows: unknown): rows is TranscriptUserRow[] {
  return Array.isArray(rows) && rows.length > 0 && rows.every(row => {
    if (!row || typeof row !== 'object') return false; const x = row as TranscriptUserRow;
    return x.provider === 'codex' && x.role === 'user' && SESSION_ID_RE.test(x.provider_session_id) && Number.isSafeInteger(x.line) && x.line > 0 && Number.isSafeInteger(x.message_index) && x.message_index >= 0 && typeof x.text === 'string' && x.text.trim() !== '' && /^[a-f0-9]{64}$/.test(x.message_hash) && /^[a-f0-9]{64}$/.test(x.transcript_hash);
  });
}

function validCandidate(value: unknown): value is BaselineCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BaselineCandidate>;
  return candidate.provider === 'codex'
    && nonEmpty(candidate.provider_session_id)
    && validIso(candidate.completed_at)
    && typeof candidate.content_hash === 'string'
    && /^[a-f0-9]{64}$/.test(candidate.content_hash);
}

function validRootBinding(value: unknown): value is RootBindingV1 {
  if (!value || typeof value !== 'object') return false;
  const b = value as Partial<RootBindingV1>;
  return /^[a-f0-9]{64}$/.test(b.configured_root_hash ?? '') && typeof b.canonical_realpath === 'string' &&
    b.canonical_realpath.startsWith('/') && Number.isSafeInteger(b.device) && Number.isSafeInteger(b.inode) &&
    /^[a-f0-9]{64}$/.test(b.binding_hash ?? '');
}

function validCorpusBinding(value: unknown): value is CorpusBindingV1 {
  if (!validRootBinding(value)) return false;
  const b = value as CorpusBindingV1;
  return nonEmpty(b.source_id) && b.binding_hash === canonicalSha256({ source_id: b.source_id,
    configured_root_hash: b.configured_root_hash, canonical_realpath: b.canonical_realpath,
    device: b.device, inode: b.inode });
}

function validDestinationBinding(value: unknown): value is DestinationBindingV1 {
  if (!validRootBinding(value)) return false;
  const b = value as DestinationBindingV1;
  return nonEmpty(b.brain_id) && nonEmpty(b.source_id) && nonEmpty(b.canonical_slug) &&
    (b.topology === 'source_local_path' || b.topology === 'sync_repo_path') &&
    b.binding_hash === canonicalSha256({ brain_id: b.brain_id, source_id: b.source_id, canonical_slug: b.canonical_slug,
      topology: b.topology, configured_root_hash: b.configured_root_hash, canonical_realpath: b.canonical_realpath,
      device: b.device, inode: b.inode });
}

function assertEventShape(event: LearningLoopEvent): void {
  const base = event as Partial<EventBase> & { event_type?: unknown };
  if (
    base.schema_version !== LEARNING_LOOP_SCHEMA_VERSION
    || !nonEmpty(base.event_id)
    || !validIso(base.occurred_at)
  ) {
    throw new LearningLoopError('ledger_corrupt', 'Learning Loop ledger event has an invalid base shape');
  }
  if (event.event_type === 'run_armed') {
    const selected = event.baseline_discovery?.selected_candidates;
    if (
      !nonEmpty(event.run_id)
      || !COMMAND_ID_RE.test(event.command_id)
      || !/^[a-f0-9]{64}$/.test(event.command_payload_hash)
      || (event.contract_version !== 1 && event.contract_version !== 2)
      || !nonEmpty(event.implementation_version)
      || event.provider_allow_list?.length !== 1
      || event.provider_allow_list[0] !== 'codex'
      || event.target_cohort_size !== TARGET_COHORT_SIZE
      || event.eligibility_classifier_version !== ELIGIBILITY_CLASSIFIER_VERSION
      || !validAdapter(event.authorized_adapter)
      || !validIso(event.baseline_discovery?.cutoff_at)
      || !['complete', 'insufficient', 'ambiguous'].includes(event.baseline_discovery?.status)
      || !/^[a-f0-9]{64}$/.test(event.baseline_discovery?.source_manifest_hash ?? '')
      || !Number.isInteger(event.baseline_discovery?.candidate_count)
      || event.baseline_discovery.candidate_count < 0
      || !Array.isArray(selected)
      || selected.length > TARGET_COHORT_SIZE
      || selected.length > event.baseline_discovery.candidate_count
      || (event.baseline_discovery.status === 'complete' && selected.length !== TARGET_COHORT_SIZE)
      || (event.baseline_discovery.status !== 'complete' && selected.length !== 0)
      || !selected.every(validCandidate)
      || canonicalJson(orderBaselineCandidates(selected)) !== canonicalJson(selected)
    ) {
      throw new LearningLoopError('ledger_corrupt', 'Learning Loop run_armed event has an invalid shape');
    }
    if (event.contract_version === 2) {
      if ('destination' in event || !validCorpusBinding(event.corpus_binding) || !validDestinationBinding(event.destination_binding)) {
        throw new LearningLoopError('ledger_corrupt', 'Learning Loop V2 run_armed event has an invalid binding');
      }
      if (event.corpus_binding.source_id !== event.authorized_adapter.source_id
        || event.destination_binding.source_id !== event.authorized_adapter.source_id) {
        throw new LearningLoopError('ledger_corrupt', 'Learning Loop V2 binding does not match its authorized adapter');
      }
    } else if (!nonEmpty(event.destination?.brain_id) || !nonEmpty(event.destination?.source_id) || !nonEmpty(event.destination?.canonical_slug)) {
      throw new LearningLoopError('ledger_corrupt', 'Learning Loop V1 run_armed event has an invalid destination');
    }
    return;
  }
  if (event.event_type === 'run_aborted') {
    if (
      !nonEmpty(event.run_id)
      || !COMMAND_ID_RE.test(event.command_id)
      || !/^[a-f0-9]{64}$/.test(event.command_payload_hash)
      || (event.reason !== 'owner_abort' && event.reason !== 'mode_changed')
      || Object.keys(event).some(key => !['schema_version', 'event_id', 'occurred_at', 'event_type', 'command_id', 'command_payload_hash', 'run_id', 'reason', 'brain_id', 'semantic_sequence', 'source_id', 'canonical_slug'].includes(key))
      || (event.brain_id !== undefined && !nonEmpty(event.brain_id))
      || (event.semantic_sequence !== undefined && (!Number.isSafeInteger(event.semantic_sequence) || event.semantic_sequence < 1))
      || ((event.brain_id === undefined) !== (event.semantic_sequence === undefined))
      || (event.source_id !== undefined && !nonEmpty(event.source_id))
      || (event.canonical_slug !== undefined && !nonEmpty(event.canonical_slug))
      || ((event.source_id === undefined) !== (event.canonical_slug === undefined))
    ) {
      throw new LearningLoopError('ledger_corrupt', 'Learning Loop run_aborted event has an invalid shape');
    }
    return;
  }
  if (event.event_type === 'adapter_session_bound') {
    if (
      !COMMAND_ID_RE.test(event.command_id)
      || !/^[a-f0-9]{64}$/.test(event.command_payload_hash)
      || !validAdapter(event.adapter)
      || !SESSION_ID_RE.test(event.provider_session_id)
    ) {
      throw new LearningLoopError('ledger_corrupt', 'Learning Loop adapter_session_bound event has an invalid shape');
    }
    return;
  }
  if (event.event_type === 'session_evaluated') {
    const receipt = event.authoritative;
    const validReason = ['eligible', 'transcript_too_small', 'insufficient_user_turns', 'insufficient_assistant_turns'].includes(event.reason);
    const validCounts = receipt
      && Number.isInteger(receipt.size_bytes) && receipt.size_bytes >= 0
      && Number.isInteger(receipt.user_turn_count) && receipt.user_turn_count >= 0
      && Number.isInteger(receipt.assistant_turn_count) && receipt.assistant_turn_count >= 0;
    if (
      (event.run_id !== null && !nonEmpty(event.run_id))
      || event.provider !== 'codex'
      || !SESSION_ID_RE.test(event.provider_session_id)
      || !validIso(event.completed_at)
      || event.completion_state !== 'completed'
      || !validAdapter(event.adapter)
      || event.classifier_version !== ELIGIBILITY_CLASSIFIER_VERSION
      || !validReason
      || event.eligible !== (event.reason === 'eligible')
      || !receipt
      || receipt.provider !== event.provider
      || receipt.provider_session_id !== event.provider_session_id
      || !nonEmpty(receipt.relative_path)
      || !validIso(receipt.completed_at)
      || receipt.completed_at !== event.completed_at
      || !/^[a-f0-9]{64}$/.test(receipt.content_hash)
      || !validCounts
      || (event.cohort_member && (!event.eligible || event.run_id === null))
      || (event.cohort_member && (!Number.isInteger(event.cohort_position) || event.cohort_position! < 1 || event.cohort_position! > TARGET_COHORT_SIZE))
      || (!event.cohort_member && event.cohort_position !== null)
      || (event.cohort_sealed && (!event.cohort_member || event.cohort_position !== TARGET_COHORT_SIZE))
    ) {
      throw new LearningLoopError('ledger_corrupt', 'Learning Loop session_evaluated event has an invalid shape');
    }
    return;
  }
  if (event.event_type === 'learning_candidate' || event.event_type === 'learning_authority') {
    const value = event as LearningCandidateEvent | LearningAuthorityEvent;
    if (!nonEmpty(value.run_id) || !validIdentity(value.identity) || !validEvidence(value.evidence)
      || Object.keys(value).some(k => !['schema_version','event_id','occurred_at','event_type','candidate_version','authority_version','run_id','identity','evidence','eligible_session_ids','authority','session_ids'].includes(k))) {
      throw new LearningLoopError('ledger_corrupt', 'Learning Loop learning event has an invalid exact shape');
    }
    if (event.event_type === 'learning_candidate' && ((value as LearningCandidateEvent).candidate_version !== 1 || !Array.isArray((value as LearningCandidateEvent).eligible_session_ids) || (value as LearningCandidateEvent).eligible_session_ids.some(id => !SESSION_ID_RE.test(id)) || 'authority' in value || 'session_ids' in value)) throw new LearningLoopError('ledger_corrupt', 'Learning Loop candidate variant is invalid');
    if (event.event_type === 'learning_authority' && ((value as LearningAuthorityEvent).authority_version !== 1 || 'candidate_version' in value || ((value as LearningAuthorityEvent).authority !== 'direct_user' && (value as LearningAuthorityEvent).authority !== 'repetition') || !Array.isArray((value as LearningAuthorityEvent).session_ids) || (value as LearningAuthorityEvent).session_ids.length < 1 || (value as LearningAuthorityEvent).session_ids.length > 2)) {
      throw new LearningLoopError('ledger_corrupt', 'Learning Loop authority event has an invalid authority');
    }
    return;
  }
  if (event.event_type === 'learning_transition') {
    const value = event as LearningTransitionEvent;
    if (Object.keys(value).some(key => !['schema_version','event_id','occurred_at','event_type','transition_version','brain_id','run_id','semantic_sequence','source_id','canonical_slug','transition','identity','authority','fact_row'].includes(key))) {
      throw new LearningLoopError('ledger_corrupt', 'Learning Loop transition event has an unknown field');
    }
    if (value.transition_version !== 1 || value.transition !== 'activate' || !nonEmpty(value.brain_id) || !nonEmpty(value.run_id)
      || !Number.isSafeInteger(value.semantic_sequence) || value.semantic_sequence < 1 || !nonEmpty(value.source_id)
      || !nonEmpty(value.canonical_slug) || !validIdentity(value.identity)
      || (value.authority !== 'direct_user' && value.authority !== 'repetition') || !Number.isSafeInteger(value.fact_row) || value.fact_row < 1) {
      throw new LearningLoopError('ledger_corrupt', 'Learning Loop transition event has an invalid shape');
    }
    return;
  }
  if (event.event_type === 'learning_correction') {
    const value = event as LearningCorrectionEvent;
    if (Object.keys(value).some(key => !['schema_version','event_id','occurred_at','event_type','correction_version','brain_id','run_id','semantic_sequence','source_id','canonical_slug','predecessor','replacement','authority','blocked_claim_key','predecessor_fact_row','replacement_fact_row','lineage_generation','replacement_set_fingerprint'].includes(key))
      || value.correction_version !== 1 || !nonEmpty(value.brain_id) || !nonEmpty(value.run_id) || !Number.isSafeInteger(value.semantic_sequence) || value.semantic_sequence < 1
      || !nonEmpty(value.source_id) || !nonEmpty(value.canonical_slug) || !validIdentity(value.predecessor) || !validIdentity(value.replacement) || (value.authority !== 'direct_user' && value.authority !== 'repetition')
      || !/^[a-f0-9]{64}$/.test(value.blocked_claim_key) || !Number.isSafeInteger(value.predecessor_fact_row) || value.predecessor_fact_row < 1
      || !Number.isSafeInteger(value.replacement_fact_row) || value.replacement_fact_row < 1 || !Number.isSafeInteger(value.lineage_generation) || value.lineage_generation < 1
      || !/^[a-f0-9]{64}$/.test(value.replacement_set_fingerprint)
      || value.blocked_claim_key !== learningBlockedClaimKey(value.predecessor)
      || value.replacement.claim_fingerprint !== learningBlockedClaimKey(value.replacement)
      || value.predecessor.claim_fingerprint !== value.blocked_claim_key
      || value.predecessor_fact_row === value.replacement_fact_row) {
      throw new LearningLoopError('ledger_corrupt', 'Learning Loop correction event has an invalid shape');
    }
    return;
  }
  if (event.event_type === 'context_supplied') {
    const value = event as ContextSuppliedEvent;
    const pointerKeys = ['brain_id','source_id','canonical_slug','row_num'];
    const claimKeys = ['claim_fingerprint','class','scope','target','trigger'];
    const validScope = (raw: unknown): raw is LearningClaimIdentity['scope'] => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const s = raw as Record<string, unknown>;
      if (s.kind === 'global') return Object.keys(s).length === 1;
      if (s.kind === 'repository') return Object.keys(s).length === 2 && typeof s.target === 'string' && /^repo:[^/\s:]+\/[^/\s:]+\/[^/\s:]+$/.test(s.target);
      return s.kind === 'project' && Object.keys(s).length === 2 && typeof s.target === 'string' && /^project:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(s.target);
    };
    const validClaim = (raw: unknown): boolean => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const c = raw as Record<string, unknown>;
      if (Object.keys(c).some((key) => !claimKeys.includes(key)) || !/^[a-f0-9]{64}$/.test(String(c.claim_fingerprint)) || !['constraint','preference','goal','lesson','open_loop'].includes(String(c.class)) || !validScope(c.scope) || (c.scope.kind === 'global' ? c.target !== null : c.target !== c.scope.target)) return false;
      if (c.class === 'open_loop') { const t = c.trigger; return !!t && typeof t === 'object' && !Array.isArray(t) && Object.keys(t).length === 3 && (t as Record<string, unknown>).state === 'pending' && typeof (t as Record<string, unknown>).kind === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test((t as Record<string, unknown>).kind as string) && typeof (t as Record<string, unknown>).id === 'string' && !!(t as Record<string, unknown>).id; }
      return c.trigger === null;
    };
    if (Object.keys(value).some((key) => !['schema_version','event_id','occurred_at','event_type','version','brain_id','run_id','semantic_sequence','provider','provider_session_id','source_id','request_hash','pointers','claims','item_count','token_estimate'].includes(key)) || value.schema_version !== LEARNING_LOOP_SCHEMA_VERSION || value.version !== 1 || !nonEmpty(value.brain_id) || !nonEmpty(value.run_id) || !Number.isSafeInteger(value.semantic_sequence) || value.semantic_sequence < 1 || value.provider !== 'codex' || !SESSION_ID_RE.test(value.provider_session_id) || !nonEmpty(value.source_id) || !/^[a-f0-9]{64}$/.test(value.request_hash) || !Array.isArray(value.pointers) || !Array.isArray(value.claims) || value.pointers.length !== value.claims.length || value.pointers.length > 5 || value.item_count !== value.pointers.length || !Number.isSafeInteger(value.token_estimate) || value.token_estimate < 0 || value.token_estimate > 800 || value.pointers.some((p) => !p || Object.keys(p).some((key) => !pointerKeys.includes(key)) || p.brain_id !== value.brain_id || p.source_id !== value.source_id || !nonEmpty(p.canonical_slug) || !Number.isSafeInteger(p.row_num) || p.row_num < 1) || value.claims.some((c) => !validClaim(c))) throw new LearningLoopError('ledger_corrupt', 'Learning Loop context event has an invalid shape');
    return;
  }
  throw new LearningLoopError('ledger_corrupt', 'Learning Loop ledger contains an unknown event type');
}

function verifyEvent(event: LearningLoopEvent): void {
  assertEventShape(event);
  const { event_id, ...body } = event;
  if (event.schema_version !== LEARNING_LOOP_SCHEMA_VERSION || eventId(body as Omit<LearningLoopEvent, 'event_id'>) !== event_id) {
    throw new LearningLoopError('ledger_corrupt', 'Learning Loop ledger event failed its content hash');
  }
}

type LearningLoopLedgerRecord = LearningLoopEvent | ExactEventRecordV1;

function isExactEventRecord(value: LearningLoopLedgerRecord): value is ExactEventRecordV1 {
  return 'event_payload_canonical_json' in value;
}

function eventFromExactRecord(value: ExactEventRecordV1): LearningLoopEvent {
  const record = decodeExactEventRecordV1(value);
  const payload = JSON.parse(record.event_payload_canonical_json) as Record<string, unknown>;
  if ('event_id' in payload) throw new LearningLoopError('ledger_corrupt', 'Exact event payload must not contain event_id');
  return { ...payload, event_id: record.event_id } as unknown as LearningLoopEvent;
}

export function replayLearningLoop(records: LearningLoopLedgerRecord[]): LearningLoopProjection {
  const projection: LearningLoopProjection = {
    events: [], active_run_id: null, runs: new Map(), session_hashes: new Map(), session_events: new Map(), session_bindings: new Map(),
  };
  validateExactEventSequence(records.filter(isExactEventRecord));
  const ids = new Map<string, string>();
  const commands = new Set<string>();
  for (const ledgerRecord of records) {
    const event = isExactEventRecord(ledgerRecord) ? eventFromExactRecord(ledgerRecord) : ledgerRecord;
    verifyEvent(event);
    const canonical = canonicalJson(event);
    const prior = ids.get(event.event_id);
    if (prior !== undefined) {
      if (prior !== canonical) throw new LearningLoopError('ledger_corrupt', 'Conflicting duplicate event id');
      continue;
    }
    ids.set(event.event_id, canonical);
    if (event.event_type === 'run_armed' || event.event_type === 'run_aborted' || event.event_type === 'adapter_session_bound') {
      const commandKey = `${event.event_type}\u0000${event.command_id}`;
      if (commands.has(commandKey)) throw new LearningLoopError('ledger_corrupt', 'A command identity has more than one ledger event');
      commands.add(commandKey);
    }
    if (event.event_type === 'run_armed') {
      if (projection.active_run_id !== null) throw new LearningLoopError('ledger_corrupt', 'Ledger contains overlapping active runs');
      if (projection.runs.has(event.run_id)) throw new LearningLoopError('ledger_corrupt', 'Run id was reused');
      projection.runs.set(event.run_id, { run_id: event.run_id, terminal: false, armed: event, cohort: [], sealed: false });
      projection.active_run_id = event.run_id;
    } else if (event.event_type === 'run_aborted') {
      const run = projection.runs.get(event.run_id);
      if (!run || run.terminal || projection.active_run_id !== event.run_id) {
        throw new LearningLoopError('ledger_corrupt', 'Abort does not match the active run');
      }
      run.terminal = true;
      projection.active_run_id = null;
    } else if (event.event_type === 'adapter_session_bound') {
      const key = `${event.adapter.provider}\u0000${event.provider_session_id}`;
      if (projection.session_bindings.has(key)) {
        throw new LearningLoopError('ledger_corrupt', 'A provider session has more than one adapter binding');
      }
      projection.session_bindings.set(key, event);
    } else if (event.event_type === 'learning_candidate' || event.event_type === 'learning_authority') {
      const run = projection.runs.get(event.run_id);
      if (!run || run.terminal) throw new LearningLoopError('ledger_corrupt', 'Learning event references a missing or terminal run');
      const sessions = [...new Set(event.evidence.map(row => row.provider_session_id))];
      for (const row of event.evidence) {
        const session = projection.session_events.get(`codex\u0000${row.provider_session_id}`);
        const expectedMessageHash = createHash('sha256').update(row.text.normalize('NFKC').trim()).digest('hex');
        if (!session?.eligible || session.run_id !== event.run_id || session.authoritative.content_hash !== row.transcript_hash
          || expectedMessageHash !== row.message_hash || normalizeLearningClaim(row.text) !== event.identity.claim) {
          throw new LearningLoopError('ledger_corrupt', 'Learning evidence does not match its accepted authoritative session and exact claim');
        }
      }
      if (event.event_type === 'learning_candidate') {
        if (canonicalJson(event.eligible_session_ids) !== canonicalJson(sessions)) throw new LearningLoopError('ledger_corrupt', 'Candidate session identities do not exactly equal its evidence sessions');
        for (const id of event.eligible_session_ids) {
          const session = projection.session_events.get(`codex\u0000${id}`);
          if (!session?.eligible) throw new LearningLoopError('ledger_corrupt', 'Candidate evidence is not an eligible session');
        }
      } else {
        if (event.authority === 'direct_user' && sessions.length !== 1) throw new LearningLoopError('ledger_corrupt', 'Direct authority requires one session');
        if (event.authority === 'repetition' && sessions.length < 2) throw new LearningLoopError('ledger_corrupt', 'Repetition authority requires two sessions');
        if (sessions.some(id => !projection.session_events.get(`codex\u0000${id}`)?.eligible)) throw new LearningLoopError('ledger_corrupt', 'Authority evidence is not eligible');
        if (canonicalJson(event.session_ids) !== canonicalJson(sessions)) throw new LearningLoopError('ledger_corrupt', 'Authority session identities do not exactly equal its evidence sessions');
      }
      projection.events.push(event);
      continue;
    } else if (event.event_type === 'learning_transition') {
      const run = projection.runs.get(event.run_id);
      if (!run || run.terminal || run.armed.contract_version !== 2 || run.armed.destination_binding.brain_id !== event.brain_id
        || run.armed.destination_binding.source_id !== event.source_id || run.armed.destination_binding.canonical_slug !== event.canonical_slug) {
        throw new LearningLoopError('ledger_corrupt', 'Learning transition does not match the active V2 destination');
      }
      const priorLearningEvents = projection.events.filter((prior): prior is LearningTransitionEvent | LearningCorrectionEvent =>
        (prior.event_type === 'learning_transition' || prior.event_type === 'learning_correction')
        && prior.brain_id === event.brain_id && prior.run_id === event.run_id);
      if (event.semantic_sequence !== priorLearningEvents.length + 1) {
        throw new LearningLoopError('ledger_corrupt', 'Learning transition semantic sequence is not contiguous');
      }
      projection.events.push(event);
      continue;
    } else if (event.event_type === 'learning_correction') {
      const run = projection.runs.get(event.run_id);
      if (!run || run.terminal || run.armed.contract_version !== 2 || run.armed.destination_binding.brain_id !== event.brain_id
        || run.armed.destination_binding.source_id !== event.source_id || run.armed.destination_binding.canonical_slug !== event.canonical_slug) {
        throw new LearningLoopError('ledger_corrupt', 'Learning correction does not match the active V2 destination');
      }
      const priorLearningEvents = projection.events.filter((prior): prior is LearningTransitionEvent | LearningCorrectionEvent =>
        (prior.event_type === 'learning_transition' || prior.event_type === 'learning_correction')
        && prior.brain_id === event.brain_id && prior.run_id === event.run_id);
      if (event.semantic_sequence !== priorLearningEvents.length + 1) {
        throw new LearningLoopError('ledger_corrupt', 'Learning correction semantic sequence is not contiguous');
      }
      const predecessorTransition = priorLearningEvents.find((prior): prior is LearningTransitionEvent =>
        prior.event_type === 'learning_transition' && canonicalJson(prior.identity) === canonicalJson(event.predecessor));
      const candidate = projection.events.find((prior): prior is LearningCandidateEvent =>
        prior.event_type === 'learning_candidate' && prior.run_id === event.run_id
        && canonicalJson(prior.identity) === canonicalJson(event.replacement));
      const authority = projection.events.find((prior): prior is LearningAuthorityEvent =>
        prior.event_type === 'learning_authority' && prior.run_id === event.run_id
        && prior.authority === event.authority && canonicalJson(prior.identity) === canonicalJson(event.replacement));
      const replacementRequiresRepetition = event.replacement.class === 'lesson';
      const replacementRequiresDirectUser = ['constraint', 'preference', 'goal', 'open_loop'].includes(event.replacement.class);
      if (!predecessorTransition || !candidate || !authority || (replacementRequiresRepetition && event.authority !== 'repetition')
        || (replacementRequiresDirectUser && event.authority !== 'direct_user')
        || !isActivatableClass(event.replacement.class) || event.replacement.class === 'friction' || event.replacement.class === 'business_candidate') {
        throw new LearningLoopError('ledger_corrupt', 'Learning correction lacks its exact predecessor, candidate, or authority evidence');
      }
      projection.events.push(event);
      continue;
    } else if (event.event_type === 'session_evaluated') {
      const key = `${event.provider}\u0000${event.provider_session_id}`;
      const binding = projection.session_bindings.get(key);
      if (
        !binding
        || binding.adapter.client_id !== event.adapter.client_id
        || binding.adapter.source_id !== event.adapter.source_id
        || binding.adapter.provider !== event.adapter.provider
      ) {
        throw new LearningLoopError('ledger_corrupt', 'Session evaluation does not match its trusted-local adapter binding');
      }
      const priorHash = projection.session_hashes.get(key);
      if (priorHash !== undefined && priorHash !== event.authoritative.content_hash) {
        throw new LearningLoopError('ledger_corrupt', 'A session identity has conflicting authoritative hashes');
      }
      if (priorHash !== undefined) {
        throw new LearningLoopError('ledger_corrupt', 'A session identity has more than one ledger event');
      } else {
        projection.session_hashes.set(key, event.authoritative.content_hash);
        projection.session_events.set(key, event);
      }
      if (event.run_id !== null) {
        const run = projection.runs.get(event.run_id);
        if (!run || run.terminal) throw new LearningLoopError('ledger_corrupt', 'Session references a missing or terminal run');
        const expectedAdapter = run.armed.authorized_adapter;
        if (
          event.adapter.client_id !== expectedAdapter.client_id
          || event.adapter.source_id !== expectedAdapter.source_id
          || event.adapter.provider !== expectedAdapter.provider
        ) throw new LearningLoopError('ledger_corrupt', 'Session adapter does not match the armed run');
        const expectedClassification = classifyTranscript(event.authoritative);
        if (event.eligible !== expectedClassification.eligible || event.reason !== expectedClassification.reason) {
          throw new LearningLoopError('ledger_corrupt', 'Session eligibility does not match the frozen classifier');
        }
        const expectedMember = event.eligible && !run.sealed;
        if (event.cohort_member !== expectedMember) throw new LearningLoopError('ledger_corrupt', 'Session cohort decision is not replay-deterministic');
        if (event.cohort_member) {
          const expected = run.cohort.length + 1;
          if (event.cohort_position !== expected || expected > TARGET_COHORT_SIZE || run.sealed) {
            throw new LearningLoopError('ledger_corrupt', 'Invalid cohort admission order');
          }
          run.cohort.push({ provider: event.provider, provider_session_id: event.provider_session_id, content_hash: event.authoritative.content_hash });
        }
        if (event.cohort_sealed) {
          if (run.cohort.length !== TARGET_COHORT_SIZE) throw new LearningLoopError('ledger_corrupt', 'Cohort sealed at the wrong size');
          run.sealed = true;
        }
      }
    }
    projection.events.push(event);
  }
  return projection;
}

export function readLearningLoopLedger(opts: LedgerOptions = {}): LearningLoopEvent[] {
  const path = learningLoopLedgerPath(opts);
  if (!existsSync(path)) return [];
  if (statSync(path).size > MAX_LEDGER_BYTES) {
    throw new LearningLoopError('ledger_corrupt', 'Learning Loop ledger exceeds the bounded replay limit');
  }
  const raw = readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_LEDGER_BYTES) {
    throw new LearningLoopError('ledger_corrupt', 'Learning Loop ledger exceeds the bounded replay limit');
  }
  if (raw.length > 0 && !raw.endsWith('\n')) throw new LearningLoopError('ledger_corrupt', 'Learning Loop ledger has a partial final line');
  const records: LearningLoopLedgerRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line) as LearningLoopLedgerRecord); }
    catch { throw new LearningLoopError('ledger_corrupt', 'Learning Loop ledger contains malformed JSON'); }
  }
  return replayLearningLoop(records).events;
}

export function activeV2CorpusBinding(opts: LedgerOptions = {}): CorpusBindingV1 | undefined {
  const state = replayLearningLoop(readLearningLoopLedger(opts));
  if (state.active_run_id === null) return undefined;
  const armed = state.runs.get(state.active_run_id)?.armed;
  return armed?.contract_version === 2 ? armed.corpus_binding : undefined;
}

/** Frozen canonical destination for the active V2 run, if one exists. */
export function activeV2DestinationBinding(opts: LedgerOptions = {}): DestinationBindingV1 | undefined {
  const state = replayLearningLoop(readLearningLoopLedger(opts));
  if (state.active_run_id === null) return undefined;
  const armed = state.runs.get(state.active_run_id)?.armed;
  return armed?.contract_version === 2 ? armed.destination_binding : undefined;
}

function appendEvent(event: LearningLoopEvent | ExactEventRecordV1, opts: LedgerOptions): void {
  if (isExactEventRecord(event)) decodeExactEventRecordV1(event); else verifyEvent(event);
  const path = learningLoopLedgerPath(opts);
  const parent = dirname(path);
  const created = !existsSync(path);
  mkdirSync(parent, { recursive: true });
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
  try {
    appendFileSync(fd, JSON.stringify(event) + '\n', 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (created) {
    const parentFd = openSync(parent, constants.O_RDONLY);
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  }
}

export async function withLearningLoopLedgerMutation<T>(engine: BrainEngine, opts: LedgerOptions, fn: (state: LearningLoopProjection) => { value: T; event?: LearningLoopEvent | ExactEventRecordV1 } | Promise<{ value: T; event?: LearningLoopEvent | ExactEventRecordV1 }>): Promise<T> {
  return withLedgerMutation(engine, opts, fn);
}

async function withLedgerMutation<T>(
  engine: BrainEngine,
  opts: LedgerOptions,
  fn: (state: LearningLoopProjection) => { value: T; event?: LearningLoopEvent | ExactEventRecordV1 } | Promise<{ value: T; event?: LearningLoopEvent | ExactEventRecordV1 }>,
): Promise<T> {
  const work = async (): Promise<T> => {
    await opts.beforeMutation?.();
    const state = replayLearningLoop(readLearningLoopLedger(opts));
    const pending = fn(state);
    const result = pending instanceof Promise ? await pending : pending;
    if (result.event) appendEvent(result.event, opts);
    return result.value;
  };
  if (opts.mutationLock) return opts.mutationLock(work);
  try {
    return await withRefreshingLock(engine, `learning-loop:ledger-v1:${ledgerScopeId(opts)}`, work, { ttlMinutes: 5 });
  } catch (error) {
    if (error instanceof LockUnavailableError) throw new LearningLoopError('ledger_busy', 'Learning Loop ledger is locked');
    throw error;
  }
}

export async function withLearningLoopLifecycleLock<T>(
  engine: BrainEngine,
  work: () => Promise<T>,
  opts: LedgerOptions = {},
): Promise<T> {
  if (opts.lifecycleLock) return opts.lifecycleLock(work);
  // Lightweight test/fake engines may provide only the ledger lock seam.
  // Reuse that explicit seam rather than attempting a driver lock on an
  // engine-shaped object with no kind.
  if (opts.mutationLock && (!('kind' in engine) || !engine.kind)) return opts.mutationLock(work);
  try {
    return await withRefreshingLock(engine, `learning-loop:lifecycle-v1:${ledgerScopeId(opts)}`, work, { ttlMinutes: 5 });
  } catch (error) {
    if (error instanceof LockUnavailableError) throw new LearningLoopError('ledger_busy', 'Learning Loop lifecycle is locked');
    throw error;
  }
}

/** One admission gate for every non-canonical Learning Loop ledger event. */
export async function withLearningLoopAdmission<T>(
  engine: BrainEngine,
  opts: LedgerOptions,
  admit: (state: LearningLoopProjection, mode: LearningLoopMode, intent: string | null) => { value: T; event?: LearningLoopEvent } | Promise<{ value: T; event?: LearningLoopEvent }>,
): Promise<T> {
  return withLearningLoopLifecycleLock(engine, async () => withLearningLoopAdmissionHeld(engine, opts, admit), opts);
}

/** Admission variant for callers that already own the lifecycle lock. */
async function withLearningLoopAdmissionHeld<T>(
  engine: BrainEngine,
  opts: LedgerOptions,
  admit: (state: LearningLoopProjection, mode: LearningLoopMode, intent: string | null) => { value: T; event?: LearningLoopEvent } | Promise<{ value: T; event?: LearningLoopEvent }>,
): Promise<T> {
    const read = async (tx: Pick<BrainEngine, 'getConfig'>) => ({
      mode: opts.precheckedMode ?? (typeof tx.getConfig === 'function' ? await resolveLearningLoopMode(tx, opts.config as GBrainConfig | undefined) : ((opts.config as GBrainConfig | undefined)?.learning_loop?.mode ?? 'off') as LearningLoopMode),
      intent: typeof tx.getConfig === 'function' ? await tx.getConfig('learning_loop.mode_transition_intent_v1') : null,
    });
    const { mode, intent } = typeof engine.transaction === 'function'
      ? await engine.transaction(async tx => typeof tx.getConfig === 'function' ? read(tx) : read(engine))
      : await read(engine);
    if (intent !== null) throw new LearningLoopError('forbidden', 'Learning Loop admission is blocked by a mode transition intent');
    let appended: LearningLoopEvent | undefined;
    const result = await withLedgerMutation(engine, opts, state => {
      const decision = admit(state, mode, intent);
      if (decision instanceof Promise) {
        return decision.then(resolved => {
          appended = resolved.event;
          return resolved;
        });
      }
      appended = decision.event;
      return decision;
    });
    // Readback is part of the admission critical section. A caller never gets
    // a success result for an event that is not durable and replay-visible.
    if (appended) {
      const events = readLearningLoopLedger(opts);
      if (!events.some(event => event.event_id === appended!.event_id && canonicalJson(event) === canonicalJson(appended))) {
        throw new LearningLoopError('ledger_corrupt', 'Learning Loop admission append failed exact readback');
      }
    }
    return result;
}

export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function orderBaselineCandidates(candidates: BaselineCandidate[]): BaselineCandidate[] {
  return [...candidates].sort((a, b) => {
    const completed = Date.parse(b.completed_at) - Date.parse(a.completed_at);
    if (completed !== 0) return completed;
    const session = compareUtf8(a.provider_session_id, b.provider_session_id);
    return session !== 0 ? session : compareUtf8(a.content_hash, b.content_hash);
  });
}

function commandPayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export interface ArmLearningLoopInput {
  command_id: string;
  engine: BrainEngine;
  config?: GBrainConfig;
  authorized_adapter: AdapterIdentity;
  destination: { source_id: string; canonical_slug: string };
  contract_version?: 1 | 2;
}

function resolveArmDestination(
  input: ArmLearningLoopInput,
  opts: LedgerOptions,
): RunArmedEvent['destination'] {
  return {
    ...input.destination,
    brain_id: ledgerScopeId(opts),
  };
}

export function bindLearningLoopSession(
  engine: BrainEngine,
  commandId: string,
  adapter: AdapterIdentity,
  providerSessionId: string,
  opts: LedgerOptions = {},
): Promise<AdapterSessionBoundEvent> {
  if (!COMMAND_ID_RE.test(commandId) || !validAdapter(adapter) || !SESSION_ID_RE.test(providerSessionId)) {
    throw new LearningLoopError('invalid_input', 'Invalid adapter session binding');
  }
  const payloadHash = commandPayloadHash({ adapter, provider_session_id: providerSessionId });
  return withLearningLoopAdmission<AdapterSessionBoundEvent>(engine, opts, (state) => {
    const priorCommand = state.events.find(
      (event): event is AdapterSessionBoundEvent => event.event_type === 'adapter_session_bound' && event.command_id === commandId,
    );
    if (priorCommand) {
      if (priorCommand.command_payload_hash !== payloadHash) {
        throw new LearningLoopError('command_conflict', 'Session binding command id was reused with a different payload');
      }
      return { value: priorCommand };
    }
    const key = `${adapter.provider}\u0000${providerSessionId}`;
    const existing = state.session_bindings.get(key);
    if (existing) {
      if (
        existing.adapter.client_id !== adapter.client_id
        || existing.adapter.source_id !== adapter.source_id
        || existing.adapter.provider !== adapter.provider
      ) {
        throw new LearningLoopError('forbidden', 'Provider session is already bound to a different adapter');
      }
      return { value: existing };
    }
    const body = {
      schema_version: LEARNING_LOOP_SCHEMA_VERSION,
      event_type: 'adapter_session_bound' as const,
      command_id: commandId,
      command_payload_hash: payloadHash,
      occurred_at: (opts.now ?? (() => new Date()))().toISOString(),
      adapter,
      provider_session_id: providerSessionId,
    };
    const event = completeEvent(body) as AdapterSessionBoundEvent;
    return { value: event, event };
  });
}

async function armLearningLoopLocked(input: ArmLearningLoopInput, opts: LedgerOptions): Promise<RunArmedEvent | RunArmedEventV2> {
  if (!COMMAND_ID_RE.test(input.command_id)) throw new LearningLoopError('invalid_input', 'Invalid arm command id');
  if (
    !validAdapter(input.authorized_adapter)
    || !nonEmpty(input.destination.source_id)
    || !nonEmpty(input.destination.canonical_slug)
    || input.authorized_adapter.source_id !== input.destination.source_id
  ) throw new LearningLoopError('forbidden', 'Arm destination must match the authorized adapter source');
  const destination = resolveArmDestination(input, opts);
  const v2 = input.contract_version === 2;
  const corpusBinding = v2 ? await resolveCodexCorpusBinding(input.engine, input.authorized_adapter.source_id, input.config) : null;
  const destinationBinding = v2 ? await resolveLearningLoopDestinationBinding(input.engine, destination.brain_id, destination.source_id, destination.canonical_slug) : null;
  const occurredAt = (opts.now ?? (() => new Date()))().toISOString();
  const payloadHash = commandPayloadHash({
    authorized_adapter: input.authorized_adapter,
    destination,
    ...(v2 ? { contract_version: 2 } : {}),
  });
  const existing = await withLearningLoopAdmissionHeld<RunArmedEvent | RunArmedEventV2 | null>(input.engine, opts, (state, mode) => {
    if (mode !== 'canary') throw new LearningLoopError('mode_off', 'Set mode to canary before arming');
    const prior = state.events.find((event): event is RunArmedEvent | RunArmedEventV2 => event.event_type === 'run_armed' && event.command_id === input.command_id);
    if (!prior) return { value: null };
    if (prior.command_payload_hash !== payloadHash) throw new LearningLoopError('command_conflict', 'Arm command id was reused with a different payload');
    return { value: prior };
  });
  if (existing) return existing;
  const baselineDiscovery = await discoverBaselineSnapshot({
    engine: input.engine,
    config: input.config,
    expected_corpus_binding: corpusBinding ?? undefined,
    source_id: input.authorized_adapter.source_id,
    cutoff_at: occurredAt,
  });
  if (v2) {
    const corpusAfter = await resolveCodexCorpusBinding(input.engine, input.authorized_adapter.source_id, input.config);
    const destinationAfter = await resolveLearningLoopDestinationBinding(input.engine, destination.brain_id, destination.source_id, destination.canonical_slug);
    assertRootBindingUnchanged(corpusBinding!, corpusAfter);
    assertRootBindingUnchanged(destinationBinding!, destinationAfter);
  }
  return withLearningLoopAdmissionHeld<RunArmedEvent | RunArmedEventV2>(input.engine, opts, (state, mode) => {
    if (mode !== 'canary') throw new LearningLoopError('mode_off', 'Set mode to canary before arming');
    const prior = state.events.find((event): event is RunArmedEvent | RunArmedEventV2 => event.event_type === 'run_armed' && event.command_id === input.command_id);
    if (prior) {
      if (prior.command_payload_hash !== payloadHash) throw new LearningLoopError('command_conflict', 'Arm command id was reused with a different payload');
      return { value: prior };
    }
    if (state.active_run_id !== null) throw new LearningLoopError('run_active', 'A Learning Loop run is already active');
    const body = {
      schema_version: LEARNING_LOOP_SCHEMA_VERSION,
      event_type: 'run_armed' as const,
      command_id: input.command_id,
      command_payload_hash: payloadHash,
      occurred_at: occurredAt,
      run_id: randomUUID(),
      implementation_version: VERSION,
      provider_allow_list: ['codex'] as ['codex'],
      target_cohort_size: TARGET_COHORT_SIZE,
      eligibility_classifier_version: ELIGIBILITY_CLASSIFIER_VERSION,
      authorized_adapter: input.authorized_adapter,
      ...(v2 ? { contract_version: 2 as const, corpus_binding: corpusBinding!, destination_binding: destinationBinding! } : { contract_version: 1 as const, destination }),
      baseline_discovery: baselineDiscovery,
    };
    const event = completeEvent(body) as RunArmedEvent | RunArmedEventV2;
    return { value: event, event };
  });
}

export function armLearningLoop(input: ArmLearningLoopInput & { contract_version: 2 }, opts?: LedgerOptions): Promise<RunArmedEventV2>;
export function armLearningLoop(input: ArmLearningLoopInput & { contract_version?: 1 }, opts?: LedgerOptions): Promise<RunArmedEvent>;
export async function armLearningLoop(
  input: ArmLearningLoopInput,
  opts: LedgerOptions = {},
): Promise<RunArmedEvent | RunArmedEventV2> {
  const scopedOpts = opts.root || opts.config ? opts : { ...opts, config: input.config };
  if (!scopedOpts.root) {
    if (!input.config || !scopedOpts.config) {
      throw new LearningLoopError('invalid_input', 'Learning Loop arm requires explicit active-brain configuration');
    }
    if (computeBrainIdFromConfig(input.config) !== computeBrainIdFromConfig(scopedOpts.config)) {
      throw new LearningLoopError('invalid_input', 'Learning Loop arm configuration does not match the active-brain ledger');
    }
  }
  return withLearningLoopLifecycleLock(input.engine, async () => {
    const mode = await resolveLearningLoopMode(input.engine, input.config);
    if (mode !== 'canary') throw new LearningLoopError('mode_off', 'Set mode to canary before arming');
    return armLearningLoopLocked(input, scopedOpts);
  }, scopedOpts);
}

async function configTransaction<T>(engine: BrainEngine, work: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return typeof engine.transaction === 'function' ? engine.transaction(work) : work(engine);
}

function exactRecordForIntent(intent: ModeTransitionIntentV1): LearningLoopEvent {
  return eventFromExactRecord(intent.event);
}

async function persistModeTransitionIntent(engine: BrainEngine, intent: ModeTransitionIntentV1): Promise<void> {
  const bytes = canonicalJson(intent);
  await configTransaction(engine, async tx => {
    const existing = await tx.getConfig('learning_loop.mode_transition_intent_v1');
    if (existing !== null) {
      const decoded = decodeModeTransitionIntent(existing);
      if (!decoded || canonicalJson(decoded) !== bytes) throw new LearningLoopError('command_conflict', 'A different mode transition intent is already present');
      return;
    }
    const holder = createLearningLoopLifecycleHolder();
    const permit = createLearningLoopConfigMutationPermit({
      key: 'learning_loop.mode_transition_intent_v1', operation: 'set', engine: tx, lifecycleHolder: holder, expectedOldValue: null,
    });
    await tx.setConfig('learning_loop.mode_transition_intent_v1', bytes, permit);
  });
}

async function retainModeTransitionIntentWhileDisabled(engine: BrainEngine, intent: ModeTransitionIntentV1): Promise<void> {
  await configTransaction(engine, async tx => {
    const stored = await tx.getConfig('learning_loop.mode_transition_intent_v1');
    const decoded = decodeModeTransitionIntent(stored);
    if (!decoded || canonicalJson(decoded) !== canonicalJson(intent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition intent changed during disable fallback');
    const current = await tx.getConfig('learning_loop.mode');
    const holder = createLearningLoopLifecycleHolder();
    if (current !== intent.requested_mode) {
      const modePermit = createLearningLoopConfigMutationPermit({ key: 'learning_loop.mode', operation: 'set', engine: tx, lifecycleHolder: holder, expectedOldValue: current });
      await tx.setConfig('learning_loop.mode', intent.requested_mode, modePermit);
    }
  });
}

function modeTransitionBindings(
  run: RunProjection,
  brainId: string,
): { source_id: string; canonical_slug: string; corpus_binding?: CorpusBindingV1; destination_binding?: DestinationBindingV1 } {
  if (run.armed.contract_version === 2) return {
    source_id: run.armed.destination_binding.source_id,
    canonical_slug: run.armed.destination_binding.canonical_slug,
    corpus_binding: run.armed.corpus_binding,
    destination_binding: run.armed.destination_binding,
  };
  return { source_id: run.armed.destination.source_id, canonical_slug: run.armed.destination.canonical_slug };
}

function createModeTransitionIntent(
  state: LearningLoopProjection,
  run: RunProjection,
  next: 'off' | 'capture',
  config: GBrainConfig,
  expectedPriorPending: ExactEventRecordV1 | null,
): ModeTransitionIntentV1 {
  const binding = modeTransitionBindings(run, computeBrainIdFromConfig(config));
  const brainId = run.armed.contract_version === 2 ? run.armed.destination_binding.brain_id : computeBrainIdFromConfig(config);
  const observedSequence = Math.max(0, ...state.events
    .filter(event => event.event_type === 'learning_transition' || event.event_type === 'learning_correction')
    .filter(event => event.run_id === run.run_id)
    .map(event => event.semantic_sequence)) + 1;
  const semanticSequence = Math.max(observedSequence, (expectedPriorPending?.semantic_sequence ?? 0) + 1);
  const occurredAt = new Date().toISOString();
  const commandId = `mode-change:${run.run_id}`;
  const payload = {
    schema_version: LEARNING_LOOP_SCHEMA_VERSION,
    event_type: 'run_aborted' as const,
    command_id: commandId,
    command_payload_hash: commandPayloadHash({ reason: 'mode_changed' }),
    run_id: run.run_id,
    reason: 'mode_changed' as const,
    occurred_at: occurredAt,
    brain_id: brainId,
    semantic_sequence: semanticSequence,
    source_id: binding.source_id,
    canonical_slug: binding.canonical_slug,
  };
  const event = makeExactEventRecordV1({ event_payload: payload, brain_id: brainId, run_id: run.run_id, occurred_at: occurredAt, semantic_sequence: semanticSequence });
  const body: Omit<ModeTransitionIntentV1, 'intent_hash'> = {
    schema_version: 1,
    run_id: run.run_id,
    command_id: commandId,
    requested_mode: next,
    reason: 'mode_changed',
    event,
    brain_id: brainId,
    source_id: binding.source_id,
    canonical_slug: binding.canonical_slug,
    ...(binding.corpus_binding ? { corpus_binding: binding.corpus_binding } : {}),
    ...(binding.destination_binding ? { destination_binding: binding.destination_binding } : {}),
    expected_prior_pending: expectedPriorPending,
  };
  return { ...body, intent_hash: modeTransitionIntentHash(body) };
}

async function clearCanonicalPending(
  engine: BrainEngine,
  target: SourceQualifiedCanonicalTarget,
  lease: SourceWriteLease,
): Promise<string> {
  const inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' });
  const fence = parseLearningLoopFence(inspected.canonical);
  if (!fence || fence.value.pending_delivery === null) return inspected.canonical;
  const cleared = { ...fence.value, pending_delivery: null };
  const written = await writeCanonicalPage(target, inspected.canonical.replace(fence.raw, renderLearningLoopFence(cleared)), {
    mode: 'learning_transition', sourceLease: lease, transitionPermit: createLearningTransitionPermit(fence.value, cleared), expectedManaged: 'expected',
  });
  const readback = inspectExpectedManagedState(target, lease, { expected: 'expected' });
  if (readback.canonical !== written) throw new LearningLoopError('assertion_mismatch', 'Mode transition canonical clear readback changed');
  await importFromContent(engine, target.canonical_slug, readback.canonical, { sourceId: target.source_id, noEmbed: true, canonicalPermit: readback.permit, canonicalReadback: readback.canonical });
  return readback.canonical;
}

async function recoverModeTransitionIntentLocked(
  engine: BrainEngine,
  intent: ModeTransitionIntentV1,
  opts: LedgerOptions,
  config: GBrainConfig,
  lease?: SourceWriteLease,
): Promise<void> {
  const storedRaw = await engine.getConfig('learning_loop.mode_transition_intent_v1');
  const stored = decodeModeTransitionIntent(storedRaw);
  if (!stored || canonicalJson(stored) !== canonicalJson(intent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition intent is missing or changed');
  const terminalEvent = exactRecordForIntent(intent);
  let state = replayLearningLoop(readLearningLoopLedger(opts));
  const run = state.runs.get(intent.run_id);
  if (!run) throw new LearningLoopError('ledger_corrupt', 'Mode transition run is missing');
  if (run.armed.contract_version === 2) {
    if (!lease || !intent.destination_binding || !intent.corpus_binding) throw new LearningLoopError('binding_unavailable', 'Mode transition recovery lacks its frozen source binding');
    const currentCorpus = await resolveCodexCorpusBinding(engine, intent.corpus_binding.source_id, config);
    const currentDestination = await resolveLearningLoopDestinationBinding(engine, intent.destination_binding.brain_id, intent.destination_binding.source_id, intent.destination_binding.canonical_slug);
    assertRootBindingUnchanged(intent.corpus_binding, currentCorpus);
    assertRootBindingUnchanged(intent.destination_binding, currentDestination);
    const target = reversalTarget(intent.destination_binding);
    let inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' });
    let fence = parseLearningLoopFence(inspected.canonical);
    if (!fence) throw new LearningLoopError('forbidden', 'Mode transition managed canonical state is unavailable');
    const currentPending = fence.value.pending_delivery === null ? null : decodeExactEventRecordV1(fence.value.pending_delivery);
    const expectedPrior = intent.expected_prior_pending;
    if (currentPending && canonicalJson(currentPending) !== canonicalJson(intent.event)) {
      if (!expectedPrior || canonicalJson(currentPending) !== canonicalJson(expectedPrior)) throw new LearningLoopError('ledger_corrupt', 'Mode transition predecessor bytes changed');
      const priorEvent = eventFromExactRecord(expectedPrior);
      const prior = state.events.find(event => event.event_id === priorEvent.event_id);
      if (prior && canonicalJson(prior) !== canonicalJson(priorEvent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition predecessor conflicts with ledger');
      if (!prior) appendEvent(expectedPrior, opts);
      const read = readLearningLoopLedger(opts).find(event => event.event_id === priorEvent.event_id);
      if (!read || canonicalJson(read) !== canonicalJson(priorEvent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition predecessor failed ledger readback');
      await clearCanonicalPending(engine, target, lease);
      inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      fence = parseLearningLoopFence(inspected.canonical)!;
    } else if (!currentPending && expectedPrior) {
      const priorEvent = eventFromExactRecord(expectedPrior);
      const prior = state.events.find(event => event.event_id === priorEvent.event_id);
      if (!prior || canonicalJson(prior) !== canonicalJson(priorEvent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition predecessor is missing after canonical clear');
    }
    const pendingNow = fence.value.pending_delivery === null ? null : decodeExactEventRecordV1(fence.value.pending_delivery);
    if (pendingNow && canonicalJson(pendingNow) !== canonicalJson(intent.event)) throw new LearningLoopError('ledger_corrupt', 'Mode transition terminal predecessor is unexpected');
    state = replayLearningLoop(readLearningLoopLedger(opts));
    if (expectedPrior) {
      const priorEvent = eventFromExactRecord(expectedPrior);
      const prior = state.events.find(event => event.event_id === priorEvent.event_id);
      if (prior && canonicalJson(prior) !== canonicalJson(priorEvent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition predecessor conflicts with ledger');
      if (!prior) {
        // A terminal record can survive a process exit before its predecessor
        // append. Restore the frozen predecessor bytes before appending the
        // terminal record; any other missing-predecessor state is corruption.
        if (!currentPending || canonicalJson(currentPending) !== canonicalJson(intent.event)) throw new LearningLoopError('ledger_corrupt', 'Mode transition predecessor is missing before terminal delivery');
        appendEvent(expectedPrior, opts);
        const read = readLearningLoopLedger(opts).find(event => event.event_id === priorEvent.event_id);
        if (!read || canonicalJson(read) !== canonicalJson(priorEvent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition predecessor failed ledger readback');
      }
    }
    if (!pendingNow) {
      const staged = { ...fence.value, pending_delivery: intent.event };
      await writeCanonicalPage(target, inspected.canonical.replace(fence.raw, renderLearningLoopFence(staged)), {
        mode: 'learning_transition', sourceLease: lease, transitionPermit: createLearningTransitionPermit(fence.value, staged), expectedManaged: 'expected',
      });
      inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      fence = parseLearningLoopFence(inspected.canonical)!;
    }
    state = replayLearningLoop(readLearningLoopLedger(opts));
    const priorTerminal = state.events.find(event => event.event_id === terminalEvent.event_id);
    if (priorTerminal && canonicalJson(priorTerminal) !== canonicalJson(terminalEvent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition terminal event conflicts with ledger');
    if (!priorTerminal) appendEvent(intent.event, opts);
    const delivered = readLearningLoopLedger(opts).find(event => event.event_id === terminalEvent.event_id);
    if (!delivered || canonicalJson(delivered) !== canonicalJson(terminalEvent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition terminal event failed ledger readback');
    await clearCanonicalPending(engine, target, lease);
  } else {
    state = replayLearningLoop(readLearningLoopLedger(opts));
    const priorTerminal = state.events.find(event => event.event_id === terminalEvent.event_id);
    if (priorTerminal && canonicalJson(priorTerminal) !== canonicalJson(terminalEvent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition terminal event conflicts with ledger');
    if (!priorTerminal) appendEvent(intent.event, opts);
    const delivered = readLearningLoopLedger(opts).find(event => event.event_id === terminalEvent.event_id);
    if (!delivered || canonicalJson(delivered) !== canonicalJson(terminalEvent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition terminal event failed ledger readback');
  }
  await configTransaction(engine, async tx => {
    const currentIntent = decodeModeTransitionIntent(await tx.getConfig('learning_loop.mode_transition_intent_v1'));
    if (!currentIntent || canonicalJson(currentIntent) !== canonicalJson(intent)) throw new LearningLoopError('ledger_corrupt', 'Mode transition intent changed before finalization');
    const currentMode = await tx.getConfig('learning_loop.mode');
    const holder = createLearningLoopLifecycleHolder();
    if (currentMode !== intent.requested_mode) {
      const modePermit = createLearningLoopConfigMutationPermit({ key: 'learning_loop.mode', operation: 'set', engine: tx, lifecycleHolder: holder, expectedOldValue: currentMode });
      await tx.setConfig('learning_loop.mode', intent.requested_mode, modePermit);
    }
    const clearPermit = createLearningLoopConfigMutationPermit({ key: 'learning_loop.mode_transition_intent_v1', operation: 'unset', engine: tx, lifecycleHolder: holder, expectedOldValue: canonicalJson(intent) });
    await tx.unsetConfig('learning_loop.mode_transition_intent_v1', clearPermit);
  });
}

async function recoverModeTransitionIntent(
  engine: BrainEngine,
  intent: ModeTransitionIntentV1,
  opts: LedgerOptions,
  config: GBrainConfig,
): Promise<void> {
  if (intent.destination_binding) {
    const target = reversalTarget(intent.destination_binding);
    return withCanonicalSourceBoundary(engine, target, lease => withLearningLoopLifecycleLock(engine, () => recoverModeTransitionIntentLocked(engine, intent, opts, config, lease), opts));
  }
  return withLearningLoopLifecycleLock(engine, () => recoverModeTransitionIntentLocked(engine, intent, opts, config), opts);
}

async function setLearningLoopModeLocked(
  engine: BrainEngine,
  config: GBrainConfig,
  next: LearningLoopMode,
  opts: LedgerOptions,
  lease?: SourceWriteLease,
): Promise<{ previous_mode: LearningLoopMode; mode: LearningLoopMode }> {
  const current = await resolveLearningLoopMode(engine, config);
  const existing = decodeModeTransitionIntent(await engine.getConfig('learning_loop.mode_transition_intent_v1'));
  if (existing) {
    await recoverModeTransitionIntentLocked(engine, existing, opts, config, lease);
    const mode = await resolveLearningLoopMode(engine, config);
    if (mode !== next) throw new LearningLoopError('assertion_mismatch', 'Requested mode disagrees with the recovered transition intent');
    return { previous_mode: current, mode };
  }
  const state = replayLearningLoop(readLearningLoopLedger(opts));
  const active = state.active_run_id === null ? undefined : state.runs.get(state.active_run_id);
  if (current === 'canary' && next !== 'canary' && active && !active.terminal) {
    if (active.armed.contract_version === 2 && !lease) throw new LearningLoopError('binding_unavailable', 'Mode transition requires the frozen canonical source lease');
    let expectedPending: ExactEventRecordV1 | null = null;
    if (active.armed.contract_version === 2 && lease) {
      const target = reversalTarget(active.armed.destination_binding);
      const inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      const fence = parseLearningLoopFence(inspected.canonical);
      if (!fence) throw new LearningLoopError('forbidden', 'Mode transition managed canonical state is unavailable');
      expectedPending = fence.value.pending_delivery === null ? null : decodeExactEventRecordV1(fence.value.pending_delivery);
    }
    const intent = createModeTransitionIntent(state, active, next, config, expectedPending);
    await persistModeTransitionIntent(engine, intent);
    await opts.afterIntentPersist?.();
    try {
      await recoverModeTransitionIntentLocked(engine, intent, opts, config, lease);
    } catch (error) {
      await retainModeTransitionIntentWhileDisabled(engine, intent);
      throw error;
    }
    return { previous_mode: current, mode: next };
  }
  let persistedCurrent: string | null = null;
  try { persistedCurrent = await engine.getConfig('learning_loop.mode'); } catch { /* file fallback */ }
  const holder = createLearningLoopLifecycleHolder();
  const permit = createLearningLoopConfigMutationPermit({ key: 'learning_loop.mode', operation: 'set', engine, lifecycleHolder: holder, expectedOldValue: persistedCurrent });
  await engine.setConfig('learning_loop.mode', next, permit);
  return { previous_mode: current, mode: next };
}

export async function setLearningLoopMode(
  engine: BrainEngine,
  config: GBrainConfig,
  next: LearningLoopMode,
  opts: LedgerOptions = {},
): Promise<{ previous_mode: LearningLoopMode; mode: LearningLoopMode }> {
  if (next !== 'off' && next !== 'capture' && next !== 'canary') throw new LearningLoopError('invalid_input', 'Invalid Learning Loop mode');
  const scopedOpts = opts.root || opts.config ? opts : { ...opts, config };
  const rawIntent = await engine.getConfig('learning_loop.mode_transition_intent_v1').catch(() => null);
  const intent = decodeModeTransitionIntent(rawIntent);
  const activeDestination = !intent && next !== 'canary'
    ? activeV2DestinationBinding({ config: scopedOpts.config ?? config })
    : undefined;
  if (intent?.destination_binding || activeDestination) {
    const target = reversalTarget(intent?.destination_binding ?? activeDestination!);
    return withCanonicalSourceBoundary(engine, target, lease => withLearningLoopLifecycleLock(engine, () => setLearningLoopModeLocked(engine, config, next, scopedOpts, lease), scopedOpts));
  }
  // Preserve the existing race-test seam: the snapshot barrier runs before
  // lifecycle acquisition, so an owner abort that wins during discovery is
  // observed as a terminal run rather than being stranded behind this call.
  if (!intent && next !== 'canary' && await resolveLearningLoopMode(engine, config) === 'canary') {
    const snapshot = replayLearningLoop(readLearningLoopLedger(scopedOpts));
    if (snapshot.active_run_id !== null) await scopedOpts.beforeMutation?.();
  }
  return withLearningLoopLifecycleLock(engine, () => setLearningLoopModeLocked(engine, config, next, scopedOpts), scopedOpts);
}

function abortLearningLoopFromState(
  state: LearningLoopProjection,
  commandId: string,
  reason: RunAbortedEvent['reason'],
  payloadHash: string,
  opts: LedgerOptions,
): { value: RunAbortedEvent; event?: RunAbortedEvent } {
  const prior = state.events.find((event): event is RunAbortedEvent => event.event_type === 'run_aborted' && event.command_id === commandId);
  if (prior) {
    if (prior.command_payload_hash !== payloadHash) throw new LearningLoopError('command_conflict', 'Abort command id was reused with a different payload');
    return { value: prior };
  }
  if (state.active_run_id === null) throw new LearningLoopError('no_active_run', 'No Learning Loop run is active');
  const body = {
    schema_version: LEARNING_LOOP_SCHEMA_VERSION,
    event_type: 'run_aborted' as const,
    command_id: commandId,
    command_payload_hash: payloadHash,
    occurred_at: (opts.now ?? (() => new Date()))().toISOString(),
    run_id: state.active_run_id,
    reason,
  };
  const event = completeEvent(body) as RunAbortedEvent;
  return { value: event, event };
}

export function abortLearningLoop(
  engine: BrainEngine,
  commandId: string,
  reason: RunAbortedEvent['reason'],
  opts: LedgerOptions = {},
): Promise<RunAbortedEvent> {
  if (!COMMAND_ID_RE.test(commandId)) throw new LearningLoopError('invalid_input', 'Invalid abort command id');
  const payloadHash = commandPayloadHash({ reason });
  return withLearningLoopAdmission<RunAbortedEvent>(engine, opts, state => abortLearningLoopFromState(state, commandId, reason, payloadHash, opts));
}

function requireSessionBinding(
  state: LearningLoopProjection,
  adapter: AdapterIdentity,
  providerSessionId: string,
): AdapterSessionBoundEvent {
  const binding = state.session_bindings.get(`${adapter.provider}\u0000${providerSessionId}`);
  if (
    !binding
    || binding.adapter.client_id !== adapter.client_id
    || binding.adapter.source_id !== adapter.source_id
    || binding.adapter.provider !== adapter.provider
  ) {
    throw new LearningLoopError('forbidden', 'Adapter is not bound to the submitted provider session');
  }
  return binding;
}

export function assertLearningLoopSessionBinding(
  adapter: AdapterIdentity,
  providerSessionId: string,
  opts: LedgerOptions = {},
): AdapterSessionBoundEvent {
  if (!validAdapter(adapter) || !SESSION_ID_RE.test(providerSessionId)) {
    throw new LearningLoopError('invalid_input', 'Invalid adapter session binding assertion');
  }
  return requireSessionBinding(
    replayLearningLoop(readLearningLoopLedger(opts)),
    adapter,
    providerSessionId,
  );
}

export function recordSessionEvaluation(input: {
  engine: BrainEngine;
  mode: LearningLoopMode;
  adapter: AdapterIdentity;
  /** Deprecated assertion retained for direct callers; authoritative time comes from the receipt. */
  completed_at?: string;
  receipt: TranscriptReceipt;
}, opts: LedgerOptions = {}): Promise<{ status: 'recorded' | 'idempotent'; event: SessionEvaluatedEvent }> {
  if (input.mode === 'off') throw new LearningLoopError('mode_off', 'Learning Loop mode is off');
  const admissionOpts = opts.root && !opts.config ? { ...opts, precheckedMode: input.mode } : opts;
  return withLearningLoopAdmission<{ status: 'recorded' | 'idempotent'; event: SessionEvaluatedEvent }>(input.engine, admissionOpts, (state, admissionMode) => {
    if (admissionMode === 'off') throw new LearningLoopError('mode_off', 'Learning Loop mode changed to off before admission');
    if (input.mode === 'canary' && admissionMode !== 'canary') throw new LearningLoopError('mode_off', 'Canary admission is no longer active');
    const effectiveMode = input.mode === 'capture' ? 'capture' : admissionMode;
    let run: RunProjection | undefined;
    if (effectiveMode === 'canary') {
      if (state.active_run_id === null) throw new LearningLoopError('no_active_run', 'Canary mode has no armed run');
      run = state.runs.get(state.active_run_id)!;
      const expected = run.armed.authorized_adapter;
      if (input.adapter.client_id !== expected.client_id || input.adapter.source_id !== expected.source_id || input.adapter.provider !== expected.provider) {
        throw new LearningLoopError('forbidden', 'Adapter identity does not match the armed run');
      }
    }
    const key = `${input.receipt.provider}\u0000${input.receipt.provider_session_id}`;
    requireSessionBinding(state, input.adapter, input.receipt.provider_session_id);
    const priorHash = state.session_hashes.get(key);
    if (priorHash !== undefined) {
      if (priorHash !== input.receipt.content_hash) throw new LearningLoopError('transcript_conflict', 'Session transcript hash changed');
      return { value: { status: 'idempotent' as const, event: state.session_events.get(key)! } };
    }
    const classification = classifyTranscript(input.receipt);
    const position = run && classification.eligible && !run.sealed ? run.cohort.length + 1 : null;
    const cohortMember = position !== null && position <= TARGET_COHORT_SIZE;
    const sealed = cohortMember && position === TARGET_COHORT_SIZE;
    const body = {
      schema_version: LEARNING_LOOP_SCHEMA_VERSION,
      event_type: 'session_evaluated' as const,
      occurred_at: (opts.now ?? (() => new Date()))().toISOString(),
      run_id: run?.run_id ?? null,
      provider: 'codex' as const,
      provider_session_id: input.receipt.provider_session_id,
      completed_at: input.receipt.completed_at,
      completion_state: 'completed' as const,
      adapter: input.adapter,
      authoritative: input.receipt,
      classifier_version: ELIGIBILITY_CLASSIFIER_VERSION,
      eligible: classification.eligible,
      reason: classification.reason,
      cohort_member: cohortMember,
      cohort_position: cohortMember ? position : null,
      cohort_sealed: sealed,
    };
    const event = completeEvent(body) as SessionEvaluatedEvent;
    return { value: { status: 'recorded' as const, event }, event };
  });
}

export const _testing = {
  countCodexJsonlRoles,
  countTextRoles,
  codexSessionIds,
  commandPayloadHash,
  eventId,
  ledgerScopeId,
  readConfinedFileOnce,
  normalizeRelativePath,
  handleBaselineWalkError,
};
