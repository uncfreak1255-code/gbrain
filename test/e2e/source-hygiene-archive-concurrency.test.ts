/**
 * Real-Postgres proof for the source archive/write lock protocol.
 *
 * PGLite proves trigger behavior, but it cannot prove two independent
 * transactions block in the required order. These cases pin both directions:
 * an existing writer makes archive wait and then veto; an archive already in
 * progress makes a later writer wait and then reject the archived source.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { archiveHygieneCandidate } from '../../src/commands/sources.ts';
import { purgeArchivedSource, softDeleteSource } from '../../src/core/destructive-guard.ts';
import { MIGRATIONS } from '../../src/core/migrate.ts';
import { withActiveEmbeddingSource } from '../../src/commands/embed.ts';
import {
  beginSourceArchiveDrain,
  revokeStaleSourceEmbeddingLeases,
  SourceEmbeddingLeaseLostError,
} from '../../src/core/source-embedding-lease.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { inspectSourceHygiene } from '../../src/core/source-hygiene.ts';
import { syncLockId } from '../../src/core/db-lock.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

if (!hasDatabase()) {
  console.log('Skipping source-hygiene archive concurrency E2E (DATABASE_URL not set)');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describeE2E('source hygiene archive/write concurrency', () => {
  beforeAll(async () => {
    await setupDB();
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('guard ignores a caller-controlled temporary sources table', async () => {
    const sourceId = 'archive-search-path-shadow-e2e';
    const jobName = 'source-hygiene-search-path-shadow-e2e';
    const writer = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM public.minion_jobs WHERE name = $1`, [jobName]);
      await writer.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO public.sources (id, name, config, archived)
         VALUES ($1, $1, '{}'::jsonb, true)`,
        [sourceId],
      );
      const error = await writer.withReservedConnection(async (conn) => {
        try {
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.sources`);
          await conn.executeRaw(
            `CREATE TEMP TABLE sources (id text PRIMARY KEY, archived boolean NOT NULL)`,
          );
          await conn.executeRaw(
            `INSERT INTO pg_temp.sources (id, archived) VALUES ($1, false)`,
            [sourceId],
          );
          await conn.executeRaw(`SET search_path = pg_temp, public`);

          try {
            await conn.executeRaw(
              `INSERT INTO public.minion_jobs (name, data)
               VALUES ($1, jsonb_build_object('sourceId', $2::text))`,
              [jobName, sourceId],
            );
          } catch (caught) {
            return caught;
          }
          return undefined;
        } finally {
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.sources`).catch(() => {});
          await conn.executeRaw(`RESET search_path`).catch(() => {});
        }
      });
      expect(error).toBeDefined();
      expect(String(error)).toContain('is archived');
    } finally {
      await writer.executeRaw(`DELETE FROM public.minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
      await writer.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]).catch(() => {});
      await writer.disconnect();
    }
  }, 30_000);

  test('queue cleanup and claim ignore a caller-controlled temporary sources table', async () => {
    const sourceId = 'queue-search-path-shadow-e2e';
    const jobName = 'queue-search-path-shadow-e2e';
    const writer = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM public.minion_jobs WHERE name = $1`, [jobName]);
      await writer.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO public.sources (id, name, config, archived)
         VALUES ($1, $1, '{}'::jsonb, false)`,
        [sourceId],
      );
      await writer.executeRaw(
        `INSERT INTO public.minion_jobs (name, data)
         VALUES ($1, jsonb_build_object('sourceId', $2::text))`,
        [jobName, sourceId],
      );

      await writer.withReservedConnection(async (conn) => {
        await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.sources`);
        await conn.executeRaw(
          `CREATE TEMP TABLE sources (
             id text PRIMARY KEY,
             archived boolean NOT NULL,
             embedding_drain_token text,
             local_path text
           )`,
        );
        await conn.executeRaw(
          `INSERT INTO pg_temp.sources (id, archived) VALUES ($1, true)`,
          [sourceId],
        );
        await conn.executeRaw(`SET search_path = pg_temp, public`);

        const scoped = {
          executeRaw: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
            conn.executeRaw<T>(sql, params),
          executeRawDirect: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
            conn.executeRaw<T>(sql, params),
          transaction: async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => {
            await conn.executeRaw('BEGIN');
            try {
              const result = await fn(scoped as unknown as BrainEngine);
              await conn.executeRaw('COMMIT');
              return result;
            } catch (error) {
              await conn.executeRaw('ROLLBACK');
              throw error;
            }
          },
        } as unknown as BrainEngine;
        const queue = new MinionQueue(scoped);
        expect(await queue.cancelArchivedSourceJobs()).toEqual([]);
        const claimed = await queue.claim('shadow-token', 30_000, 'default', [jobName]);
        expect(claimed).toMatchObject({ name: jobName, status: 'active' });

        await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.sources`);
        await conn.executeRaw(`RESET search_path`);
      });
    } finally {
      await writer.executeRaw(`DELETE FROM public.minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
      await writer.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]).catch(() => {});
      await writer.disconnect();
    }
  }, 30_000);

  test('purge waits for locked jobs and makes failed jobs non-retryable before source deletion', async () => {
    const sourceId = 'purge-locked-job-e2e';
    const waitingName = 'purge-locked-waiting-e2e';
    const failedName = 'purge-locked-failed-e2e';
    const lateChildName = 'purge-late-child-e2e';
    const cleaner = new PostgresEngine();
    const locker = new PostgresEngine();
    const childAdder = new PostgresEngine();
    await cleaner.connect({ database_url: process.env.DATABASE_URL! });
    await locker.connect({ database_url: process.env.DATABASE_URL! });
    await childAdder.connect({ database_url: process.env.DATABASE_URL! });
    const rowLocked = deferred();
    const releaseRow = deferred();
    let lockTx: Promise<void> | null = null;

    try {
      await cleaner.executeRaw(
        `DELETE FROM public.minion_jobs WHERE name IN ($1, $2, $3)`,
        [waitingName, failedName, lateChildName],
      );
      await cleaner.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]);
      await cleaner.executeRaw(
        `INSERT INTO public.sources (id, name, config, archived)
         VALUES ($1, $1, '{}'::jsonb, false)`,
        [sourceId],
      );
      await cleaner.executeRaw(
        `INSERT INTO public.minion_jobs (name, status, data)
         VALUES
           ($1, 'waiting', jsonb_build_object('sourceId', $3::text)),
           ($2, 'failed', jsonb_build_object('sourceId', $3::text))`,
        [waitingName, failedName, sourceId],
      );
      expect(await softDeleteSource(cleaner, sourceId)).toMatchObject({ id: sourceId });
      const seededJobs = await cleaner.executeRaw<{ id: number | string; name: string }>(
        `SELECT id, name FROM public.minion_jobs WHERE name IN ($1, $2)`,
        [waitingName, failedName],
      );
      const failedId = Number(seededJobs.find((job) => job.name === failedName)!.id);
      const waitingId = Number(seededJobs.find((job) => job.name === waitingName)!.id);

      lockTx = locker.transaction(async (tx) => {
        await tx.executeRaw(
          `SELECT id FROM public.minion_jobs WHERE name = $1 FOR UPDATE`,
          [waitingName],
        );
        rowLocked.resolve();
        await releaseRow.promise;
      });
      await rowLocked.promise;

      let purgeSettled = false;
      const purge = purgeArchivedSource(cleaner, sourceId)
        .finally(() => { purgeSettled = true; });
      await wait(100);
      expect(purgeSettled).toBe(false);
      let childSettled = false;
      const childAttempt = new MinionQueue(childAdder).add(lateChildName, {}, {
        parent_job_id: waitingId,
      }).then(
        (child) => child,
        (error: unknown) => error,
      ).finally(() => { childSettled = true; });
      await wait(50);
      expect(childSettled).toBe(false);
      releaseRow.resolve();
      await lockTx;
      await expect(purge).resolves.toBe(true);
      const childResult = await childAttempt;
      expect(childResult).toBeInstanceOf(Error);
      expect(String(childResult)).toContain('cannot add child to terminal parent');

      expect(await cleaner.executeRaw(
        `SELECT id FROM public.sources WHERE id = $1`,
        [sourceId],
      )).toEqual([]);
      expect(await cleaner.executeRaw<{ name: string; status: string }>(
        `SELECT name, status FROM public.minion_jobs
          WHERE name IN ($1, $2) ORDER BY name`,
        [waitingName, failedName],
      )).toEqual([
        { name: failedName, status: 'cancelled' },
        { name: waitingName, status: 'cancelled' },
      ]);
      expect(await new MinionQueue(cleaner).retryJob(failedId)).toBeNull();
    } finally {
      releaseRow.resolve();
      await lockTx?.catch(() => {});
      await cleaner.executeRaw(
        `DELETE FROM public.minion_jobs WHERE name IN ($1, $2, $3)`,
        [waitingName, failedName, lateChildName],
      ).catch(() => {});
      await cleaner.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([cleaner.disconnect(), locker.disconnect(), childAdder.disconnect()]);
    }
  }, 30_000);

  test('stale-lease revocation rechecks a concurrent fresh heartbeat before deletion', async () => {
    const sourceId = 'stale-lease-heartbeat-e2e';
    const leaseToken = 'stale-lease-heartbeat-token-e2e';
    const revoker = new PostgresEngine();
    const heartbeater = new PostgresEngine();
    await revoker.connect({ database_url: process.env.DATABASE_URL! });
    await heartbeater.connect({ database_url: process.env.DATABASE_URL! });
    const heartbeatWritten = deferred();
    const releaseHeartbeat = deferred();
    let heartbeatTx: Promise<void> | null = null;

    try {
      await revoker.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]);
      await revoker.executeRaw(
        `INSERT INTO public.sources (id, name, config, archived)
         VALUES ($1, $1, '{}'::jsonb, false)`,
        [sourceId],
      );
      const beforeDrain = await revoker.executeRaw<{ embedding_drain_epoch: number | string }>(
        `SELECT embedding_drain_epoch FROM public.sources WHERE id = $1`,
        [sourceId],
      );
      await revoker.executeRaw(
        `INSERT INTO public.source_embedding_leases
           (lease_token, source_id, source_epoch, owner_host, owner_pid, owner_instance,
            acquired_at, heartbeat_at)
         VALUES ($1, $2, $3, 'remote-host', 999999, 'remote-instance',
                 now() - interval '20 minutes', now() - interval '20 minutes')`,
        [leaseToken, sourceId, Number(beforeDrain[0]!.embedding_drain_epoch)],
      );
      const drain = await beginSourceArchiveDrain(revoker, sourceId);
      expect(drain?.epoch).toBe(Number(beforeDrain[0]!.embedding_drain_epoch) + 1);

      heartbeatTx = heartbeater.transaction(async (tx) => {
        await tx.executeRaw(
          `UPDATE public.source_embedding_leases
              SET heartbeat_at = now()
            WHERE lease_token = $1`,
          [leaseToken],
        );
        heartbeatWritten.resolve();
        await releaseHeartbeat.promise;
      });
      await heartbeatWritten.promise;

      let revocationSettled = false;
      const revocation = revokeStaleSourceEmbeddingLeases(revoker, sourceId, {
        confirmDestructive: true,
      }).finally(() => { revocationSettled = true; });
      await wait(100);
      expect(revocationSettled).toBe(false);
      releaseHeartbeat.resolve();
      await heartbeatTx;
      await expect(revocation).resolves.toEqual({ revoked: 0, remaining: 1 });

      await revoker.executeRaw(
        `UPDATE public.source_embedding_leases
            SET heartbeat_at = now() - interval '20 minutes'
          WHERE lease_token = $1`,
        [leaseToken],
      );
      await expect(revokeStaleSourceEmbeddingLeases(revoker, sourceId, {
        confirmDestructive: true,
      })).resolves.toEqual({ revoked: 1, remaining: 0 });
      await expect(softDeleteSource(revoker, sourceId)).resolves.not.toBeNull();
    } finally {
      releaseHeartbeat.resolve();
      await heartbeatTx?.catch(() => {});
      await revoker.executeRaw(
        `DELETE FROM public.source_embedding_leases WHERE lease_token = $1`,
        [leaseToken],
      ).catch(() => {});
      await revoker.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([revoker.disconnect(), heartbeater.disconnect()]);
    }
  }, 30_000);

  test('hygiene safety counts ignore caller-controlled temporary shadow tables', async () => {
    const sourceId = 'hygiene-count-shadow-e2e';
    const jobName = 'hygiene-count-shadow-job-e2e';
    const pageSlug = 'hygiene/count-shadow-e2e';
    const lockId = syncLockId(sourceId);
    const cycleLockId = `gbrain-cycle:${sourceId}`;
    const writer = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    const previousDefault = await writer.getConfig('sources.default');

    try {
      await writer.setConfig('sources.default', sourceId);
      await writer.executeRaw(`DELETE FROM public.gbrain_cycle_locks WHERE id = $1`, [lockId]);
      await writer.executeRaw(`DELETE FROM public.gbrain_cycle_locks WHERE id = $1`, [cycleLockId]);
      await writer.executeRaw(`DELETE FROM public.minion_jobs WHERE name = $1`, [jobName]);
      await writer.executeRaw(
        `DELETE FROM public.pages WHERE source_id = $1 AND slug = $2`,
        [sourceId, pageSlug],
      );
      await writer.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO public.sources (id, name, local_path, config, archived)
         VALUES ($1, $1, '/missing/hygiene-count-shadow-e2e', '{}'::jsonb, false)`,
        [sourceId],
      );
      await writer.executeRaw(
        `INSERT INTO public.pages (source_id, slug, type, title, compiled_truth)
         VALUES ($1, $2, 'note', 'Count shadow', 'count shadow')`,
        [sourceId, pageSlug],
      );
      await writer.executeRaw(
        `INSERT INTO public.minion_jobs (name, data)
         VALUES ($1, jsonb_build_object('sourceId', $2::text))`,
        [jobName, sourceId],
      );
      await writer.executeRaw(
        `INSERT INTO public.gbrain_cycle_locks
           (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
         VALUES ($1, 999999, 'shadow-test', now() + interval '5 minutes', now())`,
        [lockId],
      );
      await writer.executeRaw(
        `INSERT INTO public.gbrain_cycle_locks
           (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
         VALUES ($1, 999998, 'shadow-test', now() + interval '5 minutes', now())`,
        [cycleLockId],
      );

      await writer.withReservedConnection(async (conn) => {
        try {
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.config`);
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.gbrain_cycle_locks`);
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.pages`);
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.minion_jobs`);
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.sources`);
          await conn.executeRaw(`CREATE TEMP TABLE sources (LIKE public.sources INCLUDING DEFAULTS)`);
          await conn.executeRaw(
            `INSERT INTO pg_temp.sources (id, name, local_path, config, archived)
             VALUES ($1, $1, NULL, '{}'::jsonb, false)`,
            [sourceId],
          );
          await conn.executeRaw(`CREATE TEMP TABLE pages (source_id text)`);
          await conn.executeRaw(
            `CREATE TEMP TABLE minion_jobs (
               id bigint,
               name text,
               data jsonb,
               status text
             )`,
          );
          await conn.executeRaw(`CREATE TEMP TABLE config (LIKE public.config INCLUDING DEFAULTS)`);
          await conn.executeRaw(
            `CREATE TEMP TABLE gbrain_cycle_locks
               (LIKE public.gbrain_cycle_locks INCLUDING DEFAULTS)`,
          );
          await conn.executeRaw(`SET search_path = pg_temp, public`);

          const scoped = {
            kind: 'postgres',
            sql: async (parts: TemplateStringsArray, ...values: unknown[]) => {
              let statement = parts[0] ?? '';
              for (let index = 0; index < values.length; index += 1) {
                statement += `$${index + 1}${parts[index + 1] ?? ''}`;
              }
              return conn.executeRaw(statement, values);
            },
            executeRaw: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
              conn.executeRaw<T>(sql, params),
          } as unknown as BrainEngine;
          const packet = await inspectSourceHygiene(scoped, {
            inspectFilesystem: true,
            probes: {
              repoState: () => 'missing',
            },
          });
          const decision = packet.sources.find((source) => source.source_id === sourceId);
          expect(decision).toMatchObject({
            classification: 'recovery_required',
            configured_default: true,
            dependent_row_count: 1,
            nonterminal_work_count: 1,
            live_sync_lock: true,
            live_cycle_lock: true,
          });
        } finally {
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.config`).catch(() => {});
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.gbrain_cycle_locks`).catch(() => {});
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.pages`).catch(() => {});
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.minion_jobs`).catch(() => {});
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.sources`).catch(() => {});
          await conn.executeRaw(`RESET search_path`).catch(() => {});
        }
      });
    } finally {
      if (previousDefault == null) {
        await writer.unsetConfig('sources.default').catch(() => {});
      } else {
        await writer.setConfig('sources.default', previousDefault).catch(() => {});
      }
      await writer.executeRaw(`DELETE FROM public.gbrain_cycle_locks WHERE id = $1`, [lockId]).catch(() => {});
      await writer.executeRaw(`DELETE FROM public.gbrain_cycle_locks WHERE id = $1`, [cycleLockId]).catch(() => {});
      await writer.executeRaw(`DELETE FROM public.minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM public.pages WHERE source_id = $1 AND slug = $2`,
        [sourceId, pageSlug],
      ).catch(() => {});
      await writer.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]).catch(() => {});
      await writer.disconnect();
    }
  }, 30_000);

  test('cascade cancellation locks parent before child during concurrent completion', async () => {
    const parentName = 'cancel-lock-order-parent-e2e';
    const childName = 'cancel-lock-order-child-e2e';
    const completer = new PostgresEngine();
    const canceller = new PostgresEngine();
    await completer.connect({ database_url: process.env.DATABASE_URL! });
    await canceller.connect({ database_url: process.env.DATABASE_URL! });
    const parentLocked = deferred();
    const releaseCompletion = deferred();
    let completionTx: Promise<void> | null = null;
    let parentId: number | null = null;
    let childId: number | null = null;

    try {
      await completer.executeRaw(
        `DELETE FROM public.minion_jobs WHERE name IN ($1, $2)`,
        [parentName, childName],
      );
      const parents = await completer.executeRaw<{ id: number | string }>(
        `INSERT INTO public.minion_jobs (name, status)
         VALUES ($1, 'waiting') RETURNING id`,
        [parentName],
      );
      parentId = Number(parents[0].id);
      const children = await completer.executeRaw<{ id: number | string }>(
        `INSERT INTO public.minion_jobs
           (name, status, parent_job_id, lock_token, lock_until, started_at)
         VALUES ($1, 'active', $2, 'completion-token', now() + interval '5 minutes', now())
         RETURNING id`,
        [childName, parentId],
      );
      childId = Number(children[0].id);

      // Match the normal add-child layout: inserting the child is followed by
      // updating the parent to waiting-children, which places the live parent
      // tuple after the child. The old bulk UPDATE then locked child first.
      await completer.executeRaw(
        `UPDATE public.minion_jobs
            SET status = 'waiting-children', updated_at = clock_timestamp()
          WHERE id = $1`,
        [parentId],
      );
      const layout = await completer.executeRaw<{ child_first: boolean }>(
        `SELECT child.ctid < parent.ctid AS child_first
           FROM public.minion_jobs AS child
           JOIN public.minion_jobs AS parent ON parent.id = $1
          WHERE child.id = $2`,
        [parentId, childId],
      );
      expect(layout[0]?.child_first).toBe(true);

      completionTx = completer.transaction(async (tx) => {
        await tx.executeRaw(
          `SELECT id FROM public.minion_jobs WHERE id = $1 FOR UPDATE`,
          [parentId],
        );
        parentLocked.resolve();
        await releaseCompletion.promise;
        await tx.executeRaw(
          `UPDATE public.minion_jobs
              SET status = 'completed', lock_token = NULL, lock_until = NULL,
                  finished_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'active'`,
          [childId],
        );
      });
      await parentLocked.promise;

      let cancellationSettled = false;
      const cancellation = new MinionQueue(canceller).cancelJob(parentId)
        .finally(() => { cancellationSettled = true; });
      await wait(100);
      expect(cancellationSettled).toBe(false);

      releaseCompletion.resolve();
      const [, cancelled] = await Promise.all([completionTx, cancellation]);
      expect(cancelled).toMatchObject({ id: parentId, status: 'cancelled' });
      const finalRows = await completer.executeRaw<{ id: number | string; status: string }>(
        `SELECT id, status FROM public.minion_jobs
          WHERE id = ANY($1::bigint[]) ORDER BY id`,
        [[parentId, childId]],
      );
      expect(finalRows).toEqual([
        { id: parentId, status: 'cancelled' },
        { id: childId, status: 'completed' },
      ]);
    } finally {
      releaseCompletion.resolve();
      await completionTx?.catch(() => {});
      const ids = [childId, parentId].filter((id): id is number => id !== null);
      if (ids.length > 0) {
        await completer.executeRaw(
          `DELETE FROM public.minion_jobs WHERE id = ANY($1::bigint[])`,
          [ids],
        ).catch(() => {});
      }
      await Promise.all([completer.disconnect(), canceller.disconnect()]);
    }
  }, 30_000);

  test('archived-job cleanup does not cancel work after a concurrent restore wins', async () => {
    const sourceId = 'cleanup-restore-race-e2e';
    const jobName = 'cleanup-restore-race-job-e2e';
    const cleaner = new PostgresEngine();
    const restorer = new PostgresEngine();
    await cleaner.connect({ database_url: process.env.DATABASE_URL! });
    await restorer.connect({ database_url: process.env.DATABASE_URL! });
    const restoreUpdated = deferred();
    const releaseRestore = deferred();
    let restoreTx: Promise<void> | null = null;

    try {
      await cleaner.executeRaw(`DELETE FROM public.minion_jobs WHERE name = $1`, [jobName]);
      await cleaner.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]);
      await cleaner.executeRaw(
        `INSERT INTO public.sources (id, name, config, archived)
         VALUES ($1, $1, '{}'::jsonb, false)`,
        [sourceId],
      );
      await cleaner.executeRaw(
        `INSERT INTO public.minion_jobs (name, status, data)
         VALUES ($1, 'waiting', jsonb_build_object('sourceId', $2::text))`,
        [jobName, sourceId],
      );
      expect(await softDeleteSource(cleaner, sourceId)).toMatchObject({ id: sourceId });

      restoreTx = restorer.transaction(async (tx) => {
        await tx.executeRaw(
          `UPDATE public.sources
              SET archived = false, archived_at = NULL, archive_expires_at = NULL
            WHERE id = $1 AND archived IS TRUE`,
          [sourceId],
        );
        restoreUpdated.resolve();
        await releaseRestore.promise;
      });
      await restoreUpdated.promise;

      let cleanupSettled = false;
      const cleanup = new MinionQueue(cleaner).cancelArchivedSourceJobs()
        .finally(() => { cleanupSettled = true; });
      await wait(100);
      expect(cleanupSettled).toBe(false);

      releaseRestore.resolve();
      await restoreTx;
      expect(await cleanup).toEqual([]);
      const finalRows = await cleaner.executeRaw<{ archived: boolean; status: string }>(
        `SELECT source.archived, job.status
           FROM public.sources AS source
           JOIN public.minion_jobs AS job ON job.name = $2
          WHERE source.id = $1`,
        [sourceId, jobName],
      );
      expect(finalRows).toEqual([{ archived: false, status: 'waiting' }]);
    } finally {
      releaseRestore.resolve();
      await restoreTx?.catch(() => {});
      await cleaner.executeRaw(`DELETE FROM public.minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
      await cleaner.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([cleaner.disconnect(), restorer.disconnect()]);
    }
  }, 30_000);

  test('cleanup ignores a newly archived path-overlap source it did not lock', async () => {
    const sourceA = 'cleanup-path-phantom-a-e2e';
    const sourceB = 'cleanup-path-phantom-b-e2e';
    const sharedPath = '/tmp/gbrain-cleanup-path-phantom-e2e';
    const cleaner = new PostgresEngine();
    const lifecycleA = new PostgresEngine();
    const lifecycleB = new PostgresEngine();
    await cleaner.connect({ database_url: process.env.DATABASE_URL! });
    await lifecycleA.connect({ database_url: process.env.DATABASE_URL! });
    await lifecycleB.connect({ database_url: process.env.DATABASE_URL! });
    const restoreAUpdated = deferred();
    const releaseRestoreA = deferred();
    const restoreBUpdated = deferred();
    const releaseRestoreB = deferred();
    let restoreATx: Promise<void> | null = null;
    let restoreBTx: Promise<void> | null = null;
    let jobId: number | null = null;

    try {
      await cleaner.executeRaw(
        `DELETE FROM public.minion_jobs
          WHERE name = 'sync' AND data->>'repoPath' = $1`,
        [sharedPath],
      );
      await cleaner.executeRaw(`DELETE FROM public.sources WHERE id IN ($1, $2)`, [sourceA, sourceB]);
      await cleaner.executeRaw(
        `INSERT INTO public.sources (id, name, local_path, config, archived)
         VALUES
           ($1, $1, $3, '{}'::jsonb, false),
           ($2, $2, $3, '{}'::jsonb, false)`,
        [sourceA, sourceB, sharedPath],
      );
      const jobs = await cleaner.executeRaw<{ id: number | string }>(
        `INSERT INTO public.minion_jobs (name, status, data)
         VALUES ('sync', 'waiting', jsonb_build_object('repoPath', $1::text))
         RETURNING id`,
        [sharedPath],
      );
      jobId = Number(jobs[0].id);
      expect(await softDeleteSource(cleaner, sourceA)).toMatchObject({ id: sourceA });

      restoreATx = lifecycleA.transaction(async (tx) => {
        await tx.executeRaw(
          `UPDATE public.sources SET archived = false, archived_at = NULL,
             archive_expires_at = NULL WHERE id = $1 AND archived IS TRUE`,
          [sourceA],
        );
        restoreAUpdated.resolve();
        await releaseRestoreA.promise;
      });
      await restoreAUpdated.promise;

      let cleanupSettled = false;
      const cleanup = new MinionQueue(cleaner).cancelArchivedSourceJobs()
        .finally(() => { cleanupSettled = true; });
      await wait(100);
      expect(cleanupSettled).toBe(false);

      // The cleanup source-lock statement already has its snapshot and is
      // waiting on A. Archive B after that snapshot, then hold B's restore
      // uncommitted. B must not become an unlocked match in the later recheck.
      expect(await softDeleteSource(lifecycleB, sourceB)).toMatchObject({ id: sourceB });
      restoreBTx = lifecycleB.transaction(async (tx) => {
        await tx.executeRaw(
          `UPDATE public.sources SET archived = false, archived_at = NULL,
             archive_expires_at = NULL WHERE id = $1 AND archived IS TRUE`,
          [sourceB],
        );
        restoreBUpdated.resolve();
        await releaseRestoreB.promise;
      });
      await restoreBUpdated.promise;

      releaseRestoreA.resolve();
      await restoreATx;
      expect(await cleanup).toEqual([]);
      releaseRestoreB.resolve();
      await restoreBTx;

      const finalRows = await cleaner.executeRaw<{ id: string; archived: boolean }>(
        `SELECT id, archived FROM public.sources
          WHERE id IN ($1, $2) ORDER BY id`,
        [sourceA, sourceB],
      );
      expect(finalRows).toEqual([
        { id: sourceA, archived: false },
        { id: sourceB, archived: false },
      ]);
      const jobRows = await cleaner.executeRaw<{ status: string }>(
        `SELECT status FROM public.minion_jobs WHERE id = $1`,
        [jobId],
      );
      expect(jobRows).toEqual([{ status: 'waiting' }]);
    } finally {
      releaseRestoreA.resolve();
      releaseRestoreB.resolve();
      await Promise.all([restoreATx?.catch(() => {}), restoreBTx?.catch(() => {})]);
      if (jobId !== null) {
        await cleaner.executeRaw(`DELETE FROM public.minion_jobs WHERE id = $1`, [jobId]).catch(() => {});
      }
      await cleaner.executeRaw(`DELETE FROM public.sources WHERE id IN ($1, $2)`, [sourceA, sourceB]).catch(() => {});
      await Promise.all([
        cleaner.disconnect(), lifecycleA.disconnect(), lifecycleB.disconnect(),
      ]);
    }
  }, 30_000);

  test('claim treats an archive trigger race as a clean miss and continues', async () => {
    const archivedSource = 'claim-race-archived-e2e';
    const healthySource = 'claim-race-healthy-e2e';
    const archivedJob = 'claim-race-archived-job-e2e';
    const healthyJob = 'claim-race-healthy-job-e2e';
    const pauseLock = 42_428_901;
    const worker = new PostgresEngine();
    const archiver = new PostgresEngine();
    const blocker = new PostgresEngine();
    await worker.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });
    await blocker.connect({ database_url: process.env.DATABASE_URL! });
    const lockReady = deferred();
    const releaseLock = deferred();
    let blockerRun: Promise<void> | null = null;

    try {
      await worker.executeRaw(
        `DELETE FROM public.minion_jobs WHERE name IN ($1, $2)`,
        [archivedJob, healthyJob],
      );
      await worker.executeRaw(
        `DELETE FROM public.sources WHERE id IN ($1, $2)`,
        [archivedSource, healthySource],
      );
      await worker.executeRaw(
        `INSERT INTO public.sources (id, name, config, archived)
         VALUES ($1, $1, '{}'::jsonb, false), ($2, $2, '{}'::jsonb, false)`,
        [archivedSource, healthySource],
      );
      await worker.executeRaw(
        `INSERT INTO public.minion_jobs (name, priority, data)
         VALUES
           ($1, -10, jsonb_build_object('sourceId', $2::text)),
           ($3, 0, jsonb_build_object('sourceId', $4::text))`,
        [archivedJob, archivedSource, healthyJob, healthySource],
      );
      await worker.executeRaw(`
        CREATE OR REPLACE FUNCTION public.gbrain_test_pause_claim_fn()
        RETURNS trigger AS $fn$
        BEGIN
          IF NEW.status = 'active' THEN
            PERFORM pg_advisory_xact_lock(${pauseLock});
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;
        DROP TRIGGER IF EXISTS aa_gbrain_test_pause_claim ON public.minion_jobs;
        CREATE TRIGGER aa_gbrain_test_pause_claim
          BEFORE UPDATE ON public.minion_jobs
          FOR EACH ROW EXECUTE FUNCTION public.gbrain_test_pause_claim_fn();
      `);

      blockerRun = blocker.withReservedConnection(async (conn) => {
        await conn.executeRaw(`SELECT pg_advisory_lock($1)`, [pauseLock]);
        lockReady.resolve();
        await releaseLock.promise;
        await conn.executeRaw(`SELECT pg_advisory_unlock($1)`, [pauseLock]);
      });
      await lockReady.promise;

      const queue = new MinionQueue(worker);
      const racedClaim = queue.claim(
        'claim-race-token', 30_000, 'default', [archivedJob, healthyJob],
      );
      let observedBlockedClaim = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await archiver.executeRaw<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND lower(COALESCE(wait_event, '')) = 'advisory'
                AND query ILIKE '%UPDATE minion_jobs SET%'
           ) AS blocked`,
        );
        if (rows[0]?.blocked) {
          observedBlockedClaim = true;
          break;
        }
        await wait(25);
      }
      expect(observedBlockedClaim).toBe(true);
      expect(await softDeleteSource(archiver, archivedSource)).toMatchObject({ id: archivedSource });
      releaseLock.resolve();
      await blockerRun;
      expect(await racedClaim).toBeNull();

      await worker.executeRaw(
        `DROP TRIGGER IF EXISTS aa_gbrain_test_pause_claim ON public.minion_jobs`,
      );
      const healthy = await queue.claim(
        'claim-after-race-token', 30_000, 'default', [archivedJob, healthyJob],
      );
      expect(healthy).toMatchObject({ name: healthyJob, status: 'active' });
      const archivedState = await worker.executeRaw<{ status: string }>(
        `SELECT status FROM public.minion_jobs WHERE name = $1`,
        [archivedJob],
      );
      expect(archivedState).toEqual([{ status: 'cancelled' }]);
    } finally {
      releaseLock.resolve();
      await blockerRun?.catch(() => {});
      await worker.executeRaw(
        `DROP TRIGGER IF EXISTS aa_gbrain_test_pause_claim ON public.minion_jobs`,
      ).catch(() => {});
      await worker.executeRaw(
        `DROP FUNCTION IF EXISTS public.gbrain_test_pause_claim_fn()`,
      ).catch(() => {});
      await worker.executeRaw(
        `DELETE FROM public.minion_jobs WHERE name IN ($1, $2)`,
        [archivedJob, healthyJob],
      ).catch(() => {});
      await worker.executeRaw(
        `DELETE FROM public.sources WHERE id IN ($1, $2)`,
        [archivedSource, healthySource],
      ).catch(() => {});
      await worker.disconnect();
      await archiver.disconnect();
      await blocker.disconnect();
    }
  }, 30_000);

  test('provider lease blocks archive until egress settles and discards drained output', async () => {
    const sourceId = 'embedding-egress-lock-e2e';
    const embedder = new PostgresEngine();
    const archiver = new PostgresEngine();
    await embedder.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });
    const providerStarted = deferred();
    const releaseProvider = deferred();
    let submission: Promise<string> | null = null;
    let archive: ReturnType<typeof softDeleteSource> | null = null;

    try {
      await embedder.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]);
      await embedder.executeRaw(
        `INSERT INTO public.sources (id, name, config, archived)
         VALUES ($1, $1, '{}'::jsonb, false)`,
        [sourceId],
      );

      submission = withActiveEmbeddingSource(embedder, sourceId, async () => {
        providerStarted.resolve();
        await releaseProvider.promise;
        return 'submitted';
      });
      await providerStarted.promise;

      let archiveSettled = false;
      archive = softDeleteSource(archiver, sourceId)
        .finally(() => { archiveSettled = true; });
      await wait(100);
      expect(archiveSettled).toBe(false);

      releaseProvider.resolve();
      await expect(submission!).rejects.toBeInstanceOf(SourceEmbeddingLeaseLostError);
      expect(await archive).toMatchObject({ id: sourceId });
      const state = await archiver.executeRaw<{ archived: boolean }>(
        `SELECT archived FROM public.sources WHERE id = $1`,
        [sourceId],
      );
      expect(state).toEqual([{ archived: true }]);
    } finally {
      releaseProvider.resolve();
      await submission?.catch(() => {});
      await archive?.catch(() => {});
      await archiver.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]).catch(() => {});
      await embedder.disconnect();
      await archiver.disconnect();
    }
  }, 30_000);

  test('archived rows cannot escape through direct or page-owned source references', async () => {
    const sourceId = 'archived-rehome-e2e';
    const pageSlug = 'archive/rehome-e2e';
    const jobName = 'archive-rehome-e2e';
    const writer = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });

    const expectArchivedError = async (sql: string) => {
      let error: unknown;
      try {
        await writer.executeRaw(sql);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(String(error)).toContain('is archived');
    };

    try {
      await writer.executeRaw(
        `INSERT INTO sources (id, name, config, archived)
         VALUES ($1, $1, '{}'::jsonb, false)`,
        [sourceId],
      );
      await writer.executeRaw(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
         VALUES ($1, $2, 'note', 'Archive rehome', 'archive rehome')`,
        [sourceId, pageSlug],
      );
      await writer.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
         SELECT id, 0, 'archive rehome chunk'
           FROM pages
          WHERE source_id = $1 AND slug = $2`,
        [sourceId, pageSlug],
      );
      await writer.executeRaw(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
         VALUES
           ('default', 'archive/rehome-e2e-from', 'note', 'From', 'from'),
           ('default', 'archive/rehome-e2e-to', 'note', 'To', 'to')`,
      );
      await writer.executeRaw(
        `INSERT INTO files
           (source_id, page_slug, page_id, filename, storage_path, content_hash)
         SELECT 'default', $2, id,
                'archive-rehome-e2e.txt', 'archive-rehome-e2e.txt', 'archive-rehome-e2e-hash'
           FROM pages
          WHERE source_id = $1 AND slug = $2`,
        [sourceId, pageSlug],
      );
      await writer.executeRaw(
        `INSERT INTO links
           (from_page_id, to_page_id, origin_page_id, link_type, link_source)
         SELECT from_page.id, to_page.id, origin_page.id, 'related', 'frontmatter'
           FROM pages from_page
           JOIN pages to_page
             ON to_page.source_id = 'default' AND to_page.slug = 'archive/rehome-e2e-to'
           JOIN pages origin_page
             ON origin_page.source_id = $1 AND origin_page.slug = $2
          WHERE from_page.source_id = 'default'
            AND from_page.slug = 'archive/rehome-e2e-from'`,
        [sourceId, pageSlug],
      );
      await writer.executeRaw(
        `INSERT INTO eval_candidates
           (tool_name, query, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
         VALUES ('query', 'archive rehome', ARRAY[$1], false, false, 1, false)`,
        [sourceId],
      );
      await writer.executeRaw(
        `INSERT INTO minion_jobs (name, data)
         VALUES ($1, jsonb_build_object('sourceId', $2::text))`,
        [jobName, sourceId],
      );
      expect(await softDeleteSource(writer, sourceId)).toMatchObject({ id: sourceId });

      await expectArchivedError(
        `UPDATE pages SET source_id = 'default'
          WHERE source_id = '${sourceId}' AND slug = '${pageSlug}'`,
      );
      await expectArchivedError(
        `UPDATE content_chunks SET chunk_text = 'blocked archived chunk mutation'
          WHERE page_id = (
            SELECT id FROM pages
             WHERE source_id = '${sourceId}' AND slug = '${pageSlug}'
          )`,
      );
      await expectArchivedError(
        `UPDATE eval_candidates SET source_ids = ARRAY['default']
          WHERE query = 'archive rehome'`,
      );
      await expectArchivedError(
        `UPDATE minion_jobs SET data = '{"sourceId":"default"}'::jsonb
          WHERE name = '${jobName}'`,
      );

      await writer.executeRaw(
        `UPDATE minion_jobs SET status = 'failed' WHERE name = $1`,
        [jobName],
      );
      await writer.executeRaw(
        `DELETE FROM pages WHERE source_id = $1 AND slug = $2`,
        [sourceId, pageSlug],
      );
      const nullableRefs = await writer.executeRaw<{
        file_page_id: number | null;
        link_origin_page_id: number | null;
      }>(
        `SELECT
           (SELECT page_id FROM files
             WHERE storage_path = 'archive-rehome-e2e.txt') AS file_page_id,
           (SELECT link.origin_page_id
              FROM links link
              JOIN pages from_page ON from_page.id = link.from_page_id
             WHERE from_page.source_id = 'default'
               AND from_page.slug = 'archive/rehome-e2e-from'
               AND link.link_source = 'frontmatter'
               AND link.link_type = 'related') AS link_origin_page_id`,
      );
      expect(nullableRefs).toEqual([{
        file_page_id: null,
        link_origin_page_id: null,
      }]);
    } finally {
      await writer.executeRaw(
        `UPDATE sources SET archived = false, archived_at = NULL WHERE id = $1`,
        [sourceId],
      ).catch(() => {});
      await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
      await writer.executeRaw(`DELETE FROM eval_candidates WHERE query = 'archive rehome'`).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM files WHERE storage_path = 'archive-rehome-e2e.txt'`,
      ).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM links link
          USING pages from_page
          WHERE link.from_page_id = from_page.id
            AND from_page.source_id = 'default'
            AND from_page.slug = 'archive/rehome-e2e-from'
            AND link.link_source = 'frontmatter'
            AND link.link_type = 'related'`,
      ).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM pages WHERE source_id = $1 AND slug = $2`,
        [sourceId, pageSlug],
      ).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM pages
          WHERE source_id = 'default'
            AND slug IN ('archive/rehome-e2e-from', 'archive/rehome-e2e-to')`,
      ).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await writer.disconnect();
    }
  }, 30_000);

  test('intermediate guards allow missing legacy sources but reject archived sources', async () => {
    const referenceGuard = MIGRATIONS.find((entry) => entry.version === 124);
    const jobGuard = MIGRATIONS.find((entry) => entry.version === 126);
    const continuationGuard = MIGRATIONS.find((entry) => entry.version === 127);
    const ownedRowGuard = MIGRATIONS.find((entry) => entry.version === 128);
    const compatibilityGuard = MIGRATIONS.find((entry) => entry.version === 129);
    const finalGuard = MIGRATIONS.find((entry) => entry.version === 130);
    const indirectGuard = MIGRATIONS.find((entry) => entry.version === 132);
    const providerDrainGuard = MIGRATIONS.find((entry) => entry.version === 133);
    const cycleLockGuard = MIGRATIONS.find((entry) => entry.version === 134);
    expect(referenceGuard?.sql).toBeDefined();
    expect(jobGuard?.sql).toBeDefined();
    expect(continuationGuard?.sql).toBeDefined();
    expect(ownedRowGuard?.sql).toBeDefined();
    expect(compatibilityGuard?.sql).toBeDefined();
    expect(finalGuard?.sql).toBeDefined();
    expect(indirectGuard?.sql).toBeDefined();
    expect(providerDrainGuard?.sql).toBeDefined();
    expect(cycleLockGuard?.sql).toBeDefined();

    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    const proveMissingWriterBlocksArchive = async (sourceId: string, jobName: string) => {
      const writerReady = deferred();
      const releaseWriter = deferred();
      let writerTx: Promise<void> | null = null;
      let archiveAttempt: ReturnType<typeof archiveHygieneCandidate> | null = null;

      try {
        writerTx = writer.transaction(async (tx) => {
          await tx.executeRaw(
            `INSERT INTO minion_jobs (name, status, data)
             VALUES ($1, 'waiting', jsonb_build_object('sourceId', $2::text))`,
            [jobName, sourceId],
          );
          writerReady.resolve();
          await releaseWriter.promise;
        });
        await writerReady.promise;

        await archiver.executeRaw(
          `INSERT INTO sources (id, name, local_path, config)
           VALUES ($1, $1, $2, '{}'::jsonb)`,
          [sourceId, `/tmp/gbrain-${sourceId}-missing`],
        );
        let archiveSettled = false;
        archiveAttempt = archiveHygieneCandidate(archiver, sourceId)
          .finally(() => { archiveSettled = true; });
        await wait(100);
        expect(archiveSettled).toBe(false);

        releaseWriter.resolve();
        await writerTx;
        const archive = await archiveAttempt;
        expect(archive.result).toBeNull();
        expect(archive.reason).toContain('nonterminal_source_work');
      } finally {
        releaseWriter.resolve();
        await writerTx?.catch(() => {});
        await archiveAttempt?.catch(() => {});
        await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
        await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      }
    };

    try {
      await writer.runMigration(124, referenceGuard!.sql!);
      await writer.executeRaw(
        `INSERT INTO sources (id, name, archived)
         VALUES ('v124-archived-e2e', 'v124-archived-e2e', true)`,
      );
      await writer.executeRaw(
        `INSERT INTO eval_candidates
           (tool_name, query, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
         VALUES ('query', 'v124 missing source e2e', ARRAY['v124-missing-e2e'], false, false, 1, false)`,
      );
      await writer.executeRaw(
        `INSERT INTO config (key, value) VALUES ('sources.default', 'v124-missing-e2e')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      await writer.runMigration(124, `
            DO $assert$
            BEGIN
              BEGIN
                INSERT INTO eval_candidates
                  (tool_name, query, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
                VALUES ('query', 'v124 archived source e2e', ARRAY['v124-archived-e2e'], false, false, 1, false);
                RAISE EXCEPTION 'v124 accepted an archived source reference';
              EXCEPTION WHEN foreign_key_violation THEN
                IF SQLERRM NOT LIKE '%is archived%' THEN RAISE; END IF;
              END;

              BEGIN
                INSERT INTO config (key, value) VALUES ('sources.default', 'v124-archived-e2e')
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
                RAISE EXCEPTION 'v124 accepted an archived default source';
              EXCEPTION WHEN foreign_key_violation THEN
                IF SQLERRM NOT LIKE '%is archived%' THEN RAISE; END IF;
              END;
            END;
            $assert$;
      `);

      await writer.runMigration(126, jobGuard!.sql!);
      await writer.executeRaw(
        `INSERT INTO minion_jobs (name, data)
         VALUES ('v126-missing-source-e2e', '{"sourceId":"v126-missing-e2e"}'::jsonb)`,
      );
      await writer.runMigration(126, `
            DO $assert$
            BEGIN
              BEGIN
                INSERT INTO minion_jobs (name, data)
                VALUES ('v126-archived-source-e2e', '{"sourceId":"v124-archived-e2e"}'::jsonb);
                RAISE EXCEPTION 'v126 accepted an archived source reference';
              EXCEPTION WHEN foreign_key_violation THEN
                IF SQLERRM NOT LIKE '%is archived%' THEN RAISE; END IF;
              END;
            END;
            $assert$;
      `);

      await proveMissingWriterBlocksArchive(
        'v126-lock-missing-e2e',
        'v126-lock-missing-source-e2e',
      );

      await writer.runMigration(129, compatibilityGuard!.sql!);
      await writer.runMigration(129, `
            DO $assert$
            BEGIN
              BEGIN
                INSERT INTO minion_jobs (name, data)
                VALUES ('v129-archived-source-e2e', '{"sourceId":"v124-archived-e2e"}'::jsonb);
                RAISE EXCEPTION 'v129 accepted an archived source reference';
              EXCEPTION WHEN foreign_key_violation THEN
                IF SQLERRM NOT LIKE '%is archived%' THEN RAISE; END IF;
              END;
            END;
            $assert$;
      `);
      await proveMissingWriterBlocksArchive(
        'v129-lock-missing-e2e',
        'v129-lock-missing-source-e2e',
      );
    } finally {
      await writer.runMigration(127, continuationGuard!.sql!);
      await writer.runMigration(128, ownedRowGuard!.sql!);
      await writer.runMigration(130, finalGuard!.sql!);
      await writer.runMigration(132, indirectGuard!.sql!);
      await writer.runMigration(133, providerDrainGuard!.sql!);
      await writer.runMigration(134, cycleLockGuard!.sql!);
      await writer.executeRaw(
        `DELETE FROM minion_jobs
          WHERE name IN ('v126-missing-source-e2e', 'v126-lock-missing-source-e2e',
                         'v129-lock-missing-source-e2e')`,
      ).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM eval_candidates
          WHERE query IN ('v124 missing source e2e', 'v124 archived source e2e')`,
      ).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM sources
          WHERE id IN ('v124-archived-e2e', 'v126-lock-missing-e2e', 'v129-lock-missing-e2e')`,
      ).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);

  test('writer already holding a source share lock commits before archive rereads and vetoes', async () => {
    const sourceId = 'archive-writer-first-e2e';
    const sourcePath = `/tmp/gbrain-${sourceId}-missing`;
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, sourcePath],
      );

      const writerReady = deferred();
      const releaseWriter = deferred();
      const writerTx = writer.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO minion_jobs (name, status, data)
           VALUES ('source-hygiene-e2e', 'waiting', jsonb_build_object('sourceId', $1::text))`,
          [sourceId],
        );
        writerReady.resolve();
        await releaseWriter.promise;
      });
      await writerReady.promise;

      let archiveSettled = false;
      const archiveAttempt = archiveHygieneCandidate(archiver, sourceId)
        .finally(() => { archiveSettled = true; });
      await wait(100);
      expect(archiveSettled).toBe(false);

      releaseWriter.resolve();
      await writerTx;
      const result = await archiveAttempt;
      expect(result.result).toBeNull();
      expect(result.reason).toContain('nonterminal_source_work');

      const rows = await writer.executeRaw<{ archived: boolean }>(
        `SELECT archived FROM sources WHERE id = $1`,
        [sourceId],
      );
      expect(rows[0]?.archived).toBe(false);
    } finally {
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);

  test('writer for a missing source blocks later registration plus archive until its reference is visible', async () => {
    const sourceId = 'archive-missing-writer-first-e2e';
    const jobName = 'source-hygiene-missing-source-e2e';
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    const writerReady = deferred();
    const releaseWriter = deferred();
    let writerTx: Promise<void> | null = null;
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]);
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);

      writerTx = writer.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO minion_jobs (name, status, data)
           VALUES ($1, 'waiting', jsonb_build_object('sourceId', $2::text))`,
          [jobName, sourceId],
        );
        writerReady.resolve();
        await releaseWriter.promise;
      });
      await writerReady.promise;

      await archiver.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, `/tmp/gbrain-${sourceId}-missing`],
      );

      let archiveSettled = false;
      const archiveAttempt = archiveHygieneCandidate(archiver, sourceId)
        .finally(() => { archiveSettled = true; });
      await wait(100);
      expect(archiveSettled).toBe(false);

      releaseWriter.resolve();
      await writerTx;
      const result = await archiveAttempt;
      expect(result.result).toBeNull();
      expect(result.reason).toContain('nonterminal_source_work');

      const rows = await writer.executeRaw<{ archived: boolean }>(
        `SELECT archived FROM sources WHERE id = $1`,
        [sourceId],
      );
      expect(rows[0]?.archived).toBe(false);
    } finally {
      releaseWriter.resolve();
      await writerTx?.catch(() => {});
      await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);

  test('writer for a missing source commits before explicit soft archive', async () => {
    const sourceId = 'archive-missing-writer-explicit-e2e';
    const jobName = 'source-hygiene-missing-source-explicit-e2e';
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    const writerReady = deferred();
    const releaseWriter = deferred();
    let writerTx: Promise<void> | null = null;
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]);
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);

      writerTx = writer.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO minion_jobs (name, status, data)
           VALUES ($1, 'waiting', jsonb_build_object('sourceId', $2::text))`,
          [jobName, sourceId],
        );
        writerReady.resolve();
        await releaseWriter.promise;
      });
      await writerReady.promise;

      await archiver.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, `/tmp/gbrain-${sourceId}-missing`],
      );

      let archiveSettled = false;
      const archiveAttempt = softDeleteSource(archiver, sourceId)
        .finally(() => { archiveSettled = true; });
      await wait(100);
      expect(archiveSettled).toBe(false);

      releaseWriter.resolve();
      await writerTx;
      const result = await archiveAttempt;
      expect(result?.id).toBe(sourceId);

      const rows = await writer.executeRaw<{ archived: boolean }>(
        `SELECT archived FROM sources WHERE id = $1`,
        [sourceId],
      );
      expect(rows[0]?.archived).toBe(true);
    } finally {
      releaseWriter.resolve();
      await writerTx?.catch(() => {});
      await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);

  test('archive holding lifecycle and update locks makes a later path-routed sync job reject', async () => {
    const sourceId = 'archive-archiver-first-e2e';
    const sourcePath = `/tmp/gbrain-${sourceId}-missing`;
    const writer = postgres(process.env.DATABASE_URL!, { max: 1 });
    const archiver = postgres(process.env.DATABASE_URL!, { max: 1 });
    const drainEngine = new PostgresEngine();
    await drainEngine.connect({ database_url: process.env.DATABASE_URL! });
    const releaseArchive = deferred();
    let archiveTx: Promise<void> | null = null;

    try {
      await writer.unsafe(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await writer.unsafe(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, sourcePath],
      );
      const drain = await beginSourceArchiveDrain(drainEngine, sourceId);
      expect(drain).not.toBeNull();

      const archiveReady = deferred();
      archiveTx = archiver.begin(async (tx) => {
        await tx.unsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended('gbrain:source-lifecycle', 0))`,
        );
        await tx.unsafe(
          `SELECT id FROM sources WHERE id = $1 AND archived = false FOR UPDATE`,
          [sourceId],
        );
        await tx.unsafe(
          `UPDATE sources
              SET archived = true, archived_at = now(),
                  archive_expires_at = now() + interval '72 hours',
                  embedding_drain_token = NULL
            WHERE id = $1
              AND embedding_drain_token = $2
              AND embedding_drain_epoch = $3`,
          [sourceId, drain!.token, drain!.epoch],
        );
        archiveReady.resolve();
        await releaseArchive.promise;
      });
      await archiveReady.promise;

      let writerSettled = false;
      const writerAttempt = writer.unsafe(
        `INSERT INTO minion_jobs (name, data)
         VALUES ('sync', jsonb_build_object('repoPath', $1::text))`,
        [sourcePath],
      ).finally(() => { writerSettled = true; });
      await wait(100);
      expect(writerSettled).toBe(false);

      releaseArchive.resolve();
      await archiveTx;
      let writerError: unknown;
      try {
        await writerAttempt;
      } catch (caught) {
        writerError = caught;
      }
      expect(writerError).toBeDefined();
      expect(String(writerError)).toContain('is archived');
      expect(writerSettled).toBe(true);
    } finally {
      releaseArchive.resolve();
      await archiveTx?.catch(() => {});
      await writer.unsafe(
        `DELETE FROM minion_jobs WHERE name = 'sync' AND data->>'repoPath' = $1`,
        [sourcePath],
      ).catch(() => {});
      await writer.unsafe(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([
        writer.end({ timeout: 2 }).catch(() => {}),
        archiver.end({ timeout: 2 }).catch(() => {}),
        drainEngine.disconnect().catch(() => {}),
      ]);
    }
  }, 30_000);

  test('live sync-lock acquisition commits before archive rereads and vetoes', async () => {
    const sourceId = 'archive-sync-lock-first-e2e';
    const lockId = `gbrain-sync:${sourceId}`;
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]);
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, `/tmp/gbrain-${sourceId}-missing`],
      );

      const lockReady = deferred();
      const releaseLockWriter = deferred();
      const lockTx = writer.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO gbrain_cycle_locks
             (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
           VALUES ($1, 2001, 'fixture', now() + interval '5 minutes', now())`,
          [lockId],
        );
        lockReady.resolve();
        await releaseLockWriter.promise;
      });
      await lockReady.promise;

      let archiveSettled = false;
      const archiveAttempt = archiveHygieneCandidate(archiver, sourceId)
        .finally(() => { archiveSettled = true; });
      await wait(100);
      expect(archiveSettled).toBe(false);

      releaseLockWriter.resolve();
      await lockTx;
      const result = await archiveAttempt;
      expect(result.result).toBeNull();
      expect(result.reason).toContain('live_sync_lock');
    } finally {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);

  test('live source-cycle acquisition commits before archive rereads and vetoes', async () => {
    const sourceId = 'archive-cycle-lock-first-e2e';
    const lockId = `gbrain-cycle:${sourceId}`;
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]);
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, `/tmp/gbrain-${sourceId}-missing`],
      );

      const lockReady = deferred();
      const releaseLockWriter = deferred();
      const lockTx = writer.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO gbrain_cycle_locks
             (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
           VALUES ($1, 2003, 'fixture', now() + interval '5 minutes', now())`,
          [lockId],
        );
        lockReady.resolve();
        await releaseLockWriter.promise;
      });
      await lockReady.promise;

      let archiveSettled = false;
      const archiveAttempt = archiveHygieneCandidate(archiver, sourceId)
        .finally(() => { archiveSettled = true; });
      await wait(100);
      expect(archiveSettled).toBe(false);

      releaseLockWriter.resolve();
      await lockTx;
      const result = await archiveAttempt;
      expect(result.result).toBeNull();
      expect(result.reason).toContain('live_cycle_lock');
    } finally {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);

  test('global cycle lock rejects after any source drain commits', async () => {
    const sourceId = 'archive-global-cycle-after-drain-e2e';
    const lockId = 'gbrain-cycle';
    const writer = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]);
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`,
        [sourceId],
      );
      expect(await beginSourceArchiveDrain(writer, sourceId)).not.toBeNull();

      await expect(writer.executeRaw(
        `INSERT INTO gbrain_cycle_locks
           (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
         VALUES ($1, 2004, 'fixture', now() + interval '5 minutes', now())`,
        [lockId],
      )).rejects.toThrow(/global cycle lock.*draining/);
    } finally {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await writer.disconnect();
    }
  }, 30_000);

  test('archive holding the update lock makes a later sync-lock refresh reject', async () => {
    const sourceId = 'archive-sync-refresh-later-e2e';
    const lockId = `gbrain-sync:${sourceId}`;
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]);
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, `/tmp/gbrain-${sourceId}-missing`],
      );
      await writer.executeRaw(
        `INSERT INTO gbrain_cycle_locks
           (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
         VALUES ($1, 2002, 'fixture', now() - interval '5 minutes', now() - interval '5 minutes')`,
        [lockId],
      );
      const drain = await beginSourceArchiveDrain(archiver, sourceId);
      expect(drain).not.toBeNull();

      const archiveReady = deferred();
      const releaseArchive = deferred();
      const archiveTx = archiver.transaction(async (tx) => {
        await tx.executeRaw(
          `SELECT pg_advisory_xact_lock(
             hashtextextended('gbrain:source-lifecycle', 0)
           )`,
        );
        await tx.executeRaw(
          `SELECT id FROM sources WHERE id = $1 AND archived = false FOR UPDATE`,
          [sourceId],
        );
        await tx.executeRaw(
          `UPDATE sources
              SET archived = true, archived_at = now(),
                  archive_expires_at = now() + interval '72 hours',
                  embedding_drain_token = NULL
            WHERE id = $1
              AND embedding_drain_token = $2
              AND embedding_drain_epoch = $3`,
          [sourceId, drain!.token, drain!.epoch],
        );
        archiveReady.resolve();
        await releaseArchive.promise;
      });
      await archiveReady.promise;

      let refreshSettled = false;
      const refreshAttempt = writer.executeRaw(
        `UPDATE gbrain_cycle_locks
            SET ttl_expires_at = now() + interval '5 minutes', last_refreshed_at = now()
          WHERE id = $1`,
        [lockId],
      ).finally(() => { refreshSettled = true; });
      await wait(100);
      expect(refreshSettled).toBe(false);

      releaseArchive.resolve();
      await archiveTx;
      let refreshError: unknown;
      try {
        await refreshAttempt;
      } catch (caught) {
        refreshError = caught;
      }
      expect(refreshError).toBeDefined();
      expect(String(refreshError)).toContain('is archived');
    } finally {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);
});
