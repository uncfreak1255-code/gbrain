import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { archiveHygieneCandidate } from '../src/commands/sources.ts';
import {
  restoreSource,
  softDeleteSource,
  softDeleteSourceGuarded,
} from '../src/core/destructive-guard.ts';
import { isSourceLifecycleClaimRace, MinionQueue } from '../src/core/minions/queue.ts';
import { beginSourceArchiveDrain, cancelSourceArchiveDrain } from '../src/core/source-embedding-lease.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
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
    draining: false,
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
    live_cycle_lock: false,
    cycle_lock_state_known: true,
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
      [{ live_cycle_lock: true }, 'live_cycle_lock'],
      [{ dependent_data_known: false, dependent_row_count: null }, 'dependent_data_unknown'],
      [{ work_state_known: false, nonterminal_work_count: null }, 'source_work_unknown'],
      [{ lock_state_known: false, live_sync_lock: null }, 'sync_lock_unknown'],
      [{ cycle_lock_state_known: false, live_cycle_lock: null }, 'cycle_lock_unknown'],
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

  test('surfaces an interrupted archive drain with the exact resume command', () => {
    const draining = classifySourceHygieneEvidence(evidence({
      source_id: 'stuck-drain',
      draining: true,
      repo_state: 'healthy',
    }));

    expect(draining).toMatchObject({
      classification: 'recovery_required',
      recovery_mode: 'archive_resume',
      proposed_command_argv: ['gbrain', 'sources', 'archive', 'stuck-drain'],
      veto_reasons: ['embedding_drain_pending'],
      safe_for_agent_review: true,
    });
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
    let cycleLockProbeCalls = 0;
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
        liveCycleLock: async () => { cycleLockProbeCalls++; return false; },
      },
    });

    expect(pathProbeCalls).toBe(0);
    expect(lockProbeCalls).toBe(0);
    expect(cycleLockProbeCalls).toBe(0);
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
        liveCycleLock: async () => false,
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
        liveCycleLock: async () => { throw new Error('lock table unavailable'); },
      },
    });

    expect(packet.sources[0]).toMatchObject({
      classification: 'recovery_required',
      work_state_known: false,
      lock_state_known: false,
      cycle_lock_state_known: false,
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
        liveCycleLock: async () => false,
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
        liveCycleLock: async () => false,
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
        liveCycleLock: async () => false,
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

  test('follows a user-owned source symlink to a healthy Git checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-source-hygiene-symlink-'));
    const repo = join(root, 'repo');
    const linkedPath = join(root, 'repo-link');
    try {
      execFileSync('git', ['init', '--quiet', repo]);
      symlinkSync(repo, linkedPath, 'dir');
      expect(validateSourceRepoState(linkedPath)).toBe('healthy');
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

  test('source-scoped and legacy global cycle locks veto hygiene archive', async () => {
    const sourceId = 'cycle-lock-candidate';
    const missingPath = join(tmpdir(), `gbrain-cycle-lock-${Date.now()}`);
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      [sourceId, missingPath],
    );

    for (const lockId of [`gbrain-cycle:${sourceId}`, 'gbrain-cycle']) {
      await db.executeRaw(
        `INSERT INTO gbrain_cycle_locks
           (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
         VALUES ($1, 2001, 'fixture', now() + interval '5 minutes', now())`,
        [lockId],
      );
      const packet = await inspectSourceHygiene(db, { inspectFilesystem: true });
      expect(packet.sources.find((source) => source.source_id === sourceId)).toMatchObject({
        classification: 'recovery_required',
        live_cycle_lock: true,
        cycle_lock_state_known: true,
        safe_for_agent_review: false,
      });
      expect(packet.sources.find((source) => source.source_id === sourceId)?.veto_reasons)
        .toContain('live_cycle_lock');
      await db.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]);
    }
  });

  test('database guard rejects source-scoped and global cycle locks after archive drain begins', async () => {
    const sourceId = 'cycle-lock-during-drain';
    await db.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`,
      [sourceId],
    );
    const drain = await beginSourceArchiveDrain(db, sourceId);
    expect(drain).not.toBeNull();

    for (const lockId of [`gbrain-cycle:${sourceId}`, 'gbrain-cycle']) {
      await expect(db.executeRaw(
        `INSERT INTO gbrain_cycle_locks
           (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
         VALUES ($1, 2002, 'fixture', now() + interval '5 minutes', now())`,
        [lockId],
      )).rejects.toThrow(/archived or draining|global cycle lock.*draining/);
    }
  });

  test('a committed drain is visible, resumable, and does not survive restore', async () => {
    await db.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('stuck-drain', 'stuck-drain', '{}'::jsonb)`,
    );
    const drain = await beginSourceArchiveDrain(db, 'stuck-drain');
    expect(drain).not.toBeNull();

    const packet = await inspectSourceHygiene(db, { inspectFilesystem: true });
    expect(packet.sources.find((source) => source.source_id === 'stuck-drain')).toMatchObject({
      draining: true,
      classification: 'recovery_required',
      recovery_mode: 'archive_resume',
      proposed_command_argv: ['gbrain', 'sources', 'archive', 'stuck-drain'],
    });

    expect(await softDeleteSource(db, 'stuck-drain')).not.toBeNull();
    expect(await restoreSource(db, 'stuck-drain')).toBe(true);
    const rows = await db.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
    }>(
      `SELECT archived, embedding_drain_token
         FROM sources
        WHERE id = 'stuck-drain'`,
    );
    expect(rows).toEqual([{ archived: false, embedding_drain_token: null }]);
  });

  test('a crashed hygiene-candidate drain can resume only through a fresh candidate recheck', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-candidate-drain-'));
    const repoPath = join(parent, 'candidate');
    try {
      await db.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ('candidate-drain', 'candidate-drain', $1, '{}'::jsonb)`,
        [repoPath],
      );
      const before = await inspectSourceHygiene(db, { inspectFilesystem: true });
      expect(before.sources.find((source) => source.source_id === 'candidate-drain')?.classification)
        .toBe('archive_candidate');

      const drain = await beginSourceArchiveDrain(db, 'candidate-drain', 'hygiene_candidate');
      expect(drain?.purpose).toBe('hygiene_candidate');
      const pending = await inspectSourceHygiene(db, { inspectFilesystem: true });
      expect(pending.sources.find((source) => source.source_id === 'candidate-drain'))
        .toMatchObject({
          classification: 'recovery_required',
          proposed_command_argv: [
            'gbrain', 'sources', 'archive', 'candidate-drain', '--if-hygiene-candidate',
          ],
        });

      expect(await softDeleteSource(db, 'candidate-drain')).toBeNull();
      execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
      const resumed = await archiveHygieneCandidate(db, 'candidate-drain');
      expect(resumed.result).toBeNull();
      expect(resumed.reason).toContain('healthy');

      const rows = await db.executeRaw<{
        archived: boolean;
        embedding_drain_token: string | null;
      }>(
        `SELECT archived, embedding_drain_token
           FROM sources
          WHERE id = 'candidate-drain'`,
      );
      expect(rows).toEqual([{ archived: false, embedding_drain_token: null }]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('a crashed hygiene-candidate drain archives after a fresh candidate recheck still passes', async () => {
    const missingPath = join(tmpdir(), `gbrain-candidate-resume-${Date.now()}`);
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('candidate-resume', 'candidate-resume', $1, '{}'::jsonb)`,
      [missingPath],
    );
    expect(await beginSourceArchiveDrain(db, 'candidate-resume', 'hygiene_candidate'))
      .toMatchObject({ purpose: 'hygiene_candidate' });

    const resumed = await archiveHygieneCandidate(db, 'candidate-resume');
    expect(resumed.reason).toBe('archived');
    expect(resumed.result).toMatchObject({ id: 'candidate-resume' });

    const rows = await db.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
    }>(
      `SELECT archived, embedding_drain_token
         FROM sources
        WHERE id = 'candidate-resume'`,
    );
    expect(rows).toEqual([{ archived: true, embedding_drain_token: null }]);
  });

  test('a crashed hygiene-candidate drain still counts path-only work owned before the drain', async () => {
    const missingPath = join(tmpdir(), `gbrain-candidate-path-work-${Date.now()}`);
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('candidate-path-work', 'candidate-path-work', $1, '{}'::jsonb)`,
      [missingPath],
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('sync', 'waiting', jsonb_build_object('repoPath', $1::text))`,
      [missingPath],
    );
    expect(await beginSourceArchiveDrain(db, 'candidate-path-work', 'hygiene_candidate'))
      .toMatchObject({ purpose: 'hygiene_candidate' });

    const resumed = await archiveHygieneCandidate(db, 'candidate-path-work');
    expect(resumed.result).toBeNull();
    expect(resumed.reason).toContain('nonterminal_source_work');
    const rows = await db.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
    }>(
      `SELECT archived, embedding_drain_token
         FROM sources
        WHERE id = 'candidate-path-work'`,
    );
    expect(rows).toEqual([{ archived: false, embedding_drain_token: null }]);
  });

  test('a live shared-path owner inherits path-only work from a draining archive candidate', async () => {
    const missingPath = join(tmpdir(), `gbrain-candidate-shared-path-${Date.now()}`);
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES
         ('candidate-shared-a', 'candidate-shared-a', $1, '{}'::jsonb),
         ('candidate-shared-b', 'candidate-shared-b', $1, '{}'::jsonb)`,
      [missingPath],
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('sync', 'waiting', jsonb_build_object('repoPath', $1::text))`,
      [missingPath],
    );
    expect(await beginSourceArchiveDrain(db, 'candidate-shared-a', 'hygiene_candidate'))
      .toMatchObject({ purpose: 'hygiene_candidate' });

    const resumed = await archiveHygieneCandidate(db, 'candidate-shared-a');
    expect(resumed.reason).toBe('archived');
    expect(resumed.result).toMatchObject({ id: 'candidate-shared-a' });
    const jobRows = await db.executeRaw<{ status: string }>(
      `SELECT status FROM minion_jobs
        WHERE name = 'sync' AND data->>'repoPath' = $1`,
      [missingPath],
    );
    expect(jobRows).toEqual([{ status: 'waiting' }]);
  });

  test('rereads the complete predicate after the committed drain and before finalization', async () => {
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

  test('refuses finalization when hygiene-relevant source metadata changes after the guard', async () => {
    const firstPath = join(tmpdir(), `gbrain-archive-meta-first-${Date.now()}`);
    const secondPath = join(tmpdir(), `gbrain-archive-meta-second-${Date.now()}`);
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('archive-meta-race', 'archive-meta-race', $1, '{}'::jsonb)`,
      [firstPath],
    );

    await expect(softDeleteSourceGuarded(
      db,
      'archive-meta-race',
      async (guardEngine) => {
        await guardEngine.executeRaw(
          `UPDATE sources SET local_path = $2 WHERE id = $1`,
          ['archive-meta-race', secondPath],
        );
        return { allowed: true, reason: 'archive_candidate' };
      },
    )).rejects.toThrow(/metadata changed after archive drain began/);

    const rows = await db.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
      local_path: string | null;
    }>(
      `SELECT archived, embedding_drain_token, local_path
         FROM sources
        WHERE id = 'archive-meta-race'`,
    );
    expect(rows[0]).toMatchObject({
      archived: false,
      local_path: secondPath,
    });
    expect(rows[0]?.embedding_drain_token).not.toBeNull();
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

  test('both source-id spellings and path-routed sync jobs veto archive', async () => {
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES
         ('job-secondary-key', 'job-secondary-key', '/fixture/job-secondary-key', '{}'::jsonb),
         ('job-equal-keys', 'job-equal-keys', '/fixture/job-equal-keys', '{}'::jsonb),
         ('job-path-route', 'job-path-route', '/fixture/job-path-route', '{}'::jsonb),
         ('job-path-ignored', 'job-path-ignored', '/fixture/job-path-ignored', '{}'::jsonb),
         ('job-snake-path-ignored', 'job-snake-path-ignored', '/fixture/job-snake-path-ignored', '{}'::jsonb)`,
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES
         ('source-key-wrapper', 'waiting',
          '{"sourceId":"default","source_id":"job-secondary-key"}'::jsonb),
         ('equal-key-wrapper', 'waiting',
          '{"sourceId":"job-equal-keys","source_id":"job-equal-keys"}'::jsonb),
         ('sync', 'waiting', '{"repoPath":"/fixture/job-path-route"}'::jsonb),
         ('sync', 'waiting',
          '{"sourceId":"default","repoPath":"/fixture/job-path-ignored"}'::jsonb),
         ('sync', 'waiting',
          '{"source_id":"default","repoPath":"/fixture/job-snake-path-ignored"}'::jsonb)`,
    );

    const packet = await inspectSourceHygiene(db, {
      inspectFilesystem: true,
      probes: {
        repoState: () => 'missing',
        liveSyncLock: async () => false,
        liveCycleLock: async () => false,
      },
    });

    for (const sourceId of ['job-secondary-key', 'job-equal-keys', 'job-path-route']) {
      expect(packet.sources.find((source) => source.source_id === sourceId)).toMatchObject({
        classification: 'recovery_required',
        nonterminal_work_count: 1,
        work_state_known: true,
      });
    }
    for (const sourceId of ['job-path-ignored', 'job-snake-path-ignored']) {
      expect(packet.sources.find((source) => source.source_id === sourceId)).toMatchObject({
        classification: 'archive_candidate',
        nonterminal_work_count: 0,
        work_state_known: true,
      });
    }
  });

  test('source guard migrations cover every direct and page-owned reference at the database boundary', async () => {
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
    expect(migration?.sql).toContain('IF FOUND AND source_archived THEN');
    expect(migration?.sql).toContain('pg_advisory_xact_lock_shared');
    expect(migration?.sql).toContain("hashtextextended('gbrain:source-lifecycle', 0)");
    expect(migration?.sql).not.toContain('source % is missing or archived');
    expect(
      migration?.sql.match(/SET search_path = pg_catalog, public, pg_temp/g),
    ).toHaveLength(2);

    const cycleLockMigration = MIGRATIONS.find((entry) => entry.version === 134);
    expect(cycleLockMigration?.name).toBe('source_cycle_lock_archive_guard');
    expect(cycleLockMigration?.idempotent).toBe(true);
    expect(cycleLockMigration?.sql).toContain("lock_ref LIKE 'gbrain-cycle:%'");
    expect(cycleLockMigration?.sql).toContain("lock_ref = 'gbrain-cycle'");
    expect(cycleLockMigration?.sql).toContain('Cannot acquire global cycle lock while source % is draining');
    expect(cycleLockMigration?.sql).toContain('enforce_active_source_lock_fn');
    expect(cycleLockMigration?.sql).toContain('pg_advisory_xact_lock_shared');

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
          AND c.table_name <> 'source_embedding_leases'
          AND trigger_.oid IS NULL
        ORDER BY c.table_name`,
    );
    expect(uncovered).toEqual([]);

    const uncoveredPageReferences = await db.executeRaw<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT child_table.relname AS table_name,
              child_column.attname AS column_name
         FROM pg_constraint constraint_
         JOIN pg_class child_table
           ON child_table.oid = constraint_.conrelid
         JOIN pg_namespace child_namespace
           ON child_namespace.oid = child_table.relnamespace
         JOIN pg_class parent_table
           ON parent_table.oid = constraint_.confrelid
         JOIN pg_namespace parent_namespace
           ON parent_namespace.oid = parent_table.relnamespace
         JOIN LATERAL unnest(constraint_.conkey) WITH ORDINALITY
           AS child_key(attnum, ordinal_position) ON true
         JOIN LATERAL unnest(constraint_.confkey) WITH ORDINALITY
           AS parent_key(attnum, ordinal_position)
           ON parent_key.ordinal_position = child_key.ordinal_position
         JOIN pg_attribute child_column
           ON child_column.attrelid = child_table.oid
          AND child_column.attnum = child_key.attnum
         JOIN pg_attribute parent_column
           ON parent_column.attrelid = parent_table.oid
          AND parent_column.attnum = parent_key.attnum
         LEFT JOIN pg_trigger insert_trigger
           ON insert_trigger.tgrelid = child_table.oid
          AND insert_trigger.tgname = 'source_active_page_ref_insert_guard'
          AND NOT insert_trigger.tgisinternal
         LEFT JOIN pg_trigger update_trigger
           ON update_trigger.tgrelid = child_table.oid
          AND update_trigger.tgname = 'source_active_page_ref_update_guard'
          AND NOT update_trigger.tgisinternal
        WHERE constraint_.contype = 'f'
          AND child_namespace.nspname = 'public'
          AND parent_namespace.nspname = 'public'
          AND parent_table.relname = 'pages'
          AND parent_column.attname = 'id'
          AND (insert_trigger.oid IS NULL OR update_trigger.oid IS NULL)
        ORDER BY child_table.relname, child_column.attname`,
    );
    expect(uncoveredPageReferences).toEqual([]);
    const chunkGuardDefinitions = await db.executeRaw<{ definition: string }>(
      `SELECT pg_get_triggerdef(trigger_.oid) AS definition
         FROM pg_trigger trigger_
        WHERE trigger_.tgrelid = 'content_chunks'::regclass
          AND trigger_.tgname IN (
            'source_active_page_ref_insert_guard',
            'source_active_page_ref_update_guard'
          )
          AND NOT trigger_.tgisinternal
        ORDER BY trigger_.tgname`,
    );
    expect(chunkGuardDefinitions).toHaveLength(2);
    for (const trigger of chunkGuardDefinitions) {
      expect(trigger.definition).toContain('FOR EACH STATEMENT');
    }
    expect(chunkGuardDefinitions[0]?.definition).toContain('REFERENCING NEW TABLE AS new_rows');
    expect(chunkGuardDefinitions[1]?.definition).toContain(
      'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows',
    );

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
      `INSERT INTO oauth_clients
         (client_id, client_name, bound_source_id, federated_read)
       VALUES ('guard-bound-only-client', 'guard-bound-only-client', 'guard-active', ARRAY[]::text[])`,
    );
    await db.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES ('guard-active', 'active/page', 'note', 'Active', 'active')`,
    );
    await db.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES ('default', 'guard-target/page', 'note', 'Target', 'target')`,
    );
    await db.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
       SELECT id, chunk_index, chunk_text
         FROM pages
         CROSS JOIN (VALUES
           (0, 'active chunk'),
           (1, 'rehome chunk')
         ) AS chunks(chunk_index, chunk_text)
        WHERE source_id = 'guard-active' AND slug = 'active/page'`,
    );
    // Regression: the page-owned guard must stay statement-scoped. This is a
    // single bulk statement, not 500 row-level lock/query cycles.
    await db.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
       SELECT pages.id, series.chunk_index, 'bulk active chunk ' || series.chunk_index
         FROM pages
         CROSS JOIN generate_series(10, 509) AS series(chunk_index)
        WHERE pages.source_id = 'guard-active' AND pages.slug = 'active/page'`,
    );
    const bulkChunkCount = await db.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM content_chunks chunks
         JOIN pages ON pages.id = chunks.page_id
        WHERE pages.source_id = 'guard-active'
          AND pages.slug = 'active/page'
          AND chunks.chunk_index BETWEEN 10 AND 509`,
    );
    expect(bulkChunkCount[0]?.count).toBe(500);
    const embeddingType = await db.executeRaw<{ formatted_type: string }>(
      `SELECT format_type(attribute.atttypid, attribute.atttypmod) AS formatted_type
         FROM pg_attribute attribute
        WHERE attribute.attrelid = 'content_chunks'::regclass
          AND attribute.attname = 'embedding'
          AND NOT attribute.attisdropped`,
    );
    const embeddingDimensions = Number(
      embeddingType[0]?.formatted_type.match(/^vector\((\d+)\)$/)?.[1],
    );
    expect(embeddingDimensions).toBeGreaterThan(0);
    const vectorLiteral = `[${Array.from(
      { length: embeddingDimensions },
      () => '0.01',
    ).join(',')}]`;
    // Keep the bulk-write regression realistic: UPDATE transition rows carry
    // non-null vectors, while the guard projects only page_id and must finish
    // within the test runner's normal timeout.
    await db.executeRaw(
      `UPDATE content_chunks chunks
          SET embedding = $1::vector
         FROM pages
        WHERE pages.id = chunks.page_id
          AND pages.source_id = 'guard-active'
          AND pages.slug = 'active/page'
          AND chunks.chunk_index BETWEEN 10 AND 509`,
      [vectorLiteral],
    );
    const embeddedBulkChunkCount = await db.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM content_chunks chunks
         JOIN pages ON pages.id = chunks.page_id
        WHERE pages.source_id = 'guard-active'
          AND pages.slug = 'active/page'
          AND chunks.chunk_index BETWEEN 10 AND 509
          AND chunks.embedding IS NOT NULL`,
    );
    expect(embeddedBulkChunkCount[0]?.count).toBe(500);
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, data)
       VALUES ('guard-active-job', '{"sourceId":"guard-active"}'::jsonb)`,
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('sync', 'active', '{"repoPath":"/fixture/guard-active"}'::jsonb)`,
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
      `INSERT INTO minion_jobs (name, data)
       VALUES ('sync', '{"repoPath":"${missingPath}"}'::jsonb)`,
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, data)
       VALUES (
         'sync',
         jsonb_build_object(
           'sourceId', 'default',
           'repoPath', $1::text
         )
       )`,
      [missingPath],
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
    expect(String(pathError)).toContain('matching source is archived or draining');

    expect(await softDeleteSource(db, 'guard-active')).not.toBeNull();
    await rejectArchived(
      `UPDATE pages SET title = 'Blocked mutation'
        WHERE source_id = 'guard-active' AND slug = 'active/page'`,
    );
    await rejectArchived(
      `UPDATE pages SET source_id = 'default'
        WHERE source_id = 'guard-active' AND slug = 'active/page'`,
    );
    await rejectArchived(
      `UPDATE content_chunks
          SET chunk_text = 'Blocked indirect mutation'
        WHERE page_id = (
          SELECT id FROM pages
           WHERE source_id = 'guard-active' AND slug = 'active/page'
        )`,
    );
    await rejectArchived(
      `UPDATE content_chunks
          SET page_id = (
            SELECT id FROM pages
             WHERE source_id = 'default' AND slug = 'guard-target/page'
          )
        WHERE page_id = (
          SELECT id FROM pages
           WHERE source_id = 'guard-active' AND slug = 'active/page'
        ) AND chunk_index = 1`,
    );
    await rejectArchived(
      `UPDATE oauth_clients SET client_name = 'Blocked mutation'
        WHERE client_id = 'guard-active-client'`,
    );
    await rejectArchived(
      `UPDATE oauth_clients
          SET deleted_at = now(), client_name = 'Blocked revocation piggyback'
        WHERE client_id = 'guard-active-client'`,
    );
    await db.executeRaw(
      `UPDATE oauth_clients SET deleted_at = now()
        WHERE client_id = 'guard-active-client'`,
    );
    const revokedClient = await db.executeRaw<{
      client_name: string;
      revoked: boolean;
    }>(
      `SELECT client_name, deleted_at IS NOT NULL AS revoked
         FROM oauth_clients
        WHERE client_id = 'guard-active-client'`,
    );
    expect(revokedClient).toEqual([{
      client_name: 'guard-active-client',
      revoked: true,
    }]);
    // Removing the scalar binding is cleanup, not a write to the archived
    // source. This also preserves FK ON DELETE SET NULL compatibility.
    await db.executeRaw(
      `UPDATE oauth_clients
          SET bound_source_id = NULL
        WHERE client_id = 'guard-bound-only-client'`,
    );
    await rejectArchived(
      `UPDATE oauth_clients
          SET bound_source_id = 'guard-active'
        WHERE client_id = 'guard-bound-only-client'`,
    );
    await rejectArchived(
      `UPDATE oauth_clients
          SET bound_source_id = 'default', federated_read = ARRAY['default']
        WHERE client_id = 'guard-active-client'`,
    );
    await rejectArchived(
      `UPDATE minion_jobs
          SET data = '{"sourceId":"default"}'::jsonb
        WHERE name = 'guard-active-job'`,
    );
    await db.executeRaw(
      `UPDATE minion_jobs SET status = 'failed'
        WHERE name = 'sync'
          AND data->>'repoPath' = '/fixture/guard-active'`,
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

  test('page deletion can clear nullable child references after the owner is archived', async () => {
    await db.executeRaw(
      `INSERT INTO sources (id, name, config, archived)
       VALUES ('guard-delete-owner', 'guard-delete-owner', '{}'::jsonb, false)`,
    );
    await db.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES
         ('guard-delete-owner', 'guard-delete/origin', 'note', 'Origin', 'origin'),
         ('default', 'guard-delete/from', 'note', 'From', 'from'),
         ('default', 'guard-delete/to', 'note', 'To', 'to')`,
    );
    await db.executeRaw(
      `INSERT INTO files
         (source_id, page_slug, page_id, filename, storage_path, content_hash)
       SELECT 'default', 'guard-delete/origin', id,
              'guard-delete.txt', 'guard-delete.txt', 'guard-delete-hash'
         FROM pages
        WHERE source_id = 'guard-delete-owner' AND slug = 'guard-delete/origin'`,
    );
    await db.executeRaw(
      `INSERT INTO links
         (from_page_id, to_page_id, origin_page_id, link_type, link_source)
       SELECT from_page.id, to_page.id, origin_page.id, 'related', 'frontmatter'
         FROM pages from_page
         JOIN pages to_page
           ON to_page.source_id = 'default' AND to_page.slug = 'guard-delete/to'
         JOIN pages origin_page
           ON origin_page.source_id = 'guard-delete-owner'
          AND origin_page.slug = 'guard-delete/origin'
        WHERE from_page.source_id = 'default' AND from_page.slug = 'guard-delete/from'`,
    );

    expect(await softDeleteSource(db, 'guard-delete-owner')).not.toBeNull();
    await db.executeRaw(
      `DELETE FROM pages
        WHERE source_id = 'guard-delete-owner' AND slug = 'guard-delete/origin'`,
    );

    const files = await db.executeRaw<{ page_id: number | null }>(
      `SELECT page_id FROM files WHERE storage_path = 'guard-delete.txt'`,
    );
    const links = await db.executeRaw<{ origin_page_id: number | null }>(
      `SELECT origin_page_id FROM links WHERE link_source = 'frontmatter'
        AND link_type = 'related'`,
    );
    expect(files).toEqual([{ page_id: null }]);
    expect(links).toEqual([{ origin_page_id: null }]);
  });

  test('intermediate guards allow missing legacy sources but reject archived sources', async () => {
    const referenceGuard = MIGRATIONS.find((entry) => entry.version === 124);
    const jobGuard = MIGRATIONS.find((entry) => entry.version === 126);
    const continuationGuard = MIGRATIONS.find((entry) => entry.version === 127);
    const ownedRowGuard = MIGRATIONS.find((entry) => entry.version === 128);
    const finalGuard = MIGRATIONS.find((entry) => entry.version === 130);
    expect(referenceGuard?.sql).toBeDefined();
    expect(jobGuard?.sql).toBeDefined();
    expect(continuationGuard?.sql).toBeDefined();
    expect(ownedRowGuard?.sql).toBeDefined();
    expect(finalGuard?.sql).toBeDefined();

    await db.runMigration(124, referenceGuard!.sql!);
    try {
      await db.executeRaw(
        `INSERT INTO sources (id, name, archived)
         VALUES ('v124-archived', 'v124-archived', true)`,
      );
      await db.executeRaw(
        `INSERT INTO eval_candidates
           (tool_name, query, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
         VALUES ('query', 'v124 missing source', ARRAY['v124-missing'], false, false, 1, false)`,
      );
      await db.executeRaw(
        `INSERT INTO config (key, value) VALUES ('sources.default', 'v124-missing')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );

      const assertArchivedRejected = async (run: () => Promise<unknown>) => {
        let error: unknown;
        try {
          await run();
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeDefined();
        expect(String(error)).toContain('is archived');
      };
      await assertArchivedRejected(() => db.executeRaw(
        `INSERT INTO eval_candidates
           (tool_name, query, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
         VALUES ('query', 'v124 archived source', ARRAY['v124-archived'], false, false, 1, false)`,
      ));
      await assertArchivedRejected(() => db.executeRaw(
        `INSERT INTO config (key, value) VALUES ('sources.default', 'v124-archived')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ));

      await db.runMigration(126, jobGuard!.sql!);
      await db.executeRaw(
        `INSERT INTO minion_jobs (name, data)
         VALUES ('v126-missing-source-job', '{"sourceId":"v126-missing"}'::jsonb)`,
      );
      await assertArchivedRejected(() => db.executeRaw(
        `INSERT INTO minion_jobs (name, data)
         VALUES ('v126-archived-source-job', '{"sourceId":"v124-archived"}'::jsonb)`,
      ));
    } finally {
      await db.runMigration(127, continuationGuard!.sql!);
      await db.runMigration(128, ownedRowGuard!.sql!);
      await db.runMigration(130, finalGuard!.sql!);
    }
  });

  test('migration v129 keeps missing source identifiers compatible while locking known rows', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 129);
    expect(migration?.name).toBe('archived_source_missing_reference_compatibility');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain('SELECT archived INTO source_archived');
    expect(migration?.sql).toContain('IF FOUND AND source_archived THEN');
    expect(migration?.sql).toContain('FOR SHARE');
    expect(migration?.sql).toContain('pg_advisory_xact_lock_shared');
    expect(migration?.sql).toContain("hashtextextended('gbrain:source-lifecycle', 0)");
    expect(migration?.sql).not.toContain('source % is missing or archived');
    expect(
      migration?.sql.match(/SET search_path = pg_catalog, public, pg_temp/g),
    ).toHaveLength(3);
  });

  test('migration v135 preserves pure OAuth revocation after source archive', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 135);
    expect(migration?.name).toBe('archived_source_oauth_revocation_escape');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain("TG_TABLE_NAME = 'oauth_clients'");
    expect(migration?.sql).toContain("to_jsonb(NEW) - 'deleted_at'");
    expect(migration?.sql).toContain("to_jsonb(OLD) - 'deleted_at'");
  });

  test('migration v130 serializes writers with archive before a source row exists', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 130);
    expect(migration?.name).toBe('source_lifecycle_advisory_lock');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain('pg_advisory_xact_lock_shared');
    expect(migration?.sql).toContain("hashtextextended('gbrain:source-lifecycle', 0)");
    expect(migration?.sql).toContain('cardinality(source_refs) > 0');
    expect(migration?.sql).toContain('to_jsonb(OLD)');
    expect(migration?.sql).toContain("OLD.data->>'sourceId'");
    expect(
      migration?.sql.match(/SET search_path = pg_catalog, public, pg_temp/g),
    ).toHaveLength(3);
  });

  test('migration v131 repairs OLD-reference guards for an already-v130 brain', async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 131);
    expect(migration?.name).toBe('archived_source_update_escape_guard');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain('to_jsonb(OLD)');
    expect(migration?.sql).toContain("OLD.data->>'sourceId'");

    await db.executeRaw(`
      CREATE OR REPLACE FUNCTION enforce_active_source_reference_fn()
      RETURNS trigger
      SET search_path = pg_catalog, public, pg_temp
      AS $fn$
      BEGIN
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await db.setConfig('version', '130');
    const result = await runMigrations(db);
    expect(result.applied).toBe(6);
    expect(result.current).toBe(LATEST_VERSION);

    const definitions = await db.executeRaw<{ definition: string }>(
      `SELECT pg_get_functiondef(
         'enforce_active_source_reference_fn()'::regprocedure
       ) AS definition`,
    );
    expect(definitions[0]?.definition).toContain('to_jsonb(OLD)');
  });

  test('migration v132 guards page-owned rows for an already-v131 brain', async () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 132);
    expect(migration?.name).toBe('archived_source_indirect_reference_guard');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain('enforce_active_source_page_reference_fn');
    expect(migration?.sql).not.toContain('FROM old_rows changed');
    expect(migration?.sql).toContain('enforce_active_source_page_rehome_fn');
    expect(migration?.sql).not.toContain('to_jsonb(row_record)');
    expect(migration?.sql).toContain('FOR EACH STATEMENT');
    expect(migration?.sql).toContain("parent_table.relname = 'pages'");
    expect(migration?.sql).toContain("parent_column.attname = 'id'");
    expect(migration?.sql).toContain('pg_advisory_xact_lock_shared');
    expect(migration?.sql).toContain("NEW.data->>'repoPath'");
    expect(migration?.sql).toContain('path_source_refs_after');

    await db.executeRaw(`
      CREATE OR REPLACE FUNCTION enforce_active_source_job_status_fn()
      RETURNS trigger
      SET search_path = pg_catalog, public, pg_temp
      AS $fn$
      BEGIN
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await db.executeRaw(`
      CREATE OR REPLACE FUNCTION enforce_active_source_page_reference_fn()
      RETURNS trigger
      SET search_path = pg_catalog, public, pg_temp
      AS $fn$
      BEGIN
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await db.setConfig('version', '131');
    const result = await runMigrations(db);
    expect(result.applied).toBe(5);
    expect(result.current).toBe(LATEST_VERSION);

    const definitions = await db.executeRaw<{ definition: string }>(
      `SELECT pg_get_functiondef(
         'enforce_active_source_page_reference_fn()'::regprocedure
       ) AS definition`,
    );
    expect(definitions[0]?.definition).not.toContain('FROM old_rows changed');
    expect(definitions[0]?.definition).not.toContain('to_jsonb(row_record)');
    expect(definitions[0]?.definition).toContain('page source % is archived');
    const jobDefinitions = await db.executeRaw<{ definition: string }>(
      `SELECT pg_get_functiondef(
         'enforce_active_source_job_status_fn()'::regprocedure
       ) AS definition`,
    );
    expect(jobDefinitions[0]?.definition).toContain("NEW.data->>'repoPath'");
    expect(jobDefinitions[0]?.definition).toContain('path_source_refs_after');
  });

  test('PGLite schema replay preserves the final source guards on an already-upgraded brain', async () => {
    const assertHardenedGuards = async () => {
      const hardened = await db.executeRaw<{ proname: string; proconfig: string[] | null }>(
        `SELECT proname, proconfig
           FROM pg_proc
          WHERE proname IN (
            'enforce_active_source_reference_fn',
            'enforce_active_source_job_status_fn',
            'enforce_active_source_config_fn',
            'enforce_active_source_page_reference_fn'
          )
          ORDER BY proname`,
      );
      expect(hardened).toHaveLength(4);
      for (const guard of hardened) {
        expect(guard.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
      }
    };

    await assertHardenedGuards();
    await db.initSchema();
    await assertHardenedGuards();
    await db.executeRaw(
      `INSERT INTO sources (id, name, archived)
       VALUES ('guard-replay-archived', 'guard-replay-archived', false)`,
    );
    await db.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, source_id)
       VALUES (
         'guard-replay-page',
         'note',
         'guard-replay-page',
         '# replay',
         'guard-replay-archived'
       )`,
    );
    expect(await softDeleteSource(db, 'guard-replay-archived')).not.toBeNull();
    await expect(
      db.executeRaw(
        `UPDATE pages
            SET source_id = 'default'
          WHERE slug = 'guard-replay-page'`,
      ),
    ).rejects.toThrow('source guard-replay-archived is archived');
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
    expect(migration?.sql).toContain('IF FOUND AND source_archived THEN');
    expect(migration?.sql).toContain('pg_advisory_xact_lock_shared');
    expect(migration?.sql).toContain("hashtextextended('gbrain:source-lifecycle', 0)");
    expect(migration?.sql).not.toContain('source % is missing or archived');
    expect(
      migration?.sql.match(/SET search_path = pg_catalog, public, pg_temp/g),
    ).toHaveLength(1);
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
    expect(await softDeleteSource(db, 'job-terminalize')).not.toBeNull();

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

  test('claim cancels archived jobs, holds draining jobs, and preserves parents', async () => {
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES
         ('claim-archived', 'claim-archived', '/fixture/claim-archived', '{}'::jsonb),
         ('claim-draining', 'claim-draining', '/fixture/claim-draining', '{}'::jsonb),
         ('claim-healthy', 'claim-healthy', '/fixture/claim-healthy', '{}'::jsonb)`,
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, status, priority, data)
       VALUES
         ('sync', 'waiting', -30, '{"sourceId":"claim-archived"}'::jsonb),
         ('sync', 'waiting', -20, '{"source_id":"claim-archived"}'::jsonb),
         ('sync', 'waiting', -10, '{"repoPath":"/fixture/claim-draining"}'::jsonb)`,
    );
    const parents = await db.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('aggregate', 'waiting-children', '{}'::jsonb)
       RETURNING id`,
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, status, priority, parent_job_id, data)
       VALUES ('sync', 'waiting', -40, $1, '{"sourceId":"claim-archived"}'::jsonb)`,
      [parents[0]!.id],
    );

    expect(await softDeleteSource(db, 'claim-archived')).not.toBeNull();
    const drain = await beginSourceArchiveDrain(db, 'claim-draining');
    expect(drain).not.toBeNull();

    await db.setConfig('version', String(LATEST_VERSION));
    const queue = new MinionQueue(db);
    const submitted = await queue.add(
      'sync',
      { sourceId: 'claim-healthy' },
      { maxWaiting: 1 },
    );
    expect(submitted.data).toEqual({ sourceId: 'claim-healthy' });
    const claimed = await queue.claim('healthy-token', 30_000, 'default', ['sync']);
    expect(claimed).toMatchObject({
      status: 'active',
      data: { sourceId: 'claim-healthy' },
    });
    expect(await queue.claim('empty-token', 30_000, 'default', ['sync'])).toBeNull();

    const blocked = await db.executeRaw<{
      status: string;
      attempts_started: number;
    }>(
      `SELECT status, attempts_started
         FROM minion_jobs
        WHERE priority < 0
        ORDER BY priority`,
    );
    expect(blocked).toEqual([
      { status: 'cancelled', attempts_started: 0 },
      { status: 'cancelled', attempts_started: 0 },
      { status: 'cancelled', attempts_started: 0 },
      { status: 'waiting', attempts_started: 0 },
    ]);
    expect(await queue.getJob(parents[0]!.id)).toMatchObject({ status: 'waiting' });
    const childDone = await db.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM minion_inbox
        WHERE job_id = $1 AND payload->>'type' = 'child_done'`,
      [parents[0]!.id],
    );
    expect(childDone[0]?.count).toBe(1);

    await cancelSourceArchiveDrain(db, drain!);
    const resumed = await queue.claim('resumed-token', 30_000, 'default', ['sync']);
    expect(resumed).toMatchObject({
      status: 'active',
      data: { repoPath: '/fixture/claim-draining' },
    });
  });

  test('path-only jobs follow an active shared-path owner and cancel only after every owner archives', async () => {
    const sharedPath = '/fixture/shared-path-owner';
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES
         ('shared-path-a', 'shared-path-a', $1, '{}'::jsonb),
         ('shared-path-b', 'shared-path-b', $1, '{}'::jsonb)`,
      [sharedPath],
    );
    expect(await softDeleteSource(db, 'shared-path-a')).not.toBeNull();

    const inserted = await db.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('sync', 'waiting', jsonb_build_object('repoPath', $1::text))
       RETURNING id`,
      [sharedPath],
    );
    await expect(db.executeRaw(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES (
         'sync',
         'waiting',
         jsonb_build_object('source_id', 'shared-path-a', 'repoPath', $1::text)
       )`,
      [sharedPath],
    )).rejects.toThrow(/shared-path-a is archived/);

    await db.setConfig('version', String(LATEST_VERSION));
    const queue = new MinionQueue(db);
    expect(await queue.cancelArchivedSourceJobs(['shared-path-a'])).toEqual([]);

    const drain = await beginSourceArchiveDrain(db, 'shared-path-b');
    expect(drain).not.toBeNull();
    expect(await queue.cancelArchivedSourceJobs(['shared-path-a'])).toEqual([]);
    expect(await queue.claim('held-shared-path', 30_000, 'default', ['sync'])).toBeNull();

    await cancelSourceArchiveDrain(db, drain!);
    const claimed = await queue.claim('active-shared-path', 30_000, 'default', ['sync']);
    expect(claimed?.id).toBe(inserted[0]?.id);
    await db.executeRaw(
      `UPDATE minion_jobs SET status = 'completed' WHERE id = $1`,
      [inserted[0]!.id],
    );

    const doomed = await db.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data)
       VALUES ('sync', 'waiting', jsonb_build_object('repoPath', $1::text))
       RETURNING id`,
      [sharedPath],
    );
    expect(await softDeleteSource(db, 'shared-path-b')).not.toBeNull();
    const cancelled = await queue.cancelArchivedSourceJobs(['shared-path-b']);
    expect(cancelled.map((job) => job.id)).toContain(doomed[0]!.id);
    expect(await queue.getJob(doomed[0]!.id)).toMatchObject({ status: 'cancelled' });
  });

  test('migration v136 restores active-owner semantics for path-only jobs and config', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 136);
    expect(migration?.name).toBe('active_path_source_job_resolution');
    expect(migration?.idempotent).toBe(true);
    expect(migration?.sql).toContain("NEW.data->'source_id'");
    expect(migration?.sql).toContain('matched_active');
    expect(migration?.sql).toContain('enforce_active_source_job_status_fn');
    expect(migration?.sql).toContain('enforce_active_source_config_fn');
    expect(migration?.sql).toContain('source_active_config_guard');
  });

  test('migration v136 repairs the upgraded config guard for a shared active path owner', async () => {
    const sharedPath = '/fixture/v136-shared-config-owner';
    await db.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES
         ('v136-config-archived', 'v136-config-archived', $1, '{}'::jsonb),
         ('v136-config-active', 'v136-config-active', $1, '{}'::jsonb)`,
      [sharedPath],
    );
    expect(await softDeleteSource(db, 'v136-config-archived')).not.toBeNull();

    // Reproduce the v133-v135 upgrade state: the generic reference guard
    // rejects a path when any matching owner is archived, even if another
    // matching owner is active.
    await db.executeRaw('DROP TRIGGER IF EXISTS source_active_config_guard ON config');
    await db.executeRaw(`
      CREATE TRIGGER source_active_config_guard
        BEFORE INSERT OR UPDATE OF key, value ON config
        FOR EACH ROW EXECUTE FUNCTION enforce_active_source_reference_fn('config', 'value')
    `);
    await db.setConfig('version', '135');

    const result = await runMigrations(db);
    expect(result).toMatchObject({ applied: 1, current: LATEST_VERSION });
    const triggers = await db.executeRaw<{ definition: string }>(
      `SELECT pg_get_triggerdef(oid) AS definition
         FROM pg_trigger
        WHERE tgname = 'source_active_config_guard'
          AND NOT tgisinternal`,
    );
    expect(triggers[0]?.definition).toContain('enforce_active_source_config_fn');

    await expect(db.executeRaw(
      `INSERT INTO config (key, value) VALUES ('sync.repo_path', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [sharedPath],
    )).resolves.toEqual(expect.any(Array));

    const drain = await beginSourceArchiveDrain(db, 'v136-config-active');
    expect(drain).not.toBeNull();
    await expect(db.executeRaw(
      `UPDATE config SET value = $1 WHERE key = 'sync.repo_path'`,
      [sharedPath],
    )).rejects.toThrow(/matching source is archived or draining/);
    await cancelSourceArchiveDrain(db, drain!);
  });

  test('claim race classifier accepts only the exact source lifecycle guard', () => {
    expect(isSourceLifecycleClaimRace(Object.assign(
      new Error('Cannot write minion_jobs: source race-source is archived or draining'),
      { code: '23503' },
    ))).toBe(true);
    expect(isSourceLifecycleClaimRace(Object.assign(
      new Error('Cannot write minion_jobs.data: source race-source is archived'),
      { sqlState: '23503' },
    ))).toBe(true);
    expect(isSourceLifecycleClaimRace(Object.assign(
      new Error('insert or update violates foreign key constraint'),
      { code: '23503' },
    ))).toBe(false);
    expect(isSourceLifecycleClaimRace(Object.assign(
      new Error('Cannot write minion_jobs: source race-source is archived or draining'),
      { code: '40001' },
    ))).toBe(false);
  });

  test('delayed promotion skips inactive sources and later terminalizes their jobs', async () => {
    await db.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES
         ('delay-archived', 'delay-archived', '{}'::jsonb),
         ('delay-healthy', 'delay-healthy', '{}'::jsonb)`,
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs (name, status, delay_until, data)
       VALUES
         ('sync', 'delayed', now() - interval '1 minute', '{"sourceId":"delay-archived"}'::jsonb),
         ('sync', 'delayed', now() - interval '1 minute', '{"sourceId":"delay-healthy"}'::jsonb)`,
    );
    expect(await softDeleteSource(db, 'delay-archived')).not.toBeNull();

    await db.setConfig('version', String(LATEST_VERSION));
    const queue = new MinionQueue(db);
    const promoted = await queue.promoteDelayed();
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.data).toEqual({ sourceId: 'delay-healthy' });

    const claimed = await queue.claim('delay-token', 30_000, 'default', ['sync']);
    expect(claimed?.data).toEqual({ sourceId: 'delay-healthy' });
    const inactive = await db.executeRaw<{ status: string }>(
      `SELECT status FROM minion_jobs
        WHERE data->>'sourceId' = 'delay-archived'`,
    );
    expect(inactive).toEqual([{ status: 'cancelled' }]);
  });

  test('stalled recovery terminalizes inactive sources without rolling back healthy requeues', async () => {
    await db.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES
         ('stall-archived', 'stall-archived', '{}'::jsonb),
         ('stall-healthy', 'stall-healthy', '{}'::jsonb)`,
    );
    await db.executeRaw(
      `INSERT INTO minion_jobs
         (name, status, lock_token, lock_until, stalled_counter, max_stalled, data)
       VALUES
         ('sync', 'active', 'archived-token', now() - interval '1 minute', 0, 3,
          '{"sourceId":"stall-archived"}'::jsonb),
         ('sync', 'active', 'healthy-token', now() - interval '1 minute', 0, 3,
          '{"sourceId":"stall-healthy"}'::jsonb)`,
    );
    expect(await softDeleteSource(db, 'stall-archived')).not.toBeNull();

    await db.setConfig('version', String(LATEST_VERSION));
    const queue = new MinionQueue(db);
    const result = await queue.handleStalled();
    expect(result.dead).toEqual([]);
    expect(result.requeued).toHaveLength(1);
    expect(result.requeued[0]?.data).toEqual({ sourceId: 'stall-healthy' });

    const statuses = await db.executeRaw<{ source_id: string; status: string }>(
      `SELECT data->>'sourceId' AS source_id, status
         FROM minion_jobs
        WHERE data->>'sourceId' IN ('stall-archived', 'stall-healthy')
        ORDER BY source_id`,
    );
    expect(statuses).toEqual([
      { source_id: 'stall-archived', status: 'cancelled' },
      { source_id: 'stall-healthy', status: 'waiting' },
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
  embedding_drain_token: string | null;
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
    embedding_drain_token: null,
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
      if (sql.includes('FROM public.sources') && !sql.includes('FROM public.minion_jobs')) {
        return sources;
      }
      if (sql.includes('FROM public.config')) {
        const key = String(params?.[0]);
        if (key === 'sources.default' && opts.configuredDefault != null) {
          return [{ value: opts.configuredDefault }];
        }
        if (key === 'sync.repo_path' && opts.syncRepoPath != null) {
          return [{ value: opts.syncRepoPath }];
        }
        return [];
      }
      if (sql.includes('information_schema.columns')) {
        return [
          { table_name: 'pages', column_name: 'source_id' },
          { table_name: 'oauth_clients', column_name: 'bound_source_id' },
          { table_name: 'oauth_clients', column_name: 'federated_read' },
          { table_name: 'eval_candidates', column_name: 'source_ids' },
          { table_name: 'minion_jobs', column_name: 'data' },
        ];
      }
      if (sql.includes('FROM public."pages"')) {
        const candidates = new Set((params?.[0] as string[] | undefined) ?? []);
        return Object.entries(opts.dependentCounts ?? {})
          .filter(([sourceId]) => candidates.has(sourceId))
          .map(([source_id, n]) => ({ source_id, n }));
      }
      if (sql.includes('FROM public."oauth_clients"') && sql.includes('"bound_source_id"')) {
        const candidates = new Set((params?.[0] as string[] | undefined) ?? []);
        return Object.entries(opts.boundSourceCounts ?? {})
          .filter(([sourceId]) => candidates.has(sourceId))
          .map(([source_id, n]) => ({ source_id, n }));
      }
      if (sql.includes('FROM public."oauth_clients"') && sql.includes('"federated_read"')) {
        const sourceId = String(params?.[0]);
        return [{ source_id: sourceId, n: opts.federatedReadCounts?.[sourceId] ?? 0 }];
      }
      if (sql.includes('FROM public."eval_candidates"')) {
        const sourceId = String(params?.[0]);
        return [{ source_id: sourceId, n: opts.sourceIdArrayCounts?.[sourceId] ?? 0 }];
      }
      if (sql.includes('FROM public."minion_jobs"')) {
        const sourceId = String(params?.[0]);
        return [{ source_id: sourceId, n: opts.jsonReferenceCounts?.[sourceId] ?? 0 }];
      }
      if (sql.includes('FROM public.minion_jobs')) {
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
