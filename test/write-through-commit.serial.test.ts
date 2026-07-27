/**
 * #2426 — write-through reaches git only on durability-hardened repos.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { writePageThrough } from '../src/core/write-through.ts';

let engine: PGLiteEngine;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}

function installFakeDurabilityHook(repoPath: string): void {
  const hooksDir = join(repoPath, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'post-commit');
  writeFileSync(hookPath, [
    '#!/usr/bin/env bash',
    '# gbrain brain-durability post-commit hook (v0.42.44+)',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(hookPath, 0o755);
}

async function seedPage(slug: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'concept',
    title: 'Write-through page',
    compiled_truth: 'Content that must reach git.',
    timeline: '',
    frontmatter: { type: 'concept' },
  });
}

describe('#2426 — writePageThrough auto-commit', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repo = mkdtempSync(join(tmpdir(), 'gbrain-wt-'));
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
    // Keep the fixture independent of an operator-level core.hooksPath. The
    // fake durability hook below belongs to this disposable repository only.
    execSync('git config --local core.hooksPath .git/hooks', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'seed.md'), 'seed\n');
    execSync('git add -A && git commit -m init', { cwd: repo, stdio: 'pipe' });
    await engine.setConfig('sync.repo_path', repo);
  });

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test('a hardened repo commits only the write-through artifact', async () => {
    installFakeDurabilityHook(repo);
    writeFileSync(join(repo, 'seed.md'), 'dirty unrelated edit\n');
    await seedPage('notes/hello');
    const result = await writePageThrough(engine, 'notes/hello');

    expect(result.written).toBe(true);
    expect(result.committed).toBe(true);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('gbrain: write-through notes/hello');
    expect(git(repo, 'log', '-1', '--name-only', '--format=')).toBe('notes/hello.md');
    expect(git(repo, 'status', '--porcelain', 'notes/hello.md')).toBe('');
    expect(git(repo, 'status', '--porcelain', 'seed.md')).not.toBe('');
  }, 60_000);

  test('an unhardened repo writes without committing', async () => {
    await seedPage('notes/plain');
    const result = await writePageThrough(engine, 'notes/plain');
    expect(result.written).toBe(true);
    expect(result.committed).toBeUndefined();
    expect(git(repo, 'status', '--porcelain', 'notes/plain.md')).toContain('?? notes/plain.md');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('init');
  }, 60_000);
});
