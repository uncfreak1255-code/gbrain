import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { BrainEngine } from './engine.ts';
import { anySignal } from './abort-check.ts';

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_ARCHIVE_POLL_MS = 50;
const DEFAULT_ARCHIVE_WAIT_MS = 10 * 60_000;
const DEFAULT_DB_OPERATION_MS = 30_000;
const DEFAULT_STALE_LEASE_MS = 10 * 60_000;

const PROCESS_OWNER_HOST = hostname();
const PROCESS_OWNER_PID = process.pid;
const PROCESS_OWNER_INSTANCE = randomUUID();

let heartbeatMs = DEFAULT_HEARTBEAT_MS;
let archivePollMs = DEFAULT_ARCHIVE_POLL_MS;
let archiveWaitMs = DEFAULT_ARCHIVE_WAIT_MS;
let dbOperationMs = DEFAULT_DB_OPERATION_MS;

export interface SourceArchiveDrain {
  sourceId: string;
  token: string;
  epoch: number;
  /** Hygiene-relevant source metadata captured when this archive attempt began. */
  localPath: string | null;
  configJson: string;
}

export interface SourceDrainFinalizeState {
  status: 'ready' | 'already_archived';
}

export interface StaleSourceEmbeddingLeaseRecovery {
  revoked: number;
  remaining: number;
}

interface ProviderLeaseOwnerRow {
  lease_token: string;
  owner_host: string;
  owner_pid: number | string;
  owner_instance: string;
}

export class SourceEmbeddingLeaseLostError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SourceEmbeddingLeaseLostError';
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function leaseLost(sourceId: string, detail: string, cause?: unknown): SourceEmbeddingLeaseLostError {
  return new SourceEmbeddingLeaseLostError(
    `Embedding source lease for "${sourceId}" was lost (${detail}); provider output was discarded`,
    cause === undefined ? undefined : { cause },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localOwnerPidIsProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error as { code?: unknown }).code === 'ESRCH';
  }
}

async function reclaimProvablyDeadLocalOwners(
  engine: BrainEngine,
  drain: SourceArchiveDrain,
  rows: ProviderLeaseOwnerRow[],
): Promise<number> {
  // A shared Postgres brain can have workers on different machines with the
  // same hostname and PID. Without a machine-unique identity, a local
  // process.kill(pid, 0) result cannot prove that a Postgres lease owner is
  // dead. PGLite is single-owner under its exclusive data-directory lock, so
  // hostname + PID remains sufficient there.
  if (engine.kind !== 'pglite') return 0;

  let reclaimed = 0;
  for (const row of rows) {
    const ownerPid = Number(row.owner_pid);
    const validIdentity = row.owner_host.length > 0
      && Number.isSafeInteger(ownerPid)
      && ownerPid > 0
      && row.owner_instance.length > 0;
    if (
      !validIdentity
      || row.owner_host !== PROCESS_OWNER_HOST
      || !localOwnerPidIsProvablyDead(ownerPid)
    ) continue;

    const deleted = await engine.executeRaw<{ lease_token: string }>(
      `DELETE FROM public.source_embedding_leases
        WHERE lease_token = $1
          AND source_id = $2
          AND owner_host = $3
          AND owner_pid = $4
          AND owner_instance = $5
      RETURNING lease_token`,
      [
        row.lease_token,
        drain.sourceId,
        row.owner_host,
        ownerPid,
        row.owner_instance,
      ],
    );
    if (deleted.length === 1 && deleted[0]?.lease_token === row.lease_token) reclaimed++;
  }
  return reclaimed;
}

/**
 * Test-only timing seam. Passing no argument restores production defaults.
 */
export function __setSourceEmbeddingLeaseTimingsForTests(
  timings?: Partial<{
    heartbeatMs: number;
    archivePollMs: number;
    archiveWaitMs: number;
    dbOperationMs: number;
  }>,
): void {
  heartbeatMs = timings?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  archivePollMs = timings?.archivePollMs ?? DEFAULT_ARCHIVE_POLL_MS;
  archiveWaitMs = timings?.archiveWaitMs ?? DEFAULT_ARCHIVE_WAIT_MS;
  dbOperationMs = timings?.dbOperationMs ?? DEFAULT_DB_OPERATION_MS;
}

