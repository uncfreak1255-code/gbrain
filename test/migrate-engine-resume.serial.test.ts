import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  manifestMatchesTarget,
  migrationTargetId,
  runMigrateEngine,
  type MigrateManifest,
} from '../src/commands/migrate-engine.ts';
import { gbrainPath, loadConfig, saveConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  __setSourceEmbeddingLeaseTimingsForTests,
  beginSourceArchiveDrain,
} from '../src/core/source-embedding-lease.ts';
import { restoreSource, softDeleteSourceGuarded } from '../src/core/destructive-guard.ts';

describe('migrate-engine resume identity', () => {
  test('crash manifest resumes only against the same PGLite target', () => {
    const targetA = migrationTargetId({ engine: 'pglite', database_path: '/tmp/target-a' });
    const targetB = migrationTargetId({ engine: 'pglite', database_path: '/tmp/target-b' });
    const crashed: MigrateManifest = {
      schema_version: 2,
      target_engine: 'pglite',
      target_id: targetA,
      completed_slugs: ['source-a::people/shared'],
      started_at: '2026-07-10T00:00:00.000Z',
    };

    expect(manifestMatchesTarget(crashed, targetA)).toBe(true);
    expect(manifestMatchesTarget(crashed, targetB)).toBe(false);
  });

  test('legacy engine-only manifest cannot skip pages on a second target', () => {
    const legacy: MigrateManifest = {
      target_engine: 'postgres',
      completed_slugs: ['people/shared'],
      started_at: '2026-07-10T00:00:00.000Z',
    };
    const sampleUser = 'sample-user';
    const samplePassword = 'sample-password';
    const sampleDatabaseUrl = [
      'postgresql://', sampleUser, ':', samplePassword, '@', 'db.example.invalid/brain-b',
    ].join('');
    const target = migrationTargetId({
      engine: 'postgres',
      database_url: sampleDatabaseUrl,
    });

    expect(manifestMatchesTarget(legacy, target)).toBe(false);
    expect(target).not.toContain(sampleUser);
    expect(target).not.toContain(samplePassword);
    expect(target).not.toContain('db.example.invalid');
  });
});

