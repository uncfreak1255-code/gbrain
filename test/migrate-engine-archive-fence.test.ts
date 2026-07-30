import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  copySourceRowsForMigration,
  finalizeTargetSourceRowsForMigrationCutover,
  withMigrationSourceWriteFence,
  withTargetMigrationSessionLock,
} from '../src/commands/migrate-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { softDeleteSourceGuarded } from '../src/core/destructive-guard.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { beginSourceArchiveDrain } from '../src/core/source-embedding-lease.ts';

describe('migrate-engine archived-source fence', () => {
  let source: PGLiteEngine;
  let target: PGLiteEngine;
  let rollbackTarget: PGLiteEngine;

  beforeAll(async () => {
    source = new PGLiteEngine();
    target = new PGLiteEngine();
    rollbackTarget = new PGLiteEngine();
    await source.connect({});
    await source.initSchema();
    await target.connect({});
    await target.initSchema();
    await rollbackTarget.connect({});
    await rollbackTarget.initSchema();
  }, 30_000);

  afterAll(async () => {
    await source.disconnect();
    await target.disconnect();
    await rollbackTarget.disconnect();
  });

  test('keeps ordinary target workers fenced while an archived source is staged for copy', async () => {
    const sourceId = 'archived-copy-fence';
    await source.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    await source.putPage('projects/migration-owned', {
      type: 'project',
      title: 'Migration-owned',
      compiled_truth: 'This row belongs to the source snapshot.',
      timeline: '',
    }, { sourceId });
    expect((await softDeleteSourceGuarded(source, sourceId)).reason).toBe('archived');

    await copySourceRowsForMigration(source, target, { stageArchivedAsActive: true });

    const staged = (await target.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
    }>(
      `SELECT archived, embedding_drain_token
         FROM sources
        WHERE id = $1`,
      [sourceId],
    ))[0];
    expect(staged).toMatchObject({ archived: false });
    expect(staged?.embedding_drain_token).toStartWith('migration:');

    await expect(target.putPage('projects/ordinary-worker', {
      type: 'project',
      title: 'Ordinary worker',
      compiled_truth: 'This target-only mutation must not enter the migration.',
      timeline: '',
    }, { sourceId })).rejects.toThrow('archived or draining');

    expect(await target.executeRaw(
      `SELECT slug
         FROM pages
        WHERE source_id = $1
          AND slug = 'projects/ordinary-worker'`,
      [sourceId],
    )).toEqual([]);
  }, 30_000);

  test('allows migration-owned page writes without changing the persistent fence generation', async () => {
    const sourceId = 'migration-owned-write';
    await source.executeRaw(
      `INSERT INTO sources (id, name, config, archived, archived_at, archive_expires_at)
       VALUES ($1, $1, jsonb_build_object(), TRUE, now(), now() + interval '24 hours')`,
      [sourceId],
    );
    await copySourceRowsForMigration(source, target, { stageArchivedAsActive: true });
    const before = (await target.executeRaw<{
      embedding_drain_token: string;
      embedding_drain_epoch: number | string;
    }>(
      `SELECT embedding_drain_token, embedding_drain_epoch
         FROM sources
        WHERE id = $1`,
      [sourceId],
    ))[0]!;

    await withMigrationSourceWriteFence(target, sourceId, (tx) => tx.putPage(
      'projects/migration-owned-write',
      {
        type: 'project',
        title: 'Migration-owned write',
        compiled_truth: 'Only the migration may write through the durable fence.',
        timeline: '',
      },
      { sourceId },
    ));

    expect(await target.executeRaw(
      `SELECT slug FROM pages WHERE source_id = $1 AND slug = $2`,
      [sourceId, 'projects/migration-owned-write'],
    )).toEqual([{ slug: 'projects/migration-owned-write' }]);
    expect((await target.executeRaw(
      `SELECT embedding_drain_token, embedding_drain_epoch
         FROM sources
        WHERE id = $1`,
      [sourceId],
    ))[0]).toEqual(before);
  }, 30_000);

  test('rolls back an interrupted migration write and preserves its exact fence generation', async () => {
    const sourceId = 'migration-write-rollback';
    await source.executeRaw(
      `INSERT INTO sources (id, name, config, archived, archived_at, archive_expires_at)
       VALUES ($1, $1, jsonb_build_object(), TRUE, now(), now() + interval '24 hours')`,
      [sourceId],
    );
    await copySourceRowsForMigration(source, target, { stageArchivedAsActive: true });
    const before = (await target.executeRaw<{
      embedding_drain_token: string;
      embedding_drain_epoch: number | string;
    }>(
      `SELECT embedding_drain_token, embedding_drain_epoch
         FROM sources
        WHERE id = $1`,
      [sourceId],
    ))[0]!;

    await expect(withMigrationSourceWriteFence(target, sourceId, async (tx) => {
      await tx.putPage('projects/rolled-back', {
        type: 'project',
        title: 'Rolled back',
        compiled_truth: 'This row must not survive the injected interruption.',
        timeline: '',
      }, { sourceId });
      throw new Error('injected migration interruption');
    })).rejects.toThrow('injected migration interruption');

    expect(await target.executeRaw(
      `SELECT slug FROM pages WHERE source_id = $1 AND slug = $2`,
      [sourceId, 'projects/rolled-back'],
    )).toEqual([]);
    expect((await target.executeRaw(
      `SELECT embedding_drain_token, embedding_drain_epoch
         FROM sources
        WHERE id = $1`,
      [sourceId],
    ))[0]).toEqual(before);
  }, 30_000);

  test('retains a newer migration fence generation when staging retries', async () => {
    const sourceId = 'migration-fence-replacement';
    await source.executeRaw(
      `INSERT INTO sources (id, name, config, archived, archived_at, archive_expires_at)
       VALUES ($1, $1, jsonb_build_object(), TRUE, now(), now() + interval '24 hours')`,
      [sourceId],
    );
    await copySourceRowsForMigration(source, target, { stageArchivedAsActive: true });

    const replacementToken = 'migration:test-newer-owner';
    const replacement = (await target.executeRaw<{
      embedding_drain_token: string;
      embedding_drain_epoch: number | string;
    }>(
      `UPDATE sources
          SET embedding_drain_token = $2,
              embedding_drain_epoch = embedding_drain_epoch + 1
        WHERE id = $1
      RETURNING embedding_drain_token, embedding_drain_epoch`,
      [sourceId, replacementToken],
    ))[0]!;

    await copySourceRowsForMigration(source, target, { stageArchivedAsActive: true });

    expect((await target.executeRaw(
      `SELECT embedding_drain_token, embedding_drain_epoch
         FROM sources
        WHERE id = $1`,
      [sourceId],
    ))[0]).toEqual(replacement);
  }, 30_000);

  test('holds and releases the target migration session lock on PGLite', async () => {
    await expect(withTargetMigrationSessionLock(
      rollbackTarget,
      async () => 'pglite-lock-released',
    )).resolves.toBe('pglite-lock-released');
  });

  test('restores the previous config when target commit fails after cutover starts', async () => {
    const drain = await beginSourceArchiveDrain(rollbackTarget, 'default', 'migration');
    expect(drain?.purpose).toBe('migration');

    const commitFailingTarget = new Proxy(rollbackTarget, {
      get(realTarget, prop, receiver) {
        if (prop === 'transaction') {
          return async <T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> =>
            realTarget.transaction(async (tx) => {
              await fn(tx);
              throw new Error('injected target commit failure');
            });
        }
        return Reflect.get(realTarget, prop, receiver);
      },
    }) as unknown as BrainEngine;

    let activeConfig = 'source';
    await expect(finalizeTargetSourceRowsForMigrationCutover(
      commitFailingTarget,
      [{
        id: 'default',
        archived: false,
        archived_at: null,
        archive_expires_at: null,
        embedding_drain_token: null,
      }],
      () => { activeConfig = 'target'; },
      () => { activeConfig = 'source'; },
    )).rejects.toThrow('injected target commit failure');

    expect(activeConfig).toBe('source');
    expect((await rollbackTarget.executeRaw(
      `SELECT archived, embedding_drain_token, embedding_drain_epoch
         FROM sources
        WHERE id = 'default'`,
    ))[0]).toEqual({
      archived: false,
      embedding_drain_token: drain!.token,
      embedding_drain_epoch: drain!.epoch,
    });
  }, 30_000);
});
