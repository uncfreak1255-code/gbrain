/**
 * Trusted-local source-path hygiene evidence.
 *
 * This module is deliberately read-only. It classifies source rows and returns
 * structured review evidence; lifecycle execution remains in `gbrain sources`.
 * Absolute paths never leave the inspector packet.
 */

import type { BrainEngine } from './engine.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { inspectLock, syncLockId } from './db-lock.ts';
import { type RepoState, validateRepoState } from './git-remote.ts';
import { isOwnedClone } from './sources-ops.ts';
import {
  loadAllSources,
  parseSourceConfig,
  type SourceRow,
} from './sources-load.ts';

export type SourceHygieneClassification =
  | 'healthy'
  | 'not_applicable'
  | 'archive_candidate'
  | 'recovery_required';

export type SourceHygieneRepoState =
  | RepoState
  | 'not_inspected'
  | 'not_applicable';

export type SourceRecoveryMode =
  | 'none'
  | 'archive_review'
  | 'managed_clone_sync'
  | 'manual';

/** Privacy-safe facts used by the pure classifier. No absolute paths/bodies. */
export interface SourceHygieneEvidence {
  source_id: string;
  archived: boolean;
  has_local_path: boolean;
  shared_path_source_count: number;
  repo_state: SourceHygieneRepoState;
  /** Inspector packets always set this; absent legacy evidence fails closed. */
  source_config_known?: boolean;
  remote_recovery_configured: boolean;
  managed_clone: boolean;
  configured_default: boolean;
  configured_default_known: boolean;
  dependent_row_count: number | null;
  dependent_data_known: boolean;
  nonterminal_work_count: number | null;
  work_state_known: boolean;
  live_sync_lock: boolean | null;
  lock_state_known: boolean;
}

export interface SourceHygieneDecision extends SourceHygieneEvidence {
  classification: SourceHygieneClassification;
  recovery_mode: SourceRecoveryMode;
  proposed_command_argv: string[] | null;
  /** Stable machine-readable reasons that veto autonomous archive. */
  veto_reasons: string[];
  /** Eligible for the maintain skill's adversarial review, not auto-execution. */
  safe_for_agent_review: boolean;
}

export interface SourceHygienePacket {
  schema_version: 1;
  filesystem_inspected: boolean;
  sources: SourceHygieneDecision[];
}

export type ProtectedSourceWorkBlockReason =
  | 'unknown_source'
  | 'target_not_healthy'
  | 'brain_recovery_required';

export type ProtectedSourceWorkGate =
  | { allowed: true; reason: null }
  | { allowed: false; reason: ProtectedSourceWorkBlockReason };

export interface SourceHygieneProbes {
  repoState: (localPath: string, expectedRemoteUrl?: string) => RepoState;
  liveSyncLock: (engine: BrainEngine, sourceId: string) => Promise<boolean>;
}

export interface InspectSourceHygieneOpts {
  /** Must be explicitly true. Remote/MCP callers leave this false. */
  inspectFilesystem?: boolean;
  /** Focused deterministic test seam; production callers omit it. */
  probes?: Partial<SourceHygieneProbes>;
}

const DEFAULT_PROBES: SourceHygieneProbes = {
  repoState: validateSourceRepoState,
  liveSyncLock: async (engine, sourceId) => {
    const snap = await inspectLock(engine, syncLockId(sourceId));
    return !!snap && !snap.ttl_expired;
  },
};

/**
 * User-owned local sources do not need an `origin` remote. The shared remote
 * clone validator deliberately treats a missing origin as corrupted, so use a
 * local Git validity probe when no recovery URL is configured.
 */
