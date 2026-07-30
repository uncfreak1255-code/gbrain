/**
 * PGLite forward-reference bootstrap tests.
 *
 * Validates the contract of `PGLiteEngine#applyForwardReferenceBootstrap`:
 * given a brain that lacks the schema-blob's forward-referenced state, the
 * bootstrap adds enough state for PGLITE_SCHEMA_SQL to replay safely.
 *
 * The bootstrap covers the wedge incidents from issues
 * #239/#266/#357/#366/#374/#375/#378/#396 — every gbrain release that added
 * a column-with-index in the schema blob without a corresponding bootstrap
 * triggered the same wedge family.
 *
 * Honest limitation: test 4 simulates a v20 brain by dropping known forward
 * state from a fresh-LATEST instance. This is the same down-mutation pattern
 * codex flagged as "weak simulation" — it can't simulate every possible
 * historical state. Acceptable here because the bootstrap's contract is
 * narrow ("given a brain that lacks the specific forward-references,
 * initSchema produces a brain at LATEST"), and that contract is exactly
 * what this test exercises.
 */

import { describe, test, expect } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';

// Tier 3 opt-out: this file tests the cold init / bootstrap path explicitly.
// If GBRAIN_PGLITE_SNAPSHOT is set (ci:local sets it for unit shards), every
// PGlite would boot post-initSchema and these assertions ("0 tables on fresh
// install", "bootstrap converts pre-v0.18 brain to LATEST") would fail
// trivially. Unset for this file's process.
delete process.env.GBRAIN_PGLITE_SNAPSHOT;

