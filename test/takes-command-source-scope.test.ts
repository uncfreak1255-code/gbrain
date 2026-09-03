import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTakes } from '../src/commands/takes.ts';
import type { BrainEngine, TakeBatchInput } from '../src/core/engine.ts';
import { acquirePageLock } from '../src/core/page-lock.ts';
import { computeBrainIdFromConfig } from '../src/core/upgrade-checkpoint.ts';
import { withEnv } from './helpers/with-env.ts';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeEngine(opts: {
  sourcePaths?: Record<string, string | null>;
  legacyRepoPath?: string | null;
} = {}) {
  const added: TakeBatchInput[][] = [];
  const pageLookups: unknown[][] = [];
  const updatePageIds: number[] = [];
  const supersedePageIds: number[] = [];
  const resolvePageIds: number[] = [];
  const engine = {
    kind: 'pglite',
    db: {
      query: async (sql: string) => ({ rows: sql.includes('RETURNING id') ? [{ id: 'lock' }] : [] }),
    },
    getConfig: async (key: string) => key === 'sync.repo_path' ? (opts.legacyRepoPath ?? null) : null,
    executeRaw: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT id, local_path FROM sources ORDER BY id')) {
        const entries = Object.entries(opts.sourcePaths ?? {});
        return entries.length > 0
          ? entries.map(([id, local_path]) => ({ id, local_path }))
          : [{ id: 'default', local_path: null }];
      }
      if (sql.includes('SELECT local_path FROM sources WHERE id = $1')) {
        return [{ local_path: opts.sourcePaths?.[String(params[0])] ?? null }];
      }
      if (sql.includes('FROM sources WHERE id = $1')) {
        return [{ id: params[0] as string }];
      }
      if (sql.includes('FROM pages WHERE slug = $1 AND source_id = $2')) {
        pageLookups.push(params);
        if (params[0] === 'shared/page' && params[1] === 'dept') return [{ id: 22 }];
        if (params[0] === 'shared/page' && params[1] === 'default') return [{ id: 11 }];
        return [];
      }
      if (sql.includes('FROM pages WHERE slug = $1 LIMIT 1')) {
        pageLookups.push(params);
        return [{ id: 11 }];
      }
      return [];
    },
    addTakesBatch: async (rows: TakeBatchInput[]) => {
      added.push(rows);
      return rows.length;
    },
    updateTake: async (pageId: number) => {
      updatePageIds.push(pageId);
    },
    listTakes: async ({ page_id }: { page_id: number }) => {
      return added.flat().filter(row => row.page_id === page_id).map(row => ({
        ...row,
        id: row.row_num,
        created_at: new Date(),
        updated_at: new Date(),
        resolved_at: null,
        resolved_outcome: null,
        resolved_quality: null,
        resolved_value: null,
        resolved_unit: null,
        resolved_source: null,
        resolved_by: null,
        unresolvable_reason: null,
        embedding: null,
        embedded_at: null,
      }));
    },
    supersedeTake: async (pageId: number, oldRow: number) => {
      supersedePageIds.push(pageId);
      return { oldRow, newRow: oldRow + 1 };
    },
    resolveTake: async (pageId: number) => {
      resolvePageIds.push(pageId);
    },
  } as unknown as BrainEngine;
  return { engine, added, pageLookups, updatePageIds, supersedePageIds, resolvePageIds };
}