export function validateSourceRepoState(
  localPath: string,
  expectedRemoteUrl?: string,
): RepoState {
  if (expectedRemoteUrl) return validateRepoState(localPath, expectedRemoteUrl);
  let stat;
  try {
    stat = lstatSync(localPath);
  } catch (error: any) {
    return error?.code === 'ENOENT' ? 'missing' : 'not-a-dir';
  }
  if (!stat.isDirectory()) return 'not-a-dir';
  const hasGitMarker = existsSync(join(localPath, '.git'));
  try {
    const inside = execFileSync(
      'git',
      ['-C', localPath, 'rev-parse', '--is-inside-work-tree'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
    ).toString().trim();
    if (inside === 'true') return 'healthy';
    return hasGitMarker ? 'corrupted' : 'no-git';
  } catch {
    return hasGitMarker ? 'corrupted' : 'no-git';
  }
}

const MANAGED_SYNC_RECOVERABLE_STATES: ReadonlySet<SourceHygieneRepoState> =
  new Set(['missing', 'no-git', 'not-a-dir']);

/** Pure deterministic classification over already-redacted evidence. */
export function classifySourceHygieneEvidence(
  evidence: SourceHygieneEvidence,
): SourceHygieneDecision {
  if (evidence.archived) {
    return decision(evidence, 'not_applicable', 'none', null, [], true);
  }
  if (!evidence.has_local_path || evidence.repo_state === 'not_applicable') {
    return decision(evidence, 'not_applicable', 'none', null, [], true);
  }
  if (evidence.repo_state === 'not_inspected') {
    return decision(
      evidence,
      'not_applicable',
      'none',
      null,
      ['filesystem_not_inspected'],
      false,
    );
  }
  if (evidence.repo_state === 'healthy') {
    return decision(evidence, 'healthy', 'none', null, [], true);
  }

  const vetoes = archiveVetoReasons(evidence);
  const archiveCandidate = evidence.repo_state === 'missing' && vetoes.length === 0;
  if (archiveCandidate) {
    return decision(
      evidence,
      'archive_candidate',
      'archive_review',
      ['gbrain', 'sources', 'archive', evidence.source_id, '--if-hygiene-candidate'],
      [],
      true,
    );
  }

  const managedRecoverable =
    evidence.managed_clone &&
    evidence.remote_recovery_configured &&
    MANAGED_SYNC_RECOVERABLE_STATES.has(evidence.repo_state);
  const actionEvidenceKnown =
    evidence.work_state_known &&
    evidence.nonterminal_work_count === 0 &&
    evidence.lock_state_known &&
    evidence.live_sync_lock === false;

  if (managedRecoverable) {
    return decision(
      evidence,
      'recovery_required',
      'managed_clone_sync',
      actionEvidenceKnown
        ? ['gbrain', 'sync', '--source', evidence.source_id]
        : null,
      vetoes,
      actionEvidenceKnown,
    );
  }

  return decision(
    evidence,
    'recovery_required',
    'manual',
    null,
    vetoes,
    false,
  );
}

/**
 * Protected or paid source work is brain-wide fail-closed: a healthy target
 * cannot run while a neighboring source still needs recovery.
 */
export function gateProtectedSourceWork(
  packet: SourceHygienePacket,
  sourceId: string,
): ProtectedSourceWorkGate {
  const target = packet.sources.find((source) => source.source_id === sourceId);
  if (!target) return { allowed: false, reason: 'unknown_source' };
  if (packet.sources.some((source) => source.classification === 'recovery_required')) {
    return { allowed: false, reason: 'brain_recovery_required' };
  }
  const dbOnlyTarget =
    target.classification === 'not_applicable' &&
    !target.archived &&
    !target.has_local_path &&
    target.repo_state === 'not_applicable';
  if (target.classification !== 'healthy' && !dbOnlyTarget) {
    return { allowed: false, reason: 'target_not_healthy' };
  }
  return { allowed: true, reason: null };
}

/**
 * Build a privacy-safe, schema-versioned source-hygiene packet.
 *
 * DB metadata/count reads always run. Filesystem and live-lock probes run only
 * after a trusted local caller explicitly opts in.
 */
export async function inspectSourceHygiene(
  engine: BrainEngine,
  opts: InspectSourceHygieneOpts = {},
): Promise<SourceHygienePacket> {
  const inspectFilesystem = opts.inspectFilesystem === true;
  const probes: SourceHygieneProbes = { ...DEFAULT_PROBES, ...opts.probes };
  const sources = await loadAllSources(engine, { includeArchived: true });
  const pathCounts = countSharedPaths(sources);
  const configuredDefault = await readConfiguredDefault(engine, sources);
  const pathEvidence = new Map<string, {
    repoState: SourceHygieneRepoState;
    liveSyncLock: boolean | null;
    lockStateKnown: boolean;
  }>();
  const degradedSourceIds: string[] = [];

  for (const source of sources) {
    const sourceConfigKnown = isSourceConfigKnown(source.config);
    const cfg = sourceConfigKnown ? parseSourceConfig(source.config) : {};
    const remoteUrl = typeof cfg.remote_url === 'string' && cfg.remote_url.length > 0
      ? cfg.remote_url
      : undefined;
    const hasLocalPath = typeof source.local_path === 'string' && source.local_path.length > 0;
    let repoState: SourceHygieneRepoState = hasLocalPath
      ? 'not_inspected'
      : 'not_applicable';
    let liveSyncLock: boolean | null = null;
    let lockStateKnown = !hasLocalPath || source.archived === true;

    if (inspectFilesystem && hasLocalPath && source.archived !== true) {
      repoState = probes.repoState(source.local_path!, remoteUrl);
      try {
        liveSyncLock = await probes.liveSyncLock(engine, source.id);
        lockStateKnown = true;
      } catch {
        liveSyncLock = null;
        lockStateKnown = false;
      }
      if (repoState !== 'healthy') degradedSourceIds.push(source.id);
    }
    pathEvidence.set(source.id, { repoState, liveSyncLock, lockStateKnown });
  }

  // The expensive aggregate scans are needed only when a trusted local path
  // probe found a degraded active source. Healthy steady-state autopilot ticks
  // do not repeatedly group every source-linked table.
  const dependentData = degradedSourceIds.length > 0
    ? await readDependentDataCounts(engine, degradedSourceIds)
    : { known: true, counts: new Map<string, number>() };
  const work = degradedSourceIds.length > 0
    ? await readNonterminalWorkCounts(engine, degradedSourceIds)
    : { known: true, counts: new Map<string, number>() };

  const decisions: SourceHygieneDecision[] = [];
  for (const source of sources) {
    const sourceConfigKnown = isSourceConfigKnown(source.config);
    const cfg = sourceConfigKnown ? parseSourceConfig(source.config) : {};
    const remoteUrl = typeof cfg.remote_url === 'string' && cfg.remote_url.length > 0
      ? cfg.remote_url
      : undefined;
    const hasLocalPath = typeof source.local_path === 'string' && source.local_path.length > 0;
    const inspected = pathEvidence.get(source.id)!;
    const repoState = inspected.repoState;
    const liveSyncLock = inspected.liveSyncLock;
    const lockStateKnown = inspected.lockStateKnown;

    let managedClone = false;
    try {
      managedClone = hasLocalPath && isOwnedClone(source);
    } catch {
      // Malformed/unknown ownership evidence must never authorize archive.
      managedClone = false;
    }

    const evidence: SourceHygieneEvidence = {
      source_id: source.id,
      archived: source.archived === true,
      has_local_path: hasLocalPath,
      shared_path_source_count: hasLocalPath
        ? (pathCounts.get(source.local_path!) ?? 1)
        : 0,
      repo_state: repoState,
      source_config_known: sourceConfigKnown,
      remote_recovery_configured: remoteUrl !== undefined,
      managed_clone: managedClone,
      configured_default: configuredDefault.value === source.id,
      configured_default_known: configuredDefault.known,
      dependent_row_count: dependentData.known
        ? (dependentData.counts.get(source.id) ?? 0)
        : null,
      dependent_data_known: dependentData.known,
      nonterminal_work_count: work.known
        ? (work.counts.get(source.id) ?? 0)
        : null,
      work_state_known: work.known,
      live_sync_lock: liveSyncLock,
      lock_state_known: lockStateKnown,
    };
    decisions.push(classifySourceHygieneEvidence(evidence));
  }

  return {
    schema_version: 1,
    filesystem_inspected: inspectFilesystem,
    sources: decisions,
  };
}

function decision(
  evidence: SourceHygieneEvidence,
  classification: SourceHygieneClassification,
  recoveryMode: SourceRecoveryMode,
  command: string[] | null,
  vetoReasons: string[],
  safeForAgentReview: boolean,
): SourceHygieneDecision {
  return {
    ...evidence,
    classification,
    recovery_mode: recoveryMode,
    proposed_command_argv: command,
    veto_reasons: vetoReasons,
    safe_for_agent_review: safeForAgentReview,
  };
}

function archiveVetoReasons(evidence: SourceHygieneEvidence): string[] {
  const vetoes: string[] = [];
  if (evidence.source_id === 'default') vetoes.push('default_source');
  if (evidence.source_config_known !== true) vetoes.push('source_config_unknown');
  if (!evidence.configured_default_known) vetoes.push('configured_default_unknown');
  else if (evidence.configured_default) vetoes.push('configured_default_source');
  if (!evidence.dependent_data_known || evidence.dependent_row_count === null) {
    vetoes.push('dependent_data_unknown');
  } else if (evidence.dependent_row_count > 0) {
    vetoes.push('source_has_dependent_data');
  }
  if (evidence.remote_recovery_configured) vetoes.push('remote_recovery_metadata');
  if (evidence.managed_clone) vetoes.push('managed_clone');
  if (!evidence.work_state_known || evidence.nonterminal_work_count === null) {
    vetoes.push('source_work_unknown');
  } else if (evidence.nonterminal_work_count > 0) {
    vetoes.push('nonterminal_source_work');
  }
  if (!evidence.lock_state_known || evidence.live_sync_lock === null) {
    vetoes.push('sync_lock_unknown');
  } else if (evidence.live_sync_lock) {
    vetoes.push('live_sync_lock');
  }
  if (evidence.repo_state !== 'missing') {
    vetoes.push(`repo_state_${evidence.repo_state}`);
  }
  return vetoes;
}

function countSharedPaths(sources: SourceRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const source of sources) {
    if (!source.local_path) continue;
    counts.set(source.local_path, (counts.get(source.local_path) ?? 0) + 1);
  }
  return counts;
}

