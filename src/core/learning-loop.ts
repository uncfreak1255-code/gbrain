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
import type { BrainEngine } from './engine.ts';
import type { GBrainConfig } from './config.ts';
import { gbrainPath } from './config.ts';
import { canonicalJson } from './remediation-step.ts';
import { parseConversation } from './conversation-parser/parse.ts';
import { pruneDir } from './sync.ts';
import { VERSION } from '../version.ts';
import { LockUnavailableError, withRefreshingLock } from './db-lock.ts';
import { computeBrainIdFromConfig } from './upgrade-checkpoint.ts';
import { isPathContained } from './path-confine.ts';

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

export type LearningLoopEvent = RunArmedEvent | RunArmedEventV2 | RunAbortedEvent | AdapterSessionBoundEvent | SessionEvaluatedEvent;
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

export function classifyTranscript(receipt: TranscriptReceipt): { eligible: boolean; reason: EligibilityReason } {
  if (receipt.size_bytes < MIN_TRANSCRIPT_BYTES) return { eligible: false, reason: 'transcript_too_small' };
  if (receipt.user_turn_count < 2) return { eligible: false, reason: 'insufficient_user_turns' };
  if (receipt.assistant_turn_count < 2) return { eligible: false, reason: 'insufficient_assistant_turns' };
  return { eligible: true, reason: 'eligible' };
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
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
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
    } else {
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

function appendEvent(event: LearningLoopEvent, opts: LedgerOptions): void {
  verifyEvent(event);
  const path = learningLoopLedgerPath(opts);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
  try {
    appendFileSync(fd, JSON.stringify(event) + '\n', 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function withLedgerMutation<T>(
  engine: BrainEngine,
  opts: LedgerOptions,
  fn: (state: LearningLoopProjection) => { value: T; event?: LearningLoopEvent },
): Promise<T> {
  const work = async (): Promise<T> => {
    await opts.beforeMutation?.();
    const state = replayLearningLoop(readLearningLoopLedger(opts));
    const result = fn(state);
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
  try {
    return await withRefreshingLock(engine, `learning-loop:lifecycle-v1:${ledgerScopeId(opts)}`, work, { ttlMinutes: 5 });
  } catch (error) {
    if (error instanceof LockUnavailableError) throw new LearningLoopError('ledger_busy', 'Learning Loop lifecycle is locked');
    throw error;
  }
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
  return withLedgerMutation<AdapterSessionBoundEvent>(engine, opts, (state) => {
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
  const existing = await withLedgerMutation<RunArmedEvent | RunArmedEventV2 | null>(input.engine, opts, (state) => {
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
  return withLedgerMutation<RunArmedEvent | RunArmedEventV2>(input.engine, opts, (state) => {
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

export async function setLearningLoopMode(
  engine: BrainEngine,
  config: GBrainConfig,
  next: LearningLoopMode,
  opts: LedgerOptions = {},
): Promise<{ previous_mode: LearningLoopMode; mode: LearningLoopMode }> {
  const scopedOpts = opts.root || opts.config ? opts : { ...opts, config };
  return withLearningLoopLifecycleLock(engine, async () => {
    const current = await resolveLearningLoopMode(engine, config);
    if (current === 'canary' && next !== 'canary') {
      const state = replayLearningLoop(readLearningLoopLedger(scopedOpts));
      if (state.active_run_id !== null) {
        try {
          await abortLearningLoop(engine, `mode-change:${state.active_run_id}`, 'mode_changed', scopedOpts);
        } catch (error) {
          if (!(error instanceof LearningLoopError) || error.code !== 'no_active_run') throw error;
        }
      }
    }
    await engine.setConfig('learning_loop.mode', next);
    return { previous_mode: current, mode: next };
  }, scopedOpts);
}

export function abortLearningLoop(
  engine: BrainEngine,
  commandId: string,
  reason: RunAbortedEvent['reason'],
  opts: LedgerOptions = {},
): Promise<RunAbortedEvent> {
  if (!COMMAND_ID_RE.test(commandId)) throw new LearningLoopError('invalid_input', 'Invalid abort command id');
  const payloadHash = commandPayloadHash({ reason });
  return withLedgerMutation<RunAbortedEvent>(engine, opts, (state) => {
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
  });
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
  return withLedgerMutation<{ status: 'recorded' | 'idempotent'; event: SessionEvaluatedEvent }>(input.engine, opts, (state) => {
    let run: RunProjection | undefined;
    if (input.mode === 'canary') {
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
};
