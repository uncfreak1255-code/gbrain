import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { serializeMarkdown } from './markdown.ts';
import { renameDirectoryNoReplace } from './atomic-directory-publish.ts';
import type { RawData } from './types.ts';
import type { WriteThroughResult } from './write-through.ts';
import { activeV2CorpusBinding, activeV2DestinationBinding } from './learning-loop.ts';
import { withCanonicalCheckoutRebuildBoundary, withCanonicalSourceBoundary, type SourceWriteLease } from './canonical-page-write.ts';
import { computeBrainIdFromConfig } from './upgrade-checkpoint.ts';
import { parseLearningLoopFence } from './learning-loop-knowledge.ts';

const MANIFEST_FILENAME = '.gbrain-export-manifest.json';
const SCOPED_EXPORT_BATCH_SIZE = 5_000;
const FACTS_FENCE = /<!--- gbrain:facts:begin -->[\s\S]*?<!--- gbrain:facts:end -->/g;
const LEARNING_FENCE = /<!-- gbrain:learning-loop:v1:begin -->[\s\S]*?<!-- gbrain:learning-loop:v1:end -->/g;

function assertNoActiveV2SourceReplacement(engine: BrainEngine, sourceId: string): void {
  const config = engine.learningLoopLedgerConfig?.();
  if (!config) throw new Error('managed_state_unavailable: Learning Loop brain scope is unavailable');
  const corpus = activeV2CorpusBinding({ config });
  const destination = activeV2DestinationBinding({ config });
  if (corpus?.source_id === sourceId || destination?.source_id === sourceId) {
    throw new Error(`managed_state_unavailable: active V2 run freezes source ${JSON.stringify(sourceId)}`);
  }
}

function markdownFiles(root: string, relativeDir = ''): string[] {
  const dir = join(root, relativeDir);
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`recovery source contains symlink: ${relativePath}`);
    if (entry.isDirectory()) files.push(...markdownFiles(root, relativePath));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relativePath);
  }
  return files;
}

function singleFence(content: string, pattern: RegExp, label: string): string {
  const matches = [...content.matchAll(pattern)];
  if (matches.length > 1) throw new Error(`recovery source has duplicate ${label} fence`);
  return matches[0]?.[0] ?? '';
}

function replaceOrAppendFence(content: string, current: string, canonical: string): string {
  if (!canonical) return content;
  return current
    ? content.replace(current, canonical)
    : `${content.trimEnd()}\n\n${canonical}\n`;
}

/** Carry source-owned protected bytes; never reconstruct them from the DB export. */
function carryProtectedFences(activeRoot: string, freshRoot: string): void {
  for (const relativePath of markdownFiles(activeRoot)) {
    const activePath = join(activeRoot, relativePath);
    const oldBody = readFileSync(activePath, 'utf8');
    const oldFacts = singleFence(oldBody, FACTS_FENCE, 'facts');
    const oldLearning = singleFence(oldBody, LEARNING_FENCE, 'Learning Loop');
    if (oldLearning && !parseLearningLoopFence(oldLearning)) {
      throw new Error(`recovery source has malformed Learning Loop fence: ${relativePath}`);
    }
    if (!oldFacts && !oldLearning) continue;

    const freshPath = join(freshRoot, relativePath);
    if (!existsSync(freshPath) || !lstatSync(freshPath).isFile()) {
      throw new Error(`recovery export omitted protected page: ${relativePath}`);
    }
    let freshBody = readFileSync(freshPath, 'utf8');
    const freshFacts = singleFence(freshBody, FACTS_FENCE, 'facts');
    const freshLearning = singleFence(freshBody, LEARNING_FENCE, 'Learning Loop');
    if (freshLearning) parseLearningLoopFence(freshLearning);
    freshBody = replaceOrAppendFence(freshBody, freshFacts, oldFacts);
    freshBody = replaceOrAppendFence(freshBody, freshLearning, oldLearning);
    writeFileSync(freshPath, freshBody, 'utf8');

    const readback = readFileSync(freshPath, 'utf8');
    if (singleFence(readback, FACTS_FENCE, 'facts') !== oldFacts
      || singleFence(readback, LEARNING_FENCE, 'Learning Loop') !== oldLearning) {
      throw new Error(`recovery protected-fence readback mismatch: ${relativePath}`);
    }
  }
}