function isSourceConfigKnown(config: unknown): boolean {
  if (typeof config === 'string') {
    try {
      const parsed: unknown = JSON.parse(config);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }
  return typeof config === 'object' && config !== null && !Array.isArray(config);
}

async function readConfiguredDefault(
  engine: BrainEngine,
  sources: SourceRow[],
): Promise<{ known: boolean; value: string | null }> {
  try {
    const explicitSourceId = await engine.getConfig('sources.default');
    if (explicitSourceId) return { known: true, value: explicitSourceId };

    const legacyRepoPath = await engine.getConfig('sync.repo_path');
    if (!legacyRepoPath) return { known: true, value: null };
    const matches = sources.filter(
      (source) => source.archived !== true && source.local_path === legacyRepoPath,
    );
    const conventionalDefault = matches.find((source) => source.id === 'default');
    if (conventionalDefault) return { known: true, value: conventionalDefault.id };
    if (matches.length === 1) return { known: true, value: matches[0]!.id };
    return { known: false, value: null };
  } catch {
    return { known: false, value: null };
  }
}

type SourceReferenceKind = 'scalar' | 'array' | 'json_source_keys';

interface SourceReferenceColumn {
  table: string;
  column: string;
  kind: SourceReferenceKind;
}

/**
 * Non-canonical source references that are not discoverable as a column named
 * exactly `source_id`. Keep the shapes explicit so archive safety cannot drift
 * when an auth, eval, or job binding uses an array or JSON payload.
 */
const EXTRA_SOURCE_REFERENCE_REGISTRY: readonly SourceReferenceColumn[] = [
  { table: 'oauth_clients', column: 'bound_source_id', kind: 'scalar' },
  { table: 'oauth_clients', column: 'federated_read', kind: 'array' },
  { table: 'eval_candidates', column: 'source_ids', kind: 'array' },
];

// These rows are historical/derived receipts, not source-owned brain content.
// Nonterminal minion work is checked separately and still vetoes archive.
const NON_CONTENT_SOURCE_REFERENCE_TABLES = new Set([
  'extract_rollup_7d',
  'minion_jobs',
]);

async function readDependentDataCounts(
  engine: BrainEngine,
  candidateSourceIds: string[],
): Promise<{ known: boolean; counts: Map<string, number> }> {
  const counts = new Map<string, number>();
  if (candidateSourceIds.length === 0) return { known: true, counts };
  try {
    const columns = await engine.executeRaw<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND (
            c.column_name = 'source_id'
            OR (c.table_name = 'oauth_clients' AND c.column_name IN ('bound_source_id', 'federated_read'))
            OR (c.table_name = 'eval_candidates' AND c.column_name = 'source_ids')
            OR (c.table_name = 'minion_jobs' AND c.column_name = 'data')
          )
        ORDER BY c.table_name, c.column_name`,
    );

    const available = new Set(
      columns.map((column) => `${column.table_name}.${column.column_name}`),
    );
    const directSourceIdColumns: SourceReferenceColumn[] = columns
      .filter((column) =>
        column.column_name === 'source_id' &&
        !NON_CONTENT_SOURCE_REFERENCE_TABLES.has(column.table_name))
      .map((column) => ({ table: column.table_name, column: 'source_id', kind: 'scalar' }));
    const references = [
      ...directSourceIdColumns,
      ...EXTRA_SOURCE_REFERENCE_REGISTRY.filter(
        (reference) => available.has(`${reference.table}.${reference.column}`),
      ),
    ];

    for (const reference of references) {
      const table = quoteIdentifier(reference.table);
      const column = quoteIdentifier(reference.column);
      if (reference.kind === 'scalar') {
        const rows = await engine.executeRaw<{ source_id: string; n: number }>(
          `SELECT ${column} AS source_id, COUNT(*)::int AS n
             FROM ${table}
            WHERE ${column} = ANY($1::text[])
            GROUP BY ${column}`,
          [candidateSourceIds],
        );
        addCounts(counts, rows);
        continue;
      }

      for (const sourceId of candidateSourceIds) {
        const predicate = reference.kind === 'array'
          ? `$1::text = ANY(${column})`
          : `(${column}->>'sourceId' = $1 OR ${column}->>'source_id' = $1)`;
        const rows = await engine.executeRaw<{ source_id: string; n: number }>(
          `SELECT $1::text AS source_id, COUNT(*)::int AS n
             FROM ${table}
            WHERE ${predicate}`,
          [sourceId],
        );
        addCounts(counts, rows);
      }
    }

    return { known: true, counts };
  } catch {
    return { known: false, counts: new Map() };
  }
}

async function readNonterminalWorkCounts(
  engine: BrainEngine,
  candidateSourceIds: string[],
): Promise<{ known: boolean; counts: Map<string, number> }> {
  if (candidateSourceIds.length === 0) return { known: true, counts: new Map() };
  try {
    const rows = await engine.executeRaw<{ source_id: string; n: number }>(
      `SELECT COALESCE(data->>'sourceId', data->>'source_id') AS source_id,
              COUNT(*)::int AS n
         FROM minion_jobs
        WHERE COALESCE(data->>'sourceId', data->>'source_id') = ANY($1::text[])
          AND status NOT IN ('completed', 'failed', 'dead', 'cancelled')
        GROUP BY COALESCE(data->>'sourceId', data->>'source_id')`,
      [candidateSourceIds],
    );
    const counts = new Map<string, number>();
    addCounts(counts, rows);
    return { known: true, counts };
  } catch {
    return { known: false, counts: new Map() };
  }
}

/*
 * Keep count accumulation strict: malformed DB driver results make archive
 * evidence unknown instead of silently approving a source.
 */
function addCounts(
  target: Map<string, number>,
  rows: Array<{ source_id: string; n: number }>,
): void {
  for (const row of rows) {
    const sourceId = String(row.source_id);
    const count = Number(row.n);
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`Invalid source-owned row count for ${sourceId}`);
    }
    target.set(sourceId, (target.get(sourceId) ?? 0) + count);
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error('Unsafe information_schema table identifier');
  }
  return `"${value.replaceAll('"', '""')}"`;
}
