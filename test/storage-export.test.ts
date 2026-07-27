/**
 * Tests for export.ts --restore-only resolution chain — step 9 of v0.22.3.
 *
 * D5: --repo → sources.getDefault() → hard error. Never fall through to
 * cwd. Issue #9: bare try/catch removed from storage.ts:37.
 *
 * Tests use PGLite in-memory and a captured-output approach (process.exit
 * is intercepted) to verify the resolution chain produces the right
 * repoPath OR the right error.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __testing as exportTesting, runExport } from '../src/commands/export.ts';
import { __resetMissingStorageWarning } from '../src/core/storage-config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page } from '../src/core/types.ts';

let engine: PGLiteEngine;
let tmp: string;
let outDir: string;
let exitCode: number | null;
let originalExit: typeof process.exit;
let originalErr: typeof console.error;
let originalLog: typeof console.log;
let stderr: string[];
let stdout: string[];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-export-test-'));
  outDir = join(tmp, 'out');
  exitCode = null;
  stderr = [];
  stdout = [];
  __resetMissingStorageWarning();

  originalExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__test_exit__:${code}`);
  }) as typeof process.exit;

  originalErr = console.error;
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  };

  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  };

  // Reset DB state between tests
  const tables = ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages', 'sources'];
  for (const t of tables) {
    await (engine as unknown as { db: { exec(sql: string): Promise<unknown> } }).db.exec(`DELETE FROM ${t}`);
  }
  // Recreate the default source (the schema seed but truncated above).
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('default', 'Default') ON CONFLICT DO NOTHING`,
  );
});

afterEach(() => {
  process.exit = originalExit;
  console.error = originalErr;
  console.log = originalLog;
  rmSync(tmp, { recursive: true, force: true });
});

async function tryRunExport(args: string[]): Promise<void> {
  try {
    await runExport(engine, args);
  } catch (e) {
    // Swallow only the test-exit sentinel; rethrow others for visibility.
    if (!(e instanceof Error && e.message.startsWith('__test_exit__:'))) {
      throw e;
    }
  }
}

async function seedSourceVariant(
  sourceId: string,
  variant: 'default' | 'neighbor',
): Promise<void> {
  if (sourceId !== 'default') {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $2)`,
      [sourceId, `Source ${sourceId}`],
    );
  }
  await engine.putPage(
    'notes/shared',
    {
      type: 'note',
      title: `${variant} title`,
      compiled_truth: `${variant} body`,
      timeline: '',
      frontmatter: { variant },
    },
    { sourceId },
  );
  await engine.addTag('notes/shared', `${variant}-tag`, { sourceId });
  await engine.putRawData(
    'notes/shared',
    'unit-test',
    { variant, nested: { z: 2, a: 1 } },
    { sourceId },
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface ExportManifest {
  schema_version: number;
  source_id: string;
  source_page_count: number;
  page_count: number;
  raw_sidecar_count: number;
  pages: Array<{
    slug: string;
    db_content_hash: string | null;
    markdown_sha256: string;
    raw_sidecar_sha256: string | null;
    raw_record_count: number;
  }>;
}

describe('export --restore-only resolution chain (D5)', () => {
  test('hard-errors when --restore-only has no --repo and no default source path', async () => {
    // sources.default has no local_path (the seeded shape).
    await tryRunExport(['--dir', outDir, '--restore-only']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toMatch(/requires --repo|configured default source/);
  });

  test('uses explicit --repo when provided', async () => {
    // Make a brain repo with gbrain.yml that has empty db_only — so we
    // exit through the "0 pages to restore" path without needing real data.
    writeFileSync(
      join(tmp, 'gbrain.yml'),
      `storage:
  db_tracked: []
  db_only: []
`,
    );
    await tryRunExport(['--dir', outDir, '--restore-only', '--repo', tmp]);
    expect(exitCode).toBeNull(); // no exit
    expect(stdout.some((line) => line.includes('Restoring 0'))).toBe(true);
  });

  test('falls back to sources default local_path when --repo absent', async () => {
    // Configure default source path, write a real gbrain.yml so the storage
    // config check passes — without gbrain.yml the Codex-P0 guard correctly
    // refuses --restore-only (no storage config to scope to).
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [tmp]);
    writeFileSync(
      join(tmp, 'gbrain.yml'),
      `storage:\n  db_tracked: []\n  db_only:\n    - media/x/\n`,
    );
    await tryRunExport(['--dir', outDir, '--restore-only']);
    expect(exitCode).toBeNull(); // resolution succeeded
  });

  test('refuses --restore-only when no storage config is present (Codex P0)', async () => {
    // Default source has a path but no gbrain.yml. Without a storage config,
    // --restore-only would silently fall through to a full export — exactly
    // the silent-footgun D5 was supposed to prevent.
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [tmp]);
    await tryRunExport(['--dir', outDir, '--restore-only']);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toMatch(/storage tiering config|gbrain\.yml/);
  });

  test('non-restore export does NOT require --repo (D26)', async () => {
    // Regular export works without --repo since it dumps everything from DB.
    // Pages table is empty → exports 0 pages, no error.
    await tryRunExport(['--dir', outDir]);
    expect(exitCode).toBeNull();
    expect(stdout.some((line) => line.includes('Exporting 0'))).toBe(true);
    expect(existsSync(join(outDir, '.gbrain-export-manifest.json'))).toBe(false);
  });
});

describe('source-scoped recovery export', () => {
  test('refuses a non-empty output directory so stale pages cannot contaminate recovery', async () => {
    await seedSourceVariant('default', 'default');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'stale-page.md'), 'stale recovery data\n');

    await tryRunExport(['--dir', outDir, '--source', 'default']);

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toMatch(/absent or empty|fresh recovery directory/i);
    expect(readFileSync(join(outDir, 'stale-page.md'), 'utf8')).toBe('stale recovery data\n');
    expect(existsSync(join(outDir, 'notes/shared.md'))).toBe(false);
    expect(existsSync(join(outDir, '.gbrain-export-manifest.json'))).toBe(false);
  });

  test('accepts an existing empty output directory', async () => {
    await seedSourceVariant('default', 'default');
    mkdirSync(outDir, { recursive: true });

    await tryRunExport(['--dir', outDir, '--source', 'default']);

    expect(exitCode).toBeNull();
    expect(existsSync(join(outDir, 'notes/shared.md'))).toBe(true);
    expect(existsSync(join(outDir, '.gbrain-export-manifest.json'))).toBe(true);
  });

  test('isolates same-slug body, tags, and raw data in both source directions', async () => {
    await seedSourceVariant('default', 'default');
    await seedSourceVariant('neighbor', 'neighbor');

    await tryRunExport(['--dir', outDir, '--source', 'default']);

    expect(exitCode).toBeNull();
    const defaultMarkdown = readFileSync(join(outDir, 'notes/shared.md'), 'utf8');
    expect(defaultMarkdown).toContain('default body');
    expect(defaultMarkdown).toContain('default-tag');
    expect(defaultMarkdown).not.toContain('neighbor body');
    expect(defaultMarkdown).not.toContain('neighbor-tag');
    expect(JSON.parse(readFileSync(join(outDir, 'notes/.raw/shared.json'), 'utf8')))
      .toEqual({ 'unit-test': { nested: { a: 1, z: 2 }, variant: 'default' } });

    const neighborOut = join(tmp, 'neighbor-out');
    await tryRunExport(['--dir', neighborOut, '--source', 'neighbor']);
    const neighborMarkdown = readFileSync(join(neighborOut, 'notes/shared.md'), 'utf8');
    expect(neighborMarkdown).toContain('neighbor body');
    expect(neighborMarkdown).toContain('neighbor-tag');
    expect(neighborMarkdown).not.toContain('default body');
    expect(neighborMarkdown).not.toContain('default-tag');
    expect(JSON.parse(readFileSync(join(neighborOut, 'notes/.raw/shared.json'), 'utf8')))
      .toEqual({ 'unit-test': { nested: { a: 1, z: 2 }, variant: 'neighbor' } });
  });

  test('writes a deterministic source receipt without printing page content', async () => {
    await seedSourceVariant('default', 'default');
    await engine.putPage(
      'notes/alpha',
      { type: 'note', title: 'Alpha', compiled_truth: 'private alpha body' },
      { sourceId: 'default' },
    );

    await tryRunExport(['--dir', outDir, '--source', 'default']);

    const manifestPath = join(outDir, '.gbrain-export-manifest.json');
    const manifestBytes = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestBytes) as ExportManifest;
    expect(manifest.schema_version).toBe(1);
    expect(manifest.source_id).toBe('default');
    expect(manifest.source_page_count).toBe(2);
    expect(manifest.page_count).toBe(2);
    expect(manifest.raw_sidecar_count).toBe(1);
    expect(manifest.pages.map((page) => page.slug)).toEqual(['notes/alpha', 'notes/shared']);
    expect(manifest.pages.every((page) => /^[a-f0-9]{64}$/.test(page.markdown_sha256))).toBe(true);
    expect(manifest.pages[0].raw_sidecar_sha256).toBeNull();
    expect(manifest.pages[0].raw_record_count).toBe(0);
    expect(manifest.pages[1].raw_sidecar_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.pages[1].raw_record_count).toBe(1);
    expect(manifestBytes.endsWith('\n')).toBe(true);
    expect(stdout.join('\n')).toContain(`sha256=${sha256(manifestBytes)}`);
    expect(stdout.join('\n')).not.toContain('private alpha body');
    expect(stdout.join('\n')).not.toContain('default body');

    const repeatOut = join(tmp, 'repeat-out');
    await tryRunExport(['--dir', repeatOut, '--source', 'default']);
    expect(readFileSync(join(repeatOut, '.gbrain-export-manifest.json'), 'utf8'))
      .toBe(manifestBytes);
  });

  test('rejects missing, unknown, and restore-only source flags before writing', async () => {
    for (const args of [
      ['--dir', outDir, '--source'],
      ['--dir', outDir, '--source', 'ghost'],
      ['--dir', outDir, '--source', 'default', '--restore-only'],
    ]) {
      exitCode = null;
      stderr = [];
      await tryRunExport(args);
      expect(exitCode as number | null).toBe(1);
      expect(stderr.join('\n')).toMatch(/source|restore-only/i);
      expect(existsSync(outDir)).toBe(false);
    }
  });

  test('rejects filters that would make a recovery receipt incomplete', async () => {
    await seedSourceVariant('default', 'default');

    for (const filter of [['--type', 'note'], ['--slug-prefix', 'notes/']]) {
      exitCode = null;
      stderr = [];
      await tryRunExport(['--dir', outDir, '--source', 'default', ...filter]);
      expect(exitCode as number | null).toBe(1);
      expect(stderr.join('\n')).toMatch(/complete recovery export|does not support/i);
      expect(existsSync(outDir)).toBe(false);
    }
  });

  test('preserves raw keys named __proto__ without prototype assignment loss', async () => {
    await seedSourceVariant('default', 'default');
    await engine.putRawData(
      'notes/shared',
      '__proto__',
      { preserved: true },
      { sourceId: 'default' },
    );

    await tryRunExport(['--dir', outDir, '--source', 'default']);

    const raw = JSON.parse(
      readFileSync(join(outDir, 'notes/.raw/shared.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(raw, '__proto__')).toBe(true);
    expect(raw.__proto__).toEqual({ preserved: true });
    const manifest = JSON.parse(
      readFileSync(join(outDir, '.gbrain-export-manifest.json'), 'utf8'),
    ) as ExportManifest;
    expect(manifest.pages[0]?.raw_record_count).toBe(2);
  });

  test('does not write a recovery manifest when a page write fails', async () => {
    await engine.putPage(
      'notes/a',
      { type: 'note', title: 'File first', compiled_truth: 'first body' },
      { sourceId: 'default' },
    );
    await engine.putPage(
      'notes/a.md/b',
      { type: 'note', title: 'Path collision', compiled_truth: 'second body' },
      { sourceId: 'default' },
    );

    let caught: NodeJS.ErrnoException | undefined;
    try {
      await runExport(engine, ['--dir', outDir, '--source', 'default']);
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(['EEXIST', 'ENOTDIR']).toContain(caught?.code ?? '');
    expect(existsSync(join(outDir, 'notes/a.md'))).toBe(true);
    expect(existsSync(join(outDir, '.gbrain-export-manifest.json'))).toBe(false);
    expect(stdout.join('\n')).not.toContain('Manifest:');
  });

  test('does not report a recovery receipt when the manifest write fails', async () => {
    await engine.putPage(
      '.gbrain-export-manifest.json/x',
      { type: 'note', title: 'Manifest collision', compiled_truth: 'page body' },
      { sourceId: 'default' },
    );

    let caught: NodeJS.ErrnoException | undefined;
    try {
      await runExport(engine, ['--dir', outDir, '--source', 'default']);
    } catch (error) {
      caught = error as NodeJS.ErrnoException;
    }

    expect(caught?.code).toBe('EISDIR');
    expect(existsSync(join(outDir, '.gbrain-export-manifest.json/x.md'))).toBe(true);
    expect(stdout.join('\n')).not.toContain('Manifest:');
    expect(stdout.join('\n')).not.toContain('Exported 1 pages');
  });

  test('uses locale-independent code-point ordering for canonical receipts', () => {
    const value = Object.assign(Object.create(null), { 'ä': 1, z: 2, a: 3 });
    const json = exportTesting.canonicalJson(value);
    expect(json.indexOf('"a"')).toBeLessThan(json.indexOf('"z"'));
    expect(json.indexOf('"z"')).toBeLessThan(json.indexOf('"ä"'));
  });

  test('rejects traversal-shaped legacy slugs before writing any export file', async () => {
    await engine.putPage(
      'notes/safe',
      { type: 'note', title: 'Safe', compiled_truth: 'safe body' },
      { sourceId: 'default' },
    );
    await engine.putPage(
      'notes/legacy',
      { type: 'note', title: 'Legacy', compiled_truth: 'legacy body' },
      { sourceId: 'default' },
    );
    await engine.executeRaw(
      `UPDATE pages SET slug = '../escape' WHERE source_id = 'default' AND slug = 'notes/legacy'`,
    );

    await tryRunExport(['--dir', outDir, '--source', 'default']);

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toMatch(/unsafe|slug|path/i);
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(join(tmp, 'escape.md'))).toBe(false);
  });
});

describe('source recovery pagination', () => {
  test('reads past one batch and proves the exported count matches the source count', async () => {
    const pages = Array.from({ length: 5_001 }, (_, index) => ({
      slug: `notes/${String(index).padStart(5, '0')}`,
    })) as Page[];
    const offsets: number[] = [];
    const fake = {
      kind: 'pglite' as const,
      executeRaw: async (sql: string) => sql.includes('FROM sources')
        ? [{ id: 'default' }]
        : [{ n: pages.length }],
      listPages: async (filters: { offset?: number; limit?: number }) => {
        const offset = filters.offset ?? 0;
        const limit = filters.limit ?? 100;
        offsets.push(offset);
        return pages.slice(offset, offset + limit);
      },
      getTags: async () => [],
      getRawData: async () => [],
      transaction: async (fn: (tx: BrainEngine) => Promise<unknown>) => fn(fake as unknown as BrainEngine),
    } as unknown as BrainEngine;

    const result = await exportTesting.loadCompleteScopedPages(fake, 'default');

    expect(offsets).toEqual([0, 5_000]);
    expect(result.sourcePageCount).toBe(5_001);
    expect(result.pages).toHaveLength(5_001);
    expect(result.pages[0]?.slug).toBe('notes/00000');
    expect(result.pages.at(-1)?.slug).toBe('notes/05000');
  });
});
