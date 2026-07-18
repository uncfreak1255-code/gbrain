/**
 * #2404 — `ops/` is ordinary content: sync imports `ops/*` files and never
 * deletes deliberate pages under excluded directories on a file edit.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;

function gitInit(repo: string): void {
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
}

describe('#2404 — ops/ pages sync like ordinary content', () => {
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
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-ops-'));
    gitInit(repoPath);
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(join(repoPath, 'topics/foo.md'), [
      '---', 'type: concept', 'title: Foo', '---', '', 'Baseline content.',
    ].join('\n'));
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('a committed ops/*.md file is imported by full sync', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    mkdirSync(join(repoPath, 'ops'), { recursive: true });
    writeFileSync(join(repoPath, 'ops/tasks.md'), [
      '---', 'type: concept', 'title: Tasks', '---', '', 'Open tasks live here.',
    ].join('\n'));
    execSync('git add -A && git commit -m "add ops/tasks"', { cwd: repoPath, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    expect(['first_sync', 'synced']).toContain(result.status);
    const page = await engine.getPage('ops/tasks');
    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('Open tasks');
  }, 60_000);

  test('an edited ops/*.md updates instead of deleting its page', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    mkdirSync(join(repoPath, 'ops'), { recursive: true });
    writeFileSync(join(repoPath, 'ops/tasks.md'), [
      '---', 'type: concept', 'title: Tasks', '---', '', 'v1',
    ].join('\n'));
    execSync('git add -A && git commit -m "add ops/tasks"', { cwd: repoPath, stdio: 'pipe' });
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });

    writeFileSync(join(repoPath, 'ops/tasks.md'), [
      '---', 'type: concept', 'title: Tasks', '---', '', 'v2 with a new task',
    ].join('\n'));
    execSync('git add -A && git commit -m "edit ops/tasks"', { cwd: repoPath, stdio: 'pipe' });
    const second = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(['synced', 'up_to_date', 'first_sync']).toContain(second.status);
    const page = await engine.getPage('ops/tasks');
    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('v2');
  }, 60_000);

  test('a deliberate page under a still-pruned dir survives a file edit', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    mkdirSync(join(repoPath, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(repoPath, 'node_modules/pkg/notes.md'), 'v1\n');
    execSync('git add -A -f && git commit -m "vendor file"', { cwd: repoPath, stdio: 'pipe' });
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });

    await engine.putPage('node_modules/pkg/notes', {
      type: 'concept',
      title: 'Deliberate put page',
      compiled_truth: 'Created via put_page; must survive sync.',
      timeline: '',
      frontmatter: { type: 'concept' },
    });

    writeFileSync(join(repoPath, 'node_modules/pkg/notes.md'), 'v2\n');
    execSync('git add -A -f && git commit -m "edit vendor file"', { cwd: repoPath, stdio: 'pipe' });
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(await engine.getPage('node_modules/pkg/notes')).not.toBeNull();
  }, 60_000);
});