interface ExportManifestPage {
  slug: string;
  db_content_hash: string | null;
  markdown_sha256: string;
  raw_sidecar_sha256: string | null;
  raw_record_count: number;
  page_kind: 'markdown' | 'code';
  source_path?: string;
}

interface ExportManifest {
  schema_version: 1;
  source_id: string;
  source_page_count: number;
  page_count: number;
  raw_sidecar_count: number;
  pages: ExportManifestPage[];
}

interface PrivateScopedExportStaging {
  root: string;
  destination: string;
  assertOwned(): void;
  writeFile(relativePath: string, contents: string): void;
  tryPublish(beforeNativeRenameForTests?: () => void): boolean;
  cleanup(): void;
  [Symbol.dispose](): void;
}

interface ScopedExportRootIdentity {
  realPath: string;
  device: bigint;
  inode: bigint;
}

export interface RecoveryBackedSourceCheckout {
  sourceId: string;
  repoPath: string;
  manifestPath: string;
  remoteUrl: string | null;
}

interface RecoveryRefreshResult extends WriteThroughResult {
  refreshed: true;
  preserved_path: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2) + '\n';
}

function assertSafeExportSlug(slug: string): void {
  const segments = slug.split('/');
  if (
    slug.length === 0
    || slug.includes('\\')
    || slug.includes('\0')
    || isAbsolute(slug)
    || segments.some((segment) => (
      segment === ''
      || segment === '.'
      || segment === '..'
      || segment.toLocaleLowerCase('en-US') === '.git'
    ))
  ) {
    throw new Error(`unsafe page slug cannot be exported: ${JSON.stringify(slug)}`);
  }
}

function assertSafeExportSourcePath(sourcePath: string): void {
  const segments = sourcePath.split('/');
  if (
    sourcePath.length === 0
    || sourcePath.includes('\\')
    || sourcePath.includes('\0')
    || isAbsolute(sourcePath)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`unsafe code source path cannot be exported: ${JSON.stringify(sourcePath)}`);
  }
}

function confinedOutputPath(outDir: string, relativePath: string): string {
  const root = resolve(outDir);
  const candidate = resolve(root, relativePath);
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`export path escapes output directory: ${JSON.stringify(relativePath)}`);
  }
  return candidate;
}

function rawSidecarRelativePath(slug: string): string {
  const slugParts = slug.split('/');
  return join(
    ...slugParts.slice(0, -1),
    '.raw',
    `${slugParts[slugParts.length - 1]}.json`,
  );
}

function filesystemErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function resolveCodeExportSourcePath(
  page: { source_path?: string | null; frontmatter: Record<string, unknown> },
): string | undefined {
  const sourcePath = typeof page.source_path === 'string' && page.source_path.length > 0
    ? page.source_path
    : page.frontmatter.file;
  return typeof sourcePath === 'string' && sourcePath.length > 0 ? sourcePath : undefined;
}

function codeExportSourcePath(
  page: { slug: string; source_path?: string | null; frontmatter: Record<string, unknown> },
): string {
  const sourcePath = resolveCodeExportSourcePath(page);
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new Error(
      `code page ${JSON.stringify(page.slug)} has no safe source path for source-scoped recovery export.`,
    );
  }
  assertSafeExportSourcePath(sourcePath);
  return sourcePath;
}

function compactTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function scopedExportRootIdentity(root: string): ScopedExportRootIdentity {
  const stats = statSync(root, { bigint: true });
  if (!stats.isDirectory()) {
    throw new Error(`${JSON.stringify(root)} is not a directory.`);
  }
  return {
    realPath: realpathSync(root),
    device: stats.dev,
    inode: stats.ino,
  };
}

