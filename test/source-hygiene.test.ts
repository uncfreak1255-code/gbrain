import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { archiveHygieneCandidate } from '../src/commands/sources.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

import {
  classifySourceHygieneEvidence,
  gateProtectedSourceWork,
  inspectSourceHygiene,
  validateSourceRepoState,
  type SourceHygieneEvidence,
} from '../src/core/source-hygiene.ts';

function evidence(overrides: Partial<SourceHygieneEvidence> = {}): SourceHygieneEvidence {
  return {
    source_id: 'archive-me',
    archived: false,
    has_local_path: true,
    shared_path_source_count: 1,
    repo_state: 'missing',
    source_config_known: true,
    remote_recovery_configured: false,
    managed_clone: false,
    configured_default: false,
    configured_default_known: true,
    dependent_row_count: 0,
    dependent_data_known: true,
    nonterminal_work_count: 0,
    work_state_known: true,
    live_sync_lock: false,
    lock_state_known: true,
    ...overrides,
  };
}

describe('classifySourceHygieneEvidence', () => {
  test('classifies a usable checkout as healthy', () => {
    const decision = classifySourceHygieneEvidence(evidence({ repo_state: 'healthy' }));

    expect(decision.classification).toBe('healthy');
    expect(decision.safe_for_agent_review).toBe(true);
    expect(decision.proposed_command_argv).toBeNull();
  });

  test('allows only a fully-proven empty non-default missing source to become an archive candidate', () => {
    const decision = classifySourceHygieneEvidence(evidence());

    expect(decision.classification).toBe('archive_candidate');
    expect(decision.safe_for_agent_review).toBe(true);
    expect(decision.proposed_command_argv).toEqual([
      'gbrain', 'sources', 'archive', 'archive-me', '--if-hygiene-candidate',
    ]);
    expect(decision.veto_reasons).toEqual([]);
  });

  test('protects default and every populated missing-path source', () => {
    const defaultDecision = classifySourceHygieneEvidence(evidence({ source_id: 'default' }));
    const populatedDecision = classifySourceHygieneEvidence(evidence({ dependent_row_count: 2 }));

    expect(defaultDecision.classification).toBe('recovery_required');
    expect(defaultDecision.veto_reasons).toContain('default_source');
    expect(populatedDecision.classification).toBe('recovery_required');
    expect(populatedDecision.veto_reasons).toContain('source_has_dependent_data');
    expect(populatedDecision.proposed_command_argv).toBeNull();
  });

  test('fails closed on configured-default references, nonterminal work, live locks, and unknown evidence', () => {
    const cases: Array<[Partial<SourceHygieneEvidence>, string]> = [
      [{ configured_default: true }, 'configured_default_source'],
      [{ source_config_known: false }, 'source_config_unknown'],
      [{ configured_default_known: false }, 'configured_default_unknown'],
      [{ nonterminal_work_count: 1 }, 'nonterminal_source_work'],
      [{ live_sync_lock: true }, 'live_sync_lock'],
      [{ dependent_data_known: false, dependent_row_count: null }, 'dependent_data_unknown'],
      [{ work_state_known: false, nonterminal_work_count: null }, 'source_work_unknown'],
      [{ lock_state_known: false, live_sync_lock: null }, 'sync_lock_unknown'],
    ];

    for (const [overrides, veto] of cases) {
      const decision = classifySourceHygieneEvidence(evidence(overrides));
      expect(decision.classification).toBe('recovery_required');
      expect(decision.safe_for_agent_review).toBe(false);
      expect(decision.veto_reasons).toContain(veto);
    }
  });

  test('distinguishes a managed recoverable clone from a user-owned missing path', () => {
    const managed = classifySourceHygieneEvidence(evidence({
      source_id: 'managed',
      remote_recovery_configured: true,
      managed_clone: true,
    }));
    const userOwned = classifySourceHygieneEvidence(evidence({
      source_id: 'user-owned',
      remote_recovery_configured: true,
      managed_clone: false,
    }));

    expect(managed.classification).toBe('recovery_required');
    expect(managed.recovery_mode).toBe('managed_clone_sync');
    expect(managed.proposed_command_argv).toEqual([
      'gbrain', 'sync', '--source', 'managed',
    ]);
    expect(userOwned.classification).toBe('recovery_required');
    expect(userOwned.recovery_mode).toBe('manual');
    expect(userOwned.proposed_command_argv).toBeNull();
  });

  test('treats archived, DB-only, and uninspected filesystem sources as not applicable without a false all-clear', () => {
    const archived = classifySourceHygieneEvidence(evidence({ archived: true }));
    const dbOnly = classifySourceHygieneEvidence(evidence({
      has_local_path: false,
      repo_state: 'not_applicable',
    }));
    const uninspected = classifySourceHygieneEvidence(evidence({ repo_state: 'not_inspected' }));

    expect(archived).toMatchObject({ classification: 'not_applicable', safe_for_agent_review: true });
    expect(dbOnly).toMatchObject({ classification: 'not_applicable', safe_for_agent_review: true });
    expect(uninspected).toMatchObject({ classification: 'not_applicable', safe_for_agent_review: false });
    expect(uninspected.veto_reasons).toContain('filesystem_not_inspected');
  });
});

