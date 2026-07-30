import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  withMigrationSourceWriteFence,
  withMigrationSourceWriteFences,
} from '../src/commands/migrate-engine.ts';
import { softDeleteSourceGuarded } from '../src/core/destructive-guard.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  beginSourceArchiveDrain,
  cancelSourceArchiveDrain,
} from '../src/core/source-embedding-lease.ts';

describe('draining-source delete guards', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('blocks ordinary parent and child deletes but permits the exact migration transaction', async () => {
    const sourceId = 'delete-fence';
    const slug = 'projects/delete-fence';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    await engine.putPage(slug, {
      type: 'project',
      title: 'Delete fence',
      compiled_truth: 'Migration fencing must cover deletes.',
      timeline: '',
    }, { sourceId });
    await engine.upsertChunks(slug, [{
      chunk_index: 0,
      chunk_text: 'fenced child row',
      chunk_source: 'compiled_truth',
      model: 'test-model',
    }], { sourceId });

    const drain = await beginSourceArchiveDrain(engine, sourceId, 'migration');
    expect(drain?.purpose).toBe('migration');

    await expect(engine.executeRaw(
      `DELETE FROM content_chunks
        WHERE page_id IN (SELECT id FROM pages WHERE source_id = $1)`,
      [sourceId],
    )).rejects.toThrow('page source delete-fence is draining');
    await expect(engine.executeRaw(
      `DELETE FROM pages WHERE source_id = $1`,
      [sourceId],
    )).rejects.toThrow('source delete-fence is draining');
    expect(await engine.executeRaw(
      `SELECT count(*)::int AS count
         FROM content_chunks c
         JOIN pages p ON p.id = c.page_id
        WHERE p.source_id = $1`,
      [sourceId],
    )).toEqual([{ count: 1 }]);
    expect(await engine.executeRaw(
      `SELECT count(*)::int AS count FROM pages WHERE source_id = $1`,
      [sourceId],
    )).toEqual([{ count: 1 }]);

    await withMigrationSourceWriteFence(engine, sourceId, async (tx) => {
      await tx.executeRaw(`DELETE FROM pages WHERE source_id = $1`, [sourceId]);
    });

    expect(await engine.executeRaw(
      `SELECT count(*)::int AS count FROM pages WHERE source_id = $1`,
      [sourceId],
    )).toEqual([{ count: 0 }]);
    expect((await engine.executeRaw<{
      embedding_drain_token: string | null;
      embedding_drain_epoch: number | string;
    }>(
      `SELECT embedding_drain_token, embedding_drain_epoch
         FROM sources
        WHERE id = $1`,
      [sourceId],
    ))[0]).toEqual({
      embedding_drain_token: drain!.token,
      embedding_drain_epoch: drain!.epoch,
    });
  }, 30_000);

  test('allows cleanup after an archive drain is exact-cleared and the source is archived', async () => {
    const sourceId = 'archived-cleanup';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    await engine.putPage('projects/archived-cleanup', {
      type: 'project',
      title: 'Archived cleanup',
      compiled_truth: 'Cleanup is legal after the drain is cleared.',
      timeline: '',
    }, { sourceId });

    const drain = await beginSourceArchiveDrain(engine, sourceId, 'migration');
    expect(drain).not.toBeNull();
    expect(await cancelSourceArchiveDrain(engine, drain!)).toBe(true);
    expect((await softDeleteSourceGuarded(engine, sourceId)).reason).toBe('archived');

    await engine.executeRaw(`DELETE FROM pages WHERE source_id = $1`, [sourceId]);
    expect(await engine.executeRaw(
      `SELECT count(*)::int AS count FROM pages WHERE source_id = $1`,
      [sourceId],
    )).toEqual([{ count: 0 }]);
  }, 30_000);

  test('force-style deletion preserves pages owned by sources outside the exact fence set', async () => {
    const migratedSourceId = 'force-migrated-source';
    const targetOnlySourceId = 'force-target-only-source';
    for (const sourceId of [migratedSourceId, targetOnlySourceId]) {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config)
         VALUES ($1, $1, jsonb_build_object())`,
        [sourceId],
      );
      await engine.putPage(`projects/${sourceId}`, {
        type: 'project',
        title: sourceId,
        compiled_truth: `${sourceId} must keep the correct ownership boundary.`,
        timeline: '',
      }, { sourceId });
    }
    expect((await beginSourceArchiveDrain(engine, migratedSourceId, 'migration'))?.purpose)
      .toBe('migration');

    await withMigrationSourceWriteFences(engine, [migratedSourceId], async (tx) => {
      await tx.executeRaw(
        `DELETE FROM pages WHERE source_id = ANY($1::text[])`,
        [[migratedSourceId]],
      );
    });

    expect(await engine.executeRaw(
      `SELECT source_id FROM pages
        WHERE source_id = ANY($1::text[])
        ORDER BY source_id`,
      [[migratedSourceId, targetOnlySourceId]],
    )).toEqual([{ source_id: targetOnlySourceId }]);
  }, 30_000);
});
