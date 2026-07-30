/**
 * Engine migration: transfer brain data between PGLite and Postgres.
 *
 * Usage:
 *   gbrain migrate --to supabase [--url <connection_string>]
 *   gbrain migrate --to pglite [--path <db_path>]
 *   gbrain migrate --to <engine> --force  (overwrite target pages when source IDs are compatible)
 *   gbrain migrate --to <engine> --revoke-stale-leases --confirm-destructive
 *     (recover a target migration drain whose fenced provider owner is stale)
 */

import { createEngine } from '../core/engine-factory.ts';
import { loadConfig, saveConfig, toEngineConfig, gbrainPath, effectiveEnvDatabaseUrl, type GBrainConfig } from '../core/config.ts';
import type { BrainEngine, ReservedConnection } from '../core/engine.ts';
import type { EngineConfig } from '../core/types.ts';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { resolve } from 'path';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { executeRawJsonb } from '../core/sql-query.ts';
import {
  beginSourceArchiveDrain,
  cancelSourceArchiveDrain,
  lockSourceDrainForFinalize,
  revokeStaleSourceEmbeddingLeases,
  sourceArchiveDrainPurpose,
  waitForSourceEmbeddingLeases,
} from '../core/source-embedding-lease.ts';

interface MigrateOpts {
  targetEngine: 'postgres' | 'pglite';
  targetUrl?: string;
  targetPath?: string;
  force: boolean;
  revokeStaleLeases: boolean;
  confirmDestructive: boolean;
}

function parseArgs(args: string[]): MigrateOpts {
  const toIdx = args.indexOf('--to');
  if (toIdx === -1 || !args[toIdx + 1]) {
    throw new Error(
      'Usage: gbrain migrate --to <supabase|pglite> [--url <url>] [--path <path>] '
      + '[--force] [--revoke-stale-leases --confirm-destructive]',
    );
  }

  const targetRaw = args[toIdx + 1];
  const targetEngine = targetRaw === 'supabase' ? 'postgres' : targetRaw as 'postgres' | 'pglite';
  if (targetEngine !== 'postgres' && targetEngine !== 'pglite') {
    throw new Error(`Unknown target engine: "${targetRaw}". Use: supabase or pglite`);
  }

  const urlIdx = args.indexOf('--url');
  const pathIdx = args.indexOf('--path');

  const revokeStaleLeases = args.includes('--revoke-stale-leases');
  const confirmDestructive = args.includes('--confirm-destructive');
  if (revokeStaleLeases && !confirmDestructive) {
    throw new Error(
      'Refusing target migration lease revocation without --confirm-destructive',
    );
  }

  return {
    targetEngine,
    targetUrl: urlIdx !== -1 ? args[urlIdx + 1] : undefined,
    targetPath: pathIdx !== -1 ? args[pathIdx + 1] : undefined,
    force: args.includes('--force'),
    revokeStaleLeases,
    confirmDestructive,
  };
}

function getManifestPath(): string {
  return gbrainPath('migrate-manifest.json');
}

export interface MigrateManifest {
  completed_slugs: string[];
  target_engine: string;
  target_id?: string;
  schema_version?: number;
  started_at: string;
}

/**
 * Serialize whole migrate-engine commands per target database. Per-source
 * migration drains protect ordinary workers, but they are deliberately
 * recoverable after a crash and therefore cannot identify a live command.
 * A session advisory lock on a reserved backend supplies that live-owner
 * boundary without leaving stale state behind when the process disconnects.
 */
