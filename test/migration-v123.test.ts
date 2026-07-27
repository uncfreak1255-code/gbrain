/** Migration v123 — bounded Takes bootstrap records valid no-claim pages. */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, runMigrations } from '../src/core/migrate.ts';

describe('migration v123 — Takes extraction completion watermark', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('adds the watermark column to a v122 brain', async () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 123);
    expect(migration?.name).toBe('pages_takes_extracted_content_hash');

    await engine.executeRaw(`ALTER TABLE pages DROP COLUMN IF EXISTS takes_extracted_content_hash`);
    await engine.setConfig('version', '122');

    const result = await runMigrations(engine);
    expect(result.applied).toBe(
      MIGRATIONS.filter((candidate) => candidate.version > 122).length,
    );

    const columns = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'pages'
          AND column_name = 'takes_extracted_content_hash'`,
    );
    expect(columns).toEqual([{ column_name: 'takes_extracted_content_hash' }]);
  }, 30_000);
});
