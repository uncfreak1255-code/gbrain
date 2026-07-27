/**
 * E2E test for PostgresEngine forward-reference bootstrap.
 *
 * Codex caught that `test/e2e/helpers.ts:74` uses the standalone
 * `db.initSchema()` from `src/core/db.ts`, which only runs SCHEMA_SQL and
 * never calls runMigrations(). A test using that helper would NOT exercise
 * `PostgresEngine.initSchema()`'s reordered path, producing false-positive
 * coverage. This test deliberately bypasses the standard helper and
 * instantiates `PostgresEngine` directly, calling `engine.initSchema()` so
 * the bootstrap → SCHEMA_SQL → runMigrations sequence runs end-to-end.
 *
 * Covers issues #366, #375, #378 — Postgres-side wedges where pre-v0.18
 * brains crashed on `column "source_id" does not exist`.
 *
 * NOTE: snapshot-based historical state simulation is out of scope for this
 * wave (would require maintaining historical schema dumps). The test
 * mutates a fresh-LATEST brain to a pre-v0.18 shape; codex flagged this as
 * approximate. Acceptable here because the bootstrap's contract is narrow:
 * "given a brain that lacks the specific forward-references, initSchema
 * produces a brain at LATEST." The test exercises exactly that contract.
 *
 * Run: DATABASE_URL=postgresql://... bun run test:e2e test/e2e/postgres-bootstrap.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

describe.skipIf(skip)('PostgresEngine forward-reference bootstrap (E2E)', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('PostgresEngine.initSchema applies bootstrap → SCHEMA_SQL → migrations on pre-v0.18 brain', async () => {
    // First call: bring the test DB to LATEST shape so we have something to mutate.
    await engine.initSchema();

    // Clear data from prior tests in the suite. Adding a UNIQUE(slug)
    // constraint below would fail if multi-source fixtures left rows with
    // duplicate slugs across sources (which is valid under the composite
    // UNIQUE this test is undoing).
    const conn = (engine as any).sql;
    await conn.unsafe(`TRUNCATE pages, content_chunks, links, tags, raw_data, timeline_entries, page_versions, ingest_log RESTART IDENTITY CASCADE`);

    // Mutate to pre-v0.18 shape: drop source_id and the sources table.
    // The advisory lock is released between initSchema calls, so this
    // direct DDL won't deadlock.
    await conn.unsafe(`
      ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_source_slug_key;
      ALTER TABLE pages ADD CONSTRAINT pages_slug_key UNIQUE (slug);
      DROP INDEX IF EXISTS idx_pages_source_id;
      ALTER TABLE pages DROP COLUMN IF EXISTS source_id CASCADE;
      DROP TABLE IF EXISTS sources CASCADE;
    `);
    await engine.setConfig('version', '20');

    // The path under test: full PostgresEngine.initSchema() including the
    // bootstrap call, SCHEMA_SQL replay, and runMigrations chain.
    await engine.initSchema();

    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    // Verify the forward-referenced column exists after upgrade.
    const colCheck = await conn`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'pages'
        AND column_name = 'source_id'
    `;
    expect(colCheck).toHaveLength(1);

    // Verify the default source row was seeded.
    const srcCheck = await conn`SELECT id FROM sources WHERE id = 'default'`;
    expect(srcCheck).toHaveLength(1);
  });

  test('PostgresEngine.initSchema is idempotent on a brain already at LATEST', async () => {
    // Fresh-LATEST brain. Calling initSchema again must not error and must
    // not regress the version.
    await engine.initSchema();
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
  });

  // Migration v121 — schema-lint hardening (#1647 / #171). Postgres-only
  // assertions (security_invoker has no surface on embedded PGLite).
  test('v121: page_links view runs with security_invoker=on (#1647b)', async () => {
    await engine.initSchema();
    const rows = await engine.executeRaw<{ reloptions: string[] | null }>(
      `SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'page_links' AND c.relkind = 'v'`,
    );
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0].reloptions ?? [])).toContain('security_invoker=on');
  });

  test('v121: trigger + event-trigger functions pin search_path, incl auto_enable_rls (#1647a/#171)', async () => {
    await engine.initSchema();
    const rows = await engine.executeRaw<{ proname: string; proconfig: unknown }>(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('bump_page_generation_fn','bump_page_generation_clock_fn',
                            'update_chunk_search_vector','update_page_search_vector',
                            'notify_minion_job_change','auto_enable_rls')`,
    );
    expect(rows.map(r => r.proname).sort()).toEqual([
      'auto_enable_rls',
      'bump_page_generation_clock_fn',
      'bump_page_generation_fn',
      'notify_minion_job_change',
      'update_chunk_search_vector',
      'update_page_search_vector',
    ]);
    for (const r of rows) {
      expect(JSON.stringify(r.proconfig ?? [])).toContain('search_path=');
    }
  });

  test('source lifecycle guards pin public ahead of caller-controlled temporary tables', async () => {
    await engine.initSchema();
    const rows = await engine.executeRaw<{ proname: string; proconfig: string[] | null }>(
      `SELECT p.proname, p.proconfig
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
            'enforce_active_source_reference_fn',
            'enforce_active_source_job_status_fn',
            'enforce_active_source_config_fn'
          )
        ORDER BY p.proname`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    }
  });

  test('RLS capability checks do not mistake inherited role membership for BYPASSRLS', async () => {
    await engine.initSchema();
    const suffix = `${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const parent = `gbrain_rls_parent_${suffix}`;
    const member = `gbrain_rls_member_${suffix}`;
    const conn = (engine as any).sql;
    try {
      await conn.unsafe(`CREATE ROLE ${parent} NOLOGIN BYPASSRLS`);
      await conn.unsafe(`CREATE ROLE ${member} NOLOGIN`);
      await conn.unsafe(`GRANT ${parent} TO ${member}`);

      const rows = await engine.executeRaw<{
        direct_bypass: boolean;
        inherited_membership: boolean;
      }>(
        `SELECT (pr.rolbypassrls OR pr.rolsuper) AS direct_bypass,
                pg_has_role($1::name, $2::name, 'USAGE') AS inherited_membership
           FROM pg_roles pr
          WHERE pr.rolname = $1`,
        [member, parent],
      );
      expect(rows).toEqual([{ direct_bypass: false, inherited_membership: true }]);

    } finally {
      await conn.unsafe(`DROP ROLE IF EXISTS ${member}`);
      await conn.unsafe(`DROP ROLE IF EXISTS ${parent}`);
    }
  });
});
