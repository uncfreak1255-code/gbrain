import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  finalizeTargetSourceRowsForMigrationCutover,
  withMigrationSourceWriteFence,
  withTargetMigrationSessionLock,
} from '../../src/commands/migrate-engine.ts';
import type { FinalSourceMigrationState } from '../../src/commands/migrate-engine.ts';
import { softDeleteSourceGuarded } from '../../src/core/destructive-guard.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  beginSourceArchiveDrain,
  cancelSourceArchiveDrain,
} from '../../src/core/source-embedding-lease.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

if (!hasDatabase()) {
  console.log('Skipping migrate-engine source-fence concurrency E2E (DATABASE_URL not set)');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describeE2E('migrate-engine source-fence concurrency', () => {
  let migration: PostgresEngine;
  let ordinaryWorker: PostgresEngine;

  beforeAll(async () => {
    migration = await setupDB();
    ordinaryWorker = new PostgresEngine();
    await ordinaryWorker.connect({ database_url: process.env.DATABASE_URL! });
  }, 30_000);

  afterAll(async () => {
    await ordinaryWorker.disconnect();
    await teardownDB();
  });

  test('ordinary child delete waits and rejects without deadlocking the migration writer', async () => {
    const sourceId = 'migration-child-delete-race';
    const slug = 'projects/migration-child-delete-race';
    const sourceOpts = { sourceId };
    await migration.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    await migration.putPage(slug, {
      type: 'project',
      title: 'Migration child delete race',
      compiled_truth: 'The migration owns this target snapshot.',
      timeline: '',
    }, sourceOpts);
    await migration.upsertChunks(slug, [{
      chunk_index: 0,
      chunk_text: 'before migration write',
      chunk_source: 'compiled_truth',
      model: 'test-model',
      token_count: 3,
    }], sourceOpts);
    const drain = await beginSourceArchiveDrain(migration, sourceId, 'migration');
    expect(drain?.purpose).toBe('migration');

    const migrationHasLifecycleLock = deferred();
    const allowMigrationWrite = deferred();
    let migrationSettled = false;
    let ordinarySettled = false;
    const migrationRun = withMigrationSourceWriteFence(migration, sourceId, async (tx) => {
      migrationHasLifecycleLock.resolve();
      await allowMigrationWrite.promise;
      await tx.upsertChunks(slug, [{
        chunk_index: 0,
        chunk_text: 'migration write committed',
        chunk_source: 'compiled_truth',
        model: 'test-model',
        token_count: 3,
      }], sourceOpts);
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { migrationSettled = true; });

    await within(migrationHasLifecycleLock.promise, 5_000, 'migration lifecycle lock');
    const ordinaryRun = ordinaryWorker.executeRaw(
      `DELETE FROM content_chunks
        WHERE page_id = (
          SELECT id FROM pages WHERE source_id = $1 AND slug = $2
        )
          AND chunk_index = 0`,
      [sourceId, slug],
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { ordinarySettled = true; });

    await wait(150);
    expect(migrationSettled).toBe(false);
    expect(ordinarySettled).toBe(false);
    allowMigrationWrite.resolve();

    const [migrationOutcome, ordinaryOutcome] = await within(
      Promise.all([migrationRun, ordinaryRun]),
      10_000,
      'migration/delete race',
    );
    expect(migrationOutcome).toEqual({ ok: true });
    expect(ordinaryOutcome.ok).toBe(false);
    const ordinaryError = String(
      ordinaryOutcome.ok ? '' : ordinaryOutcome.error,
    );
    expect(ordinaryError).toContain(`source ${sourceId} is draining`);
    expect(ordinaryError).not.toContain('deadlock detected');

    expect(await migration.executeRaw(
      `SELECT chunk_text
         FROM content_chunks
        WHERE page_id = (
          SELECT id FROM pages WHERE source_id = $1 AND slug = $2
        )
          AND chunk_index = 0`,
      [sourceId, slug],
    )).toEqual([{ chunk_text: 'migration write committed' }]);
    expect(await cancelSourceArchiveDrain(migration, drain!)).toBe(true);
  }, 30_000);

  test('archived cleanup cannot observe the final lifecycle before cutover commits', async () => {
    const priorSourceId = 'migration-child-delete-race';
    await migration.executeRaw('DELETE FROM pages WHERE source_id = $1', [priorSourceId]);
    await migration.executeRaw('DELETE FROM sources WHERE id = $1', [priorSourceId]);

    const sourceId = 'migration-archived-cutover-race';
    const slug = 'projects/migration-archived-cutover-race';
    const archivedAt = '2026-07-01T12:00:00.000Z';
    const archiveExpiresAt = '2026-08-01T12:00:00.000Z';
    await migration.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    await migration.putPage(slug, {
      type: 'project',
      title: 'Archived cutover race',
      compiled_truth: 'Cleanup must wait until target cutover commits.',
      timeline: '',
    }, { sourceId });

    const defaultDrain = await beginSourceArchiveDrain(migration, 'default', 'migration');
    const archivedDrain = await beginSourceArchiveDrain(migration, sourceId, 'migration');
    expect(defaultDrain?.purpose).toBe('migration');
    expect(archivedDrain?.purpose).toBe('migration');

    const sourceRows: FinalSourceMigrationState[] = [
      {
        id: 'default',
        archived: false,
        archived_at: null,
        archive_expires_at: null,
        embedding_drain_token: null,
      },
      {
        id: sourceId,
        archived: true,
        archived_at: archivedAt,
        archive_expires_at: archiveExpiresAt,
        embedding_drain_token: null,
      },
    ];
    const cutoverHasLifecycleLock = deferred();
    const allowCutoverCommit = deferred();
    let cutoverSettled = false;
    let ordinarySettled = false;

    const cutoverRun = finalizeTargetSourceRowsForMigrationCutover(
      migration,
      sourceRows,
      async () => {
        cutoverHasLifecycleLock.resolve();
        await allowCutoverCommit.promise;
      },
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { cutoverSettled = true; });

    await within(cutoverHasLifecycleLock.promise, 5_000, 'cutover lifecycle lock');
    expect(await ordinaryWorker.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
    }>(
      `SELECT archived, embedding_drain_token
         FROM sources
        WHERE id = $1`,
      [sourceId],
    )).toEqual([{
      archived: false,
      embedding_drain_token: archivedDrain!.token,
    }]);

    const ordinaryRun = ordinaryWorker.executeRaw(
      'DELETE FROM pages WHERE source_id = $1',
      [sourceId],
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { ordinarySettled = true; });

    await wait(150);
    expect(cutoverSettled).toBe(false);
    expect(ordinarySettled).toBe(false);
    allowCutoverCommit.resolve();

    const [cutoverOutcome, ordinaryOutcome] = await within(
      Promise.all([cutoverRun, ordinaryRun]),
      10_000,
      'archived cutover/delete race',
    );
    expect(cutoverOutcome).toEqual({ ok: true });
    expect(ordinaryOutcome).toEqual({ ok: true });
    expect(await migration.executeRaw(
      `SELECT archived, archived_at, archive_expires_at, embedding_drain_token
         FROM sources
        WHERE id = $1`,
      [sourceId],
    )).toEqual([{
      archived: true,
      archived_at: new Date(archivedAt),
      archive_expires_at: new Date(archiveExpiresAt),
      embedding_drain_token: null,
    }]);
    expect(await migration.executeRaw(
      'SELECT COUNT(*)::int AS count FROM pages WHERE source_id = $1',
      [sourceId],
    )).toEqual([{ count: 0 }]);
  }, 30_000);

  test('source deletion rejects a migration drain but permits archived cleanup', async () => {
    const sourceId = 'migration-source-delete-fence';
    await migration.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    await migration.putPage('projects/migration-source-delete-fence', {
      type: 'project',
      title: 'Source delete fence',
      compiled_truth: 'The source registry row owns the whole cascade.',
      timeline: '',
    }, { sourceId });
    const drain = await beginSourceArchiveDrain(migration, sourceId, 'migration');
    expect(drain?.purpose).toBe('migration');

    await expect(ordinaryWorker.executeRaw(
      'DELETE FROM sources WHERE id = $1',
      [sourceId],
    )).rejects.toThrow(`Cannot delete source ${sourceId} while it is draining`);
    expect(await migration.executeRaw(
      'SELECT COUNT(*)::int AS count FROM pages WHERE source_id = $1',
      [sourceId],
    )).toEqual([{ count: 1 }]);

    expect(await cancelSourceArchiveDrain(migration, drain!)).toBe(true);
    expect((await softDeleteSourceGuarded(migration, sourceId)).reason).toBe('archived');
    expect(await migration.executeRaw(
      `SELECT archived, embedding_drain_token
         FROM sources
        WHERE id = $1`,
      [sourceId],
    )).toEqual([{ archived: true, embedding_drain_token: null }]);

    await ordinaryWorker.executeRaw('DELETE FROM sources WHERE id = $1', [sourceId]);
    expect(await migration.executeRaw(
      'SELECT COUNT(*)::int AS count FROM pages WHERE source_id = $1',
      [sourceId],
    )).toEqual([{ count: 0 }]);
  }, 30_000);

  test('nullable page references do not suppress ordinary PostgreSQL deletes', async () => {
    const sourceId = 'migration-nullable-page-delete';
    await migration.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    const inserted = await migration.executeRaw<{ id: number }>(
      `INSERT INTO files (
         source_id, page_id, filename, storage_path, content_hash
       ) VALUES ($1, NULL, 'orphan.txt', 'nullable/orphan.txt', 'nullable-hash')
       RETURNING id`,
      [sourceId],
    );

    await ordinaryWorker.executeRaw('DELETE FROM files WHERE id = $1', [inserted[0]!.id]);

    expect(await migration.executeRaw(
      'SELECT COUNT(*)::int AS count FROM files WHERE id = $1',
      [inserted[0]!.id],
    )).toEqual([{ count: 0 }]);
  }, 30_000);

  test('only one live migrate-engine command can own a target database', async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const firstRun = withTargetMigrationSessionLock(migration, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return 'first-complete';
    });

    await within(firstEntered.promise, 5_000, 'first target migration lock');
    let secondRan = false;
    await expect(withTargetMigrationSessionLock(ordinaryWorker, async () => {
      secondRan = true;
    })).rejects.toThrow('Another migrate-engine command is already writing this target');
    expect(secondRan).toBe(false);

    releaseFirst.resolve();
    await expect(within(firstRun, 5_000, 'first target migration release'))
      .resolves.toBe('first-complete');
    await expect(withTargetMigrationSessionLock(ordinaryWorker, async () => 'next-run'))
      .resolves.toBe('next-run');
  }, 30_000);

  test('dedicated session lock does not consume a poolSize=1 work connection', async () => {
    const singleConnectionWorker = new PostgresEngine();
    await singleConnectionWorker.connect({
      database_url: process.env.DATABASE_URL!,
      poolSize: 1,
    });
    try {
      await expect(within(withTargetMigrationSessionLock(
        singleConnectionWorker,
        async () => {
          await singleConnectionWorker.initSchema();
          return singleConnectionWorker.executeRaw<{ value: number }>(
            'SELECT 1::int AS value',
          );
        },
      ), 15_000, 'poolSize=1 migration session lock')).resolves.toEqual([{ value: 1 }]);
    } finally {
      await singleConnectionWorker.disconnect();
    }
  }, 30_000);
});
