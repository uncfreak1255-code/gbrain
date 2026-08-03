import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, join, dirname, isAbsolute, relative, resolve, sep } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { loadStorageConfig, isDbOnly } from '../core/storage-config.ts';
import { getDefaultSourcePath } from '../core/source-resolver.ts';
import { isValidSourceId } from '../core/source-id.ts';
import type { PageType, RawData } from '../core/types.ts';
import { renameDirectoryNoReplace } from '../core/atomic-directory-publish.ts';

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
  /** Exposed for focused race tests; production callers only use write/publish. */
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

function failExport(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
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
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    failExport(`unsafe page slug cannot be exported: ${JSON.stringify(slug)}`);
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
    failExport(`unsafe code source path cannot be exported: ${JSON.stringify(sourcePath)}`);
  }
}

function codeExportSourcePath(page: { slug: string; frontmatter: Record<string, unknown> }): string {
  const frontmatterFile = page.frontmatter.file;
  const sourcePath = typeof frontmatterFile === 'string' && frontmatterFile.length > 0
    ? frontmatterFile
    : page.slug;
  assertSafeExportSourcePath(sourcePath);
  return sourcePath;
}

function confinedOutputPath(outDir: string, relativePath: string): string {
  const root = resolve(outDir);
  const candidate = resolve(root, relativePath);
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    failExport(`export path escapes output directory: ${JSON.stringify(relativePath)}`);
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

function sameScopedExportRoot(
  left: ScopedExportRootIdentity,
  right: ScopedExportRootIdentity,
): boolean {
  return left.realPath === right.realPath
    && sameFilesystemObject(left, right);
}

function sameFilesystemObject(
  left: ScopedExportRootIdentity,
  right: ScopedExportRootIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
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

function createPrivateScopedExportStaging(outDir: string): PrivateScopedExportStaging {
  const requestedRoot = resolve(outDir);
  const requestedParent = dirname(requestedRoot);
  try {
    mkdirSync(requestedParent, { recursive: true });
  } catch {
    failExport(
      `gbrain export --source could not create the parent directory for ${JSON.stringify(outDir)}.`,
    );
  }

  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(requestedParent);
  } catch {
    failExport(
      `gbrain export --source could not identify the destination filesystem for `
      + `${JSON.stringify(outDir)}.`,
    );
  }

  const destinationName = basename(requestedRoot);
  const destination = join(canonicalParent, destinationName);
  if (!destinationName || pathEntryExists(destination)) {
    failExport(
      `gbrain export --source requires --dir to be absent; `
      + `${JSON.stringify(outDir)} already exists. `
      + 'Choose a fresh recovery directory.',
    );
  }
  let destinationParentIdentity: ScopedExportRootIdentity;
  try {
    destinationParentIdentity = scopedExportRootIdentity(requestedParent);
  } catch {
    failExport(
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
    failExport(
      `gbrain export --source could not create private staging next to ${JSON.stringify(outDir)}.`,
    );
  }
  const stagingRoot = root;

  let stagedRoot: ScopedExportRootIdentity;
  try {
    stagedRoot = scopedExportRootIdentity(stagingRoot);
  } catch {
    try { rmSync(stagingRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    failExport(
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
    // `wx` is exclusive and refuses an existing leaf (including a symlink).
    writeFileSync(filePath, contents, { flag: 'wx', mode: 0o600 });
    assertOwned();
  };

  const tryPublish = (beforeNativeRenameForTests?: () => void): boolean => {
    assertOwned();
    assertDestinationParentOwned();
    const manifestPath = join(stagingRoot, '.gbrain-export-manifest.json');
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
      // Preserve the primary failure. A private staging directory that cannot
      // be proven ours remains hidden and the destination stays absent.
    }
  };

  try {
    assertOwned();
    const mode = statSync(stagingRoot).mode & 0o777;
    if (mode !== 0o700) throw new Error('private staging mode is not 0700');
    assertOwned();
  } catch {
    if (ownsStaging()) dispose();
    failExport(
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
  pages: import('../core/types.ts').Page[],
  rawBySlug: Map<string, RawData[]>,
): void {
  const root = resolve(outDir);
  // Recovery exports must be portable across the common case-insensitive and
  // Unicode-normalization-insensitive filesystems used by operators. Keep the
  // original path for writes and receipts, but compare an NFC + lowercase key
  // so canonically equivalent legacy slugs cannot overwrite one another.
  const collisionKey = (file: string): string => relative(root, file)
    .split(sep)
    .map((segment) => segment.normalize('NFC').toLowerCase())
    .join('/');
  const files = new Map<string, string>();
  const addFile = (file: string): void => {
    const key = collisionKey(file);
    const existing = files.get(key);
    if (existing !== undefined) {
      failExport(
        `filesystem-equivalent export output paths: `
        + `${JSON.stringify(relative(root, existing))} and ${JSON.stringify(relative(root, file))}`,
      );
    }
    files.set(key, file);
  };

  addFile(confinedOutputPath(outDir, '.gbrain-export-manifest.json'));

  for (const page of pages) {
    const pagePath = confinedOutputPath(outDir, `${page.slug}.md`);
    addFile(pagePath);

    if ((rawBySlug.get(page.slug) ?? []).length > 0) {
      const rawPath = confinedOutputPath(
        outDir,
        rawSidecarRelativePath(page.slug),
      );
      addFile(rawPath);
    }
  }

  for (const file of files.values()) {
    let parent = dirname(file);
    while (parent !== root) {
      const collidingFile = files.get(collisionKey(parent));
      if (collidingFile !== undefined) {
        failExport(
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

async function parseScopedSource(engine: BrainEngine, args: string[]): Promise<string | undefined> {
  const sourceIdx = args.indexOf('--source');
  if (sourceIdx === -1) return undefined;

  const sourceId = args[sourceIdx + 1];
  if (!sourceId || sourceId.startsWith('--')) {
    failExport('gbrain export --source requires a source id.');
  }
  if (!isValidSourceId(sourceId)) {
    failExport(`invalid --source value ${JSON.stringify(sourceId)}; expected a registered lowercase source id.`);
  }
  if (args.includes('--restore-only')) {
    failExport('gbrain export does not support --source with --restore-only; choose one recovery mode.');
  }
  if (args.includes('--type') || args.includes('--slug-prefix')) {
    failExport(
      'gbrain export --source is a complete recovery export and does not support '
      + '--type or --slug-prefix filters.',
    );
  }

  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1 AND archived = false`,
    [sourceId],
  );
  if (rows.length === 0) {
    failExport(
      `source "${sourceId}" is not active or does not exist. `
      + 'Run `gbrain sources list` to inspect registered sources.',
    );
  }
  return sourceId;
}

const SCOPED_EXPORT_BATCH_SIZE = 5_000;

async function countScopedPages(engine: BrainEngine, sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL`,
    [sourceId],
  );
  const count = Number(rows[0]?.n ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    failExport(`invalid page count while exporting source "${sourceId}".`);
  }
  return count;
}

async function loadCompleteScopedPages(
  engine: BrainEngine,
  sourceId: string,
): Promise<{
  pages: import('../core/types.ts').Page[];
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
      failExport(`source "${sourceId}" stopped being active before its recovery snapshot.`);
    }

    const sourcePageCountBefore = await countScopedPages(snapshot, sourceId);
    const pages: import('../core/types.ts').Page[] = [];

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
      failExport(
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

export async function runExport(engine: BrainEngine, args: string[]) {
  const dirIdx = args.indexOf('--dir');
  const outDir = dirIdx !== -1 ? args[dirIdx + 1] : './export';
  if (!outDir || outDir.startsWith('--')) {
    failExport('gbrain export --dir requires an output directory.');
  }

  const repoIdx = args.indexOf('--repo');
  const explicitRepoPath = repoIdx !== -1 ? args[repoIdx + 1] : null;

  const typeIdx = args.indexOf('--type');
  const typeFilter = typeIdx !== -1 ? (args[typeIdx + 1] as string) : undefined;

  const slugPrefixIdx = args.indexOf('--slug-prefix');
  const slugPrefix = slugPrefixIdx !== -1 ? args[slugPrefixIdx + 1] : undefined;

  const restoreOnly = args.includes('--restore-only');
  const sourceId = await parseScopedSource(engine, args);

  // Resolution chain (D5): explicit --repo → typed sources.getDefault() →
  // hard-error for restore-only paths (never fall through to cwd).
  // For non-restore exports, repoPath stays null because regular export
  // doesn't need a brain repo to run (D26 — exports include everything).
  let repoPath: string | null = explicitRepoPath;
  if (restoreOnly && !repoPath) {
    repoPath = await getDefaultSourcePath(engine);
    if (!repoPath) {
      console.error(
        `Error: gbrain export --restore-only requires --repo <path> or a configured\n` +
          `default source with a local_path. Run \`gbrain sources list\` to inspect\n` +
          `sources, or pass --repo explicitly.`,
      );
      process.exit(1);
    }
  }

  // Load storage configuration if repo path is provided
  const storageConfig = repoPath ? loadStorageConfig(repoPath) : null;

  // D5 + Codex P0: refuse --restore-only when there's no storage config to
  // scope the restore. Without storageConfig, the selective filter (db_only
  // pages missing on disk) can't run, and falling through to the full
  // listPages export silently dumps the entire DB. Catch this before any
  // page query fires.
  if (restoreOnly && !storageConfig) {
    console.error(
      `Error: gbrain export --restore-only requires a storage tiering config\n` +
        `(gbrain.yml with a "storage:" section) at ${repoPath}/gbrain.yml.\n` +
        `Without it, there's nothing to scope the restore to.\n` +
        `Run \`gbrain storage status\` to inspect the current configuration.`,
    );
    process.exit(1);
  }

  // Build filters. slugPrefix is engine-side (Issue #13) — no in-memory
  // post-filter, no full-table load.
  const filters: import('../core/types.ts').PageFilters = { limit: 100000 };
  if (typeFilter) filters.type = typeFilter;
  if (slugPrefix) filters.slugPrefix = slugPrefix;

  let pages: import('../core/types.ts').Page[];
  let sourcePageCount: number | undefined;
  let scopedTags: Map<string, string[]> | undefined;
  let scopedRaw: Map<string, RawData[]> | undefined;

  // Restore-only path: query each db_only directory with slugPrefix instead
  // of loading every page in the brain. On a 200K-page brain where 95% is
  // db_only, this is roughly the same load — but on brains where only 5K
  // out of 200K are db_only, this is a ~40x reduction.
  if (restoreOnly && repoPath && storageConfig) {
    const seen = new Set<string>();
    pages = [];
    for (const dir of storageConfig.db_only) {
      const tierFilters: import('../core/types.ts').PageFilters = {
        ...filters,
        slugPrefix: filters.slugPrefix
          ? // If user passed --slug-prefix, only include tier dirs that start with it.
            (dir.startsWith(filters.slugPrefix) ? dir : undefined)
          : dir,
      };
      if (!tierFilters.slugPrefix) continue;
      const tierPages = await engine.listPages(tierFilters);
      for (const p of tierPages) {
        if (seen.has(p.slug)) continue;
        seen.add(p.slug);
        if (!isDbOnly(p.slug, storageConfig)) continue; // belt-and-suspenders
        const filePath = join(repoPath, p.slug + '.md');
        if (existsSync(filePath)) continue;
        pages.push(p);
      }
    }
  } else if (sourceId) {
    const complete = await loadCompleteScopedPages(engine, sourceId);
    pages = complete.pages;
    sourcePageCount = complete.sourcePageCount;
    scopedTags = complete.tagsBySlug;
    scopedRaw = complete.rawBySlug;
  } else {
    pages = await engine.listPages(filters);
  }

  // Validate the complete scoped write set before creating the output
  // directory so a malformed legacy row cannot leave a partial recovery
  // snapshot behind. Unscoped export retains its historical behavior.
  if (sourceId) {
    for (const page of pages) {
      assertSafeExportSlug(page.slug);
      confinedOutputPath(outDir, `${page.slug}.md`);
    }
    assertNonCollidingScopedWriteSet(outDir, pages, scopedRaw ?? new Map());
    if (sourcePageCount === undefined) {
      failExport('complete source page count was not captured.');
    }
  }

  using scopedStaging = sourceId ? createPrivateScopedExportStaging(outDir) : null;
  let exported = 0;
  let manifestReceipt: string | null = null;

  if (restoreOnly) {
    console.log(`Restoring ${pages.length} db_only pages to ${outDir}/`);
  } else {
    console.log(`Exporting ${pages.length} pages to ${outDir}/`);
  }

  // Progress on stderr so stdout stays clean for scripts parsing counts.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('export.pages', pages.length);

  let rawSidecarCount = 0;
  const manifestPages: ExportManifestPage[] = [];

  try {
    for (const page of pages) {
      const tags = sourceId
        ? (scopedTags?.get(page.slug) ?? [])
        : await engine.getTags(page.slug);
      const pageKind = page.type === 'code' ? 'code' : 'markdown';
      const sourcePath = pageKind === 'code' ? codeExportSourcePath(page) : undefined;
      // Code pages are exported as their original bytes. The recovery manifest
      // carries the importer kind and trusted source path, so the `.md`
      // snapshot filename remains a sealed page identity rather than silently
      // routing code through the markdown importer.
      const md = pageKind === 'code'
        ? page.compiled_truth
        : serializeMarkdown(
          page.frontmatter,
          page.compiled_truth,
          page.timeline,
          { type: page.type, title: page.title, tags },
        );

      const pageRelativePath = `${page.slug}.md`;
      if (sourceId) {
        scopedStaging!.writeFile(pageRelativePath, md);
      } else {
        const filePath = join(outDir, pageRelativePath);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, md);
      }

      // Export raw data as sidecar JSON
      const rawData = sourceId
        ? (scopedRaw?.get(page.slug) ?? [])
        : await engine.getRawData(page.slug);
      let rawSidecarSha256: string | null = null;
      if (rawData.length > 0) {
        const rawRelativePath = rawSidecarRelativePath(page.slug);
        const rawPath = sourceId
          ? confinedOutputPath(outDir, rawRelativePath)
          : join(outDir, rawRelativePath);
        const rawObj = Object.create(null) as Record<string, unknown>;
        const orderedRawData = sourceId
          ? [...rawData].sort((left, right) => compareCodePoints(left.source, right.source))
          : rawData;
        for (const rd of orderedRawData) {
          rawObj[rd.source] = rd.data;
        }
        const rawJson = sourceId
          ? canonicalJson(rawObj)
          : JSON.stringify(rawObj, null, 2) + '\n';
        if (sourceId) {
          scopedStaging!.writeFile(rawRelativePath, rawJson);
        } else {
          mkdirSync(dirname(rawPath), { recursive: true });
          writeFileSync(rawPath, rawJson);
        }
        rawSidecarSha256 = sha256(rawJson);
        rawSidecarCount++;
      }

      if (sourceId) {
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

      exported++;
      progress.tick();
    }
  } catch (error) {
    progress.finish('failed');
    throw error;
  }

  try {
    if (sourceId) {
      const manifest: ExportManifest = {
        schema_version: 1,
        source_id: sourceId,
        source_page_count: sourcePageCount!,
        page_count: exported,
        raw_sidecar_count: rawSidecarCount,
        pages: manifestPages,
      };
      const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
      const manifestPath = confinedOutputPath(outDir, '.gbrain-export-manifest.json');
      scopedStaging!.writeFile('.gbrain-export-manifest.json', manifestJson);
      manifestReceipt = `Manifest: ${manifestPath} sha256=${sha256(manifestJson)} `
        + `pages=${exported} raw_sidecars=${rawSidecarCount}`;
    }
  } catch (error) {
    progress.finish('failed');
    throw error;
  }
  if (sourceId && !scopedStaging!.tryPublish()) {
    progress.finish('failed');
    failExport(
      `gbrain export --source requires --dir to remain absent until publish; `
      + `${JSON.stringify(outDir)} became occupied. Choose a fresh recovery directory.`,
    );
  }
  progress.finish();

  // Stdout summary preserved so scripts that grep for "Exported N pages" keep working.
  if (restoreOnly) {
    console.log(`Restored ${exported} pages to ${outDir}/`);
  } else {
    console.log(`Exported ${exported} pages to ${outDir}/`);
  }

  if (manifestReceipt) console.log(manifestReceipt);
}

/** Focused test seam for completeness/determinism without filesystem writes. */
export const __testing = {
  compareCodePoints,
  canonicalJson,
  assertNonCollidingScopedWriteSet,
  createPrivateScopedExportStaging,
  loadCompleteScopedPages,
};
