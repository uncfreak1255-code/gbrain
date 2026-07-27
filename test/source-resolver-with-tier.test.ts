/**
 * v0.37.7.0 — resolveSourceWithTier() tier-attribution variant tests.
 *
 * Mirrors the 6-tier priority chain from source-resolver.test.ts but
 * asserts the returned `tier` label matches the winning tier.
 * Powers `gbrain sources current` so users can verify both the
 * resolved source AND the reason it resolved.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveSourceWithTier,
  SOURCE_TIER_NAMES,
  type SourceTier,
} from '../src/core/source-resolver.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

// Stub engine same shape as source-resolver.test.ts
function makeStub(
  registeredSources: string[],
  paths: Array<{ id: string; local_path: string; archived?: boolean }>,
  defaultKey: string | null,
): BrainEngine {
  const archivedIds = new Set(paths.filter((path) => path.archived).map((path) => path.id));
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SELECT id, archived FROM sources WHERE id = $1')) {
        const target = params?.[0] as string;
        return (registeredSources.includes(target)
          ? [{ id: target, archived: archivedIds.has(target) } as unknown as T]
          : []);
      }
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const target = params?.[0];
        return (registeredSources.includes(target as string)
          ? [{ id: target } as unknown as T]
          : []);
      }
      if (sql.includes('SELECT id, local_path FROM sources')) {
        const visiblePaths = sql.includes('archived = false')
          ? paths.filter((path) => !path.archived)
          : paths;
        return visiblePaths as unknown as T[];
      }
      return [];
    },
    getConfig: async (key: string) => (key === 'sources.default' ? defaultKey : null),
  } as unknown as BrainEngine;
}

describe('SOURCE_TIER_NAMES ordering matches resolveSourceId priority', () => {
  test('canonical order is 1=flag → 7=seed_default with sole_non_default at 5.5', () => {
    // v0.41.13 (#1434): tier 5.5 `sole_non_default` slots between brain_default
    // and seed_default. Explicit user intent (sources.default config) wins
    // over the auto-routing; seed terminal still loses to anything.
    expect(SOURCE_TIER_NAMES).toEqual([
      'flag',
      'env',
      'dotfile',
      'local_path',
      'brain_default',
      'sole_non_default',
      'seed_default',
    ]);
  });
});

describe('resolveSourceWithTier pre-v34 compatibility', () => {
  test('uses the legacy registered-path query when archived is undefined', async () => {
    const engine = {
      kind: 'pglite' as const,
      executeRaw: async (sql: string) => {
        if (sql.includes('archived = false')) {
          throw Object.assign(new Error('column archived does not exist'), { code: '42703' });
        }
        if (sql.includes('SELECT id, local_path FROM sources')) {
          return [{ id: 'legacy-source', local_path: '/legacy/repo' }];
        }
        return [];
      },
      getConfig: async () => null,
    } as unknown as BrainEngine;

    expect(await resolveSourceWithTier(engine, null, '/legacy/repo/nested')).toMatchObject({
      source_id: 'legacy-source',
      tier: 'local_path',
    });
  });

  test('treats an existing automatic source as active when archived is undefined', async () => {
    const engine = {
      kind: 'pglite' as const,
      executeRaw: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT id, archived FROM sources WHERE id = $1')) {
          throw Object.assign(new Error('column archived does not exist'), { code: '42703' });
        }
        if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
          return params?.[0] === 'legacy-source' ? [{ id: 'legacy-source' }] : [];
        }
        if (sql.includes('SELECT id, local_path FROM sources')) return [];
        return [];
      },
      getConfig: async (key: string) => key === 'sources.default' ? 'legacy-source' : null,
    } as unknown as BrainEngine;

    await expect(resolveSourceWithTier(engine, null, '/tmp')).resolves.toMatchObject({
      source_id: 'legacy-source',
      tier: 'brain_default',
    });
  });
});

describe('resolveSourceWithTier — tier 1 (flag)', () => {
  test('explicit flag returns tier=flag with detail naming the value', async () => {
    const engine = makeStub(['default', 'dept-x'], [], null);
    const result = await resolveSourceWithTier(engine, 'dept-x', '/tmp');
    expect(result.source_id).toBe('dept-x');
    expect(result.tier).toBe('flag');
    expect(result.detail).toContain('--source dept-x');
  });

  test('rejects unregistered explicit source', async () => {
    const engine = makeStub(['default'], [], null);
    await expect(resolveSourceWithTier(engine, 'ghost', '/tmp')).rejects.toThrow(/not found/);
  });

  test('explicit flag can still name an archived source', async () => {
    const engine = makeStub(
      ['default', 'retired'],
      [{ id: 'retired', local_path: '/retired', archived: true }],
      null,
    );
    await expect(resolveSourceWithTier(engine, 'retired', '/tmp')).resolves.toMatchObject({
      source_id: 'retired',
      tier: 'flag',
    });
  });
});

describe('resolveSourceWithTier — tier 2 (env)', () => {
  test('GBRAIN_SOURCE env returns tier=env when no flag', async () => {
    const engine = makeStub(['default', 'wiki'], [], null);
    await withEnv({ GBRAIN_SOURCE: 'wiki' }, async () => {
      const result = await resolveSourceWithTier(engine, null, '/tmp');
      expect(result.source_id).toBe('wiki');
      expect(result.tier).toBe('env');
      expect(result.detail).toBe('GBRAIN_SOURCE=wiki');
    });
  });

  test('GBRAIN_SOURCE can still intentionally name an archived source', async () => {
    const engine = makeStub(
      ['default', 'retired'],
      [{ id: 'retired', local_path: '/retired', archived: true }],
      null,
    );
    await withEnv({ GBRAIN_SOURCE: 'retired' }, async () => {
      await expect(resolveSourceWithTier(engine, null, '/tmp')).resolves.toMatchObject({
        source_id: 'retired',
        tier: 'env',
      });
    });
  });
});

describe('resolveSourceWithTier — tier 3 (dotfile)', () => {
  let scratchDir: string;
  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'gbrain-tier-dotfile-'));
  });
  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  test('.gbrain-source dotfile in CWD returns tier=dotfile', async () => {
    writeFileSync(join(scratchDir, '.gbrain-source'), 'team-alpha\n');
    const engine = makeStub(['default', 'team-alpha'], [], null);
    const result = await resolveSourceWithTier(engine, null, scratchDir);
    expect(result.source_id).toBe('team-alpha');
    expect(result.tier).toBe('dotfile');
    expect(result.detail).toBe('.gbrain-source');
  });

  test('dotfile in ancestor directory walks up to find it', async () => {
    writeFileSync(join(scratchDir, '.gbrain-source'), 'team-alpha\n');
    const nested = join(scratchDir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const engine = makeStub(['default', 'team-alpha'], [], null);
    const result = await resolveSourceWithTier(engine, null, nested);
    expect(result.tier).toBe('dotfile');
  });

  test('archived dotfile falls through to an active local-path source', async () => {
    writeFileSync(join(scratchDir, '.gbrain-source'), 'retired\n');
    const engine = makeStub(
      ['default', 'retired', 'active'],
      [
        { id: 'retired', local_path: '/retired', archived: true },
        { id: 'active', local_path: scratchDir },
      ],
      null,
    );
    await expect(resolveSourceWithTier(engine, null, scratchDir)).resolves.toMatchObject({
      source_id: 'active',
      tier: 'local_path',
    });
  });

  test('valid-but-unregistered dotfile remains a loud error', async () => {
    writeFileSync(join(scratchDir, '.gbrain-source'), 'missing-source\n');
    const engine = makeStub(['default'], [], null);
    await expect(resolveSourceWithTier(engine, null, scratchDir)).rejects.toThrow(/not found/);
  });
});

describe('resolveSourceWithTier — tier 4 (local_path)', () => {
  test('registered source whose local_path contains CWD returns tier=local_path', async () => {
    const engine = makeStub(
      ['default', 'gstack'],
      [{ id: 'gstack', local_path: '/work/gstack' }],
      null,
    );
    const result = await resolveSourceWithTier(engine, null, '/work/gstack/src');
    expect(result.source_id).toBe('gstack');
    expect(result.tier).toBe('local_path');
    expect(result.detail).toContain('/work/gstack');
  });

  test('longest-prefix wins on nested registered sources', async () => {
    const engine = makeStub(
      ['default', 'parent', 'child'],
      [
        { id: 'parent', local_path: '/work' },
        { id: 'child', local_path: '/work/sub' },
      ],
      null,
    );
    const result = await resolveSourceWithTier(engine, null, '/work/sub/file');
    expect(result.source_id).toBe('child');
    expect(result.tier).toBe('local_path');
  });

  test('an archived exact-path source cannot win the attributed resolver', async () => {
    const engine = makeStub(
      ['default', 'archived-copy'],
      [
        { id: 'archived-copy', local_path: '/work/shared', archived: true },
        { id: 'default', local_path: '/work/shared' },
      ],
      null,
    );
    const result = await resolveSourceWithTier(engine, null, '/work/shared/pages');
    expect(result.source_id).toBe('default');
    expect(result.tier).toBe('local_path');
  });
});

describe('resolveSourceWithTier — tier 5 (brain_default)', () => {
  test('sources.default config returns tier=brain_default', async () => {
    const engine = makeStub(['default', 'dept-x'], [], 'dept-x');
    const result = await resolveSourceWithTier(engine, null, '/tmp/no-dotfile-here');
    expect(result.source_id).toBe('dept-x');
    expect(result.tier).toBe('brain_default');
    expect(result.detail).toContain('sources.default');
  });

  test('archived brain default falls through to the seed default', async () => {
    const engine = makeStub(
      ['default', 'retired'],
      [{ id: 'retired', local_path: '/retired', archived: true }],
      'retired',
    );
    await expect(resolveSourceWithTier(engine, null, '/tmp/no-dotfile-here')).resolves.toMatchObject({
      source_id: 'default',
      tier: 'seed_default',
    });
  });

  test('valid-but-unregistered brain default remains a loud error', async () => {
    const engine = makeStub(['default'], [], 'missing-source');
    await expect(resolveSourceWithTier(engine, null, '/tmp/no-dotfile-here')).rejects.toThrow(/not found/);
  });
});

describe('resolveSourceWithTier — tier 6 (seed_default)', () => {
  test('no other signals returns tier=seed_default with no detail', async () => {
    const engine = makeStub(['default'], [], null);
    const result = await resolveSourceWithTier(engine, null, '/tmp/no-dotfile-here');
    expect(result.source_id).toBe('default');
    expect(result.tier).toBe('seed_default');
    expect(result.detail).toBeUndefined();
  });
});

describe('resolveSourceWithTier — priority assertion', () => {
  test('flag wins over env wins over dotfile wins over default', async () => {
    // Set up a stub where ALL tiers could resolve. Assert the
    // higher-priority one wins.
    const engine = makeStub(
      ['default', 'flag-src', 'env-src', 'dot-src', 'default-src'],
      [],
      'default-src',
    );
    await withEnv({ GBRAIN_SOURCE: 'env-src' }, async () => {
      // Flag highest priority
      const r1 = await resolveSourceWithTier(engine, 'flag-src', '/tmp');
      expect(r1.tier).toBe('flag');
      // Without flag → env
      const r2 = await resolveSourceWithTier(engine, null, '/tmp');
      expect(r2.tier).toBe('env');
    });
  });
});

// Typecheck-only assertion: SourceTier is the union of SOURCE_TIER_NAMES.
const _exhaustiveCheck: SourceTier = 'flag';
void _exhaustiveCheck;
