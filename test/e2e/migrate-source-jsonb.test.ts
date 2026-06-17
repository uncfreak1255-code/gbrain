/**
 * E2E JSONB round-trip for cross-engine source migration.
 *
 * copySourceRowsForMigration (src/commands/migrate-engine.ts) copies the
 * `sources` table into the target engine during `gbrain migrate`. The config
 * column is JSONB. Pre-fix, the copy bound `JSON.stringify(config)` (a string)
 * to the `$N::jsonb` cast; on a Postgres target postgres.js double-encodes it,
 * storing a JSONB STRING literal instead of an OBJECT — so `config->>'key'`
 * returns NULL on every migrated source. PGLite normalizes the stringified
 * value back to an object, which is why the pure-PGLite unit test passed while
 * real Postgres-backed brains silently lost source config on migration.
 *
 * This test runs the actual copy with a REAL Postgres target and asserts the
 * migrated config is a real JSONB object (jsonb_typeof='object', keys readable
 * via ->>'key'), not a double-encoded string literal. It is the
 * environment-faithful regression: it cannot be masked by PGLite. The
 * driver-faithful unit assertion (no DB required) lives in
 * test/migrate-engine-source-copy.test.ts.
 *
 * Run: DATABASE_URL=... bun test test/e2e/migrate-source-jsonb.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { copySourceRowsForMigration } from '../../src/commands/migrate-engine.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E migrate-source JSONB round-trip test (DATABASE_URL not set)');
}

describeE2E('Postgres migrate-engine source copy — config stays a JSONB object', () => {
  let source: PGLiteEngine;

  beforeAll(async () => {
    await setupDB();
    source = new PGLiteEngine();
    await source.connect({});
    await source.initSchema();
  });

  afterAll(async () => {
    await source.disconnect();
    await teardownDB();
  });

  test('copySourceRowsForMigration writes config as object, not a double-encoded string', async () => {
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
        config->>'k'         AS k
      FROM sources
      WHERE id = 'wiki'
    `);

    expect(rows).toHaveLength(1);
    // The bug stores config as jsonb_typeof='string'; the fix keeps it 'object'.
    expect(rows[0].jt).toBe('object');
    expect(rows[0].federated).toBe('true');
    expect(rows[0].k).toBe('v');
  }, 60_000);
});