function boundedDbOperation<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${dbOperationMs}ms`));
    }, dbOperationMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Acquire one exact, durable provider token in a short transaction. The shared
 * lifecycle advisory lock keeps the ordering consistent with source archive's
 * final transaction; the source-row lock linearizes acquire vs begin-drain.
 */
async function acquireProviderLease(
  engine: BrainEngine,
  sourceId: string,
): Promise<{ token: string; epoch: number }> {
  const token = randomUUID();
  return engine.transaction(async (tx) => {
    await tx.executeRaw(
      `SELECT pg_advisory_xact_lock_shared(
         hashtextextended('gbrain:source-lifecycle', 0)
       )`,
    );
    const sources = await tx.executeRaw<{
      id: string;
      archived: boolean;
      embedding_drain_token: string | null;
      embedding_drain_epoch: number | string;
    }>(
      `SELECT id, archived, embedding_drain_token, embedding_drain_epoch
         FROM public.sources
        WHERE id = $1
        FOR UPDATE`,
      [sourceId],
    );
    const source = sources[0];
    if (!source || source.archived || source.embedding_drain_token !== null) {
      throw new Error(
        `Source "${sourceId}" is archived, draining, or unavailable; refusing embedding provider submission`,
      );
    }

    const epoch = Number(source.embedding_drain_epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error(`Source "${sourceId}" has an invalid embedding drain epoch`);
    }
    await tx.executeRaw(
      `INSERT INTO public.source_embedding_leases
         (lease_token, source_id, source_epoch, owner_host, owner_pid,
          owner_instance, acquired_at, heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
      [
        token,
        sourceId,
        epoch,
        PROCESS_OWNER_HOST,
        PROCESS_OWNER_PID,
        PROCESS_OWNER_INSTANCE,
      ],
    );
    return { token, epoch };
  });
}

async function heartbeatProviderLease(
  engine: BrainEngine,
  sourceId: string,
  token: string,
  epoch: number,
): Promise<void> {
  const rows = await boundedDbOperation(
    engine.transaction((tx) => tx.executeRaw<{ lease_token: string }>(
      `UPDATE public.source_embedding_leases lease
        SET heartbeat_at = now()
       FROM public.sources source
      WHERE lease.lease_token = $1
        AND lease.source_id = $2
        AND lease.source_epoch = $3
        AND source.id = lease.source_id
        AND source.archived IS NOT TRUE
        AND source.embedding_drain_token IS NULL
        AND source.embedding_drain_epoch = lease.source_epoch
      RETURNING lease.lease_token`,
      [token, sourceId, epoch],
    )),
    `Embedding lease heartbeat for source "${sourceId}"`,
  );
  if (rows.length !== 1 || rows[0]?.lease_token !== token) {
    throw leaseLost(sourceId, 'heartbeat token no longer exists');
  }
}

async function completeProviderLease(
  engine: BrainEngine,
  sourceId: string,
  token: string,
  epoch: number,
): Promise<boolean> {
  return boundedDbOperation(engine.transaction(async (tx) => {
    await tx.executeRaw(
      `SELECT pg_advisory_xact_lock_shared(
         hashtextextended('gbrain:source-lifecycle', 0)
       )`,
    );
    const sources = await tx.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
      embedding_drain_epoch: number | string;
    }>(
      `SELECT archived, embedding_drain_token, embedding_drain_epoch
         FROM public.sources
        WHERE id = $1
        FOR UPDATE`,
      [sourceId],
    );
    const source = sources[0];
    const sourceStillValid = Boolean(
      source
      && !source.archived
      && source.embedding_drain_token === null
      && Number(source.embedding_drain_epoch) === epoch,
    );
    const rows = await tx.executeRaw<{ lease_token: string }>(
      `DELETE FROM public.source_embedding_leases
        WHERE lease_token = $1
          AND source_id = $2
          AND source_epoch = $3
        RETURNING lease_token`,
      [token, sourceId, epoch],
    );
    if (rows.length !== 1 || rows[0]?.lease_token !== token) {
      throw leaseLost(sourceId, 'completion token no longer exists');
    }
    return sourceStillValid;
  }), `Embedding lease completion for source "${sourceId}"`);
}

/**
 * Fence one real provider submission with a durable per-source token.
 *
 * The provider receives the lease-loss signal composed with any caller signal.
 * We deliberately still await provider settlement after lease loss: a provider
 * that ignores abort keeps its exact token present, so archive remains blocked.
 * Successful output is returned only after exact-token deletion validates that
 * this call still owns the lease it acquired.
 */
