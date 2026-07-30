/**
 * E2E JSONB round-trip for cross-engine source migration.
 *
 * PGLite normalizes some stringified JSON values back into objects, so the
 * environment-faithful proof for this bug class needs a real Postgres target.
 *
 * Run: DATABASE_URL=... bun test test/e2e/migrate-source-jsonb.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { softDeleteSourceGuarded } from '../../src/core/destructive-guard.ts';
import { beginSourceArchiveDrain } from '../../src/core/source-embedding-lease.ts';
import {
  copySourceRowsForMigration,
  finalizeArchivedSourceRowsForMigration,
} from '../../src/commands/migrate-engine.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E migrate-source JSONB round-trip test (DATABASE_URL not set)');
}

describeE2E('Postgres migrate-engine source copy config shape', () => {
  let source: PGLiteEngine;

  beforeAll(async () => {
    await setupDB();
    source = new PGLiteEngine();
    await source.connect({});
    await source.initSchema();
  }, 60_000);

  afterAll(async () => {
    await source.disconnect();
    await teardownDB();
  });

  test('copySourceRowsForMigration writes config as an object, not a JSONB string', async () => {
    const target = getEngine();
    const conn = getConn();

    await source.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
         VALUES ('wiki', 'Wiki', '/tmp/wiki', '{"federated": true, "k": "v"}'::jsonb)`,
    );

    await copySourceRowsForMigration(source, target);

    const rows = await conn.unsafe(`
      SELECT
        jsonb_typeof(config) AS jt,
        config->>'federated' AS federated,
        config->>'k' AS k
      FROM sources
      WHERE id = 'wiki'
    `);

    expect(rows).toHaveLength(1);
    expect(rows[0].jt).toBe('object');
    expect(rows[0].federated).toBe('true');
    expect(rows[0].k).toBe('v');
  }, 60_000);

  test('archived PGLite sources stay writable while copying and finish archived in Postgres', async () => {
    const target = getEngine();
    const conn = getConn();
    const sourceId = 'archived-cross-engine';
    const slug = 'projects/archived-cross-engine';

    await source.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, 'Archived Cross Engine', '/tmp/archived-cross-engine', '{}'::jsonb)`,
      [sourceId],
    );
    await source.putPage(slug, {
      type: 'project',
      title: 'Archived Cross Engine',
      compiled_truth: 'Cross-engine migration preserves archived source data.',
      timeline: '',
    }, { sourceId });
    const archive = await softDeleteSourceGuarded(source, sourceId);
    expect(archive.reason).toBe('archived');
    const sourceArchive = await source.executeRaw<{
      archived_at: Date | string | null;
      archive_expires_at: Date | string | null;
    }>(
      `SELECT archived_at, archive_expires_at FROM sources WHERE id = $1`,
      [sourceId],
    );

    await copySourceRowsForMigration(source, target, { stageArchivedAsActive: true });
    await target.putPage(slug, {
      type: 'project',
      title: 'Archived Cross Engine',
      compiled_truth: 'Cross-engine migration preserves archived source data.',
      timeline: '',
    }, { sourceId });
    await finalizeArchivedSourceRowsForMigration(source, target);

    const rows = await conn.unsafe(`
      SELECT s.archived, s.archived_at, s.archive_expires_at, count(p.id)::int AS pages
        FROM sources s
        LEFT JOIN pages p ON p.source_id = s.id
       WHERE s.id = $1
       GROUP BY s.id
    `, [sourceId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].archived).toBe(true);
    expect(new Date(rows[0].archived_at).toISOString()).toBe(
      new Date(sourceArchive[0]!.archived_at!).toISOString(),
    );
    expect(new Date(rows[0].archive_expires_at).toISOString()).toBe(
      new Date(sourceArchive[0]!.archive_expires_at!).toISOString(),
    );
    expect(rows[0].pages).toBe(1);

    await copySourceRowsForMigration(source, target, { stageArchivedAsActive: true });
    expect((await beginSourceArchiveDrain(target, sourceId, 'migration'))?.purpose)
      .toBe('migration');
    await copySourceRowsForMigration(source, target, { stageArchivedAsActive: true });
    const recovered = await conn.unsafe(`
      SELECT archived, embedding_drain_token
        FROM sources
       WHERE id = $1
    `, [sourceId]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].archived).toBe(false);
    expect(recovered[0].embedding_drain_token).toBeNull();
    await finalizeArchivedSourceRowsForMigration(source, target);
  }, 60_000);

  test('rejects a source-side drain before writing that source to Postgres', async () => {
    const target = getEngine();
    const conn = getConn();
    const sourceId = 'draining-cross-engine';
    await source.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, 'Draining Cross Engine', '/tmp/draining-cross-engine', '{}'::jsonb)`,
      [sourceId],
    );
    expect((await beginSourceArchiveDrain(source, sourceId))?.purpose).toBe('manual');

    await expect(
      copySourceRowsForMigration(source, target, { stageArchivedAsActive: true }),
    ).rejects.toThrow(`Cannot migrate while source "${sourceId}" has an active archive drain`);
    const rows = await conn.unsafe('SELECT id FROM sources WHERE id = $1', [sourceId]);
    expect(rows).toHaveLength(0);
  }, 60_000);
});