export async function withTargetMigrationSessionLock<T>(
  targetEngine: BrainEngine,
  run: () => Promise<T>,
): Promise<T> {
  const onLockedConnection = async (conn: ReservedConnection): Promise<T> => {
    const acquired = (await conn.executeRaw<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(
         hashtextextended('gbrain:migrate-engine', 0)
       ) AS acquired`,
    ))[0]?.acquired === true;
    if (!acquired) {
      throw new Error(
        'Another migrate-engine command is already writing this target; wait for it to finish and rerun',
      );
    }

    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await run();
    } catch (error) {
      operationError = error;
    }

    let unlockError: unknown;
    try {
      const unlocked = (await conn.executeRaw<{ unlocked: boolean }>(
        `SELECT pg_advisory_unlock(
           hashtextextended('gbrain:migrate-engine', 0)
         ) AS unlocked`,
      ))[0]?.unlocked === true;
      if (!unlocked) {
        throw new Error('Could not release the target migrate-engine session lock');
      }
    } catch (error) {
      unlockError = error;
    }

    if (operationError !== undefined) {
      if (unlockError !== undefined) {
        throw new AggregateError(
          [operationError, unlockError],
          'Migration failed and its target session lock could not be released cleanly',
        );
      }
      throw operationError;
    }
    if (unlockError !== undefined) throw unlockError;
    return result as T;
  };

  if (targetEngine.kind === 'postgres') {
    const postgresTarget = targetEngine as BrainEngine & {
      withSessionReservedConnection<R>(
        fn: (conn: ReservedConnection) => Promise<R>,
      ): Promise<R>;
    };
    return postgresTarget.withSessionReservedConnection(onLockedConnection);
  }
  return targetEngine.withReservedConnection(onLockedConnection);
}

export function migrationTargetId(config: EngineConfig): string {
  const locator = config.engine === 'postgres'
    ? config.database_url ?? ''
    : resolve(config.database_path ?? gbrainPath('brain.pglite'));
  return createHash('sha256')
    .update(JSON.stringify([config.engine, locator]))
    .digest('hex');
}

export function manifestMatchesTarget(manifest: MigrateManifest, targetId: string): boolean {
  return manifest.schema_version === 2 && manifest.target_id === targetId;
}

interface SourceMigrationRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | string | null;
  config: unknown;
  chunker_version: string | null;
  archived: boolean;
  archived_at: Date | string | null;
  archive_expires_at: Date | string | null;
  contextual_retrieval_mode: string | null;
  trust_frontmatter_overrides: boolean;
  newest_content_at: Date | string | null;
  created_at: Date | string;
  embedding_drain_token: string | null;
  embedding_drain_epoch: number | string;
}

interface ArchivedSourceMigrationRow {
  id: string;
  archived_at: Date | string | null;
  archive_expires_at: Date | string | null;
}

interface TargetSourceMigrationState extends ArchivedSourceMigrationRow {
  archived: boolean;
  embedding_drain_token: string | null;
}

interface TargetSourceDrainMigrationState extends TargetSourceMigrationState {
  embedding_drain_epoch: number | string;
}

export interface SourceMigrationLifecycleState {
  id: string;
  archived: boolean;
  embedding_drain_token: string | null;
}

export interface FinalSourceMigrationState extends SourceMigrationLifecycleState {
  archived_at: Date | string | null;
  archive_expires_at: Date | string | null;
}

interface FinalTargetSourceMigrationState extends FinalSourceMigrationState {
  embedding_drain_epoch: number | string;
}

interface RecoverySourceMigrationState extends FinalSourceMigrationState {
  embedding_drain_epoch: number | string;
}

function migrationDrainFromTargetState(
  row: Pick<TargetSourceDrainMigrationState, 'id' | 'embedding_drain_token' | 'embedding_drain_epoch'>,
) {
  if (
    row.embedding_drain_token === null
    || sourceArchiveDrainPurpose(row.embedding_drain_token) !== 'migration'
  ) {
    throw new Error(`Target source "${row.id}" does not have a migration-owned drain`);
  }
  const epoch = Number(row.embedding_drain_epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error(`Target source "${row.id}" has an invalid embedding drain epoch`);
  }
  return {
    sourceId: row.id,
    token: row.embedding_drain_token,
    epoch,
    purpose: 'migration' as const,
    localPath: null,
    configJson: '{}',
  };
}

function loadManifest(): MigrateManifest | null {
  const path = getManifestPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function saveManifest(manifest: MigrateManifest): void {
  writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2));
}

function clearManifest(): void {
  const path = getManifestPath();
  if (existsSync(path)) unlinkSync(path);
}

function normalizeSourceConfig(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to empty config
    }
  }
  return {};
}

function asIsoTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertSourceMigrationLifecycleSnapshot(
  sourceStates: SourceMigrationLifecycleState[],
): void {
  const drainingSource = sourceStates.find((row) => row.embedding_drain_token !== null);
  if (drainingSource) {
    throw new Error(
      `Cannot migrate while source "${drainingSource.id}" has an active archive drain; `
      + 'finish or recover that drain, then rerun migration',
    );
  }
  if (sourceStates.some((row) => row.id === 'default' && row.archived)) {
    throw new Error('Cannot migrate an invalid archived "default" source');
  }
}

export async function assertSourceLifecycleReadyForMigration(
  sourceEngine: BrainEngine,
): Promise<void> {
  const sourceStates = await sourceEngine.executeRaw<SourceMigrationLifecycleState>(
    `SELECT id, archived, embedding_drain_token
      FROM sources
      ORDER BY (id = 'default') DESC, id`,
  );
  assertSourceMigrationLifecycleSnapshot(sourceStates);
}

export async function copySourceRowsForMigration(
  sourceEngine: BrainEngine,
  targetEngine: BrainEngine,
  opts: { stageArchivedAsActive?: boolean } = {},
): Promise<number> {
  await assertSourceLifecycleReadyForMigration(sourceEngine);
  const sourceRows = await sourceEngine.executeRaw<SourceMigrationRow>(
    `SELECT id, name, local_path, last_commit, last_sync_at, config,
            chunker_version, archived, archived_at, archive_expires_at,
            contextual_retrieval_mode, trust_frontmatter_overrides,
            newest_content_at, created_at, embedding_drain_token,
            embedding_drain_epoch
       FROM sources
      ORDER BY (id = 'default') DESC, id`,
  );
  // Validate the exact rows that will be copied. This closes the interleaving
  // where a drain commits after the early command-entry preflight but before
  // this snapshot; no target read or write occurs before this check.
  assertSourceMigrationLifecycleSnapshot(sourceRows);

  // A committed drain is source truth, not transient transport state. Copying
  // it as an ordinary active source would reopen writes and provider work on
  // the target. Fail before touching any target row; the operator can finish
  // or recover the source-side archive and rerun migration.
  for (const row of sourceRows) {
    // Page/chunk/tag/timeline/raw/link writes now reject archived owners. A
    // migration therefore stages archived source rows as active parents, then
    // restores their exact archive metadata only after every dependent row is
    // copied. The default preserves the standalone helper's exact-copy
    // contract for callers that are not about to write dependents.
    const fenceForMigration = opts.stageArchivedAsActive === true;
    const stageArchived = fenceForMigration && row.archived;
    const writeSourceRow = async (engine: BrainEngine) => executeRawJsonb(
      engine,
      `INSERT INTO sources (
         id, name, local_path, last_commit, last_sync_at, config,
         chunker_version, archived, archived_at, archive_expires_at,
         contextual_retrieval_mode, trust_frontmatter_overrides,
         newest_content_at, created_at
       ) VALUES (
         $1, $2, $3, $4, $5::timestamptz, $14::jsonb,
         $6, $7, $8::timestamptz, $9::timestamptz,
         $10, $11, $12::timestamptz, $13::timestamptz
       )
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         local_path = EXCLUDED.local_path,
         last_commit = EXCLUDED.last_commit,
         last_sync_at = EXCLUDED.last_sync_at,
         config = EXCLUDED.config,
         chunker_version = EXCLUDED.chunker_version,
         archived = EXCLUDED.archived,
         archived_at = EXCLUDED.archived_at,
         archive_expires_at = EXCLUDED.archive_expires_at,
         contextual_retrieval_mode = EXCLUDED.contextual_retrieval_mode,
         trust_frontmatter_overrides = EXCLUDED.trust_frontmatter_overrides,
         newest_content_at = EXCLUDED.newest_content_at,
         created_at = EXCLUDED.created_at`,
      [
        row.id,
        row.name,
        row.local_path,
        row.last_commit,
        asIsoTimestamp(row.last_sync_at),
        row.chunker_version,
        stageArchived ? false : row.archived,
        stageArchived ? null : asIsoTimestamp(row.archived_at),
        stageArchived ? null : asIsoTimestamp(row.archive_expires_at),
        row.contextual_retrieval_mode,
        row.trust_frontmatter_overrides,
        asIsoTimestamp(row.newest_content_at),
        asIsoTimestamp(row.created_at),
      ],
      [normalizeSourceConfig(row.config)],
    );
    if (!fenceForMigration) {
      await writeSourceRow(targetEngine);
      continue;
    }

    // Keep every copied source fenced at every committed target snapshot. This
    // protects active sources during --force as well as archived sources during
    // staged dependent-row copy. Archived rows are restored to active form only
    // inside the same transaction that installs (or retains) the drain.
    await targetEngine.transaction(async (tx) => {
      await tx.executeRaw(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('gbrain:source-lifecycle', 0)
         )`,
      );
      const current = (await tx.executeRaw<TargetSourceDrainMigrationState>(
        `SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token,
                embedding_drain_epoch
           FROM sources
          WHERE id = $1
          FOR UPDATE`,
        [row.id],
      ))[0];
      if (
        current?.embedding_drain_token
        && sourceArchiveDrainPurpose(current.embedding_drain_token) !== 'migration'
      ) {
        throw new Error(
          `Cannot stage migration source "${row.id}" while the target has a non-migration archive drain`,
        );
      }

      await writeSourceRow(tx);
      if (current?.embedding_drain_token) return;

      const token = `migration:${randomUUID()}`;
      const drained = await tx.executeRaw<{ id: string }>(
        `UPDATE sources
            SET embedding_drain_token = $2,
                embedding_drain_epoch = embedding_drain_epoch + 1
          WHERE id = $1
            AND archived IS NOT TRUE
            AND embedding_drain_token IS NULL
        RETURNING id`,
        [row.id, token],
      );
      if (drained.length !== 1 || drained[0]?.id !== row.id) {
        throw new Error(`Could not install migration drain for source "${row.id}"`);
      }
    });
  }

  return sourceRows.length;
}

