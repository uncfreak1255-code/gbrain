/**
 * #2607 — full-sync git enumeration uses the same exclusions as incremental
 * sync.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { collectSyncableFiles } from '../src/commands/import.ts';
import { isSyncable } from '../src/core/sync.ts';

let repo: string;

function rel(files: string[]): string[] {
  return files.map((file) => relative(repo, file));
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gbrain-fastpath-'));
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });

  mkdirSync(join(repo, 'notes'), { recursive: true });
  writeFileSync(join(repo, 'notes/real.md'), '---\ntitle: Real\n---\nbody\n');
  mkdirSync(join(repo, 'ops'), { recursive: true });
  writeFileSync(join(repo, 'ops/tasks.md'), '---\ntitle: Tasks\n---\nbody\n');

  mkdirSync(join(repo, '.obsidian'), { recursive: true });
  writeFileSync(join(repo, '.obsidian/plugin-notes.md'), 'not a page\n');
  mkdirSync(join(repo, 'vendor/pkg'), { recursive: true });
  writeFileSync(join(repo, 'vendor/pkg/notes.md'), 'vendored\n');
  mkdirSync(join(repo, 'node_modules/dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules/dep/CHANGELOG.md'), 'dep changelog\n');
  mkdirSync(join(repo, 'people/pedro.raw'), { recursive: true });
  writeFileSync(join(repo, 'people/pedro.raw/source.md'), 'raw sidecar\n');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  writeFileSync(join(repo, 'notes/index.md'), '# index\n');

  execSync('git add -A -f && git commit -m "fixture"', { cwd: repo, stdio: 'pipe' });
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('#2607 — full and incremental sync exclusions agree', () => {
  test('tracked files under pruned dirs are not collected', () => {
    const files = rel(collectSyncableFiles(repo, { strategy: 'markdown' }));
    expect(files).toContain('notes/real.md');
    expect(files).toContain('ops/tasks.md');
    expect(files).not.toContain('.obsidian/plugin-notes.md');
    expect(files).not.toContain('vendor/pkg/notes.md');
    expect(files).not.toContain('node_modules/dep/CHANGELOG.md');
    expect(files).not.toContain('people/pedro.raw/source.md');
    expect(files).not.toContain('README.md');
    expect(files).not.toContain('notes/index.md');
  });

  test('every collected file is incrementally syncable', () => {
    const files = rel(collectSyncableFiles(repo, { strategy: 'markdown' }));
    for (const path of files) {
      expect({ path, syncable: isSyncable(path) }).toEqual({ path, syncable: true });
    }
    expect(files.length).toBeGreaterThan(0);
  });
});