describe('gbrain takes CLI source scoping', () => {
  test('a source-qualified page lock covers the markdown and DB mutation', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-source-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(brainDir, home);
    const { engine, added } = makeEngine();
    const held = await acquirePageLock('shared/page', {
      lockRoot: join(home, '.gbrain', 'page-locks'),
      brainId: computeBrainIdFromConfig({}),
      sourceId: 'dept',
    });
    expect(held).not.toBeNull();

    let settled = false;
    const mutation = withEnv({ GBRAIN_SOURCE: 'dept', GBRAIN_HOME: home }, async () => {
      await runTakes(engine, [
        'add', 'shared/page', '--claim', 'Serialized claim', '--kind', 'take', '--who', 'self',
        '--source-id', 'dept', '--dir', brainDir,
      ]);
    }).then(() => { settled = true; });

    await Bun.sleep(50);
    expect(settled).toBe(false);
    expect(added).toEqual([]);
    await held!.release();
    await mutation;
    expect(added).toHaveLength(1);
  });

  test('add mirrors to the page in GBRAIN_SOURCE, not an arbitrary same-slug page (#2684)', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-source-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(brainDir, home);
    const { engine, added, pageLookups } = makeEngine();

    await withEnv({ GBRAIN_SOURCE: 'dept', GBRAIN_HOME: home }, async () => {
      await runTakes(engine, [
        'add',
        'shared/page',
        '--claim',
        'Dept-scoped claim',
        '--kind',
        'take',
        '--who',
        'self',
        '--source-id',
        'dept',
        '--dir',
        brainDir,
      ]);
    });

    expect(pageLookups).toEqual([['shared/page', 'dept']]);
    expect(added).toHaveLength(1);
    expect(added[0]![0]!.page_id).toBe(22);

    const written = join(brainDir, 'shared/page.md');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf-8')).toContain('Dept-scoped claim');
  });

  test('invalid GBRAIN_SOURCE fails closed instead of falling back to an unscoped page lookup', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-source-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(brainDir, home);
    const { engine, added, pageLookups } = makeEngine();

    await withEnv({ GBRAIN_SOURCE: 'INVALID_SOURCE', GBRAIN_HOME: home }, async () => {
      await expect(runTakes(engine, [
        'add',
        'shared/page',
        '--claim',
        'Must not land',
        '--kind',
        'take',
        '--who',
        'self',
        '--source-id',
        'INVALID_SOURCE',
        '--dir',
        brainDir,
      ])).rejects.toThrow(/Invalid --source value/);
    });

    expect(pageLookups).toEqual([]);
    expect(added).toEqual([]);
  });

  test('omitted --source-id uses GBRAIN_SOURCE instead of requiring the flag', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-dept-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(sourceDir, home);
    const { engine, added, pageLookups } = makeEngine({ sourcePaths: { dept: sourceDir } });
    await withEnv({ GBRAIN_SOURCE: 'dept', GBRAIN_HOME: home }, async () => {
      await runTakes(engine, [
        'add', 'shared/page', '--claim', 'Ambient source', '--kind', 'take', '--who', 'self',
      ]);
    });
    expect(pageLookups.some(params => params[0] === 'shared/page' && params[1] === 'dept')).toBe(true);
    expect(added[0]![0]!.page_id).toBe(22);
    expect(readFileSync(join(sourceDir, 'shared/page.md'), 'utf-8')).toContain('Ambient source');
  });

  test('selected source controls both the markdown path and the DB page', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-dept-'));
    const legacyDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-legacy-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(sourceDir, legacyDir, home);
    const { engine, added } = makeEngine({
      sourcePaths: { dept: sourceDir },
      legacyRepoPath: legacyDir,
    });
    await withEnv({ GBRAIN_SOURCE: 'dept', GBRAIN_HOME: home }, async () => {
      await runTakes(engine, [
        'add',
        'shared/page',
        '--claim',
        'Dept path and row',
        '--kind',
        'take',
        '--who',
        'self',
        '--source-id',
        'dept',
      ]);
    });

    expect(added[0]![0]!.page_id).toBe(22);
    expect(readFileSync(join(sourceDir, 'shared/page.md'), 'utf-8')).toContain('Dept path and row');
    expect(existsSync(join(legacyDir, 'shared/page.md'))).toBe(false);
  });

  test('update, supersede, and resolve keep using the selected source page', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-dept-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(sourceDir, home);
    const {
      engine,
      updatePageIds,
      supersedePageIds,
      resolvePageIds,
    } = makeEngine({ sourcePaths: { dept: sourceDir } });

    await withEnv({ GBRAIN_SOURCE: 'dept', GBRAIN_HOME: home }, async () => {
      await runTakes(engine, [
        'add', 'shared/page', '--claim', 'Original claim', '--kind', 'take', '--who', 'self', '--source-id', 'dept',
      ]);
      await runTakes(engine, [
        'update', 'shared/page', '--row', '1', '--weight', '0.8', '--source-id', 'dept',
      ]);
      await runTakes(engine, [
        'supersede', 'shared/page', '--row', '1', '--claim', 'Revised claim', '--source-id', 'dept',
      ]);
      await runTakes(engine, [
        'resolve', 'shared/page', '--row', '2', '--quality', 'correct', '--source-id', 'dept',
      ]);
    });

    expect(updatePageIds).toEqual([22]);
    expect(supersedePageIds).toEqual([22]);
    expect(resolvePageIds).toEqual([22]);
    const markdown = readFileSync(join(sourceDir, 'shared/page.md'), 'utf-8');
    expect(markdown).toContain('Revised claim');
    expect(markdown).toContain('correct');
  });

  test('canonical rejection leaves the take row unchanged', async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'gbrain-takes-dept-'));
    const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-home-'));
    tmpRoots.push(sourceDir, home);
    const { engine, updatePageIds } = makeEngine({ sourcePaths: { dept: sourceDir } });
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await runTakes(engine, [
        'add', 'shared/page', '--claim', 'Original', '--kind', 'take', '--who', 'self', '--source-id', 'dept',
      ]);
      const file = join(sourceDir, 'shared/page.md');
      const broken = `${readFileSync(file, 'utf8')}\n<!-- gbrain:learning-loop:v1:begin -->\n`;
      writeFileSync(file, broken);
      await expect(runTakes(engine, [
        'update', 'shared/page', '--row', '1', '--weight', '0.9', '--source-id', 'dept',
      ])).rejects.toThrow(/malformed/);
      expect(updatePageIds).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe(broken);
    });
  });
});
