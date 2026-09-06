/**
 * PGLite lifecycle test for storage tiering — D8 + D4 of v0.22.3.
 *
 * Per the plan: "the full PGLite lifecycle for D8's both-engines requirement.
 * gbrain.yml load → gbrain storage status → soft-warn message present →
 * manageGitignore happy-path on a tmp dir. PGLite-specific path for the
 * slugPrefix filter."
 *
 * In-memory PGLite, no Docker, no DATABASE_URL. Runs instantly in CI.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  getStorageStatus,
  runStorage,
  formatStorageStatusHuman,
  __resetPGLiteWarn,
} from '../src/commands/storage.ts';
import { manageGitignore, __resetPGLiteTierWarn } from '../src/commands/sync.ts';
import { __resetMissingStorageWarning } from '../src/core/storage-config.ts';
import { ALL_SOURCES } from '../src/core/source-resolver.ts';

let engine: PGLiteEngine;
let tmp: string;
let warnings: string[];
let originalWarn: typeof console.warn;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-pglite-test-'));
  __resetMissingStorageWarning();
  __resetPGLiteWarn();
  __resetPGLiteTierWarn();
  warnings = [];
  originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  // Reset DB between tests.
  const tables = ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages', 'sources'];
  for (const t of tables) {
    await (engine as unknown as { db: { exec(sql: string): Promise<unknown> } }).db.exec(`DELETE FROM ${t}`);
  }
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('default', 'Default', $1) ON CONFLICT DO NOTHING`,
    [tmp],
  );
});

function cleanup(): void {
  console.warn = originalWarn;
  rmSync(tmp, { recursive: true, force: true });
}

function writeGbrainYml(): void {
  writeFileSync(
    join(tmp, 'gbrain.yml'),
    `storage:
  db_tracked:
    - people/
  db_only:
    - media/x/
`,
  );
}

describe('Storage tiering on PGLite — full lifecycle (D8 + D4)', () => {
  test('engine.kind is pglite', () => {
    try {
      expect(engine.kind).toBe('pglite');
    } finally {
      cleanup();
    }
  });

  test('getStorageStatus loads gbrain.yml and reports tier counts', async () => {
    try {
      writeGbrainYml();
      await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
      await engine.putPage('media/x/tweet-1', { type: 'concept', title: 'Tweet', compiled_truth: '', timeline: '' });
      await engine.putPage('media/x/tweet-2', { type: 'concept', title: 'Tweet 2', compiled_truth: '', timeline: '' });
      await engine.putPage('random/note', { type: 'concept', title: 'Random', compiled_truth: '', timeline: '' });

      const result = await getStorageStatus(engine, tmp);
      expect(result.totalPages).toBe(4);
      expect(result.pagesByTier.db_tracked).toBe(1);
      expect(result.pagesByTier.db_only).toBe(2);
      expect(result.pagesByTier.unspecified).toBe(1);
      expect(result.config!.db_only).toEqual(['media/x/']);
    } finally {
      cleanup();
    }
  });

  test('getStorageStatus scopes page checks to the source that owns the repo path (#4763)', async () => {
    try {
      writeGbrainYml();
      mkdirSync(join(tmp, 'media', 'x'), { recursive: true });
      writeFileSync(join(tmp, 'media', 'x', 'default-db-only.md'), 'file-backed default page');

      const otherRepo = join(tmp, 'other-repo');
      mkdirSync(otherRepo, { recursive: true });
      await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [tmp]);
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
           VALUES ('media-corpus', 'media-corpus', $1, '{}'::jsonb)
           ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
        [otherRepo],
      );

      await engine.putPage('media/x/default-db-only', {
        type: 'concept',
        title: 'Default source page',
        compiled_truth: '',
        timeline: '',
      }, { sourceId: 'default' });
      await engine.putPage('media/x/foreign-db-only', {
        type: 'concept',
        title: 'Foreign source page',
        compiled_truth: '',
        timeline: '',
      }, { sourceId: 'media-corpus' });

      const result = await getStorageStatus(engine, tmp);
      expect(result.totalPages).toBe(1);
      expect(result.pagesByTier.db_only).toBe(1);
      expect(result.missingFiles).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('the all-sources sentinel omits the scalar listPages filter', async () => {
    try {
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('foreign', 'Foreign')`);
      await engine.putPage('people/default', { type: 'person', title: 'Default', compiled_truth: '', timeline: '' });
      await engine.putPage('people/foreign', { type: 'person', title: 'Foreign', compiled_truth: '', timeline: '' }, { sourceId: 'foreign' });

      const result = await getStorageStatus(engine, null, ALL_SOURCES);
      expect(result.totalPages).toBe(2);
    } finally {
      cleanup();
    }
  });

  test('all-source status does not apply a legacy repo config or disk map to foreign pages', async () => {
    const oldLog = console.log;
    const output: string[] = [];
    try {
      writeGbrainYml();
      mkdirSync(join(tmp, 'media', 'x'), { recursive: true });
      writeFileSync(join(tmp, 'media', 'x', 'shared.md'), 'local file');
      await engine.executeRaw(`UPDATE sources SET local_path = NULL`);
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('foreign', 'Foreign')`);
      await engine.setConfig('sync.repo_path', tmp);
      for (const sourceId of ['default', 'foreign']) {
        await engine.putPage('media/x/shared', { type: 'note', title: 'Shared', compiled_truth: '', timeline: '' }, { sourceId });
        await engine.putPage('media/x/missing', { type: 'note', title: 'Missing', compiled_truth: '', timeline: '' }, { sourceId });
      }
      console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
      await withEnv({ GBRAIN_SOURCE: ALL_SOURCES }, () => runStorage(engine, ['status', '--json']));
      const result = JSON.parse(output.at(-1)!);
      expect(result.totalPages).toBe(4);
      expect(result.repoPath).toBeNull();
      expect(result.config).toBeNull();
      expect(result.pagesByTier).toEqual({ db_tracked: 0, db_only: 0, unspecified: 4 });
      expect(result.diskUsageByTier).toEqual({ db_tracked: 0, db_only: 0, unspecified: 0 });
      expect(result.missingFiles).toEqual([]);
      expect(formatStorageStatusHuman(result)).toContain('--repo');
    } finally {
      console.log = oldLog;
      await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.repo_path'`);
      cleanup();
    }
  });

  test('unmapped explicit repo refuses instead of counting all sources', async () => {
    try {
      await engine.executeRaw(`UPDATE sources SET local_path = NULL`);
      await expect(getStorageStatus(engine, tmp)).rejects.toThrow('no registered source');
    } finally { cleanup(); }
  });

  test('implicit legacy repo retains the selected source', async () => {
    const oldLog = console.log;
    const output: string[] = [];
    try {
      writeGbrainYml();
      await engine.executeRaw(`UPDATE sources SET local_path = NULL`);
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('foreign', 'Foreign')`);
      await engine.setConfig('sync.repo_path', tmp);
      await engine.putPage('media/x/owned', { type: 'note', title: 'Owned', compiled_truth: '', timeline: '' });
      await engine.putPage('media/x/foreign', { type: 'note', title: 'Foreign', compiled_truth: '', timeline: '' }, { sourceId: 'foreign' });
      console.log = (...args: unknown[]) => output.push(args.map(String).join(' '));
      await withEnv({ GBRAIN_SOURCE: 'default' }, () => runStorage(engine, ['status', '--json']));
      const result = JSON.parse(output.at(-1)!);
      expect(result.totalPages).toBe(1);
      expect(result.missingFiles.map((p: { slug: string }) => p.slug)).toEqual(['media/x/owned']);
    } finally {
      console.log = oldLog;
      await engine.executeRaw(`DELETE FROM config WHERE key = 'sync.repo_path'`);
      cleanup();
    }
  });

  test('manageGitignore on PGLite emits the D4 soft-warn (once per process)', () => {
    try {
      writeGbrainYml();
      manageGitignore(tmp, 'pglite');
      expect(warnings.some((w) => /limited effect on PGLite/.test(w))).toBe(true);
      expect(existsSync(join(tmp, '.gitignore'))).toBe(true);
      expect(readFileSync(join(tmp, '.gitignore'), 'utf-8')).toContain('media/x/');

      // Second call: no second warning (once-per-process).
      const before = warnings.length;
      manageGitignore(tmp, 'pglite');
      const newWarnings = warnings.slice(before).filter((w) => /limited effect on PGLite/.test(w));
      expect(newWarnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('manageGitignore on Postgres does NOT emit the PGLite warning', () => {
    try {
      writeGbrainYml();
      manageGitignore(tmp, 'postgres');
      expect(warnings.filter((w) => /limited effect on PGLite/.test(w))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test('slugPrefix engine filter works on PGLite (Issue #13)', async () => {
    try {
      await engine.putPage('media/x/tweet-1', { type: 'concept', title: 'T1', compiled_truth: '', timeline: '' });
      await engine.putPage('media/x/tweet-2', { type: 'concept', title: 'T2', compiled_truth: '', timeline: '' });
      await engine.putPage('media/articles/post-1', { type: 'concept', title: 'A1', compiled_truth: '', timeline: '' });

      const xOnly = await engine.listPages({ slugPrefix: 'media/x/', limit: 100 });
      expect(xOnly.map((p) => p.slug).sort()).toEqual(['media/x/tweet-1', 'media/x/tweet-2']);
    } finally {
      cleanup();
    }
  });

  test('end-to-end: gbrain.yml + putPage + storage status + .gitignore', async () => {
    try {
      writeGbrainYml();
      await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
      await engine.putPage('media/x/tweet-1', { type: 'concept', title: 'T1', compiled_truth: '', timeline: '' });

      // Status reads tier counts correctly.
      const status = await getStorageStatus(engine, tmp);
      expect(status.config).not.toBeNull();
      expect(status.pagesByTier.db_only).toBe(1);

      // Render to human output without errors.
      const out = formatStorageStatusHuman(status);
      expect(out).toContain('DB only:        1 pages');

      // .gitignore management produces a managed block.
      manageGitignore(tmp, 'pglite');
      const gitignore = readFileSync(join(tmp, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('# Auto-managed by gbrain');
      expect(gitignore).toContain('media/x/');
    } finally {
      cleanup();
    }
  });
});