async function withMigrationHome(
  fn: (ctx: { home: string; source: PGLiteEngine }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-migrate-resume-'));
  const oldHome = process.env.GBRAIN_HOME;
  const oldDatabaseUrl = process.env.DATABASE_URL;
  const oldGbrainDatabaseUrl = process.env.GBRAIN_DATABASE_URL;
  process.env.GBRAIN_HOME = home;
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_DATABASE_URL;
  const source = new PGLiteEngine();
  try {
    await source.connect({});
    await source.initSchema();
    await source.putPage('people/one', {
      type: 'person', title: 'One', compiled_truth: 'source one', timeline: '',
    });
    await source.putPage('people/two', {
      type: 'person', title: 'Two', compiled_truth: 'source two', timeline: '',
    });
    saveConfig({
      engine: 'postgres',
      database_url: 'postgresql://example.invalid/source-brain',
    });
    await fn({ home, source });
  } finally {
    await source.disconnect();
    if (oldHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = oldHome;
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    if (oldGbrainDatabaseUrl === undefined) delete process.env.GBRAIN_DATABASE_URL;
    else process.env.GBRAIN_DATABASE_URL = oldGbrainDatabaseUrl;
    rmSync(home, { recursive: true, force: true });
  }
}

function writeManifest(manifest: MigrateManifest): void {
  const path = gbrainPath('migrate-manifest.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest));
}

describe('migrate-engine crash resume behavior', () => {
  test('matching partial target resumes without --force and preserves completed pages', async () => {
    await withMigrationHome(async ({ home, source }) => {
      const targetPath = join(home, 'partial-target');
      const partial = new PGLiteEngine();
      await partial.connect({ engine: 'pglite', database_path: targetPath });
      await partial.initSchema();
      await partial.putPage('people/one', {
        type: 'person', title: 'One', compiled_truth: 'already copied', timeline: '',
      });
      await partial.disconnect();

      writeManifest({
        schema_version: 2,
        target_engine: 'pglite',
        target_id: migrationTargetId({ engine: 'pglite', database_path: targetPath }),
        completed_slugs: ['people/one'],
        started_at: '2026-07-16T00:00:00.000Z',
      });

      await runMigrateEngine(source, ['--to', 'pglite', '--path', targetPath]);

      const readback = new PGLiteEngine();
      await readback.connect({ engine: 'pglite', database_path: targetPath });
      const pages = await readback.listPages({ limit: 10 });
      expect(pages.map(p => p.slug).sort()).toEqual(['people/one', 'people/two']);
      expect((await readback.getPage('people/one'))?.compiled_truth).toBe('already copied');
      await readback.disconnect();
      expect(existsSync(gbrainPath('migrate-manifest.json'))).toBe(false);
    });
  }, 60_000);

  test('--force wipes the target and ignores completed keys from a matching manifest', async () => {
    await withMigrationHome(async ({ home, source }) => {
      const targetPath = join(home, 'forced-target');
      const partial = new PGLiteEngine();
      await partial.connect({ engine: 'pglite', database_path: targetPath });
      await partial.initSchema();
      await partial.putPage('people/one', {
        type: 'person', title: 'One', compiled_truth: 'stale target copy', timeline: '',
      });
      await partial.putPage('stale/only', {
        type: 'note', title: 'Stale', compiled_truth: 'remove me', timeline: '',
      });
      await partial.disconnect();

      writeManifest({
        schema_version: 2,
        target_engine: 'pglite',
        target_id: migrationTargetId({ engine: 'pglite', database_path: targetPath }),
        completed_slugs: ['people/one'],
        started_at: '2026-07-16T00:00:00.000Z',
      });

      await runMigrateEngine(source, ['--to', 'pglite', '--path', targetPath, '--force']);

      const readback = new PGLiteEngine();
      await readback.connect({ engine: 'pglite', database_path: targetPath });
      const pages = await readback.listPages({ limit: 10 });
      expect(pages.map(p => p.slug).sort()).toEqual(['people/one', 'people/two']);
      expect((await readback.getPage('people/one'))?.compiled_truth).toBe('source one');
      expect(await readback.getPage('stale/only')).toBeNull();
      await readback.disconnect();
      expect(existsSync(gbrainPath('migrate-manifest.json'))).toBe(false);
    });
  }, 60_000);

  test('--force rejects target-only sources before deleting or copying pages', async () => {
    await withMigrationHome(async ({ home, source }) => {
      const targetPath = join(home, 'incompatible-forced-target');
      const partial = new PGLiteEngine();
      await partial.connect({ engine: 'pglite', database_path: targetPath });
      await partial.initSchema();
      await partial.executeRaw(
        `INSERT INTO sources (id, name, config)
         VALUES ('target-extra', 'Target Extra', '{}'::jsonb)`,
      );
      await partial.putPage('stale/only', {
        type: 'note', title: 'Stale', compiled_truth: 'must survive rejected preflight', timeline: '',
      });
      await partial.disconnect();

      await expect(
        runMigrateEngine(source, ['--to', 'pglite', '--path', targetPath, '--force']),
      ).rejects.toThrow('Migration target has unexpected source "target-extra"');

      expect(loadConfig()?.engine).toBe('postgres');
      const readback = new PGLiteEngine();
      await readback.connect({ engine: 'pglite', database_path: targetPath });
      expect((await readback.getPage('stale/only'))?.compiled_truth)
        .toBe('must survive rejected preflight');
      expect(await readback.executeRaw<{ id: string }>(
        `SELECT id FROM sources WHERE id = 'target-extra'`,
      )).toEqual([{ id: 'target-extra' }]);
      await readback.disconnect();
    });
  }, 60_000);

  test('--force rejects a same-ID manual drain without mutating target state', async () => {
    await withMigrationHome(async ({ home, source }) => {
      const targetPath = join(home, 'draining-forced-target');
      await source.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ('shared', 'Shared', '{}'::jsonb)`,
      );
      const partial = new PGLiteEngine();
      await partial.connect({ engine: 'pglite', database_path: targetPath });
      await partial.initSchema();
      await partial.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ('shared', 'Shared', '{}'::jsonb)`,
      );
      await partial.putPage('stale/shared', {
        type: 'note', title: 'Shared', compiled_truth: 'must survive lifecycle preflight', timeline: '',
      }, { sourceId: 'shared' });
      const drain = await beginSourceArchiveDrain(partial, 'shared', 'manual');
      expect(drain?.purpose).toBe('manual');
      await partial.disconnect();

      await expect(
        runMigrateEngine(source, ['--to', 'pglite', '--path', targetPath, '--force']),
      ).rejects.toThrow('incompatible manual archive drain');

      expect(loadConfig()?.engine).toBe('postgres');
      const readback = new PGLiteEngine();
      await readback.connect({ engine: 'pglite', database_path: targetPath });
      expect((await readback.getPage('stale/shared', { sourceId: 'shared' }))?.compiled_truth)
        .toBe('must survive lifecycle preflight');
      expect((await readback.executeRaw<{ embedding_drain_token: string | null }>(
        `SELECT embedding_drain_token FROM sources WHERE id = 'shared'`,
      ))[0]?.embedding_drain_token).toBe(drain!.token);
      await readback.disconnect();
    });
  }, 60_000);

  test('--force recovers a manifest-less migration drain before deleting target pages', async () => {
    await withMigrationHome(async ({ home, source }) => {
      const targetPath = join(home, 'leased-migration-drain-target');
      await source.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ('shared', 'Shared', '{}'::jsonb)`,
      );
      expect((await softDeleteSourceGuarded(source, 'shared')).reason).toBe('archived');

      const partial = new PGLiteEngine();
      await partial.connect({ engine: 'pglite', database_path: targetPath });
      await partial.initSchema();
      await partial.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ('shared', 'Shared', '{}'::jsonb)`,
      );
      await partial.putPage('stale/shared', {
        type: 'note', title: 'Shared', compiled_truth: 'must survive recovery refusal', timeline: '',
      }, { sourceId: 'shared' });
      const drain = await beginSourceArchiveDrain(partial, 'shared', 'migration');
      expect(drain?.purpose).toBe('migration');
      await partial.executeRaw(
        `INSERT INTO source_embedding_leases
           (lease_token, source_id, source_epoch, owner_host, owner_pid, owner_instance,
            acquired_at, heartbeat_at)
         VALUES ('remote-migration-lease', 'shared', $1, 'remote-host.invalid', 2147483647,
                 'remote-migration-instance', now() - interval '20 minutes',
                 now() - interval '20 minutes')`,
        [drain!.epoch - 1],
      );
      await partial.disconnect();

      __setSourceEmbeddingLeaseTimingsForTests({ archivePollMs: 1, archiveWaitMs: 10 });
      try {
        await expect(
          runMigrateEngine(source, ['--to', 'pglite', '--path', targetPath, '--force']),
        ).rejects.toThrow('--revoke-stale-leases --confirm-destructive');
      } finally {
        __setSourceEmbeddingLeaseTimingsForTests();
      }

      expect(loadConfig()?.engine).toBe('postgres');
      const readback = new PGLiteEngine();
      await readback.connect({ engine: 'pglite', database_path: targetPath });
      expect((await readback.getPage('stale/shared', { sourceId: 'shared' }))?.compiled_truth)
        .toBe('must survive recovery refusal');
      expect(await readback.executeRaw<{
        embedding_drain_token: string | null;
        lease_token: string | null;
      }>(
        `SELECT source.embedding_drain_token, lease.lease_token
           FROM sources source
           LEFT JOIN source_embedding_leases lease ON lease.source_id = source.id
          WHERE source.id = 'shared'`,
      )).toEqual([{
        embedding_drain_token: drain!.token,
        lease_token: 'remote-migration-lease',
      }]);
      await readback.disconnect();

      // The printed, destructively-confirmed recovery flags are executable
      // without any local manifest. They revoke only the old fenced lease,
      // finish recovery, then let force delete the stale page.
      await runMigrateEngine(source, [
        '--to', 'pglite', '--path', targetPath, '--force',
        '--revoke-stale-leases', '--confirm-destructive',
      ]);
      expect(loadConfig()?.engine).toBe('pglite');
      const recovered = new PGLiteEngine();
      await recovered.connect({ engine: 'pglite', database_path: targetPath });
      expect(await recovered.getPage('stale/shared', { sourceId: 'shared' })).toBeNull();
      expect(await recovered.executeRaw<{
        archived: boolean;
        embedding_drain_token: string | null;
      }>(
        `SELECT archived, embedding_drain_token FROM sources WHERE id = 'shared'`,
      )).toEqual([{ archived: true, embedding_drain_token: null }]);
      await recovered.disconnect();
    });
  }, 60_000);

  test('source restore during target-drain recovery remains executable', async () => {
    await withMigrationHome(async ({ home, source }) => {
      const targetPath = join(home, 'restore-during-recovery-target');
      await source.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ('shared', 'Shared', '{}'::jsonb)`,
      );
      expect((await softDeleteSourceGuarded(source, 'shared')).reason).toBe('archived');

      const partial = new PGLiteEngine();
      await partial.connect({ engine: 'pglite', database_path: targetPath });
      await partial.initSchema();
      await partial.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ('shared', 'Shared', '{}'::jsonb)`,
      );
      await partial.putPage('stale/shared', {
        type: 'note', title: 'Shared', compiled_truth: 'replace after restore race', timeline: '',
      }, { sourceId: 'shared' });
      expect((await beginSourceArchiveDrain(partial, 'shared', 'migration'))?.purpose)
        .toBe('migration');
      await partial.disconnect();

      let lifecycleReads = 0;
      const racingSource = new Proxy(source, {
        get(realSource, prop) {
          if (prop === 'executeRaw') {
            return async <T>(sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) => {
              if (
                /SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token\s+FROM sources ORDER BY id/i.test(sql)
                && ++lifecycleReads === 2
              ) {
                expect(await restoreSource(realSource, 'shared', false)).toBe(true);
              }
              return realSource.executeRaw<T>(sql, params, opts);
            };
          }
          const value = Reflect.get(realSource, prop, realSource);
          return typeof value === 'function' ? value.bind(realSource) : value;
        },
      }) as unknown as BrainEngine;

      await runMigrateEngine(
        racingSource,
        ['--to', 'pglite', '--path', targetPath, '--force'],
      );
      expect(lifecycleReads).toBeGreaterThanOrEqual(2);
      expect(loadConfig()?.engine).toBe('pglite');
      const recovered = new PGLiteEngine();
      await recovered.connect({ engine: 'pglite', database_path: targetPath });
      expect(await recovered.executeRaw<{
        archived: boolean;
        embedding_drain_token: string | null;
      }>(
        `SELECT archived, embedding_drain_token FROM sources WHERE id = 'shared'`,
      )).toEqual([{ archived: false, embedding_drain_token: null }]);
      await recovered.disconnect();
    });
  }, 60_000);
});
