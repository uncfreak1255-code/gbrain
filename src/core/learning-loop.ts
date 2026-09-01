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
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import type { BrainEngine } from './engine.ts';
import type { GBrainConfig } from './config.ts';
import { gbrainPath } from './config.ts';
import { canonicalJson } from './remediation-step.ts';
import { parseConversation } from './conversation-parser/parse.ts';
import { pruneDir } from './sync.ts';
import { VERSION } from '../version.ts';
import { LockUnavailableError, withRefreshingLock } from './db-lock.ts';
import { computeBrainIdFromConfig } from './upgrade-checkpoint.ts';

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

export type LearningLoopEvent = RunArmedEvent | RunAbortedEvent | AdapterSessionBoundEvent | SessionEvaluatedEvent;
export type EligibilityReason =
  | 'eligible'
  | 'transcript_too_small'
  | 'insufficient_user_turns'
  | 'insufficient_assistant_turns';

export interface RunProjection {
  run_id: string;
  terminal: boolean;
  armed: RunArmedEvent;
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
      | 'assertion_mismatch',
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
    const rel = relative(root, resolved);
    if (!rel || rel.startsWith('..') || rel.startsWith('/') || rel.includes('\\')) throw new Error('escape');
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
  const { root } = await resolveCodexCorpus(input.engine, input.source_id, input.config);
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
  source_id: string;
  cutoff_at: string;
}): Promise<RunArmedEvent['baseline_discovery']> {
  const cutoffMs = Date.parse(input.cutoff_at);
  if (!Number.isFinite(cutoffMs)) throw new LearningLoopError('invalid_input', 'Baseline cutoff must be ISO 8601');
  const { root } = await resolveCodexCorpus(input.engine, input.source_id, input.config);
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
      manifest.push({ relative_path: relative(root, path), error: 'invalid_or_unreadable' });
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
      || event.contract_version !== 1
      || !nonEmpty(event.implementation_version)
      || event.provider_allow_list?.length !== 1
      || event.provider_allow_list[0] !== 'codex'
      || event.target_cohort_size !== TARGET_COHORT_SIZE
      || event.eligibility_classifier_version !== ELIGIBILITY_CLASSIFIER_VERSION
      || !validAdapter(event.authorized_adapter)
      || !nonEmpty(event.destination?.brain_id)
      || !nonEmpty(event.destination?.source_id)
      || !nonEmpty(event.destination?.canonical_slug)
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

export function replayLearningLoop(events: LearningLoopEvent[]): LearningLoopProjection {
  const projection: LearningLoopProjection = {
    events: [], active_run_id: null, runs: new Map(), session_hashes: new Map(), session_events: new Map(), session_bindings: new Map(),
  };
  const ids = new Map<string, string>();
  const commands = new Set<string>();
  for (const event of events) {
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
  const events: LearningLoopEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line) as LearningLoopEvent); }
    catch { throw new LearningLoopError('ledger_corrupt', 'Learning Loop ledger contains malformed JSON'); }
  }
  replayLearningLoop(events);
  return events;
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
  destination: { brain_id: string; source_id: string; canonical_slug: string };
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

async function armLearningLoopLocked(input: ArmLearningLoopInput, opts: LedgerOptions): Promise<RunArmedEvent> {
  if (!COMMAND_ID_RE.test(input.command_id)) throw new LearningLoopError('invalid_input', 'Invalid arm command id');
  if (
    !validAdapter(input.authorized_adapter)
    || !nonEmpty(input.destination.brain_id)
    || !nonEmpty(input.destination.source_id)
    || !nonEmpty(input.destination.canonical_slug)
    || input.authorized_adapter.source_id !== input.destination.source_id
  ) throw new LearningLoopError('forbidden', 'Arm destination must match the authorized adapter source');
  const occurredAt = (opts.now ?? (() => new Date()))().toISOString();
  const payloadHash = commandPayloadHash({
    authorized_adapter: input.authorized_adapter,
    destination: input.destination,
  });
  const existing = await withLedgerMutation<RunArmedEvent | null>(input.engine, opts, (state) => {
    const prior = state.events.find((event): event is RunArmedEvent => event.event_type === 'run_armed' && event.command_id === input.command_id);
    if (!prior) return { value: null };
    if (prior.command_payload_hash !== payloadHash) throw new LearningLoopError('command_conflict', 'Arm command id was reused with a different payload');
    return { value: prior };
  });
  if (existing) return existing;
  const baselineDiscovery = await discoverBaselineSnapshot({
    engine: input.engine,
    config: input.config,
    source_id: input.authorized_adapter.source_id,
    cutoff_at: occurredAt,
  });
  return withLedgerMutation<RunArmedEvent>(input.engine, opts, (state) => {
    const prior = state.events.find((event): event is RunArmedEvent => event.event_type === 'run_armed' && event.command_id === input.command_id);
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
      contract_version: 1 as const,
      implementation_version: VERSION,
      provider_allow_list: ['codex'] as ['codex'],
      target_cohort_size: TARGET_COHORT_SIZE,
      eligibility_classifier_version: ELIGIBILITY_CLASSIFIER_VERSION,
      authorized_adapter: input.authorized_adapter,
      destination: input.destination,
      baseline_discovery: baselineDiscovery,
    };
    const event = completeEvent(body) as RunArmedEvent;
    return { value: event, event };
  });
}

export async function armLearningLoop(
  input: ArmLearningLoopInput,
  opts: LedgerOptions = {},
): Promise<RunArmedEvent> {
  const scopedOpts = opts.root || opts.config ? opts : { ...opts, config: input.config };
  return withLearningLoopLifecycleLock(input.engine, async () => {
    const mode = await resolveLearningLoopMode(input.engine, input.config);
    if (mode !== 'canary') throw new LearningLoopError('mode_off', 'Set mode to canary before arming');
    return armLearningLoopLocked(input, scopedOpts);
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
    const binding = state.session_bindings.get(key);
    if (
      !binding
      || binding.adapter.client_id !== input.adapter.client_id
      || binding.adapter.source_id !== input.adapter.source_id
      || binding.adapter.provider !== input.adapter.provider
    ) {
      throw new LearningLoopError('forbidden', 'Adapter is not bound to the submitted provider session');
    }
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
};