export async function withActiveSourceProviderLease<T>(
  engine: BrainEngine,
  sourceId: string,
  submit: (leaseSignal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const lease = await acquireProviderLease(engine, sourceId);
  const leaseAbort = new AbortController();
  const providerSignal = anySignal(leaseAbort.signal, callerSignal);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatInFlight: Promise<void> | undefined;
  let healthFailure: Error | undefined;

  const loseLease = (caught: unknown) => {
    if (healthFailure) return;
    const error = caught instanceof SourceEmbeddingLeaseLostError
      ? caught
      : leaseLost(sourceId, asError(caught).message, caught);
    healthFailure = error;
    leaseAbort.abort(error);
  };

  const scheduleHeartbeat = () => {
    if (stopped || healthFailure) return;
    timer = setTimeout(() => {
      heartbeatInFlight = heartbeatProviderLease(
        engine,
        sourceId,
        lease.token,
        lease.epoch,
      ).catch(loseLease).finally(() => {
        heartbeatInFlight = undefined;
        scheduleHeartbeat();
      });
    }, heartbeatMs);
    timer.unref?.();
  };
  scheduleHeartbeat();

  let providerValue: T | undefined;
  let providerFailure: unknown;
  try {
    providerValue = await submit(providerSignal);
  } catch (caught) {
    providerFailure = caught;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    await heartbeatInFlight;
  }

  let completionFailure: unknown;
  let completionValid = false;
  try {
    completionValid = await completeProviderLease(engine, sourceId, lease.token, lease.epoch);
  } catch (caught) {
    completionFailure = caught;
  }

  if (healthFailure) throw healthFailure;
  if (completionFailure) {
    throw completionFailure instanceof SourceEmbeddingLeaseLostError
      ? completionFailure
      : leaseLost(sourceId, asError(completionFailure).message, completionFailure);
  }
  if (!completionValid) throw leaseLost(sourceId, 'source began draining before completion');
  if (providerFailure !== undefined) throw providerFailure;
  return providerValue as T;
}

/**
 * Phase 1 of archive: commit an exact per-source drain marker. A concurrent
 * provider acquire either commits first (and leaves a token to drain) or sees
 * this marker and rejects. Existing drain state is adopted so a later archive
 * invocation can resume safely after the original process exits.
 */
export async function beginSourceArchiveDrain(
  engine: BrainEngine,
  sourceId: string,
): Promise<SourceArchiveDrain | null> {
  return engine.transaction(async (tx) => {
    // Drain begins only after every earlier source writer that holds the shared
    // lifecycle lock has committed. All lifecycle paths take advisory before
    // row locks, preserving one global lock order.
    await tx.executeRaw(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('gbrain:source-lifecycle', 0)
       )`,
    );
    const rows = await tx.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
      embedding_drain_epoch: number | string;
      local_path: string | null;
      config_json: string;
    }>(
      `SELECT archived, embedding_drain_token, embedding_drain_epoch,
              local_path, config::text AS config_json
         FROM public.sources
        WHERE id = $1
        FOR UPDATE`,
      [sourceId],
    );
    const source = rows[0];
    if (!source || source.archived) return null;
    if (source.embedding_drain_token) {
      return {
        sourceId,
        token: source.embedding_drain_token,
        epoch: Number(source.embedding_drain_epoch),
        localPath: source.local_path,
        configJson: source.config_json,
      };
    }

    const token = randomUUID();
    const updated = await tx.executeRaw<{
      embedding_drain_token: string;
      embedding_drain_epoch: number | string;
    }>(
      `UPDATE public.sources
          SET embedding_drain_token = $2,
              embedding_drain_epoch = embedding_drain_epoch + 1
        WHERE id = $1
          AND archived IS NOT TRUE
          AND embedding_drain_token IS NULL
      RETURNING embedding_drain_token, embedding_drain_epoch`,
      [sourceId, token],
    );
    const drain = updated[0];
    if (!drain) throw new Error(`Could not begin embedding drain for source "${sourceId}"`);
    return {
      sourceId,
      token: drain.embedding_drain_token,
      epoch: Number(drain.embedding_drain_epoch),
      localPath: source.local_path,
      configJson: source.config_json,
    };
  });
}

/** Wait outside any transaction until this exact source has no provider tokens. */
export async function waitForSourceEmbeddingLeases(
  engine: BrainEngine,
  drain: SourceArchiveDrain,
): Promise<void> {
  const deadline = Date.now() + archiveWaitMs;
  for (;;) {
    const rows = await engine.executeRaw<ProviderLeaseOwnerRow>(
      `SELECT lease_token, owner_host, owner_pid, owner_instance
         FROM public.source_embedding_leases
        WHERE source_id = $1
        ORDER BY lease_token`,
      [drain.sourceId],
    );
    if (rows.length === 0) return;
    const reclaimed = await reclaimProvablyDeadLocalOwners(engine, drain, rows);
    if (reclaimed > 0) continue;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${rows.length} embedding provider lease(s) on source "${drain.sourceId}"; owners are alive, remote, malformed, or permission-unknown and require operator review`,
      );
    }
    await sleep(archivePollMs);
  }
}

