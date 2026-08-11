/**
 * Regression fixture for source-scoped recovery export identity.
 *
 * A historical row can have a safe stored slug that does not round-trip through
 * the current filesystem slugifier. Recovery export must not turn that row
 * into a second active page when its output is synced back into an isolated
 * checkout.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExport } from '../src/commands/export.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { planReconcileDeletes } from '../src/commands/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let tmp: string;
let recoveryRepo: string;

function commitRecoveryCheckout(repoPath: string): void {
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'GBrain Test'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'source recovery fixture'], { cwd: repoPath, stdio: 'pipe' });
}

function commitAll(repoPath: string, message: string): void {
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'GBrain Test'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
  // Cloned updater fixtures do not inherit the seed checkout's local Git
  // identity on Actions. Keep the author fixture-local rather than depending
  // on a runner-wide Git config.
  execFileSync(
    'git',
    ['-c', 'user.email=test@example.invalid', '-c', 'user.name=GBrain Test', 'commit', '-m', message],
    { cwd: repoPath, stdio: 'pipe' },
  );
}

function writeRecoveryManifest(
  repoPath: string,
  slugs: string[],
  dbContentHash: string | null,
): void {
  writeFileSync(
    join(repoPath, '.gbrain-export-manifest.json'),
    JSON.stringify({
      schema_version: 1,
      source_id: 'default',
      source_page_count: slugs.length,
      page_count: slugs.length,
      raw_sidecar_count: 0,
      pages: slugs.map(slug => ({
        slug,
        db_content_hash: dbContentHash,
        markdown_sha256: createHash('sha256')
          .update(readFileSync(join(repoPath, `${slug}.md`)))
          .digest('hex'),
      })),
    }),
  );
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not reserve a loopback port for git daemon'));
        return;
      }
      server.close(error => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForGitDaemon(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const connected = await new Promise<boolean>(resolveConnection => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.end();
        resolveConnection(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolveConnection(false);
      });
    });
    if (connected) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
  }
  throw new Error(`git daemon did not listen on 127.0.0.1:${port}`);
}

async function startGitDaemon(root: string): Promise<{ daemon: ChildProcess; port: number }> {
  const port = await reserveLoopbackPort();
  const daemon = spawn('git', [
    'daemon',
    '--reuseaddr',
    '--export-all',
    `--base-path=${root}`,
    `--port=${port}`,
    '--listen=127.0.0.1',
    root,
  ], { stdio: 'ignore' });
  try {
    await waitForGitDaemon(port);
  } catch (error) {
    await stopGitDaemon(daemon);
    throw error;
  }
  return { daemon, port };
}

async function stopGitDaemon(daemon: ChildProcess): Promise<void> {
  if (daemon.exitCode !== null) return;
  await new Promise<void>(resolveExit => {
    daemon.once('exit', () => resolveExit());
    daemon.kill();
  });
}

async function seedLegacyPage(): Promise<string> {
  const legacySlug = 'notes/legacy slug';
  await engine.putPage(
    legacySlug,
    {
      type: 'note',
      title: 'Legacy recovery fixture',
      compiled_truth: 'Generic fixture body.',
      timeline: '',
      frontmatter: {},
      source_path: `${legacySlug}.md`,
    },
    { sourceId: 'default' },
  );
  return legacySlug;
}

async function activeSlugs(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL
      ORDER BY slug`,
    ['default'],
  );
  return rows.map(row => row.slug);
}

describe('source-scoped recovery export slug identity', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    tmp = mkdtempSync(join(tmpdir(), 'gbrain-export-sync-slug-'));
    recoveryRepo = join(tmp, 'recovery');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('keeps a legacy stored slug instead of creating its path-derived duplicate', async () => {
    const legacySlug = await seedLegacyPage();
    const pathDerivedSlug = slugifyPath(`${legacySlug}.md`);
    expect(pathDerivedSlug).toBe('notes/legacy-slug');

    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);
    commitRecoveryCheckout(recoveryRepo);

    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, {
      repoPath: recoveryRepo,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    expect(await activeSlugs()).toEqual([legacySlug]);

    // A source recovery is a static trusted snapshot, not a one-use escape
    // hatch. Once it has restored the legacy identity, the unchanged checkout
    // must remain syncable without reissuing or weakening the receipt.
    await performSync(engine, {
      repoPath: recoveryRepo,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    expect(await activeSlugs()).toEqual([legacySlug]);
  });

  test('does not reconcile-delete a recovery-manifest-owned legacy page', () => {
    const rows = [{ slug: 'notes/legacy slug', source_path: 'historical/location-before-recovery.md' }];
    const isMarkdown = (path: string) => path.endsWith('.md');

    expect(
      planReconcileDeletes(rows, ['notes/legacy slug.md'], isMarkdown).staleSlugs,
    ).toEqual(['notes/legacy slug']);
    expect(
      planReconcileDeletes(
        rows,
        ['notes/legacy slug.md'],
        isMarkdown,
        new Set(['notes/legacy slug']),
      ).staleSlugs,
    ).toEqual([]);
  });

  test('preserves code-page identity during a source-scoped recovery sync', async () => {
    const sourcePath = 'src/example.ts';
    const source = 'export const answer = 42;\n';
    const codeSlug = 'src-example-ts';
    await engine.putPage(
      codeSlug,
      {
        type: 'note',
        page_kind: 'code',
        title: 'src/example.ts (typescript)',
        compiled_truth: source,
        timeline: '',
        frontmatter: { language: 'typescript' },
        source_path: sourcePath,
      },
      { sourceId: 'default' },
    );
    await engine.putPage(
      'notes/recovery-markdown',
      {
        type: 'note',
        title: 'Recovery markdown fixture',
        compiled_truth: 'A markdown recovery page.\n',
        timeline: '',
        frontmatter: {},
        source_path: 'notes/recovery-markdown.md',
      },
      { sourceId: 'default' },
    );

    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);
    const manifest = JSON.parse(
      readFileSync(join(recoveryRepo, '.gbrain-export-manifest.json'), 'utf8'),
    ) as { pages: Array<{ slug: string; page_kind?: string; source_path?: string }> };
    expect(manifest.pages).toContainEqual(
      expect.objectContaining({ slug: codeSlug, page_kind: 'code', source_path: sourcePath }),
    );
    expect(readFileSync(join(recoveryRepo, `${codeSlug}.md`), 'utf8')).toBe(source);
    commitRecoveryCheckout(recoveryRepo);

    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, {
      repoPath: recoveryRepo,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    const restored = await engine.getPage(codeSlug, { sourceId: 'default' });
    expect(restored?.type).toBe('code');
    expect(restored?.compiled_truth).toBe(source);
    const restoredRows = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages WHERE source_id = $1 AND slug = $2`,
      ['default', codeSlug],
    );
    expect(restoredRows[0]?.source_path).toBe(sourcePath);
    expect(await activeSlugs()).toEqual(['notes/recovery-markdown', codeSlug]);
  });

  test('fails closed when a recovery checkout adds an unlisted Markdown page', async () => {
    const legacySlug = await seedLegacyPage();
    const unlistedPath = 'notes/legacy-slug.md';
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);
    writeFileSync(
      join(recoveryRepo, unlistedPath),
      '---\ntype: note\ntitle: Unlisted recovery file\n---\n\nMust not be imported.\n',
    );
    commitRecoveryCheckout(recoveryRepo);

    const { performSync } = await import('../src/commands/sync.ts');
    await expect(performSync(engine, {
      repoPath: recoveryRepo,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    })).rejects.toThrow(`unexpected recovery file ${unlistedPath}`);

    expect(await activeSlugs()).toEqual([legacySlug]);
  });

  test('keeps the recovery checkout sealed after capabilities are issued', async () => {
    const legacySlug = await seedLegacyPage();
    const unlistedPath = 'notes/legacy-slug.md';
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);

    const {
      getVerifiedRecoverySlugOverrideForPath,
      loadVerifiedRecoverySlugOverrides,
    } = await import('../src/core/source-recovery-manifest.ts');
    const overrides = await loadVerifiedRecoverySlugOverrides(engine, recoveryRepo, 'default');
    writeFileSync(
      join(recoveryRepo, unlistedPath),
      '---\ntype: note\ntitle: Late unlisted recovery file\n---\n\nMust not be imported.\n',
    );

    expect(() => getVerifiedRecoverySlugOverrideForPath(
      overrides,
      recoveryRepo,
      unlistedPath,
    )).toThrow(`unexpected recovery file ${unlistedPath}`);
    expect(await activeSlugs()).toEqual([legacySlug]);
  });

  test('rejects an older markdown-only recovery receipt before a code sync can reconcile it', async () => {
    const codeSlug = 'src/recovery-fixture-ts';
    const code = 'export const recoveryFixture = true;\n';
    await engine.putPage(
      codeSlug,
      {
        type: 'code',
        page_kind: 'code',
        title: 'src/recovery-fixture.ts (typescript)',
        compiled_truth: code,
        timeline: '',
        frontmatter: { language: 'typescript', file: 'src/recovery-fixture.ts' },
        source_path: 'src/recovery-fixture.ts',
      },
      { sourceId: 'default' },
    );
    mkdirSync(join(recoveryRepo, 'src'), { recursive: true });
    writeFileSync(
      join(recoveryRepo, `${codeSlug}.md`),
      serializeMarkdown(
        { language: 'typescript', file: 'src/recovery-fixture.ts' },
        code,
        '',
        { type: 'code', title: 'src/recovery-fixture.ts (typescript)', tags: [] },
      ),
    );
    const codePage = await engine.getPage(codeSlug, { sourceId: 'default' });
    writeRecoveryManifest(recoveryRepo, [codeSlug], codePage!.content_hash ?? null);
    commitRecoveryCheckout(recoveryRepo);

    const { performSync } = await import('../src/commands/sync.ts');
    await expect(performSync(engine, {
      repoPath: recoveryRepo,
      sourceId: 'default',
      strategy: 'code',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    })).rejects.toThrow(`code recovery page ${codeSlug}.md must declare page_kind code`);

    const rows = await engine.executeRaw<{ page_kind: string; source_path: string }>(
      `SELECT page_kind, source_path FROM pages WHERE source_id = $1 AND slug = $2`,
      ['default', codeSlug],
    );
    expect(rows).toEqual([{ page_kind: 'code', source_path: 'src/recovery-fixture.ts' }]);
  });

  test('rejects an edited receipt that tries to grant a new legacy identity during rename', async () => {
    const legacySlug = await seedLegacyPage();
    const renamedSlug = 'notes/renamed legacy slug';
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);
    commitRecoveryCheckout(recoveryRepo);

    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, {
      repoPath: recoveryRepo,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    execFileSync('git', ['mv', `${legacySlug}.md`, `${renamedSlug}.md`], {
      cwd: recoveryRepo,
      stdio: 'pipe',
    });
    const trustedBeforeRename = await engine.getPage(legacySlug, { sourceId: 'default' });
    writeRecoveryManifest(recoveryRepo, [renamedSlug], trustedBeforeRename!.content_hash ?? null);
    commitAll(recoveryRepo, 'rename legacy recovery page');

    await expect(performSync(engine, {
      repoPath: recoveryRepo,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    })).rejects.toThrow(`no active trusted source page exists for ${renamedSlug}`);

    expect(await activeSlugs()).toEqual([legacySlug]);
  });

  test('keeps a rename with an import error in the sync failure gate', async () => {
    const repoPath = join(tmp, 'rename-failure');
    mkdirSync(join(repoPath, 'notes'), { recursive: true });
    writeFileSync(
      join(repoPath, 'notes', 'good.md'),
      '---\ntype: note\ntitle: Good\n---\n\nInitial body.\n',
    );
    commitRecoveryCheckout(repoPath);

    const { performSync } = await import('../src/commands/sync.ts');
    const initial = await performSync(engine, {
      repoPath,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(initial.status).toBe('first_sync');
    const anchoredBeforeRename = await engine.getConfig('sync.last_commit');

    execFileSync('git', ['mv', 'notes/good.md', 'notes/bad.md'], {
      cwd: repoPath,
      stdio: 'pipe',
    });
    writeFileSync(
      join(repoPath, 'notes', 'bad.md'),
      '---\ntype: note\ntitle: Bad\nslug: someone/else\n---\n\nInitial body.\n',
    );
    commitAll(repoPath, 'rename to a frontmatter-mismatched path');

    await withEnv({ GBRAIN_HOME: tmp }, async () => {
      const result = await performSync(engine, {
        repoPath,
        sourceId: 'default',
        noPull: true,
        noEmbed: true,
        noExtract: true,
      });

      expect(result.status).toBe('blocked_by_failures');
      expect(await engine.getConfig('sync.last_commit')).toBe(anchoredBeforeRename);
    });
  });

  test('rejects a receipt amended after pull before incremental import', async () => {
    const legacySlug = await seedLegacyPage();
    const pulledSlug = 'notes/pulled legacy slug';
    const remoteRepo = join(tmp, 'remote.git');
    const updaterRepo = join(tmp, 'updater');

    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);
    commitRecoveryCheckout(recoveryRepo);
    execFileSync('git', ['init', '--bare', remoteRepo], { stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', remoteRepo], { cwd: recoveryRepo, stdio: 'pipe' });
    execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd: recoveryRepo, stdio: 'pipe' });

    const { daemon, port } = await startGitDaemon(tmp);
    try {
      // The production pull path bans the local-file transport. Exercise its
      // permitted git:// loopback transport so this test proves that a pulled
      // receipt is revalidated, rather than relying on a test-only bypass.
      execFileSync('git', ['remote', 'set-url', 'origin', `git://127.0.0.1:${port}/remote.git`], {
        cwd: recoveryRepo,
        stdio: 'pipe',
      });

      const { performSync } = await import('../src/commands/sync.ts');
      await performSync(engine, {
        repoPath: recoveryRepo,
        sourceId: 'default',
        noPull: true,
        noEmbed: true,
        noExtract: true,
      });

      execFileSync('git', ['clone', remoteRepo, updaterRepo], { stdio: 'pipe' });
      writeFileSync(
        join(updaterRepo, `${pulledSlug}.md`),
        readFileSync(join(updaterRepo, `${legacySlug}.md`)),
      );
      const trustedBeforePull = await engine.getPage(legacySlug, { sourceId: 'default' });
      writeRecoveryManifest(
        updaterRepo,
        [legacySlug, pulledSlug],
        trustedBeforePull!.content_hash ?? null,
      );
      commitAll(updaterRepo, 'add pulled legacy recovery page');
      execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: updaterRepo, stdio: 'pipe' });

      await expect(performSync(engine, {
        repoPath: recoveryRepo,
        sourceId: 'default',
        noEmbed: true,
        noExtract: true,
      })).rejects.toThrow('source page count 2 does not match the trusted active source count 1');

      expect(await activeSlugs()).toEqual([legacySlug]);
    } finally {
      await stopGitDaemon(daemon);
    }
  });

  test('rejects an ordinary frontmatter slug mismatch', async () => {
    const filePath = join(tmp, 'notes', 'random.md');
    mkdirSync(join(tmp, 'notes'), { recursive: true });
    writeFileSync(
      filePath,
      '---\nslug: people/target\n---\n# Generic untrusted fixture\n',
    );

    const { importFromFile } = await import('../src/core/import-file.ts');
    const result = await importFromFile(engine, filePath, 'notes/random.md', {
      noEmbed: true,
      sourceId: 'default',
    });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('does not match path-derived slug "notes/random"');
    expect(await activeSlugs()).toEqual([]);
  });

  test('rejects a caller-supplied lookalike recovery override', async () => {
    const filePath = join(tmp, 'notes', 'random.md');
    mkdirSync(join(tmp, 'notes'), { recursive: true });
    writeFileSync(filePath, '# Generic untrusted fixture\n');

    const { importFromFile } = await import('../src/core/import-file.ts');
    const result = await importFromFile(engine, filePath, 'notes/random.md', {
      noEmbed: true,
      sourceId: 'default',
      recoverySlug: {
        relativePath: 'notes/random.md',
        slug: 'people/target',
        sourceId: 'default',
      } as never,
    });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('Unverified recovery slug override');
    expect(await activeSlugs()).toEqual([]);
  });

  test('rejects a forged self-consistent receipt before it can overwrite a trusted legacy row', async () => {
    const legacySlug = await seedLegacyPage();
    const relativePath = `${legacySlug}.md`;
    const attackerContent = '# Attacker-controlled recovery bytes\n';
    const trustedBefore = await engine.getPage(legacySlug, { sourceId: 'default' });
    expect(trustedBefore).not.toBeNull();

    mkdirSync(join(recoveryRepo, 'notes'), { recursive: true });
    writeFileSync(join(recoveryRepo, relativePath), attackerContent);
    writeFileSync(
      join(recoveryRepo, '.gbrain-export-manifest.json'),
      JSON.stringify({
        schema_version: 1,
        source_id: 'default',
        source_page_count: 1,
        page_count: 1,
        raw_sidecar_count: 0,
        pages: [{
          slug: legacySlug,
          // A forged receipt can copy the target row's public hash while
          // self-certifying different bytes. The verifier must bind both
          // values to the trusted source row before it issues an override.
          db_content_hash: trustedBefore!.content_hash ?? null,
          markdown_sha256: createHash('sha256').update(attackerContent).digest('hex'),
          raw_sidecar_sha256: null,
          raw_record_count: 0,
        }],
      }),
    );

    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    await expect(loadVerifiedRecoverySlugOverrides(engine, recoveryRepo, 'default'))
      .rejects.toThrow(`Markdown content does not match the trusted source page for ${relativePath}`);
    expect((await engine.getPage(legacySlug, { sourceId: 'default' }))?.compiled_truth)
      .toBe('Generic fixture body.');
  });

  test('rejects a self-consistent partial receipt before full sync can reconcile away source pages', async () => {
    const legacySlug = await seedLegacyPage();
    await engine.putPage(
      'notes/other',
      {
        type: 'note',
        title: 'Other recovery fixture',
        compiled_truth: 'Independent trusted page.',
        timeline: '',
        frontmatter: {},
        source_path: 'notes/other.md',
      },
      { sourceId: 'default' },
    );
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);
    const trustedLegacy = await engine.getPage(legacySlug, { sourceId: 'default' });
    writeRecoveryManifest(recoveryRepo, [legacySlug], trustedLegacy!.content_hash ?? null);

    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    await expect(loadVerifiedRecoverySlugOverrides(engine, recoveryRepo, 'default'))
      .rejects.toThrow('source page count 1 does not match the trusted active source count 2');
    expect(await activeSlugs()).toEqual([legacySlug, 'notes/other']);
  });

  test('rechecks the exact receipt bytes before import to close the file TOCTOU window', async () => {
    const legacySlug = await seedLegacyPage();
    const relativePath = `${legacySlug}.md`;
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);

    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    const recoverySlug = (await loadVerifiedRecoverySlugOverrides(engine, recoveryRepo, 'default'))
      .get(relativePath)!;
    writeFileSync(join(recoveryRepo, relativePath), '# Changed after capability issuance\n');

    const { importFromFile } = await import('../src/core/import-file.ts');
    const result = await importFromFile(engine, join(recoveryRepo, relativePath), relativePath, {
      noEmbed: true,
      sourceId: 'default',
      recoverySlug,
    });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('Unverified recovery slug override');
    expect((await engine.getPage(legacySlug, { sourceId: 'default' }))?.compiled_truth)
      .toBe('Generic fixture body.');
  });

  test('does not overwrite a source page changed after recovery preflight', async () => {
    const legacySlug = await seedLegacyPage();
    const relativePath = `${legacySlug}.md`;
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);

    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    const recoverySlug = (await loadVerifiedRecoverySlugOverrides(engine, recoveryRepo, 'default'))
      .get(relativePath)!;
    const { importFromFile } = await import('../src/core/import-file.ts');

    const originalGetPage = engine.getPage.bind(engine);
    let targetReads = 0;
    const mutableEngine = engine as PGLiteEngine & { getPage: typeof engine.getPage };
    mutableEngine.getPage = async (slug, opts) => {
      const page = await originalGetPage(slug, opts);
      if (slug === legacySlug && opts?.sourceId === 'default' && ++targetReads === 2) {
        // Deterministically simulate a concurrent manual/MCP update after
        // importFromFile's preflight read but before importFromContent writes.
        await engine.executeRaw(
          `UPDATE pages
              SET compiled_truth = $1, content_hash = $2
            WHERE source_id = $3 AND slug = $4`,
          ['Concurrent source update.', 'f'.repeat(64), 'default', legacySlug],
        );
      }
      return page;
    };

    let result;
    try {
      result = await importFromFile(engine, join(recoveryRepo, relativePath), relativePath, {
        noEmbed: true,
        sourceId: 'default',
        recoverySlug,
      });
    } finally {
      // PGLite transaction engines inherit from the parent engine. Restore
      // the prototype method rather than leaving a parent-bound own method,
      // which would make tx.getPage re-enter the parent connection.
      Reflect.deleteProperty(mutableEngine, 'getPage');
    }

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('trusted source page changed before write');
    expect((await engine.getPage(legacySlug, { sourceId: 'default' }))?.compiled_truth)
      .toBe('Concurrent source update.');
  });

  test('does not overwrite a source page changed to code after recovery preflight', async () => {
    const legacySlug = await seedLegacyPage();
    const relativePath = `${legacySlug}.md`;
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);

    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    const recoverySlug = (await loadVerifiedRecoverySlugOverrides(engine, recoveryRepo, 'default'))
      .get(relativePath)!;
    const { importFromFile } = await import('../src/core/import-file.ts');

    // This bypasses only the preflight's row-kind query to model a concurrent
    // trusted update between capability issuance and the final write lock.
    await engine.executeRaw(
      `UPDATE pages SET page_kind = 'code' WHERE source_id = $1 AND slug = $2`,
      ['default', legacySlug],
    );
    const result = await importFromFile(engine, join(recoveryRepo, relativePath), relativePath, {
      noEmbed: true,
      sourceId: 'default',
      recoverySlug,
    });

    expect(result.status).toBe('skipped');
    expect(result.error).toContain('trusted source page changed before write');
    const rows = await engine.executeRaw<{ page_kind: string }>(
      `SELECT page_kind FROM pages WHERE source_id = $1 AND slug = $2`,
      ['default', legacySlug],
    );
    expect(rows).toEqual([{ page_kind: 'code' }]);
  });

  test('cannot retarget an issued recovery override to a different slug', async () => {
    const legacySlug = await seedLegacyPage();
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);

    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    const relativePath = `${legacySlug}.md`;
    const recoverySlug = (await loadVerifiedRecoverySlugOverrides(engine, recoveryRepo, 'default'))
      .get(relativePath)!;

    expect(Reflect.set(recoverySlug, 'slug', 'people/target')).toBe(false);

    const { importFromFile } = await import('../src/core/import-file.ts');
    const result = await importFromFile(engine, join(recoveryRepo, relativePath), relativePath, {
      noEmbed: true,
      sourceId: 'default',
      recoverySlug,
    });

    expect(result.slug).toBe(legacySlug);
    expect(await activeSlugs()).toEqual([legacySlug]);
  });

  test('rejects a self-consistent receipt whose content no longer matches the trusted page', async () => {
    const legacySlug = await seedLegacyPage();
    const relativePath = `${legacySlug}.md`;
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);
    writeFileSync(
      join(recoveryRepo, relativePath),
      '---\nslug: people/unrelated\n---\n# Recovery fixture with a spoofed slug\n',
    );
    const trustedBefore = await engine.getPage(legacySlug, { sourceId: 'default' });
    writeRecoveryManifest(recoveryRepo, [legacySlug], trustedBefore!.content_hash ?? null);

    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    await expect(loadVerifiedRecoverySlugOverrides(engine, recoveryRepo, 'default'))
      .rejects.toThrow(`Markdown content does not match the trusted source page for ${relativePath}`);
    expect(await activeSlugs()).toEqual([legacySlug]);
  });

  test('ignores an incompatible recovery manifest for another source', async () => {
    writeFileSync(
      join(tmp, '.gbrain-export-manifest.json'),
      JSON.stringify({ source_id: 'another-source', schema_version: 99 }),
    );

    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    expect(await loadVerifiedRecoverySlugOverrides(engine, tmp, 'default')).toEqual(new Map());
  });

  test('fails closed when a manifest names the requested source but has an unsupported schema', async () => {
    writeFileSync(
      join(tmp, '.gbrain-export-manifest.json'),
      JSON.stringify({ source_id: 'default', schema_version: 99 }),
    );

    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    await expect(loadVerifiedRecoverySlugOverrides(engine, tmp, 'default')).rejects.toThrow('unsupported schema_version');
  });

  test('fails closed when a present recovery manifest cannot be parsed', async () => {
    writeFileSync(join(tmp, '.gbrain-export-manifest.json'), '{not valid JSON');

    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    await expect(loadVerifiedRecoverySlugOverrides(engine, tmp, 'default'))
      .rejects.toThrow('could not parse .gbrain-export-manifest.json');
  });

  test('fails closed for a dangling recovery manifest symlink', async () => {
    symlinkSync(
      join(tmp, 'missing-recovery-receipt.json'),
      join(tmp, '.gbrain-export-manifest.json'),
    );

    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    await expect(loadVerifiedRecoverySlugOverrides(engine, tmp, 'default'))
      .rejects.toThrow('.gbrain-export-manifest.json must be a regular file');
  });

  test('normalizes Windows-style file paths before recovery override lookup', async () => {
    const legacySlug = await seedLegacyPage();
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);

    const { normalizeImportRelativePath } = await import('../src/commands/import.ts');
    const { loadVerifiedRecoverySlugOverrides } = await import('../src/core/source-recovery-manifest.ts');
    const manifestPaths = await loadVerifiedRecoverySlugOverrides(engine, recoveryRepo, 'default');
    const windowsPath = `${legacySlug}.md`.replace(/\//g, '\\');
    const normalizedPath = normalizeImportRelativePath(windowsPath);

    expect(normalizedPath).toBe(`${legacySlug}.md`);
    expect(manifestPaths.get(normalizedPath)?.slug).toBe(legacySlug);
  });

  test('fails closed when a recovery export page changes after its receipt', async () => {
    const legacySlug = await seedLegacyPage();
    await runExport(engine, ['--dir', recoveryRepo, '--source', 'default']);
    writeFileSync(join(recoveryRepo, `${legacySlug}.md`), '# Changed after export\n');
    commitRecoveryCheckout(recoveryRepo);

    const { performSync } = await import('../src/commands/sync.ts');
    await expect(performSync(engine, {
      repoPath: recoveryRepo,
      sourceId: 'default',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    })).rejects.toThrow(`SHA-256 mismatch for ${legacySlug}.md`);

    expect(await activeSlugs()).toEqual([legacySlug]);
  });
});
