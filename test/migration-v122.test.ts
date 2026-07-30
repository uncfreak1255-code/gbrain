/** Migration v122 — file identity matches the source-scoped reader contract. */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, runMigrations } from '../src/core/migrate.ts';

describe('migration v122 — source-scoped file identity', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('upgrades the legacy global path constraint and permits same-path sources', async () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 122);
    expect(migration?.name).toBe('files_source_storage_path_unique');

    await engine.executeRaw(`ALTER TABLE files DROP CONSTRAINT IF EXISTS files_source_storage_path_key`);
    await engine.executeRaw(`ALTER TABLE files ADD CONSTRAINT files_storage_path_key UNIQUE (storage_path)`);
    await engine.setConfig('version', '121');

    const result = await runMigrations(engine);
    expect(result.applied).toBe(
      MIGRATIONS.filter((candidate) => candidate.version > 121).length,
    );

    const constraints = await engine.executeRaw<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'files'::regclass AND contype = 'u'`,
    );
    expect(constraints.map((row) => row.conname)).toContain('files_source_storage_path_key');
    expect(constraints.map((row) => row.conname)).not.toContain('files_storage_path_key');

    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING`,
    );
    await engine.upsertFile({
      filename: 'same.png',
      storage_path: 'photos/same.png',
      content_hash: 'sha256:default',
    });
    await engine.upsertFile({
      source_id: 'source-b',
      filename: 'same.png',
      storage_path: 'photos/same.png',
      content_hash: 'sha256:source-b',
    });

    const rows = await engine.executeRaw<{ source_id: string; content_hash: string }>(
      `SELECT source_id, content_hash FROM files
        WHERE storage_path = 'photos/same.png' ORDER BY source_id`,
    );
    expect(rows).toEqual([
      { source_id: 'default', content_hash: 'sha256:default' },
      { source_id: 'source-b', content_hash: 'sha256:source-b' },
    ]);
  }, 30_000);
});