/**
 * Run migration-owned dependent writes while a staged archived source remains
 * durably fenced from ordinary target workers. The exact drain is cleared only
 * inside this transaction. MVCC and the exclusive lifecycle lock mean other
 * sessions either see the committed drain or wait until it has been restored.
 */
export async function withMigrationSourceWriteFence<T>(
  targetEngine: BrainEngine,
  sourceId: string,
  write: (tx: BrainEngine) => Promise<T>,
): Promise<T> {
  return withMigrationSourceWriteFences(targetEngine, [sourceId], write);
}

export async function withMigrationSourceWriteFences<T>(
  targetEngine: BrainEngine,
  sourceIds: string[],
  write: (tx: BrainEngine) => Promise<T>,
): Promise<T> {
  const exactSourceIds = [...new Set(sourceIds)].sort();
  if (exactSourceIds.length === 0) return targetEngine.transaction(write);
  return targetEngine.transaction(async (tx) => {
    await tx.executeRaw(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('gbrain:source-lifecycle', 0)
       )`,
    );
    const currentRows = await tx.executeRaw<TargetSourceDrainMigrationState>(
      `SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token,
              embedding_drain_epoch
         FROM sources
        WHERE id = ANY($1::text[])
        ORDER BY id
        FOR UPDATE`,
      [exactSourceIds],
    );
    if (currentRows.length !== exactSourceIds.length) {
      throw new Error('One or more migration sources are not staged for dependent writes');
    }
    const drains = currentRows.map((current) => {
      if (current.archived) {
        throw new Error(`Migration source "${current.id}" is not staged for dependent writes`);
      }
      return migrationDrainFromTargetState(current);
    });
    for (const drain of drains) {
      const cleared = await tx.executeRaw<{ id: string }>(
        `UPDATE sources
            SET embedding_drain_token = NULL
          WHERE id = $1
            AND archived IS NOT TRUE
            AND embedding_drain_token = $2
            AND embedding_drain_epoch = $3
        RETURNING id`,
        [drain.sourceId, drain.token, drain.epoch],
      );
      if (cleared.length !== 1 || cleared[0]?.id !== drain.sourceId) {
        throw new Error(
          `Migration drain ownership changed for source "${drain.sourceId}" before write`,
        );
      }
    }

    const result = await write(tx);
    for (const drain of drains) {
      const restored = await tx.executeRaw<{ id: string }>(
        `UPDATE sources
            SET embedding_drain_token = $2
          WHERE id = $1
            AND archived IS NOT TRUE
            AND embedding_drain_token IS NULL
            AND embedding_drain_epoch = $3
        RETURNING id`,
        [drain.sourceId, drain.token, drain.epoch],
      );
      if (restored.length !== 1 || restored[0]?.id !== drain.sourceId) {
        throw new Error(
          `Could not restore migration drain for source "${drain.sourceId}" after write`,
        );
      }
    }
    return result;
  });
}

async function finalizeArchivedMigrationRow(
  targetEngine: BrainEngine,
  row: ArchivedSourceMigrationRow,
): Promise<void> {
  const current = (await targetEngine.executeRaw<TargetSourceMigrationState>(
    `SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token
       FROM sources
      WHERE id = $1`,
    [row.id],
  ))[0];
  if (!current) {
    throw new Error(`Could not find staged migration source "${row.id}"`);
  }
  if (current.archived) {
    const currentArchivedAt = asIsoTimestamp(current.archived_at);
    const currentExpiresAt = asIsoTimestamp(current.archive_expires_at);
    if (
      current.embedding_drain_token !== null
      || currentArchivedAt !== asIsoTimestamp(row.archived_at)
      || currentExpiresAt !== asIsoTimestamp(row.archive_expires_at)
    ) {
      throw new Error(`Migration source "${row.id}" was archived by another operation`);
    }
    return;
  }

  const drain = await beginSourceArchiveDrain(targetEngine, row.id, 'migration');
  if (!drain) {
    throw new Error(`Could not begin archive finalization for migration source "${row.id}"`);
  }
  if (drain.purpose !== 'migration') {
    throw new Error(
      `Cannot finalize migration source "${row.id}" through a ${drain.purpose} archive drain`,
    );
  }
  await waitForSourceEmbeddingLeases(targetEngine, drain);
  await targetEngine.transaction(async (tx) => {
    await tx.executeRaw(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('gbrain:source-lifecycle', 0)
       )`,
    );
    const readiness = await lockSourceDrainForFinalize(tx, drain);
    if (readiness.status !== 'ready') {
      throw new Error(`Migration source "${row.id}" was archived before finalization`);
    }
    const updated = await tx.executeRaw<{ id: string }>(
      `UPDATE sources
          SET archived = TRUE,
              archived_at = $4::timestamptz,
              archive_expires_at = $5::timestamptz,
              embedding_drain_token = NULL
        WHERE id = $1
          AND archived IS NOT TRUE
          AND embedding_drain_token = $2
          AND embedding_drain_epoch = $3
      RETURNING id`,
      [
        row.id,
        drain.token,
        drain.epoch,
        asIsoTimestamp(row.archived_at),
        asIsoTimestamp(row.archive_expires_at),
      ],
    );
    if (updated.length !== 1 || updated[0]?.id !== row.id) {
      throw new Error(`Could not restore archived migration source "${row.id}"`);
    }
  });
}