describe('gateProtectedSourceWork', () => {
  test('blocks a healthy target while any neighboring source needs recovery', () => {
    const healthy = classifySourceHygieneEvidence(evidence({
      source_id: 'healthy-target',
      repo_state: 'healthy',
    }));
    const brokenNeighbor = classifySourceHygieneEvidence(evidence({
      source_id: 'broken-neighbor',
      dependent_row_count: 1,
    }));

    expect(gateProtectedSourceWork({
      schema_version: 1,
      filesystem_inspected: true,
      sources: [healthy, brokenNeighbor],
    }, 'healthy-target')).toEqual({
      allowed: false,
      reason: 'brain_recovery_required',
    });
  });

  test('allows only a known healthy target when no source needs recovery', () => {
    const healthy = classifySourceHygieneEvidence(evidence({
      source_id: 'healthy-target',
      repo_state: 'healthy',
    }));
    const packet = { schema_version: 1 as const, filesystem_inspected: true, sources: [healthy] };

    expect(gateProtectedSourceWork(packet, 'healthy-target')).toEqual({ allowed: true, reason: null });
    expect(gateProtectedSourceWork(packet, 'missing-target')).toEqual({
      allowed: false,
      reason: 'unknown_source',
    });
  });

  test('allows an active DB-only target when no source needs recovery', () => {
    const dbOnly = classifySourceHygieneEvidence(evidence({
      source_id: 'db-only',
      has_local_path: false,
      repo_state: 'not_applicable',
    }));
    const packet = { schema_version: 1 as const, filesystem_inspected: true, sources: [dbOnly] };

    expect(gateProtectedSourceWork(packet, 'db-only')).toEqual({ allowed: true, reason: null });
  });
});