function sameFilesystemObject(
  left: ScopedExportRootIdentity,
  right: ScopedExportRootIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sameScopedExportRoot(
  left: ScopedExportRootIdentity,
  right: ScopedExportRootIdentity,
): boolean {
  return left.realPath === right.realPath
    && sameFilesystemObject(left, right);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (filesystemErrorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function uniqueSiblingPath(basePath: string, suffix: string): string {
  const root = resolve(basePath);
  const parent = dirname(root);
  const name = basename(root);
  const stamp = compactTimestamp();
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = join(
      parent,
      `${name}${suffix}${stamp}${attempt === 0 ? '' : `-${attempt}`}`,
    );
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`could not allocate a fresh sibling path for ${JSON.stringify(basePath)}`);
}

function createPrivateScopedExportStaging(outDir: string): PrivateScopedExportStaging {
  const requestedRoot = resolve(outDir);
  const requestedParent = dirname(requestedRoot);
  mkdirSync(requestedParent, { recursive: true });

  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(requestedParent);
  } catch {
    throw new Error(
      `gbrain export --source could not identify the destination filesystem for `
      + `${JSON.stringify(outDir)}.`,
    );
  }

  const destinationName = basename(requestedRoot);
  const destination = join(canonicalParent, destinationName);
  if (!destinationName || pathEntryExists(destination)) {
    throw new Error(
      `gbrain export --source requires --dir to be absent; `
      + `${JSON.stringify(outDir)} already exists. `
      + 'Choose a fresh recovery directory.',
    );
  }

  let destinationParentIdentity: ScopedExportRootIdentity;
  try {
    destinationParentIdentity = scopedExportRootIdentity(requestedParent);
  } catch {
    throw new Error(
      `gbrain export --source could not identify the destination parent for `
      + `${JSON.stringify(outDir)}.`,
    );
  }

  let root: string | null = null;
  try {
    root = mkdtempSync(join(canonicalParent, `.${destinationName}.gbrain-export-stage-`));
    chmodSync(root, 0o700);
  } catch {
    if (root) {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    throw new Error(
      `gbrain export --source could not create private staging next to ${JSON.stringify(outDir)}.`,
    );
  }
  const stagingRoot = root;

  let stagedRoot: ScopedExportRootIdentity;
  try {
    stagedRoot = scopedExportRootIdentity(stagingRoot);
  } catch {
    try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(
      `gbrain export --source could not identify its private staging directory for `
      + `${JSON.stringify(outDir)}.`,
    );
  }

  let published = false;
  let cleaned = false;
  const ownershipError = (): Error => new Error(
    `gbrain export --source lost its private staging directory for ${JSON.stringify(outDir)}; `
    + 'stop and use a fresh recovery directory.',
  );
  const ownsStaging = (): boolean => {
    try {
      return sameScopedExportRoot(stagedRoot, scopedExportRootIdentity(stagingRoot));
    } catch {
      return false;
    }
  };
  const assertOwned = (): void => {
    if (published || cleaned || !ownsStaging()) throw ownershipError();
  };
  const assertDestinationParentOwned = (): void => {
    try {
      const current = scopedExportRootIdentity(requestedParent);
      if (sameScopedExportRoot(destinationParentIdentity, current)) return;
    } catch {
      // Fall through to one stable error for rename/replacement/symlink races.
    }
    throw new Error(
      `gbrain export --source destination parent changed before publish for `
      + `${JSON.stringify(outDir)}; the private staging directory was not published.`,
    );
  };

  const ensurePrivateParent = (filePath: string): void => {
    const parentRelative = relative(stagingRoot, dirname(filePath));
    let current = stagingRoot;
    if (parentRelative === '') return;
    for (const segment of parentRelative.split(sep)) {
      current = join(current, segment);
      assertOwned();
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if (filesystemErrorCode(error) !== 'EEXIST') throw error;
      }
      const stats = lstatSync(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(
          `gbrain export --source refused a non-directory or symlink inside private staging: `
          + `${JSON.stringify(relative(stagingRoot, current))}.`,
        );
      }
    }
  };

  const writeFile = (relativePath: string, contents: string): void => {
    assertOwned();
    const filePath = confinedOutputPath(stagingRoot, relativePath);
    ensurePrivateParent(filePath);
    assertOwned();
    writeFileSync(filePath, contents, { flag: 'wx', mode: 0o600 });
    assertOwned();
  };

  const tryPublish = (beforeNativeRenameForTests?: () => void): boolean => {
    assertOwned();
    assertDestinationParentOwned();
    const manifestPath = join(stagingRoot, MANIFEST_FILENAME);
    const manifestStats = lstatSync(manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
      throw new Error('gbrain export --source cannot publish staging without a regular manifest.');
    }
    beforeNativeRenameForTests?.();
    if (!renameDirectoryNoReplace(stagingRoot, destination)) return false;
    const publishedRoot = scopedExportRootIdentity(destination);
    if (!sameFilesystemObject(stagedRoot, publishedRoot)) {
      throw new Error('gbrain export --source published an unexpected directory identity.');
    }
    published = true;
    return true;
  };

  const cleanup = (): void => {
    if (published || cleaned) return;
    if (!ownsStaging()) throw ownershipError();
    rmSync(stagingRoot, { recursive: true, force: false });
    cleaned = true;
  };

  const dispose = (): void => {
    if (published || cleaned || !ownsStaging()) return;
    try {
      rmSync(stagingRoot, { recursive: true, force: false });
      cleaned = true;
    } catch {
      // Preserve the primary failure.
    }
  };

  const mode = statSync(stagingRoot).mode & 0o777;
  if (mode !== 0o700) {
    if (ownsStaging()) dispose();
    throw new Error(
      `gbrain export --source could not secure private staging for ${JSON.stringify(outDir)}.`,
    );
  }

  return {
    root: stagingRoot,
    destination,
    assertOwned,
    writeFile,
    tryPublish,
    cleanup,
    [Symbol.dispose]: dispose,
  };
}

function assertNonCollidingScopedWriteSet(
  outDir: string,
  pages: Array<{
    slug: string;
  }>,
  rawBySlug: Map<string, RawData[]>,
): void {
  const root = resolve(outDir);
  const collisionKey = (file: string): string => relative(root, file)
    .split(sep)
    .map((segment) => segment.normalize('NFC').toLowerCase())
    .join('/');
  const files = new Map<string, string>();
  const addFile = (file: string): void => {
    const key = collisionKey(file);
    const existing = files.get(key);
    if (existing !== undefined) {
      throw new Error(
        `filesystem-equivalent export output paths: `
        + `${JSON.stringify(relative(root, existing))} and ${JSON.stringify(relative(root, file))}`,
      );
    }
    files.set(key, file);
  };

  addFile(confinedOutputPath(outDir, MANIFEST_FILENAME));

  for (const page of pages) {
    addFile(confinedOutputPath(outDir, `${page.slug}.md`));
    if ((rawBySlug.get(page.slug) ?? []).length > 0) {
      addFile(confinedOutputPath(outDir, rawSidecarRelativePath(page.slug)));
    }
  }

  for (const file of files.values()) {
    let parent = dirname(file);
    while (parent !== root) {
      const collidingFile = files.get(collisionKey(parent));
      if (collidingFile !== undefined) {
        throw new Error(
          `export output path collision: ${JSON.stringify(relative(root, collidingFile))} `
          + 'would need to be both a file and a directory',
        );
      }
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

async function countScopedPages(engine: BrainEngine, sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL`,
    [sourceId],
  );
  const count = Number(rows[0]?.n ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`invalid page count while exporting source "${sourceId}".`);
  }
  return count;
}

async function loadCompleteScopedPages(
  engine: BrainEngine,
  sourceId: string,
): Promise<{
  pages: Array<{
    slug: string;
    page_kind?: string | null;
    source_path?: string | null;
    frontmatter: Record<string, unknown>;
    compiled_truth: string;
    timeline: string;
    type: string;
    title: string;
    content_hash?: string | null;
  }>;
  sourcePageCount: number;
  tagsBySlug: Map<string, string[]>;
  rawBySlug: Map<string, RawData[]>;
}> {
  return engine.transaction(async (snapshot) => {
    if (snapshot.kind === 'postgres') {
      await snapshot.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    }
    const active = await snapshot.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = $1 AND archived = false`,
      [sourceId],
    );
    if (active.length === 0) {
      throw new Error(`source "${sourceId}" stopped being active before its recovery snapshot.`);
    }

    const unsupported = await snapshot.executeRaw<{ slug: string; page_kind: string }>(
      `SELECT slug, page_kind
         FROM pages
        WHERE source_id = $1
          AND deleted_at IS NULL
          AND page_kind NOT IN ('markdown', 'code')
        ORDER BY slug
        LIMIT 1`,
      [sourceId],
    );
    if (unsupported.length > 0) {
      const page = unsupported[0]!;
      throw new Error(
        `source-scoped recovery export supports only markdown and code pages; `
        + `${JSON.stringify(page.slug)} is a ${page.page_kind} page. `
        + 'Use the original source checkout for image recovery.',
      );
    }

    const sourcePageCountBefore = await countScopedPages(snapshot, sourceId);
    const pages: Array<{
      slug: string;
      page_kind?: string | null;
      source_path?: string | null;
      frontmatter: Record<string, unknown>;
      compiled_truth: string;
      timeline: string;
      type: string;
      title: string;
      content_hash?: string | null;
    }> = [];

    for (let offset = 0; ; offset += SCOPED_EXPORT_BATCH_SIZE) {
      const batch = await snapshot.listPages({
        sourceId,
        sort: 'slug',
        limit: SCOPED_EXPORT_BATCH_SIZE,
        offset,
      });
      pages.push(...batch);
      if (batch.length < SCOPED_EXPORT_BATCH_SIZE) break;
    }

    const sourcePageCountAfter = await countScopedPages(snapshot, sourceId);
    const distinctSlugs = new Set(pages.map((page) => page.slug));
    if (
      sourcePageCountBefore !== sourcePageCountAfter
      || pages.length !== sourcePageCountAfter
      || distinctSlugs.size !== pages.length
    ) {
      throw new Error(
        `source "${sourceId}" changed or could not be exported completely; `
        + `expected ${sourcePageCountBefore} pages, read ${pages.length}, `
        + `final count ${sourcePageCountAfter}. Retry from a quiet runtime.`,
      );
    }

    pages.sort((left, right) => compareCodePoints(left.slug, right.slug));
    const tagsBySlug = new Map<string, string[]>();
    const rawBySlug = new Map<string, RawData[]>();
    for (const page of pages) {
      tagsBySlug.set(page.slug, await snapshot.getTags(page.slug, { sourceId }));
      rawBySlug.set(
        page.slug,
        await snapshot.getRawData(page.slug, undefined, { sourceId }),
      );
    }
    return {
      pages,
      sourcePageCount: sourcePageCountAfter,
      tagsBySlug,
      rawBySlug,
    };
  });
}

function gitInitAndCommit(repoPath: string, remoteUrl: string | null): void {
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'gbrain@local.invalid'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'GBrain Recovery Refresh'], { cwd: repoPath, stdio: 'pipe' });
  if (remoteUrl) {
    execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: repoPath, stdio: 'pipe' });
  }
  execFileSync('git', ['add', '-A'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'gbrain: refresh recovery checkout'], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}