function assertNoArchivedDefaultForMigration(rows: ArchivedSourceMigrationRow[]): void {
  if (rows.some((row) => row.id === 'default')) {
    throw new Error('Cannot finalize an invalid archived "default" source migration');
  }
}

async function finalizeArchivedMigrationRows(
  targetEngine: BrainEngine,
  archivedRows: ArchivedSourceMigrationRow[],
): Promise<void> {
  assertNoArchivedDefaultForMigration(archivedRows);
  for (const row of archivedRows) {
    await finalizeArchivedMigrationRow(targetEngine, row);
  }
}

async function waitForMigrationDrainsBeforeCutover(
  targetEngine: BrainEngine,
  sourceRows: FinalSourceMigrationState[],
): Promise<Map<string, ReturnType<typeof migrationDrainFromTargetState>>> {
  const sourceIds = sourceRows.map((row) => row.id).sort();
  const targetRows = await targetEngine.executeRaw<TargetSourceDrainMigrationState>(
    `SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token,
            embedding_drain_epoch
       FROM sources
      WHERE id = ANY($1::text[])
      ORDER BY id`,
    [sourceIds],
  );
  if (targetRows.length !== sourceIds.length) {
    throw new Error('One or more migration target sources are missing before cutover');
  }
  const drains = new Map<string, ReturnType<typeof migrationDrainFromTargetState>>();
  for (const row of targetRows) {
    if (row.archived) {
      throw new Error(`Migration target source "${row.id}" lost its fence before cutover`);
    }
    const drain = migrationDrainFromTargetState(row);
    await waitForSourceEmbeddingLeases(targetEngine, drain);
    drains.set(row.id, drain);
  }
  return drains;
}

/**
 * Atomically turn staged target sources into their final lifecycle state and
 * perform the file-plane cutover while the target lifecycle lock is held.
 * Archived rows never commit as cleanup-eligible before the config switch.
 */