describe('inspectSourceHygiene', () => {
  test('remote/no-filesystem mode never invokes path or lock probes and returns privacy-safe evidence', async () => {
    let pathProbeCalls = 0;
    let lockProbeCalls = 0;
    const engine = makeEngine([
      sourceRow('default', '/private/owner/default-brain', false),
      sourceRow('archived-one', '/private/owner/archived', true),
      sourceRow('db-only', null, false),
    ]);

    const packet = await inspectSourceHygiene(engine as never, {
      inspectFilesystem: false,
      probes: {
        repoState: () => { pathProbeCalls++; return 'healthy'; },
        liveSyncLock: async () => { lockProbeCalls++; return false; },
      },
    });

    expect(pathProbeCalls).toBe(0);
    expect(lockProbeCalls).toBe(0);
    expect(packet.schema_version).toBe(1);
    expect(packet.filesystem_inspected).toBe(false);
    expect(packet.sources.find((s) => s.source_id === 'default')).toMatchObject({
      classification: 'not_applicable',
      safe_for_agent_review: false,
      repo_state: 'not_inspected',
    });
    expect(packet.sources.find((s) => s.source_id === 'archived-one')?.classification).toBe('not_applicable');
    expect(packet.sources.find((s) => s.source_id === 'db-only')?.classification).toBe('not_applicable');
    expect(JSON.stringify(packet)).not.toContain('/private/owner');
    expect(packet.sources.every((s) => !('local_path' in s))).toBe(true);
  });

  test('trusted-local inspection classifies shared missing paths independently and remains read-only', async () => {
    const rows = [
      sourceRow('default', '/fixture/shared-missing', false),
      sourceRow('empty-duplicate', '/fixture/shared-missing', false),
    ];
    const engine = makeEngine(rows, {
      configuredDefault: 'default',
      dependentCounts: { default: 443 },
    });

    const packet = await inspectSourceHygiene(engine as never, {
      inspectFilesystem: true,
      probes: {
        repoState: () => 'missing',
        liveSyncLock: async () => false,
      },
    });

    const protectedDefault = packet.sources.find((s) => s.source_id === 'default')!;
    const emptyDuplicate = packet.sources.find((s) => s.source_id === 'empty-duplicate')!;
    expect(protectedDefault).toMatchObject({
      classification: 'recovery_required',
      dependent_row_count: 443,
      shared_path_source_count: 2,
    });
    expect(emptyDuplicate).toMatchObject({
      classification: 'archive_candidate',
      dependent_row_count: 0,
      shared_path_source_count: 2,
      safe_for_agent_review: true,
    });
    expect(engine.mutationCount).toBe(0);
  });

  test('unknown nonterminal work and lock reads fail closed', async () => {
    const engine = makeEngine([sourceRow('uncertain', '/fixture/missing', false)], {
      failWorkRead: true,
    });

    const packet = await inspectSourceHygiene(engine as never, {
      inspectFilesystem: true,
      probes: {
        repoState: () => 'missing',
        liveSyncLock: async () => { throw new Error('lock table unavailable'); },
      },
    });

    expect(packet.sources[0]).toMatchObject({
      classification: 'recovery_required',
      work_state_known: false,
      lock_state_known: false,
      safe_for_agent_review: false,
    });
  });

  test('legacy sync.repo_path protects its sole configured source from archive', async () => {
    const engine = makeEngine([sourceRow('legacy-source', '/fixture/missing', false)], {
      syncRepoPath: '/fixture/missing',
    });

    const packet = await inspectSourceHygiene(engine as never, {
      inspectFilesystem: true,
      probes: {
        repoState: () => 'missing',
        liveSyncLock: async () => false,
      },
    });

    expect(packet.sources[0]).toMatchObject({
      classification: 'recovery_required',
      configured_default: true,
    });
    expect(packet.sources[0]?.veto_reasons).toContain('configured_default_source');
  });

  test('malformed source config cannot become an archive candidate', async () => {
    const row = sourceRow('uncertain-config', '/fixture/missing', false);
    row.config = '{not-json';
    const engine = makeEngine([row]);

    const packet = await inspectSourceHygiene(engine as never, {
      inspectFilesystem: true,
      probes: {
        repoState: () => 'missing',
        liveSyncLock: async () => false,
      },
    });

    expect(packet.sources[0]).toMatchObject({
      classification: 'recovery_required',
      source_config_known: false,
      safe_for_agent_review: false,
    });
    expect(packet.sources[0]?.veto_reasons).toContain('source_config_unknown');
  });

  test('vetoes active scalar and array source bindings outside source_id columns', async () => {
    const engine = makeEngine([
      sourceRow('scalar-binding', '/fixture/scalar-missing', false),
      sourceRow('array-binding', '/fixture/array-missing', false),
      sourceRow('eval-array-binding', '/fixture/eval-array-missing', false),
    ], {
      boundSourceCounts: { 'scalar-binding': 1 },
      federatedReadCounts: { 'array-binding': 1 },
      sourceIdArrayCounts: { 'eval-array-binding': 1 },
    });

    const packet = await inspectSourceHygiene(engine as never, {
      inspectFilesystem: true,
      probes: {
        repoState: () => 'missing',
        liveSyncLock: async () => false,
      },
    });

    for (const sourceId of [
      'scalar-binding',
      'array-binding',
      'eval-array-binding',
    ]) {
      expect(packet.sources.find((source) => source.source_id === sourceId)).toMatchObject({
        classification: 'recovery_required',
        dependent_data_known: true,
        dependent_row_count: 1,
      });
    }
  });
});