/**
 * Explicit operator recovery for a crashed shared-database provider owner.
 * Automatic Postgres reclamation stays fail-closed: this path requires a
 * destructive confirmation, an already-committed source drain, a lease epoch
 * fenced by that drain, and a heartbeat older than the conservative window.
 */
export async function revokeStaleSourceEmbeddingLeases(
  engine: BrainEngine,
  sourceId: string,
  opts: { confirmDestructive: boolean },
): Promise<StaleSourceEmbeddingLeaseRecovery> {
  if (!opts.confirmDestructive) {
    throw new Error(
      `Refusing to revoke stale embedding leases for source "${sourceId}" without --confirm-destructive`,
    );
  }

  return engine.transaction(async (tx) => {
    await tx.executeRaw(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('gbrain:source-lifecycle', 0)
       )`,
    );
    const sources = await tx.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
      embedding_drain_epoch: number | string;
    }>(
      `SELECT archived, embedding_drain_token, embedding_drain_epoch
         FROM public.sources
        WHERE id = $1
        FOR UPDATE`,
      [sourceId],
    );
    const source = sources[0];
    if (!source) throw new Error(`Source "${sourceId}" not found`);
    if (source.archived || source.embedding_drain_token === null) {
      throw new Error(
        `Source "${sourceId}" is not in an active embedding drain; start or resume archive first`,
      );
    }
    const epoch = Number(source.embedding_drain_epoch);
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error(`Source "${sourceId}" has an invalid embedding drain epoch`);
    }

    const revoked = await tx.executeRaw<{ lease_token: string }>(
      `DELETE FROM public.source_embedding_leases
        WHERE source_id = $1
          AND source_epoch < $2
          AND heartbeat_at <= now() - ($3::bigint * interval '1 millisecond')
      RETURNING lease_token`,
      [sourceId, epoch, DEFAULT_STALE_LEASE_MS],
    );
    const remaining = await tx.executeRaw<{ count: number | string }>(
      `SELECT count(*)::int AS count
         FROM public.source_embedding_leases
        WHERE source_id = $1`,
      [sourceId],
    );
    return {
      revoked: revoked.length,
      remaining: Number(remaining[0]?.count ?? 0),
    };
  });
}

/**
 * Phase 2 precondition, called inside archive's final transaction after taking
 * the exclusive global lifecycle lock. Token+epoch prevent a stale archiver
 * from finalizing a newer drain generation.
 */
export async function lockSourceDrainForFinalize(
  tx: BrainEngine,
  drain: SourceArchiveDrain,
): Promise<SourceDrainFinalizeState> {
  const sources = await tx.executeRaw<{
    archived: boolean;
    embedding_drain_token: string | null;
    embedding_drain_epoch: number | string;
    local_path: string | null;
    config_json: string;
  }>(
    `SELECT archived, embedding_drain_token, embedding_drain_epoch,
            local_path, config::text AS config_json
       FROM public.sources
      WHERE id = $1
      FOR UPDATE`,
    [drain.sourceId],
  );
  const source = sources[0];
  if (!source || source.archived) return { status: 'already_archived' };
  if (
    source.embedding_drain_token !== drain.token
    || Number(source.embedding_drain_epoch) !== drain.epoch
  ) {
    throw new Error(`Embedding drain ownership changed for source "${drain.sourceId}"`);
  }
  if (
    source.local_path !== drain.localPath
    || source.config_json !== drain.configJson
  ) {
    throw new Error(
      `Source "${drain.sourceId}" metadata changed after archive drain began; `
      + 'resume archive to re-run hygiene against the current source state',
    );
  }
  const leases = await tx.executeRaw<{ lease_token: string }>(
    `SELECT lease_token
       FROM public.source_embedding_leases
      WHERE source_id = $1
      ORDER BY lease_token
      FOR UPDATE`,
    [drain.sourceId],
  );
  if (leases.length > 0) {
    throw new Error(
      `Source "${drain.sourceId}" still has ${leases.length} embedding provider lease(s)`,
    );
  }
  return { status: 'ready' };
}

/** Clear only the drain generation this caller owns; provider rows are never pruned. */
export async function cancelSourceArchiveDrain(
  engine: BrainEngine,
  drain: SourceArchiveDrain,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE public.sources
        SET embedding_drain_token = NULL
      WHERE id = $1
        AND archived IS NOT TRUE
        AND embedding_drain_token = $2
        AND embedding_drain_epoch = $3`,
    [drain.sourceId, drain.token, drain.epoch],
  );
}