describe('PGLiteEngine#applyForwardReferenceBootstrap', () => {
  test('no-op on fresh install (no pages or links table)', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      // Don't call initSchema — verify bootstrap alone does nothing on empty DB
      await (engine as any).applyForwardReferenceBootstrap();
      const { rows } = await (engine as any).db.query(`
        SELECT COUNT(*)::int AS c FROM information_schema.tables
        WHERE table_schema = 'public'
      `);
      expect(rows[0].c).toBe(0);
    } finally {
      await engine.disconnect();
    }
  }, 30000);

  test('idempotent: calling twice produces same result', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const db = (engine as any).db;

      // Mutate to pre-v0.18 shape: drop source_id and the sources FK target
      await db.exec(`
        ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
        ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);
        DROP INDEX IF EXISTS idx_pages_source_id;
        ALTER TABLE pages DROP COLUMN IF EXISTS source_id;
        DROP TABLE IF EXISTS source_embedding_leases;
        DROP TABLE IF EXISTS sources CASCADE;
      `);

      // First call: applies bootstrap
      await (engine as any).applyForwardReferenceBootstrap();
      // Second call: must not error, must not duplicate state
      await (engine as any).applyForwardReferenceBootstrap();

      const { rows: cols } = await db.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'pages' AND column_name = 'source_id'
      `);
      expect(cols).toHaveLength(1);

      const { rows: src } = await db.query(`SELECT COUNT(*)::int AS c FROM sources`);
      expect(src[0].c).toBe(1); // 'default' seed not duplicated
    } finally {
      await engine.disconnect();
    }
  }, 30000);

  test('no-op on modern brain (source_id and links provenance already present)', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const db = (engine as any).db;

      const before = await db.query(`SELECT COUNT(*)::int AS c FROM sources`);
      await (engine as any).applyForwardReferenceBootstrap();
      const after = await db.query(`SELECT COUNT(*)::int AS c FROM sources`);

      // Bootstrap probe should detect the brain is modern and skip the seed insert
      expect(after.rows[0].c).toBe(before.rows[0].c);
    } finally {
      await engine.disconnect();
    }
  }, 30000);

  test('full path: pre-v0.18 brain reaches LATEST_VERSION via initSchema', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const db = (engine as any).db;

      // Mark the historical version while the current schema is still intact.
      // The down-mutation below removes `sources`; latest-only lifecycle
      // triggers must not run in that intentionally incomplete fixture state.
      await engine.setConfig('version', '20');

      // Mutate to pre-v0.18 shape: strip the forward-referenced state.
      // Match the shape from #399's regression fixture; constraints first
      // (so dropping columns succeeds).
      await db.exec(`
        ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
        ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);
        DROP INDEX IF EXISTS idx_pages_source_id;
        ALTER TABLE pages DROP COLUMN IF EXISTS source_id;
        DROP TABLE IF EXISTS source_embedding_leases;
        DROP TABLE IF EXISTS sources CASCADE;
        ALTER TABLE links DROP CONSTRAINT IF EXISTS links_resolution_type_check;
        ALTER TABLE links DROP COLUMN IF EXISTS resolution_type;
      `);

      // Path under test: bootstrap → SCHEMA_SQL → runMigrations
      await engine.initSchema();

      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

      const { rows: srcCol } = await db.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'pages' AND column_name = 'source_id'
      `);
      expect(srcCol).toHaveLength(1);

      const { rows: defaultSrc } = await db.query(`SELECT id FROM sources WHERE id = 'default'`);
      expect(defaultSrc).toHaveLength(1);

      const { rows: leaseFk } = await db.query(`
        SELECT 1
          FROM pg_constraint constraint_
          JOIN pg_class child ON child.oid = constraint_.conrelid
          JOIN pg_class parent ON parent.oid = constraint_.confrelid
         WHERE constraint_.contype = 'f'
           AND child.relname = 'source_embedding_leases'
           AND parent.relname = 'sources'
      `);
      expect(leaseFk).toHaveLength(1);
    } finally {
      await engine.disconnect();
    }
  }, 30000);

  test('fresh install regression: initSchema on empty DB produces LATEST', async () => {
    // The bootstrap's table-existence probe must not mis-classify "no table"
    // as "pre-v0.18 brain." Without the table-existence guard, the bootstrap
    // would call runMigrations against an empty DB and crash on
    // `relation "config" does not exist`. Regression test for that path.
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

      const db = (engine as any).db;
      const pages = await db.query(`SELECT 1 FROM pages LIMIT 0`);
      const sources = await db.query(`SELECT 1 FROM sources LIMIT 0`);
      const config = await db.query(`SELECT 1 FROM config LIMIT 0`);
      expect(pages).toBeDefined();
      expect(sources).toBeDefined();
      expect(config).toBeDefined();
    } finally {
      await engine.disconnect();
    }
  }, 30000);

  test('pre-v133 sources shape reaches LATEST through schema replay', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const db = (engine as any).db;

      // Recreate the v132 boundary without retaining v133-only triggers that
      // would not exist on a real old brain. Schema replay installs current
      // guards, then migration v133 adds the drain columns before user writes.
      await engine.setConfig('version', '132');
      await db.exec(`
        DROP TRIGGER IF EXISTS source_active_config_guard ON config;
        DROP TRIGGER IF EXISTS source_archive_transition_guard ON sources;
        DROP TABLE IF EXISTS source_embedding_leases;
        ALTER TABLE sources DROP COLUMN IF EXISTS embedding_drain_token;
        ALTER TABLE sources DROP COLUMN IF EXISTS embedding_drain_epoch;
      `);

      await engine.initSchema();

      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      const { rows } = await db.query(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_name = 'sources'
           AND column_name IN ('embedding_drain_token', 'embedding_drain_epoch')
         ORDER BY column_name
      `);
      expect(rows.map((row: { column_name: string }) => row.column_name)).toEqual([
        'embedding_drain_epoch',
        'embedding_drain_token',
      ]);
    } finally {
      await engine.disconnect();
    }
  }, 30000);

  test('v33 archived config backfill survives current lifecycle schema replay', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const db = (engine as any).db;

      await db.exec(`
        INSERT INTO sources (id, name, config)
        VALUES (
          'legacy-archived',
          'legacy-archived',
          '{"archived":true,"archived_at":"2026-01-01T00:00:00Z","archive_expires_at":"2026-01-04T00:00:00Z"}'::jsonb
        );
      `);
      await engine.setConfig('version', '33');
      await db.exec(`
        DROP TRIGGER IF EXISTS source_active_config_guard ON config;
        DROP TRIGGER IF EXISTS source_archive_transition_guard ON sources;
        DROP TABLE IF EXISTS source_embedding_leases;
        ALTER TABLE sources DROP COLUMN IF EXISTS embedding_drain_token;
        ALTER TABLE sources DROP COLUMN IF EXISTS embedding_drain_epoch;
        ALTER TABLE sources DROP COLUMN IF EXISTS archived;
        ALTER TABLE sources DROP COLUMN IF EXISTS archived_at;
        ALTER TABLE sources DROP COLUMN IF EXISTS archive_expires_at;
      `);

      await engine.initSchema();

      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      const { rows } = await db.query(`
        SELECT archived,
               archived_at IS NOT NULL AS has_archived_at,
               archive_expires_at IS NOT NULL AS has_archive_expires_at,
               config ?| ARRAY['archived', 'archived_at', 'archive_expires_at'] AS has_legacy_config
          FROM sources
         WHERE id = 'legacy-archived'
      `);
      expect(rows).toEqual([{
        archived: true,
        has_archived_at: true,
        has_archive_expires_at: true,
        has_legacy_config: false,
      }]);
    } finally {
      await engine.disconnect();
    }
  }, 30000);

  test('pre-v0.13 links shape: bootstrap adds link_source + origin_page_id', async () => {
    // Issues #266 / #357 — pre-v0.13 brains had `links` without
    // `link_source` / `origin_page_id`. Schema blob's
    // `CREATE INDEX idx_links_source` would crash before v11 ran.
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      await engine.initSchema();
      const db = (engine as any).db;

      await db.exec(`
        DROP INDEX IF EXISTS idx_links_source;
        DROP INDEX IF EXISTS idx_links_origin;
        ALTER TABLE links DROP CONSTRAINT IF EXISTS links_from_to_type_source_origin_unique;
        DROP TRIGGER IF EXISTS source_active_page_rehome_f22216da1e39c629 ON links;
        ALTER TABLE links DROP COLUMN IF EXISTS link_source;
        ALTER TABLE links DROP COLUMN IF EXISTS origin_page_id;
      `);

      await (engine as any).applyForwardReferenceBootstrap();

      const { rows: lsCol } = await db.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'links' AND column_name = 'link_source'
      `);
      expect(lsCol).toHaveLength(1);

      const { rows: opCol } = await db.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'links' AND column_name = 'origin_page_id'
      `);
      expect(opCol).toHaveLength(1);
    } finally {
      await engine.disconnect();
    }
  }, 30000);
});
