import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runExport } from '../src/commands/export.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { getRecoveryBackedSourceCheckout, withRecoverySourceWriteBoundary } from '../src/core/recovery-source-refresh.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { renderLearningLoopFence } from '../src/core/learning-loop-knowledge.ts';
import { computeBrainIdFromConfig } from '../src/core/upgrade-checkpoint.ts';
import { armLearningLoop, setLearningLoopMode } from '../src/core/learning-loop.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let recoveryRepo: string;
let previousGbrainHome: string | undefined;

function commitRecoveryCheckout(repoPath: string, message: string): void {
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'GBrain Test'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', message], { cwd: repoPath, stdio: 'pipe' });
}

function gitStatus(repoPath: string): string[] {
  return execFileSync('git', ['status', '--short'], {
    cwd: repoPath,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);
}

function makeCtx(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
  };
}

async function activeSlugs(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug
       FROM pages
      WHERE source_id = 'default' AND deleted_at IS NULL
      ORDER BY slug`,
  );
  return rows.map((row) => row.slug);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-recovery-refresh-'));
  previousGbrainHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpRoot;
  recoveryRepo = path.join(tmpRoot, 'recovery');
});

afterEach(() => {
  if (previousGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = previousGbrainHome;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('recovery-backed source refresh', () => {
  test('ignores a recovery manifest for another source', async () => {
    fs.mkdirSync(recoveryRepo, { recursive: true });
    fs.writeFileSync(
      path.join(recoveryRepo, '.gbrain-export-manifest.json'),
      JSON.stringify({ source_id: 'another-source', schema_version: 99 }),
    );
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
      [recoveryRepo],
    );

    expect(await getRecoveryBackedSourceCheckout(engine, 'default')).toBeNull();
  });

  test('fails closed for a malformed same-source recovery manifest', async () => {
    fs.mkdirSync(recoveryRepo, { recursive: true });
    fs.writeFileSync(
      path.join(recoveryRepo, '.gbrain-export-manifest.json'),
      '{not valid json',
    );
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
      [recoveryRepo],
    );

    await expect(getRecoveryBackedSourceCheckout(engine, 'default'))
      .rejects.toThrow('could not parse .gbrain-export-manifest.json');
  });

  test('put_page refreshes the sealed checkout and keeps legacy slug identity syncable', async () => {
    const legacySlug = 'notes/legacy slug';
    const newSlug = 'wiki/sessions/recovery-refresh-note';
    await engine.putPage(
      legacySlug,
      {
        type: 'note',
        title: 'Legacy fixture',
        compiled_truth: 'legacy body',
        timeline: '',
        frontmatter: {},
        source_path: `${legacySlug}.md`,
      },
      { sourceId: 'default' },
    );

    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);
    commitRecoveryCheckout(recoveryRepo, 'source recovery fixture');
    await engine.executeRaw(
      `UPDATE sources
          SET local_path = $1,
              config = jsonb_set(config, '{remote_url}', to_jsonb($2::text), true)
        WHERE id = 'default'`,
      [recoveryRepo, 'https://example.com/gbrain-default.git'],
    );

    const putPage = operations.find((op) => op.name === 'put_page');
    expect(putPage).toBeDefined();
    const result = await putPage!.handler(makeCtx(), {
      slug: newSlug,
      content: '---\ntitle: Refresh note\n---\n\nbody',
    }) as {
      write_through?: {
        written: boolean;
        refreshed?: boolean;
        committed?: boolean;
        path?: string;
        preserved_path?: string;
      };
    };

    expect(result.write_through?.written).toBe(true);
    expect(result.write_through?.refreshed).toBe(true);
    expect(result.write_through?.committed).toBe(true);
    expect(result.write_through?.path).toBe(
      fs.realpathSync(path.join(recoveryRepo, `${newSlug}.md`)),
    );
    expect(result.write_through?.preserved_path).toBeDefined();
    expect(fs.existsSync(result.write_through!.preserved_path!)).toBe(true);
    const sourcePathRows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = 'default'`,
    );
    expect(sourcePathRows[0]?.local_path).toBe(recoveryRepo);
    expect(gitStatus(recoveryRepo)).toEqual([]);
    expect(execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: recoveryRepo,
      encoding: 'utf8',
    }).trim()).toBe('https://example.com/gbrain-default.git');

    const manifest = JSON.parse(
      fs.readFileSync(path.join(recoveryRepo, '.gbrain-export-manifest.json'), 'utf8'),
    ) as {
      source_page_count: number;
      page_count: number;
      pages: Array<{ slug: string }>;
    };
    expect(manifest.source_page_count).toBe(2);
    expect(manifest.page_count).toBe(2);
    expect(manifest.pages.map((page) => page.slug)).toEqual([legacySlug, newSlug]);

    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, {
      repoPath: recoveryRepo,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    expect(await activeSlugs()).toEqual([legacySlug, newSlug]);
    expect(gitStatus(recoveryRepo)).toEqual([]);
  });

  test('managed put_page carries protected metadata through checkout rebuild', async () => {
    const slug = 'notes/managed-recovery';
    const brainId = computeBrainIdFromConfig(engine.learningLoopLedgerConfig());
    const fence = renderLearningLoopFence({
      brain_id: brainId, source_id: 'default', canonical_slug: slug,
      managed_rows: {}, blocked_identities: [], correction_lineages: {},
      reversal_attempts: {}, immutable_commit_markers: [], pending_delivery: null,
    });
    await engine.putPage(slug, {
      type: 'note', title: 'Managed before', compiled_truth: `Before.\n\n${fence}`,
      timeline: '', frontmatter: {}, source_path: `${slug}.md`,
    }, { sourceId: 'default' });

    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);
    commitRecoveryCheckout(recoveryRepo, 'managed recovery fixture');
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1,
         config = jsonb_set(config, '{remote_url}', to_jsonb($2::text), true)
       WHERE id = 'default'`,
      [recoveryRepo, 'https://example.com/gbrain-default.git'],
    );

    const putPage = operations.find((op) => op.name === 'put_page')!;
    const result = await putPage.handler(makeCtx(), {
      slug,
      content: `---\ntitle: Managed after\nslug: ${slug}\n---\n\nAfter.\n`,
    }) as { write_through?: { written: boolean; refreshed?: boolean } };

    expect(result.write_through?.written).toBe(true);
    expect(result.write_through?.refreshed).toBe(true);
    const readback = fs.readFileSync(path.join(recoveryRepo, `${slug}.md`), 'utf8');
    expect(readback).toContain('After.');
    expect(readback).toContain(fence);
    expect(gitStatus(recoveryRepo)).toEqual([]);
  });

  test('active V2 run refuses recovery before changing the frozen checkout inode', async () => {
    const corpus = path.join(tmpRoot, 'corpus');
    const config = { engine: 'pglite' as const };
    fs.mkdirSync(corpus, { recursive: true });
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);
    commitRecoveryCheckout(recoveryRepo, 'active V2 recovery fixture');
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [recoveryRepo]);
    await setLearningLoopMode(engine, config, 'canary');
    await engine.setConfig('learning_loop.corpus.codex.root', corpus);
    await engine.setConfig('learning_loop.corpus.codex.source_id', 'default');
    await armLearningLoop({
      command_id: 'recovery-active-v2', contract_version: 2, engine, config,
      authorized_adapter: { client_id: 'codex-test', source_id: 'default', provider: 'codex' },
      destination: { source_id: 'default', canonical_slug: 'notes/frozen' },
    });
    const before = fs.statSync(recoveryRepo);

    await expect(withRecoverySourceWriteBoundary(engine, 'default', async () => true))
      .rejects.toThrow('active V2 run freezes source');
    const after = fs.statSync(recoveryRepo);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(gitStatus(recoveryRepo)).toEqual([]);
  });
});