describe('validateSourceRepoState', () => {
  test('accepts a private local Git recovery repo without an origin remote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-source-hygiene-local-git-'));
    try {
      execFileSync('git', ['init', '--quiet', dir]);
      expect(validateSourceRepoState(dir)).toBe('healthy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lets Git validate a linked worktree whose .git marker is a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-source-hygiene-worktree-'));
    const repo = join(root, 'repo');
    const worktree = join(root, 'linked');
    try {
      execFileSync('git', ['init', '--quiet', repo]);
      execFileSync('git', [
        '-C', repo,
        '-c', 'user.name=GBrain Test',
        '-c', 'user.email=gbrain-test@example.invalid',
        'commit', '--quiet', '--allow-empty', '-m', 'fixture',
      ]);
      execFileSync('git', ['-C', repo, 'worktree', 'add', '--quiet', '--detach', worktree]);

      expect(lstatSync(join(worktree, '.git')).isFile()).toBe(true);
      expect(validateSourceRepoState(worktree)).toBe('healthy');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('archive hygiene execution gate', () => {
  let db: PGLiteEngine;

  beforeAll(async () => {
    db = new PGLiteEngine();
    await db.connect({});
    await db.initSchema();
  });

  beforeEach(async () => {
    await resetPgliteState(db);
  });

  afterAll(async () => {
    await db.disconnect();
  });

  test('rereads the complete predicate inside the archive transaction', async () => {
    const missingPath = join(tmpdir(), `gbrain-archive-race-${Date.now()}`);
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('archive-race', 'archive-race', $1, '{}'::jsonb)`,
      [missingPath],
    );

    const before = await inspectSourceHygiene(db, { inspectFilesystem: true });
    expect(before.sources.find((source) => source.source_id === 'archive-race')?.classification)
      .toBe('archive_candidate');

    await db.putPage(
      'notes/appeared-late',
      { type: 'note', title: 'Appeared late', compiled_truth: 'veto archive' },
      { sourceId: 'archive-race' },
    );
    const blocked = await archiveHygieneCandidate(db, 'archive-race');
    expect(blocked.result).toBeNull();
    expect(blocked.reason).toContain('source_has_dependent_data');
    const rows = await db.executeRaw<{ archived: boolean }>(
      `SELECT archived FROM sources WHERE id = 'archive-race'`,
    );
    expect(rows[0]?.archived).toBe(false);
  });

  test('archives a still-empty candidate while preserving terminal receipts and derived rollups', async () => {
    const missingPath = join(tmpdir(), `gbrain-archive-empty-${Date.now()}`);
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('archive-empty', 'archive-empty', $1, '{}'::jsonb)`,
      [missingPath],
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES
         ('historical-complete', 'completed', '{"sourceId":"archive-empty"}'::jsonb),
         ('historical-dead', 'dead', '{"source_id":"archive-empty"}'::jsonb),
         ('historical-failed', 'failed', '{"sourceId":"archive-empty"}'::jsonb)`,
    );
    await db.executeRaw(
      `INSERT INTO extract_rollup_7d (kind, source_id, day)
       VALUES ('extract', 'archive-empty', CURRENT_DATE)`,
    );

    const archived = await archiveHygieneCandidate(db, 'archive-empty');
    expect(archived.result?.id).toBe('archive-empty');
    expect(archived.reason).toBe('archived');
    const receipts = await db.executeRaw<{ jobs: number; rollups: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM minion_jobs
           WHERE data->>'sourceId' = 'archive-empty'
              OR data->>'source_id' = 'archive-empty') AS jobs,
         (SELECT COUNT(*)::int FROM extract_rollup_7d
           WHERE source_id = 'archive-empty') AS rollups`,
    );
    expect(receipts[0]).toEqual({ jobs: 3, rollups: 1 });

    for (const name of ['historical-dead', 'historical-failed']) {
      let retryError: unknown;
      try {
        await db.executeRaw(
          `UPDATE minion_jobs SET status = 'waiting' WHERE name = $1`,
          [name],
        );
      } catch (caught) {
        retryError = caught;
      }
      expect(String(retryError)).toContain('is archived');
    }
    const terminal = await db.executeRaw<{ name: string; status: string }>(
      `SELECT name, status FROM minion_jobs
        WHERE name IN ('historical-dead', 'historical-failed')
        ORDER BY name`,
    );
    expect(terminal).toEqual([
      { name: 'historical-dead', status: 'dead' },
      { name: 'historical-failed', status: 'failed' },
    ]);
  });

  test('migration v124 guards every source-reference shape at the database boundary', async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 124);
    expect(migration?.name).toBe('active_source_reference_write_guard');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain('FOR SHARE');
    expect(migration?.sql).toContain("('oauth_clients', 'bound_source_id', 'scalar'");
    expect(migration?.sql).toContain("('oauth_clients', 'federated_read', 'array'");
    expect(migration?.sql).toContain("('eval_candidates', 'source_ids', 'array'");
    expect(migration?.sql).toContain("('minion_jobs', 'data', 'json_source_keys'");
    expect(migration?.sql).toContain("('gbrain_cycle_locks', 'id', 'sync_lock_id'");
    expect(migration?.sql).toContain('BEFORE INSERT OR UPDATE ON %I');
    expect(migration?.sql).toContain('source_active_config_guard');

    const uncovered = await db.executeRaw<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables tables_
           ON tables_.table_schema = c.table_schema
          AND tables_.table_name = c.table_name
         LEFT JOIN pg_class class_ ON class_.relname = c.table_name
         LEFT JOIN pg_namespace namespace_ ON namespace_.oid = class_.relnamespace
                                         AND namespace_.nspname = c.table_schema
         LEFT JOIN pg_trigger trigger_ ON trigger_.tgrelid = class_.oid
                                      AND trigger_.tgname = 'source_active_ref_guard'
                                      AND NOT trigger_.tgisinternal
        WHERE c.table_schema = 'public'
          AND tables_.table_type = 'BASE TABLE'
          AND c.column_name = 'source_id'
          AND trigger_.oid IS NULL
        ORDER BY c.table_name`,
    );
    expect(uncovered).toEqual([]);

    const missingPath = join(tmpdir(), `gbrain-guard-archived-${Date.now()}`);
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived)
       VALUES
         ('guard-active', 'guard-active', '/fixture/guard-active', '{}'::jsonb, false),
         ('guard-archived', 'guard-archived', $1, '{}'::jsonb, true)`,
      [missingPath],
    );

    // Missing registry rows are a supported legacy shape only on tables whose
    // source references are not protected by a foreign key. The trigger keeps
    // those rows compatible while FK-bound tables such as pages remain strict.
    await db.executeRaw(
      `INSERT INTO eval_candidates
         (tool_name, query, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
       VALUES ('query', 'missing guard', ARRAY['guard-missing'], false, false, 1, false)`,
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, data)
       VALUES ('guard-missing-job', '{"sourceId":"guard-missing"}'::jsonb)`,
    );
    await db.executeRaw(
      `INSERT INTO config (key, value) VALUES ('sources.default', 'guard-missing')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    await db.executeRaw(
      `INSERT INTO gbrain_cycle_locks
         (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
       VALUES ('gbrain-sync:guard-missing', 1000, 'fixture', now() + interval '5 minutes', now())`,
    );

    // Each non-canonical shape accepts an active source.
    await db.executeRaw(
      `INSERT INTO oauth_clients
         (client_id, client_name, bound_source_id, federated_read)
       VALUES ('guard-active-client', 'guard-active-client', 'guard-active', ARRAY['guard-active'])`,
    );
    await db.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES ('guard-active', 'active/page', 'note', 'Active', 'active')`,
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, data)
       VALUES ('guard-active-job', '{"sourceId":"guard-active"}'::jsonb)`,
    );
    await db.executeRaw(
      `INSERT INTO config (key, value) VALUES ('sources.default', 'guard-active')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    await db.executeRaw(
      `INSERT INTO gbrain_cycle_locks
         (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
       VALUES ('gbrain-sync:guard-active', 1001, 'fixture', now() + interval '5 minutes', now())`,
    );
    await db.executeRaw(
      `UPDATE gbrain_cycle_locks
          SET ttl_expires_at = now() + interval '10 minutes', last_refreshed_at = now()
        WHERE id = 'gbrain-sync:guard-active'`,
    );
    await db.executeRaw(
      `INSERT INTO gbrain_cycle_locks
         (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
       VALUES ('gbrain-cycle', 1002, 'fixture', now() + interval '5 minutes', now())`,
    );

    const rejectArchived = async (sql: string, params: unknown[] = []) => {
      let error: unknown;
      try {
        await db.executeRaw(sql, params);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(String(error)).toContain('is archived');
    };

    await rejectArchived(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES ('guard-archived', 'blocked/page', 'note', 'Blocked', 'blocked')`,
    );
    await rejectArchived(
      `INSERT INTO oauth_clients (client_id, client_name, bound_source_id)
       VALUES ('guard-bound-client', 'guard-bound-client', 'guard-archived')`,
    );
    await rejectArchived(
      `INSERT INTO oauth_clients (client_id, client_name, federated_read)
       VALUES ('guard-federated-client', 'guard-federated-client', ARRAY['guard-archived'])`,
    );
    await rejectArchived(
      `INSERT INTO eval_candidates
         (tool_name, query, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
       VALUES ('query', 'guard', ARRAY['guard-archived'], false, false, 1, false)`,
    );
    await rejectArchived(
      `INSERT INTO minion_jobs (name, data)
       VALUES ('guard-archived-job', '{"source_id":"guard-archived"}'::jsonb)`,
    );
    await rejectArchived(
      `INSERT INTO gbrain_cycle_locks
         (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
       VALUES ('gbrain-sync:guard-archived', 1003, 'fixture', now() + interval '5 minutes', now())`,
    );
    await rejectArchived(
      `INSERT INTO config (key, value) VALUES ('sources.default', 'guard-archived')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );

    let pathError: unknown;
    try {
      await db.executeRaw(
        `INSERT INTO config (key, value) VALUES ('sync.repo_path', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [missingPath],
      );
    } catch (caught) {
      pathError = caught;
    }
    expect(pathError).toBeDefined();
    expect(String(pathError)).toContain('matching source is archived');

    await db.executeRaw(`UPDATE sources SET archived = true WHERE id = 'guard-active'`);
    await rejectArchived(
      `UPDATE pages SET title = 'Blocked mutation'
        WHERE source_id = 'guard-active' AND slug = 'active/page'`,
    );
    await rejectArchived(
      `UPDATE oauth_clients SET client_name = 'Blocked mutation'
        WHERE client_id = 'guard-active-client'`,
    );
    await rejectArchived(
      `UPDATE gbrain_cycle_locks
          SET ttl_expires_at = now() + interval '15 minutes', last_refreshed_at = now()
        WHERE id = 'gbrain-sync:guard-active'`,
    );
  });

  test('migration v128 rechecks every update to source-owned rows', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 128);
    expect(migration?.name).toBe('archived_source_owned_row_guard');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain(
      'CREATE TRIGGER source_active_ref_guard BEFORE INSERT OR UPDATE ON %I',
    );
    expect(migration?.sql).not.toContain('UPDATE OF %I');
  });

  test('migration v129 keeps missing source identifiers compatible while locking known rows', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 129);
    expect(migration?.name).toBe('archived_source_missing_reference_compatibility');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain('SELECT archived INTO source_archived');
    expect(migration?.sql).toContain('IF FOUND AND source_archived THEN');
    expect(migration?.sql).toContain('FOR SHARE');
    expect(migration?.sql).not.toContain('source % is missing or archived');
  });

  test('migration v130 serializes writers with archive before a source row exists', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 130);
    expect(migration?.name).toBe('source_lifecycle_advisory_lock');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain('pg_advisory_xact_lock_shared');
    expect(migration?.sql).toContain("hashtextextended('gbrain:source-lifecycle', 0)");
    expect(migration?.sql).toContain('cardinality(source_refs) > 0');
  });

  test('PGLite schema replay preserves the final v130 guard on an already-upgraded brain', async () => {
    await db.initSchema();
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, data)
       VALUES ('guard-replay-missing-job', '{"sourceId":"guard-replay-missing"}'::jsonb)`,
    );
    const definitions = await db.executeRaw<{ definition: string }>(
      `SELECT pg_get_functiondef(
         'enforce_active_source_reference_fn()'::regprocedure
       ) AS definition`,
    );
    expect(definitions[0]?.definition).toContain('pg_advisory_xact_lock_shared');
    expect(definitions[0]?.definition).not.toContain('source % is missing or archived');
  });

  test('migration v125 closes terminal-job retry after source archive', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 125);
    expect(migration?.name).toBe('active_source_job_status_guard');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain('UPDATE OF data, status ON minion_jobs');
  });

  test('migrations v126-v127 allow terminalization but block every archived-source continuation update', async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 126);
    expect(migration?.name).toBe('archived_source_job_terminalization_guard');
    expect(migration?.idempotent).toBe(true);
    const continuationMigration = MIGRATIONS.find((entry) => entry.version === 127);
    expect(continuationMigration?.name).toBe('archived_source_job_continuation_guard');
    expect(continuationMigration?.idempotent).toBe(true);
    expect(continuationMigration?.sql).toContain('BEFORE INSERT OR UPDATE ON minion_jobs');

    await db.executeRaw(
      `INSERT INTO sources (id, name, archived)
       VALUES ('job-terminalize', 'job-terminalize', false)`,
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES
         ('finish-after-archive', 'active', '{"sourceId":"job-terminalize"}'::jsonb),
         ('continue-after-archive', 'waiting', '{"sourceId":"job-terminalize"}'::jsonb)`,
    );
    await db.executeRaw(
      `UPDATE sources SET archived = true, archived_at = now()
        WHERE id = 'job-terminalize'`,
    );

    let progressError: unknown;
    try {
      await db.executeRaw(
        `UPDATE minion_jobs SET progress = '{"current":1}'::jsonb
          WHERE name = 'finish-after-archive'`,
      );
    } catch (caught) {
      progressError = caught;
    }
    expect(String(progressError)).toContain('is archived');

    let renewalError: unknown;
    try {
      await db.executeRaw(
        `UPDATE minion_jobs SET lock_until = now() + interval '1 minute'
          WHERE name = 'finish-after-archive'`,
      );
    } catch (caught) {
      renewalError = caught;
    }
    expect(String(renewalError)).toContain('is archived');

    await db.executeRaw(
      `UPDATE minion_jobs SET status = 'failed'
        WHERE name = 'finish-after-archive'`,
    );
    let continuationError: unknown;
    try {
      await db.executeRaw(
        `UPDATE minion_jobs SET status = 'active'
          WHERE name = 'continue-after-archive'`,
      );
    } catch (caught) {
      continuationError = caught;
    }
    expect(String(continuationError)).toContain('is archived');
    const rows = await db.executeRaw<{ name: string; status: string }>(
      `SELECT name, status FROM minion_jobs
        WHERE name IN ('finish-after-archive', 'continue-after-archive')
        ORDER BY name`,
    );
    expect(rows).toEqual([
      { name: 'continue-after-archive', status: 'waiting' },
      { name: 'finish-after-archive', status: 'failed' },
    ]);
  });
});

