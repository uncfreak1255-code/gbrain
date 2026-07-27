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
      expect(String(writerError)).toContain('missing or archived');
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
      expect(String(refreshError)).toContain('missing or archived');
    } finally {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);
});
