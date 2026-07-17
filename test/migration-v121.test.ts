/**
 * Migration v121 — schema-lint hardening (#1647 / #171).
 *
 * The upstream fix used v120; the downstream fork already owns that number,
 * so this backport is intentionally v121.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { SCHEMA_SQL } from '../src/core/schema-embedded.ts';

describe('migration v121 — search_path hardening', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('PGLite trigger functions carry SET search_path after migrations', async () => {
    const rows = await engine.executeRaw<{ proname: string; proconfig: unknown }>(
      `SELECT p.proname, p.proconfig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('bump_page_generation_fn','bump_page_generation_clock_fn','update_page_search_vector')`,
    );
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(JSON.stringify(row.proconfig ?? [])).toContain('search_path=');
    }
  }, 30_000);

  test('re-running migrations after initSchema is idempotent', async () => {
    const result = await runMigrations(engine);
    expect(result.applied).toBe(0);
  }, 30_000);

  test('RLS guards check the active role directly, never inherited membership', () => {
    expect(SCHEMA_SQL).toContain('FROM pg_roles pr WHERE pr.rolname = current_user');
    expect(SCHEMA_SQL).not.toContain("pg_has_role(current_user, pr.oid, 'USAGE')");

    const rlsMigrationSql = MIGRATIONS
      .map(migration => migration.sql)
      .filter(sql => sql.includes('rolbypassrls'))
      .join('\n');
    expect(rlsMigrationSql).toContain('FROM pg_roles pr WHERE pr.rolname = current_user');
    expect(rlsMigrationSql).not.toContain("pg_has_role(current_user, pr.oid, 'USAGE')");
  });

  test('Postgres 15 minimum is checked before the security_invoker option', () => {
    const sql = MIGRATIONS.find((migration) => migration.version === 121)?.sqlFor?.postgres ?? '';
    const versionGate = sql.indexOf("current_setting('server_version_num')::int < 150000");
    const securityInvoker = sql.indexOf('ALTER VIEW IF EXISTS page_links SET (security_invoker = on)');
    expect(versionGate).toBeGreaterThanOrEqual(0);
    expect(securityInvoker).toBeGreaterThan(versionGate);
    expect(sql).toContain('requires PostgreSQL 15+');
  });
});
