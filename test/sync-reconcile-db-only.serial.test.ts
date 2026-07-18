/**
 * #2426 — full-sync reconciliation preserves never-committed write-through
 * pages while still removing genuinely deleted file-backed pages.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { listEverCommittedPaths } from '../src/commands/sync.ts';
import { persistSavedIdea } from '../src/commands/brainstorm.ts';

let engine: PGLiteEngine;
let repoPath: string;

function gitInit(repo: string): void {
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
}

describe('listEverCommittedPaths (#2426)', () => {
  test('returns added paths including deleted ones; null for non-git dirs', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-ecp-'));
    try {
      gitInit(repo);
      writeFileSync(join(repo, 'kept.md'), 'kept\n');
      writeFileSync(join(repo, 'gone.md'), 'gone\n');
      execSync('git add -A && git commit -m add', { cwd: repo, stdio: 'pipe' });
      execSync('git rm -q gone.md && git commit -m rm', { cwd: repo, stdio: 'pipe' });
      const set = listEverCommittedPaths(repo);
      expect(set).not.toBeNull();
      expect(set!.has('kept.md')).toBe(true);
      expect(set!.has('gone.md')).toBe(true);
      expect(set!.has('never-committed.md')).toBe(false);

      const plain = mkdtempSync(join(tmpdir(), 'gbrain-ecp-plain-'));
      try {
        expect(listEverCommittedPaths(plain)).toBeNull();
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('#2426 — full sync keeps never-committed pages', () => {
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
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-dbonly-'));
    gitInit(repoPath);
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/keep.md'), [
      '---', 'type: concept', 'title: Keep', '---', '', 'still here',
    ].join('\n'));
    writeFileSync(join(repoPath, 'topics/gone.md'), [
      '---', 'type: concept', 'title: Gone', '---', '', 'will be removed',
    ].join('\n'));
    execSync('git add -A && git commit -m initial', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('genuine deletes reconcile; DB-only pages survive and re-export', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(engine, {
      repoPath, full: true, sourceId: 'default', noPull: true, noEmbed: true,
    });
    expect(['first_sync', 'synced']).toContain(first.status);

    const saved = await persistSavedIdea(engine, {
      slug: 'memories/lost',
      content: [
        '---', 'type: concept', 'title: Lost write-through', '---', '',
        'Years of content that must not be reconciled away.',
      ].join('\n'),
      provenanceVia: 'lsd',
    });
    expect(saved.dbSaved).toBe(true);
    expect(saved.writeThrough.written).toBe(true);
    rmSync(join(repoPath, 'memories/lost.md'));

    execSync('git rm -q topics/gone.md && git commit -m "rm gone"', { cwd: repoPath, stdio: 'pipe' });
    const second = await performSync(engine, {
      repoPath, full: true, sourceId: 'default', noPull: true, noEmbed: true,
    });
    expect(['first_sync', 'synced']).toContain(second.status);
    expect(await engine.getPage('topics/gone')).toBeNull();
    expect(await engine.getPage('topics/keep')).not.toBeNull();
    const lost = await engine.getPage('memories/lost');
    expect(lost).not.toBeNull();
    expect(lost?.compiled_truth).toContain('must not be reconciled');
    expect(existsSync(join(repoPath, 'memories/lost.md'))).toBe(true);
  }, 120_000);

  test('a deleted untracked sync import is not mistaken for write-through', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, {
      repoPath, full: true, sourceId: 'default', noPull: true, noEmbed: true,
    });

    mkdirSync(join(repoPath, 'drafts'), { recursive: true });
    writeFileSync(join(repoPath, 'drafts/untracked.md'), [
      '---', 'type: concept', 'title: Untracked', 'source_kind: user-authored',
      'ingested_via: put_page', '---', '',
      'temporary draft',
    ].join('\n'));
    await performSync(engine, {
      repoPath, full: true, sourceId: 'default', noPull: true, noEmbed: true,
    });
    expect(await engine.getPage('drafts/untracked')).not.toBeNull();

    rmSync(join(repoPath, 'drafts/untracked.md'));
    await performSync(engine, {
      repoPath, full: true, sourceId: 'default', noPull: true, noEmbed: true,
    });
    expect(await engine.getPage('drafts/untracked')).toBeNull();
  }, 120_000);
});