export async function finalizeTargetSourceRowsForMigrationCutover<T>(
  targetEngine: BrainEngine,
  sourceRows: FinalSourceMigrationState[],
  cutover: (targetTx: BrainEngine) => Promise<T> | T,
  rollbackCutover?: () => Promise<void> | void,
): Promise<T> {
  assertNoArchivedDefaultForMigration(sourceRows.filter((row) => row.archived));
  const expectedDrains = await waitForMigrationDrainsBeforeCutover(targetEngine, sourceRows);
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));

  // Postgres commits only after the transaction callback returns. If that
  // commit fails after the file-plane cutover started, restore the previous
  // config while the rolled-back DB still retains every migration drain.
  let cutoverStarted = false;
  try {
    return await targetEngine.transaction(async (targetTx) => {
      await targetTx.executeRaw(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('gbrain:source-lifecycle', 0)
         )`,
      );
      const targetLifecycle = await targetTx.executeRaw<FinalTargetSourceMigrationState>(
        `SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token,
                embedding_drain_epoch
           FROM sources
          ORDER BY (id = 'default') DESC, id
          FOR UPDATE`,
      );
      assertTargetSourceIdsCompatibleForMigration(sourceRows, targetLifecycle);

      for (const target of targetLifecycle) {
        const source = sourceById.get(target.id);
        if (!source) continue;
        const expected = expectedDrains.get(target.id);
        if (!expected) {
          throw new Error(`Migration target source "${target.id}" has no cutover drain receipt`);
        }
        if (
          target.archived
          || target.embedding_drain_token !== expected.token
          || Number(target.embedding_drain_epoch) !== expected.epoch
        ) {
          throw new Error(
            `Target migration drain ownership changed for source "${target.id}" before cutover`,
          );
        }

        if (source.archived) {
          const updated = await targetTx.executeRaw<{ id: string }>(
            `UPDATE sources
                SET archived = TRUE,
                    archived_at = $4::timestamptz,
                    archive_expires_at = $5::timestamptz,
                    embedding_drain_token = NULL
              WHERE id = $1
                AND archived IS NOT TRUE
                AND embedding_drain_token = $2
                AND embedding_drain_epoch = $3
            RETURNING id`,
            [
              target.id,
              expected.token,
              expected.epoch,
              asIsoTimestamp(source.archived_at),
              asIsoTimestamp(source.archive_expires_at),
            ],
          );
          if (updated.length !== 1 || updated[0]?.id !== target.id) {
            throw new Error(`Could not restore archived migration source "${target.id}" at cutover`);
          }
          target.archived = true;
          target.archived_at = source.archived_at;
          target.archive_expires_at = source.archive_expires_at;
        } else if (!await cancelSourceArchiveDrain(targetTx, expected)) {
          throw new Error(`Could not clear migration drain for source "${target.id}" at cutover`);
        }
        target.embedding_drain_token = null;
      }

      assertTargetSourceLifecycleParityForMigration(sourceRows, targetLifecycle);
      cutoverStarted = true;
      return await cutover(targetTx);
    });
  } catch (error) {
    if (cutoverStarted && rollbackCutover) {
      try {
        await rollbackCutover();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Target cutover failed and the previous config could not be restored',
        );
      }
    }
    throw error;
  }
}

export function assertTargetSourceLifecycleParityForMigration(
  sourceRows: FinalSourceMigrationState[],
  targetRows: FinalSourceMigrationState[],
): void {
  assertTargetSourceIdsCompatibleForMigration(sourceRows, targetRows);
  const targetById = new Map(targetRows.map((row) => [row.id, row]));
  for (const source of sourceRows) {
    const target = targetById.get(source.id);
    if (!target) throw new Error(`Migration target is missing source "${source.id}"`);
    if (target.embedding_drain_token !== null) {
      throw new Error(`Migration target source "${source.id}" is still draining`);
    }
    if (target.archived !== source.archived) {
      throw new Error(`Migration target source "${source.id}" has stale archive state`);
    }
    if (source.archived && (
      asIsoTimestamp(target.archived_at) !== asIsoTimestamp(source.archived_at)
      || asIsoTimestamp(target.archive_expires_at) !== asIsoTimestamp(source.archive_expires_at)
    )) {
      throw new Error(`Migration target source "${source.id}" has stale archive metadata`);
    }
  }
}

export function assertTargetSourceIdsCompatibleForMigration(
  sourceRows: Array<{ id: string }>,
  targetRows: Array<{ id: string }>,
): void {
  const sourceIds = new Set(sourceRows.map((row) => row.id));
  const unexpectedTarget = targetRows.find((row) => !sourceIds.has(row.id));
  if (unexpectedTarget) {
    throw new Error(
      `Migration target has unexpected source "${unexpectedTarget.id}"; `
      + '--force overwrites pages but does not delete source registrations',
    );
  }
}

export function assertTargetSourceLifecycleCompatibleForMigration(
  sourceRows: SourceMigrationLifecycleState[],
  targetRows: SourceMigrationLifecycleState[],
  opts: { allowMigrationDrain?: boolean } = {},
): void {
  // Repeat the source check at the exact pre-mutation snapshot. Target setup
  // can take long enough for a drain to begin after command-entry preflight.
  assertSourceMigrationLifecycleSnapshot(sourceRows);
  assertTargetSourceIdsCompatibleForMigration(sourceRows, targetRows);
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  for (const target of targetRows) {
    const source = sourceById.get(target.id)!;
    if (target.embedding_drain_token !== null) {
      const purpose = sourceArchiveDrainPurpose(target.embedding_drain_token);
      const recoverableMigrationDrain = purpose === 'migration'
        && !target.archived
        && opts.allowMigrationDrain !== false;
      if (!recoverableMigrationDrain) {
        if (purpose === 'migration' && opts.allowMigrationDrain === false) {
          throw new Error(
            `Migration target source "${target.id}" has active migration recovery; `
            + 'rerun migration without --force before overwriting target pages',
          );
        }
        throw new Error(
          `Migration target source "${target.id}" has an incompatible ${purpose} archive drain`,
        );
      }
    }
    if (target.archived && !source.archived) {
      throw new Error(
        `Migration target source "${target.id}" is archived but the source is active`,
      );
    }
  }
}

async function recoverTargetMigrationDrainsBeforePageMutation(
  sourceRows: FinalSourceMigrationState[],
  targetRows: RecoverySourceMigrationState[],
  targetEngine: BrainEngine,
  opts: Pick<MigrateOpts, 'revokeStaleLeases' | 'confirmDestructive'>,
): Promise<void> {
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  for (const target of targetRows) {
    if (sourceArchiveDrainPurpose(target.embedding_drain_token) !== 'migration') continue;
    const source = sourceById.get(target.id);
    if (!source || target.archived) continue;
    const drain = migrationDrainFromTargetState(target);
    if (opts.revokeStaleLeases) {
      const recovery = await revokeStaleSourceEmbeddingLeases(targetEngine, target.id, {
        confirmDestructive: opts.confirmDestructive,
        expectedDrain: { token: drain.token, epoch: drain.epoch },
      });
      console.log(
        `Revoked ${recovery.revoked} stale target embedding lease(s) for source "${target.id}"; `
        + `${recovery.remaining} current lease(s) remain.`,
      );
    }
    try {
      // Recovery drains the exact provider generation but deliberately keeps
      // the migration token committed. The copy path temporarily clears that
      // token only inside its own target transaction, so ordinary workers stay
      // fenced even when the local resume manifest is missing.
      await waitForSourceEmbeddingLeases(targetEngine, drain);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not recover target migration drain for source "${target.id}" before page mutation: `
        + `${detail}. Target pages were not changed. After the provider owner finishes, rerun `
        + 'the same migration command; if the owner is stale, add '
        + '--revoke-stale-leases --confirm-destructive.',
        { cause: error },
      );
    }
  }
}

