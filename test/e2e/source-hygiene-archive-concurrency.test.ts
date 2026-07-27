/**
 * Real-Postgres proof for the source archive/write lock protocol.
 *
 * PGLite proves trigger behavior, but it cannot prove two independent
 * transactions block in the required order. These cases pin both directions:
 * an existing writer makes archive wait and then veto; an archive already in
 * progress makes a later writer wait and then reject the archived source.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { archiveHygieneCandidate } from '../../src/commands/sources.ts';
import { softDeleteSource } from '../../src/core/destructive-guard.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

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

  test('archive holding the update lock commits before a later writer rereads and rejects', async () => {
    const sourceId = 'archive-archiver-first-e2e';
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, `/tmp/gbrain-${sourceId}-missing`],
      );

      const archiveReady = deferred();
      const releaseArchive = deferred();
      const archiveTx = archiver.transaction(async (tx) => {
        await tx.executeRaw(
          `SELECT id FROM sources WHERE id = $1 AND archived = false FOR UPDATE`,
          [sourceId],
        );
        await tx.executeRaw(
          `UPDATE sources
              SET archived = true, archived_at = now(),
                  archive_expires_at = now() + interval '72 hours'
            WHERE id = $1`,
          [sourceId],
        );
        archiveReady.resolve();
        await releaseArchive.promise;
      });
      await archiveReady.promise;

      let writerSettled = false;
      const writerAttempt = writer.executeRaw(
        `INSERT INTO minion_jobs (name, data)
         VALUES ('source-hygiene-e2e', jsonb_build_object('source_id', $1::text))`,
        [sourceId],
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
    } finally {
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
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

      const archiveReady = deferred();
      const releaseArchive = deferred();
      const archiveTx = archiver.transaction(async (tx) => {
        await tx.executeRaw(
          `SELECT id FROM sources WHERE id = $1 AND archived = false FOR UPDATE`,
          [sourceId],
        );
        await tx.executeRaw(
          `UPDATE sources
              SET archived = true, archived_at = now(),
                  archive_expires_at = now() + interval '72 hours'
            WHERE id = $1`,
          [sourceId],
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
