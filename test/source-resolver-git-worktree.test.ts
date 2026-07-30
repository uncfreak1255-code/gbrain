/**
 * Codex-linked worktrees should inherit the source registered for the main
 * checkout. The durable signal is git's common dir, not per-worktree
 * .gbrain-source files.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveSourceId, resolveSourceWithTier } from '../src/core/source-resolver.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function makeGitWorktreeFixture(): { root: string; main: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-source-worktree-'));
  roots.push(root);

  const main = join(root, 'main');
  const worktree = join(root, 'linked');
  mkdirSync(main);
  execFileSync('git', ['init', main], { stdio: 'ignore' });
  git(main, ['config', 'user.email', 'gbrain-test@example.invalid']);
  git(main, ['config', 'user.name', 'GBrain Test']);
  mkdirSync(join(main, 'plans'));
  writeFileSync(join(main, 'README.md'), '# fixture\n');
  writeFileSync(join(main, 'plans', 'README.md'), '# plans\n');
  git(main, ['add', 'README.md', 'plans/README.md']);
  git(main, ['commit', '-m', 'fixture']);
  git(main, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  mkdirSync(join(worktree, 'nested'), { recursive: true });
  mkdirSync(join(worktree, 'plans', 'nested'), { recursive: true });

  return { root, main, worktree };
}

function makeStub(localPath: string): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        return params?.[0] === 'gbrain' ? [{ id: 'gbrain' } as T] : [];
      }
      if (sql.includes('SELECT id, local_path')) {
        return [{
          id: 'gbrain',
          local_path: localPath,
          archived: false,
          draining: false,
          drain_requires_hygiene_candidate: false,
        } as T];
      }
      return [];
    },
    getConfig: async () => null,
  } as unknown as BrainEngine;
}

function makeNestedStub(mainPath: string): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const ids = new Set(['gbrain', 'gbrain-plans']);
        return ids.has(params?.[0] as string) ? [{ id: params?.[0] } as T] : [];
      }
      if (sql.includes('SELECT id, local_path')) {
        return [
          {
            id: 'gbrain',
            local_path: mainPath,
            archived: false,
            draining: false,
            drain_requires_hygiene_candidate: false,
          },
          {
            id: 'gbrain-plans',
            local_path: join(mainPath, 'plans'),
            archived: false,
            draining: false,
            drain_requires_hygiene_candidate: false,
          },
        ] as T[];
      }
      return [];
    },
    getConfig: async () => null,
  } as unknown as BrainEngine;
}

describe('source resolver git worktree propagation', () => {
  test('resolveSourceId matches a linked worktree by git common dir', async () => {
    const fixture = makeGitWorktreeFixture();
    const engine = makeStub(fixture.main);

    await expect(resolveSourceId(engine, null, join(fixture.worktree, 'nested')))
      .resolves.toBe('gbrain');
  });

  test('resolveSourceWithTier reports linked worktree matches as local_path tier', async () => {
    const fixture = makeGitWorktreeFixture();
    const engine = makeStub(fixture.main);

    const result = await resolveSourceWithTier(engine, null, join(fixture.worktree, 'nested'));

    expect(result.source_id).toBe('gbrain');
    expect(result.tier).toBe('local_path');
    expect(result.detail).toContain('git worktree');
  });

  test('linked worktree matching preserves nested source subpaths', async () => {
    const fixture = makeGitWorktreeFixture();
    const engine = makeNestedStub(fixture.main);

    const rootResult = await resolveSourceWithTier(engine, null, join(fixture.worktree, 'nested'));
    const nestedResult = await resolveSourceWithTier(engine, null, join(fixture.worktree, 'plans', 'nested'));

    expect(rootResult.source_id).toBe('gbrain');
    expect(rootResult.detail).toContain('git worktree');
    expect(nestedResult.source_id).toBe('gbrain-plans');
    expect(nestedResult.detail).toContain('plans');
  });
});