interface FakeSourceRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | null;
  config: Record<string, unknown> | string;
  created_at: Date;
  archived: boolean;
  newest_content_at: Date | null;
}

function sourceRow(id: string, localPath: string | null, archived: boolean): FakeSourceRow {
  return {
    id,
    name: id,
    local_path: localPath,
    last_commit: null,
    last_sync_at: null,
    config: { federated: true },
    created_at: new Date('2026-01-01T00:00:00Z'),
    archived,
    newest_content_at: null,
  };
}

function makeEngine(
  sources: FakeSourceRow[],
  opts: {
    configuredDefault?: string | null;
    syncRepoPath?: string | null;
    dependentCounts?: Record<string, number>;
    boundSourceCounts?: Record<string, number>;
    federatedReadCounts?: Record<string, number>;
    sourceIdArrayCounts?: Record<string, number>;
    jsonReferenceCounts?: Record<string, number>;
    nonterminalWorkCounts?: Record<string, number>;
    failWorkRead?: boolean;
  } = {},
) {
  return {
    kind: 'pglite',
    mutationCount: 0,
    getConfig: async (key: string) => {
      if (key === 'sources.default') return opts.configuredDefault ?? null;
      if (key === 'sync.repo_path') return opts.syncRepoPath ?? null;
      return null;
    },
    executeRaw: async (sql: string, params?: unknown[]) => {
      if (/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i.test(sql)) {
        throw new Error(`unexpected mutation: ${sql}`);
      }
      if (sql.includes('FROM sources')) return sources;
      if (sql.includes('information_schema.columns')) {
        return [
          { table_name: 'pages', column_name: 'source_id' },
          { table_name: 'oauth_clients', column_name: 'bound_source_id' },
          { table_name: 'oauth_clients', column_name: 'federated_read' },
          { table_name: 'eval_candidates', column_name: 'source_ids' },
          { table_name: 'minion_jobs', column_name: 'data' },
        ];
      }
      if (sql.includes('FROM "pages"')) {
        const candidates = new Set((params?.[0] as string[] | undefined) ?? []);
        return Object.entries(opts.dependentCounts ?? {})
          .filter(([sourceId]) => candidates.has(sourceId))
          .map(([source_id, n]) => ({ source_id, n }));
      }
      if (sql.includes('FROM "oauth_clients"') && sql.includes('"bound_source_id"')) {
        const candidates = new Set((params?.[0] as string[] | undefined) ?? []);
        return Object.entries(opts.boundSourceCounts ?? {})
          .filter(([sourceId]) => candidates.has(sourceId))
          .map(([source_id, n]) => ({ source_id, n }));
      }
      if (sql.includes('FROM "oauth_clients"') && sql.includes('"federated_read"')) {
        const sourceId = String(params?.[0]);
        return [{ source_id: sourceId, n: opts.federatedReadCounts?.[sourceId] ?? 0 }];
      }
      if (sql.includes('FROM "eval_candidates"')) {
        const sourceId = String(params?.[0]);
        return [{ source_id: sourceId, n: opts.sourceIdArrayCounts?.[sourceId] ?? 0 }];
      }
      if (sql.includes('FROM "minion_jobs"')) {
        const sourceId = String(params?.[0]);
        return [{ source_id: sourceId, n: opts.jsonReferenceCounts?.[sourceId] ?? 0 }];
      }
      if (sql.includes('FROM minion_jobs')) {
        if (!sql.includes("data->>'sourceId'") || !sql.includes("data->>'source_id'")) {
          throw new Error('work query must cover both source-id payload spellings');
        }
        if (opts.failWorkRead) throw new Error('jobs unavailable');
        return Object.entries(opts.nonterminalWorkCounts ?? {}).map(([source_id, n]) => ({ source_id, n }));
      }
      throw new Error(`unexpected read: ${sql}`);
    },
  };
}