/** Restore final archive state after every migrated source-owned row lands. */
export async function finalizeArchivedSourceRowsForMigration(
  sourceEngine: BrainEngine,
  targetEngine: BrainEngine,
): Promise<number> {
  const archivedRows = await sourceEngine.executeRaw<ArchivedSourceMigrationRow>(
    `SELECT id, archived_at, archive_expires_at
       FROM sources
      WHERE archived IS TRUE
      ORDER BY id`,
  );
  await finalizeArchivedMigrationRows(targetEngine, archivedRows);

  return archivedRows.length;
}

export async function runMigrateEngine(sourceEngine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }

  // Check source != target
  if (config.engine === opts.targetEngine) {
    console.error(`Already using ${opts.targetEngine} engine. Nothing to migrate.`);
    process.exit(1);
  }

  // Run against the source before connecting to, initializing, or possibly
  // force-wiping the target. The helper repeats this check immediately before
  // source-row copy as defense against a drain that begins later in setup.
  await assertSourceLifecycleReadyForMigration(sourceEngine);

  // Build target config
  const targetConfig: EngineConfig = { engine: opts.targetEngine };
  if (opts.targetEngine === 'postgres') {
    // #427 guard: don't let a cwd-.env DATABASE_URL become a migration target.
    targetConfig.database_url = opts.targetUrl || effectiveEnvDatabaseUrl();
    if (!targetConfig.database_url) {
      console.error('Target is Supabase but no connection string provided. Use: --url <connection_string>');
      process.exit(1);
    }
  } else {
    targetConfig.database_path = opts.targetPath || gbrainPath('brain.pglite');
  }
  const targetId = migrationTargetId(targetConfig);

  // Connect to target
  console.log(`Connecting to target (${opts.targetEngine})...`);
  const targetEngine = await createEngine(targetConfig);
  await targetEngine.connect(targetConfig);

  try {
    await withTargetMigrationSessionLock(targetEngine, async () => {
      await targetEngine.initSchema();

  // `--force` deletes page-owned data, not arbitrary source registrations.
  // Reject an incompatible target before deleting or copying anything. The
  // final locked parity check repeats this fail-closed if target state changes
  // while a long migration is running.
  let [sourceLifecycle, targetLifecycle] = await Promise.all([
    sourceEngine.executeRaw<FinalSourceMigrationState>(
      `SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token
         FROM sources ORDER BY id`,
    ),
    targetEngine.executeRaw<RecoverySourceMigrationState>(
      `SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token,
              embedding_drain_epoch
         FROM sources ORDER BY id`,
    ),
  ]);
  try {
    assertTargetSourceLifecycleCompatibleForMigration(sourceLifecycle, targetLifecycle, {
      allowMigrationDrain: true,
    });
    // Complete only migration-owned target drains before the non-empty-target
    // decision. This recovery-only phase never touches pages. It closes the
    // cross-machine case where durable DB drain state survives but the local
    // resume manifest does not.
    await recoverTargetMigrationDrainsBeforePageMutation(
      sourceLifecycle,
      targetLifecycle,
      targetEngine,
      opts,
    );
    [sourceLifecycle, targetLifecycle] = await Promise.all([
      sourceEngine.executeRaw<FinalSourceMigrationState>(
        `SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token
           FROM sources ORDER BY id`,
      ),
      targetEngine.executeRaw<RecoverySourceMigrationState>(
        `SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token,
                embedding_drain_epoch
           FROM sources ORDER BY id`,
      ),
    ]);
    assertTargetSourceLifecycleCompatibleForMigration(sourceLifecycle, targetLifecycle, {
      allowMigrationDrain: true,
    });
  } catch (error) {
    throw error;
  }

  // Load the resume manifest before deciding whether a non-empty target is
  // safe. A matching v2 manifest proves that the existing rows belong to an
  // interrupted migration to this exact target, so that case resumes in place.
  let manifest = loadManifest();
  if (manifest && !manifestMatchesTarget(manifest, targetId)) {
    console.log('Previous migration was to a different target. Starting fresh.');
    manifest = null;
    clearManifest();
  }

  // Check if target has data.
  const targetStats = await targetEngine.getStats();
  const canResume = manifest !== null && manifestMatchesTarget(manifest, targetId);
  if (targetStats.page_count > 0 && !opts.force && !canResume) {
    console.error(`Target brain is not empty (${targetStats.page_count} pages).`);
    console.error('Run with --force to overwrite target pages, or migrate to an empty brain.');
    process.exit(1);
  }

  const wipeTargetPages = targetStats.page_count > 0 && opts.force;
  if (wipeTargetPages) {
    console.log('--force: preparing to wipe target pages under migration fences...');
    manifest = null;
    clearManifest();
  } else if (opts.force || (targetStats.page_count === 0 && (manifest?.completed_slugs.length ?? 0) > 0)) {
    // `--force` always means a fresh copy. An empty target also cannot contain
    // pages named by a partial manifest, so carrying those skip keys forward
    // would silently produce an incomplete migration.
    manifest = null;
    clearManifest();
  }

  console.log('Copying source rows...');
  const sourceCount = await copySourceRowsForMigration(
    sourceEngine,
    targetEngine,
    { stageArchivedAsActive: true },
  );
  console.log(`Copied ${sourceCount} source rows.`);
  // Re-read source IDs after staging. This exact allow-list prevents a target-
  // only source registered concurrently after compatibility preflight from
  // being swept by --force. If a new source appeared too late to stage, the
  // fenced helper fails before any page deletion.
  const copiedSourceIds = (await sourceEngine.executeRaw<{ id: string }>(
    `SELECT id FROM sources ORDER BY id`,
  )).map((row) => row.id);
  const migrationFencedSourceIds = new Set(copiedSourceIds);
  if (wipeTargetPages) {
    // v0.18.0+ multi-source: deletePage(slug) is source-scoped, so the force
    // reset is one raw DELETE across all compatible sources. Every target
    // source is already durably migration-drained. Clearing all exact drains
    // only inside this transaction makes the migration the sole permitted
    // delete while ordinary target workers remain fenced.
    await withMigrationSourceWriteFences(
      targetEngine,
      copiedSourceIds,
      async (tx) => {
        await tx.executeRaw(
          `DELETE FROM pages WHERE source_id = ANY($1::text[])`,
          [copiedSourceIds],
        );
      },
    );
  }

  // Continue the matching manifest, or create a fresh one.
  // v0.32.8 F8: manifest keys are now `${source_id}::${slug}` so multi-source
  // migrations don't collide on same-slug-different-source pages. Pre-v0.32.8
  // entries were bare slugs; we keep treating those as default-source for
  // back-compat resume.
  const completedSet = new Set(manifest?.completed_slugs || []);
  const makeManifestKey = (sourceId: string, slug: string): string =>
    sourceId === 'default' ? slug : `${sourceId}::${slug}`;
  if (!manifest) {
    manifest = {
      completed_slugs: [],
      target_engine: opts.targetEngine,
      target_id: targetId,
      schema_version: 2,
      started_at: new Date().toISOString(),
    };
  }

  // Get all source pages
  const sourceStats = await sourceEngine.getStats();
  const allPages = await sourceEngine.listPages({ limit: 100000 });
  const pagesToMigrate = allPages.filter(p => !completedSet.has(makeManifestKey(p.source_id, p.slug)));

  console.log(`Migrating ${pagesToMigrate.length} pages (${allPages.length} total, ${completedSet.size} already done)...`);

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('migrate.copy_pages', pagesToMigrate.length);

  let migrated = 0;
  for (const page of pagesToMigrate) {
    // v0.32.8 F8: thread source_id end-to-end so multi-source pages migrate
    // intact. Pre-fix: putPage / getTags / getTimeline / getRawData / getLinks
    // all silently defaulted to source_id='default', so non-default-source
    // tags / timeline / raw / links were either dropped or attached to the
    // wrong row.
    const sourceOpts = { sourceId: page.source_id };

    // Read the source snapshot before opening the target write transaction.
    // For an archived source, every dependent row for this page lands in one
    // exact-drain transaction; a crash rolls the page and its dependents back
    // together and leaves the committed migration fence intact.
    const chunks = await sourceEngine.getChunksWithEmbeddings(page.slug, sourceOpts);
    const tags = await sourceEngine.getTags(page.slug, sourceOpts);
    const timeline = await sourceEngine.getTimeline(page.slug, sourceOpts);
    const rawData = await sourceEngine.getRawData(page.slug, undefined, sourceOpts);
    const writePage = async (engine: BrainEngine) => {
      await engine.putPage(page.slug, {
        type: page.type,
        title: page.title,
        compiled_truth: page.compiled_truth,
        timeline: page.timeline,
        frontmatter: page.frontmatter,
        content_hash: page.content_hash,
      }, sourceOpts);
      if (chunks.length > 0) {
        await engine.upsertChunks(page.slug, chunks.map(c => ({
          chunk_index: c.chunk_index,
          chunk_text: c.chunk_text,
          chunk_source: c.chunk_source,
          embedding: c.embedding || undefined,
          model: c.model,
          token_count: c.token_count || undefined,
        })), sourceOpts);
      }
      for (const tag of tags) await engine.addTag(page.slug, tag, sourceOpts);
      for (const entry of timeline) {
        await engine.addTimelineEntry(page.slug, { // gbrain-allow-direct-insert: migrate-engine copies canonical timeline rows from the source engine
          date: entry.date,
          source: entry.source,
          summary: entry.summary,
          detail: entry.detail,
        }, sourceOpts);
      }
      for (const rd of rawData) {
        await engine.putRawData(page.slug, rd.source, rd.data, sourceOpts);
      }
    };
    if (migrationFencedSourceIds.has(page.source_id)) {
      await withMigrationSourceWriteFence(targetEngine, page.source_id, writePage);
    } else {
      await writePage(targetEngine);
    }

    // Track progress with composite key so multi-source resume is correct.
    manifest!.completed_slugs.push(makeManifestKey(page.source_id, page.slug));
    saveManifest(manifest!);
    migrated++;
    progress.tick(1, page.slug);
  }
  progress.finish();

  // Copy links (after all pages exist in target).
  // v0.32.8 F8: thread source_id so cross-source links migrate correctly.
  console.log('Copying links...');
  progress.start('migrate.copy_links', allPages.length);
  for (const page of allPages) {
    const sourceOpts = { sourceId: page.source_id };
    const links = await sourceEngine.getLinks(page.slug, sourceOpts);
    const writeLinks = async (engine: BrainEngine) => {
      for (const link of links) {
        await engine.addLink( // gbrain-allow-direct-insert: migrate-engine copies canonical link rows from the source engine
          link.from_slug, link.to_slug,
          link.context, link.link_type,
          undefined, undefined, undefined,
          { fromSourceId: page.source_id, toSourceId: page.source_id },
        );
      }
    };
    if (migrationFencedSourceIds.has(page.source_id)) {
      await withMigrationSourceWriteFence(targetEngine, page.source_id, writeLinks);
    } else {
      await writeLinks(targetEngine);
    }
    progress.tick(1);
  }
  progress.finish();

  // Copy config (selective).
  //
  // v0.37 fix wave Lane C.4: these DB-plane writes are SCHEMA METADATA for
  // the target engine — they record "the schema was sized using this
  // embedding model + dimension." They are NOT the runtime gateway config
  // (which lives in the file plane via `~/.gbrain/config.json`). When this
  // function copies them, it's preserving the schema-applied state across
  // the migration, not re-pointing the gateway. The newConfig below
  // doesn't carry these fields because the user's existing file config
  // already has them (or didn't, in which case the file plane should stay
  // unset and re-read from gateway defaults).
  const configKeys = ['embedding_model', 'embedding_dimensions', 'chunk_strategy'];
  for (const key of configKeys) {
    const val = await sourceEngine.getConfig(key);
    if (val) await targetEngine.setConfig(key, val);
  }

  // Update local config. v0.37 fix wave: preserve existing file-plane
  // embedding/expansion/chat config across the engine migration; only
  // the engine + connection target should change.
  const existingFile = (await import('../core/config.ts')).loadConfigFileOnly() ?? ({} as GBrainConfig);
  const configFilePath = gbrainPath('config.json');
  const previousConfigContents = existsSync(configFilePath)
    ? readFileSync(configFilePath, 'utf-8')
    : null;
  const newConfig: GBrainConfig = {
    ...existingFile,
    engine: opts.targetEngine,
    ...(opts.targetEngine === 'postgres'
      ? { database_url: targetConfig.database_url, database_path: undefined }
      : { database_path: targetConfig.database_path, database_url: undefined }),
  };

  // Linearize the final lifecycle snapshot and config switch. The source lock
  // blocks archive-begin and provider-acquire; row locks also fence restore,
  // which predates the advisory protocol. Every target source remains durably
  // migration-drained until one target transaction applies final lifecycle
  // state, proves parity, and performs the file-plane cutover.
  // Both engines differ by construction, so these transactions cannot share
  // a connection or self-deadlock.
  let archivedSourceCount = 0;
  await sourceEngine.transaction(async (sourceTx) => {
    await sourceTx.executeRaw(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('gbrain:source-lifecycle', 0)
       )`,
    );
    const sourceLifecycle = await sourceTx.executeRaw<FinalSourceMigrationState>(
      `SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token
         FROM sources
        ORDER BY (id = 'default') DESC, id
        FOR UPDATE`,
    );
    assertSourceMigrationLifecycleSnapshot(sourceLifecycle);
    const archivedRows = sourceLifecycle.filter((row) => row.archived);
    archivedSourceCount = archivedRows.length;
    await finalizeTargetSourceRowsForMigrationCutover(
      targetEngine,
      sourceLifecycle,
      () => { saveConfig(newConfig); },
      () => {
        if (previousConfigContents === null) {
          if (existsSync(configFilePath)) unlinkSync(configFilePath);
          return;
        }
        writeFileSync(configFilePath, previousConfigContents, { mode: 0o600 });
      },
    );
  });
  if (archivedSourceCount > 0) {
    console.log(`Restored archive state for ${archivedSourceCount} source row(s).`);
  }

  // Clean up
  clearManifest();

  console.log(`\nMigration complete. ${migrated} pages transferred.`);
  console.log(`Config updated to engine: ${opts.targetEngine}`);
  if (config.engine === 'pglite' && config.database_path) {
    console.log(`Original PGLite brain preserved at ${config.database_path} (backup).`);
  }

  // Post-migrate verification: confirm the target is healthy before we
  // leave the user. Catches incomplete copies, schema drift, and missing
  // embeddings immediately instead of on next CLI use. Non-fatal — prints
  // warnings and keeps going so the user sees the full picture.
  console.log('\nVerifying target...');
  try {
    await verifyTarget(targetEngine, sourceStats.page_count);
  } catch (e) {
    console.warn(`  Verification could not complete: ${e instanceof Error ? e.message : String(e)}`);
  }

    });
  } finally {
    await targetEngine.disconnect();
  }
}

/**
 * Lightweight doctor-style verify run against the migrated target.
 * Prints a small table of signals; does not exit. Callers own engine
 * lifecycle.
 */
async function verifyTarget(engine: BrainEngine, expectedPages: number): Promise<void> {
  const stats = await engine.getStats();
  if (stats.page_count === expectedPages) {
    console.log(`  ok  pages: ${stats.page_count} (matches source)`);
  } else {
    console.warn(`  WARN pages: ${stats.page_count} (source had ${expectedPages})`);
  }

  try {
    const health = await engine.getHealth();
    const pct = (health.embed_coverage * 100).toFixed(0);
    if (health.embed_coverage >= 0.9) {
      console.log(`  ok  embeddings: ${pct}% coverage, ${health.missing_embeddings} missing`);
    } else {
      console.warn(`  WARN embeddings: ${pct}% coverage, ${health.missing_embeddings} missing. Run: gbrain embed --stale`);
    }
  } catch (e) {
    console.warn(`  WARN embeddings: could not measure (${e instanceof Error ? e.message : String(e)})`);
  }

  try {
    const version = await engine.getConfig('version');
    const { LATEST_VERSION } = await import('../core/migrate.ts');
    const schemaVersion = parseInt(version || '0', 10);
    if (schemaVersion >= LATEST_VERSION) {
      console.log(`  ok  schema: version ${schemaVersion}`);
    } else {
      console.warn(`  WARN schema: version ${schemaVersion} (latest: ${LATEST_VERSION}). Run: gbrain apply-migrations --yes`);
    }
  } catch {
    console.warn('  WARN schema: version could not be read');
  }

  console.log('  Full health check: gbrain doctor');
}