function switchRecoveryCheckout(
  activePath: string,
  freshPath: string,
  preservedPath: string,
): void {
  renameSync(activePath, preservedPath);
  try {
    renameSync(freshPath, activePath);
  } catch (error) {
    try {
      if (!existsSync(activePath) && existsSync(preservedPath)) {
        renameSync(preservedPath, activePath);
      }
    } catch {
      // Best effort rollback. Surface the original failure below.
    }
    throw error;
  }
}

async function exportRecoveryCheckout(
  engine: BrainEngine,
  sourceId: string,
  outDir: string,
): Promise<void> {
  const complete = await loadCompleteScopedPages(engine, sourceId);
  const pages = complete.pages;
  const scopedTags = complete.tagsBySlug;
  const scopedRaw = complete.rawBySlug;

  for (const page of pages) {
    assertSafeExportSlug(page.slug);
    confinedOutputPath(outDir, `${page.slug}.md`);
    if (page.page_kind === 'code') codeExportSourcePath(page);
  }
  assertNonCollidingScopedWriteSet(outDir, pages, scopedRaw);

  using staging = createPrivateScopedExportStaging(outDir);

  let rawSidecarCount = 0;
  const manifestPages: ExportManifestPage[] = [];

  for (const page of pages) {
    const tags = scopedTags.get(page.slug) ?? [];
    const pageKind: 'markdown' | 'code' = page.page_kind === 'code' ? 'code' : 'markdown';
    const sourcePath = pageKind === 'code' ? codeExportSourcePath(page) : undefined;
    const archiveFrontmatter = pageKind === 'code'
      && resolveCodeExportSourcePath(page) !== undefined
      && typeof page.frontmatter.file !== 'string'
      ? { ...page.frontmatter, file: resolveCodeExportSourcePath(page) }
      : page.frontmatter;
    const md = pageKind === 'code'
      ? page.compiled_truth
      : serializeMarkdown(
        archiveFrontmatter,
        page.compiled_truth,
        page.timeline,
        { type: page.type, title: page.title, tags },
      );

    staging.writeFile(`${page.slug}.md`, md);

    const rawData = scopedRaw.get(page.slug) ?? [];
    let rawSidecarSha256: string | null = null;
    if (rawData.length > 0) {
      const rawRelativePath = rawSidecarRelativePath(page.slug);
      const rawObj = Object.create(null) as Record<string, unknown>;
      for (const rd of [...rawData].sort((left, right) => compareCodePoints(left.source, right.source))) {
        rawObj[rd.source] = rd.data;
      }
      const rawJson = canonicalJson(rawObj);
      staging.writeFile(rawRelativePath, rawJson);
      rawSidecarSha256 = sha256(rawJson);
      rawSidecarCount++;
    }

    manifestPages.push({
      slug: page.slug,
      db_content_hash: page.content_hash ?? null,
      markdown_sha256: sha256(md),
      raw_sidecar_sha256: rawSidecarSha256,
      raw_record_count: rawData.length,
      page_kind: pageKind,
      ...(sourcePath === undefined ? {} : { source_path: sourcePath }),
    });
  }

  const manifest: ExportManifest = {
    schema_version: 1,
    source_id: sourceId,
    source_page_count: complete.sourcePageCount,
    page_count: pages.length,
    raw_sidecar_count: rawSidecarCount,
    pages: manifestPages,
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  staging.writeFile(MANIFEST_FILENAME, manifestJson);

  if (!staging.tryPublish()) {
    throw new Error(
      `gbrain export --source requires --dir to remain absent until publish; `
      + `${JSON.stringify(outDir)} became occupied. Choose a fresh recovery directory.`,
    );
  }
}

export async function getRecoveryBackedSourceCheckout(
  engine: BrainEngine,
  sourceId: string,
): Promise<RecoveryBackedSourceCheckout | null> {
  if (typeof (engine as { executeRaw?: unknown }).executeRaw !== 'function') {
    return null;
  }
  const rows = await engine.executeRaw<{ local_path: string | null; config: unknown }>(
    `SELECT local_path, config FROM sources WHERE id = $1`,
    [sourceId],
  );
  const repoPath = rows[0]?.local_path ?? null;
  if (!repoPath) return null;
  if (!existsSync(repoPath)) return null;
  const manifestPath = join(repoPath, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;
  if (!isRegularFile(manifestPath)) {
    throw new Error(`${MANIFEST_FILENAME} must be a regular file`);
  }
  // This is a mode-selection probe, not an import authority. It runs before a
  // DB-first write whose new page necessarily makes the old sealed receipt
  // stale; fully validating that old count here would make this recovery path
  // unable to repair the known mismatch. No old checkout bytes are imported or
  // trusted: the fresh DB export must pass a real source sync before swap.
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new Error(`could not parse ${MANIFEST_FILENAME}`);
  }
  if (typeof manifestJson !== 'object' || manifestJson === null || Array.isArray(manifestJson)) {
    throw new Error('recovery manifest must be a JSON object');
  }
  const manifestSourceId = (manifestJson as { source_id?: unknown }).source_id;
  if (typeof manifestSourceId !== 'string' || manifestSourceId.length === 0) {
    throw new Error('source_id must be a non-empty string');
  }
  if (manifestSourceId !== sourceId) return null;
  if ((manifestJson as { schema_version?: unknown }).schema_version !== 1) {
    throw new Error('unsupported schema_version');
  }
  const config = typeof rows[0]?.config === 'string'
    ? JSON.parse(rows[0].config) as Record<string, unknown>
    : (rows[0]?.config ?? {}) as Record<string, unknown>;
  const remoteUrl = typeof config.remote_url === 'string' ? config.remote_url : null;
  return {
    sourceId,
    repoPath,
    manifestPath,
    remoteUrl,
  };
}

export async function withRecoverySourceWriteBoundary<T>(
  engine: BrainEngine,
  sourceId: string,
  fn: (recovery: RecoveryBackedSourceCheckout | null) => Promise<T>,
): Promise<T> {
  assertNoActiveV2SourceReplacement(engine, sourceId);
  const initial = await getRecoveryBackedSourceCheckout(engine, sourceId);
  if (!initial) return fn(null);
  const target = {
    brain_id: computeBrainIdFromConfig(engine.learningLoopLedgerConfig?.() ?? {}),
    source_id: sourceId,
    canonical_slug: '_source-boundary',
    configured_root: initial.repoPath,
  };
  return withCanonicalSourceBoundary(engine, target, async () => {
    assertNoActiveV2SourceReplacement(engine, sourceId);
    const locked = await getRecoveryBackedSourceCheckout(engine, sourceId);
    if (!locked) {
      throw new Error(
        `recovery checkout for source ${JSON.stringify(sourceId)} changed while acquiring its write lock; `
        + 'the DB write was not started.',
      );
    }
    return fn(locked);
  });
}

export async function refreshRecoverySourceCheckout(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  recovery: RecoveryBackedSourceCheckout,
  sourceLease?: SourceWriteLease,
): Promise<RecoveryRefreshResult> {
  assertNoActiveV2SourceReplacement(engine, sourceId);
  if (!existsSync(recovery.repoPath) || !lstatSync(recovery.repoPath).isDirectory()) {
    return {
      written: false,
      refreshed: true,
      error: `recovery checkout is not a directory: ${recovery.repoPath}`,
      preserved_path: recovery.repoPath,
    };
  }
  if (!isRegularFile(recovery.manifestPath)) {
    return {
      written: false,
      refreshed: true,
      error: `recovery manifest is missing or not a regular file: ${recovery.manifestPath}`,
      preserved_path: recovery.repoPath,
    };
  }

  const freshPath = uniqueSiblingPath(recovery.repoPath, '-refresh-');
  const preservedPath = uniqueSiblingPath(recovery.repoPath, '-stale-');
  const sourceRows = await engine.executeRaw<{ local_path: string | null; last_commit: string | null }>(
    `SELECT local_path, last_commit FROM sources WHERE id = $1`,
    [sourceId],
  );
  const previousLastCommit = sourceRows[0]?.last_commit ?? null;
  let switched = false;

  try {
    await exportRecoveryCheckout(engine, sourceId, freshPath);
    carryProtectedFences(recovery.repoPath, freshPath);
    gitInitAndCommit(freshPath, recovery.remoteUrl);
    const { performSync } = await import('../commands/sync.ts');
    let proofResult:
      | { status: 'synced' | 'up_to_date' | 'first_sync' | 'dry_run' | 'blocked_by_failures' | 'partial' }
      | undefined;
    try {
      await engine.executeRaw(
        `UPDATE sources SET local_path = $1 WHERE id = $2`,
        [freshPath, sourceId],
      );
      proofResult = await withCanonicalCheckoutRebuildBoundary({
        brain_id: computeBrainIdFromConfig(engine.learningLoopLedgerConfig?.() ?? {}),
        source_id: sourceId,
        canonical_slug: '_source-boundary',
        configured_root: freshPath,
      }, () => performSync(engine, {
          repoPath: freshPath,
          sourceId,
          noPull: true,
          noEmbed: true,
          noExtract: true,
          skipLock: true,
        }), sourceLease);
    } finally {
      await engine.executeRaw(
        `UPDATE sources SET local_path = $1 WHERE id = $2`,
        [recovery.repoPath, sourceId],
      );
    }
    if (
      !proofResult
      || (proofResult.status !== 'synced'
        && proofResult.status !== 'up_to_date'
        && proofResult.status !== 'first_sync')
    ) {
      throw new Error(
        `recovery sync proof failed for ${sourceId}: ${proofResult?.status ?? 'unknown'}`,
      );
    }
    switchRecoveryCheckout(recovery.repoPath, freshPath, preservedPath);
    switched = true;

    const filePath = join(recovery.repoPath, `${slug}.md`);
    return {
      written: existsSync(filePath),
      committed: true,
      refreshed: true,
      path: existsSync(filePath) ? realpathSync(filePath) : filePath,
      preserved_path: preservedPath,
    };
  } catch (error) {
    if (!switched && existsSync(freshPath)) {
      try { rmSync(freshPath, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (!switched) {
      try {
        await engine.executeRaw(
          `UPDATE sources SET local_path = $1, last_commit = $2 WHERE id = $3`,
          [recovery.repoPath, previousLastCommit, sourceId],
        );
      } catch {
        // Preserve the primary refresh failure. The source may require manual recovery.
      }
    }
    return {
      written: false,
      refreshed: true,
      error: error instanceof Error ? error.message : String(error),
      preserved_path: preservedPath,
    };
  }
}
