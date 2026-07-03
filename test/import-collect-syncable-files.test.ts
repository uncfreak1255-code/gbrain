import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { collectSyncableFiles } from '../src/commands/import.ts';
import { resolveRepoLocalSyncExcludes } from '../src/core/sync.ts';

function gitInit(repo: string): void {
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
}

function seedRepo(repo: string, packageName: string): void {
  gitInit(repo);
  mkdirSync(join(repo, 'people'), { recursive: true });
  mkdirSync(join(repo, 'test/fixtures/calibration/extract-takes-corpus'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: packageName, version: '0.0.0' }, null, 2),
  );
  writeFileSync(join(repo, 'people/alice.md'), '---\ntype: person\ntitle: Alice\n---\n');
  writeFileSync(
    join(repo, 'test/fixtures/calibration/extract-takes-corpus/people-alice-example.md'),
    '---\ntype: people\ntitle: Alice Example\nslug: people/alice-example\n---\n',
  );
  execSync('git add -A && git commit -m "seed files"', { cwd: repo, stdio: 'pipe' });
}

describe('collectSyncableFiles', () => {
  test('gbrain repo skips synthetic calibration corpus during markdown sync walks', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-collect-syncable-'));
    try {
      seedRepo(repo, 'gbrain');
      expect(resolveRepoLocalSyncExcludes(repo)).toEqual(['test/fixtures/calibration/**']);

      const files = collectSyncableFiles(repo, { strategy: 'markdown' })
        .map((p) => p.replace(`${repo}/`, ''))
        .sort();

      expect(files).toEqual(['people/alice.md']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('non-gbrain repos keep the same path syncable', () => {
    const repo = mkdtempSync(join(tmpdir(), 'generic-collect-syncable-'));
    try {
      seedRepo(repo, 'example-repo');
      expect(resolveRepoLocalSyncExcludes(repo)).toEqual([]);

      const files = collectSyncableFiles(repo, { strategy: 'markdown' })
        .map((p) => p.replace(`${repo}/`, ''))
        .sort();

      expect(files).toEqual([
        'people/alice.md',
        'test/fixtures/calibration/extract-takes-corpus/people-alice-example.md',
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('shared sync gate excludes metafiles during git-backed full-sync collection', () => {
    const repo = mkdtempSync(join(tmpdir(), 'metafile-collect-syncable-'));
    try {
      gitInit(repo);
      mkdirSync(join(repo, 'people'), { recursive: true });
      mkdirSync(join(repo, 'website/docs'), { recursive: true });
      writeFileSync(
        join(repo, 'package.json'),
        JSON.stringify({ name: 'example-repo', version: '0.0.0' }, null, 2),
      );
      writeFileSync(join(repo, 'README.md'), '# Repo\n');
      writeFileSync(join(repo, 'website/docs/index.md'), '---\nslug: /\n---\n');
      writeFileSync(join(repo, 'people/alice.md'), '---\ntype: person\ntitle: Alice\n---\n');
      execSync('git add -A && git commit -m "seed metafiles"', { cwd: repo, stdio: 'pipe' });

      const files = collectSyncableFiles(repo, { strategy: 'markdown' })
        .map((p) => p.replace(`${repo}/`, ''))
        .sort();

      expect(files).toEqual(['people/alice.md']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
