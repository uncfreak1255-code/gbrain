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
import { gbrainPath, saveConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

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
});
