/**
 * Source-scoped recovery export identity.
 *
 * A recovery export writes each page at `<stored-slug>.md`. Legacy stored
 * slugs can contain characters that the current path slugifier normalizes, so
 * importing that checkout by path alone can fabricate a second page.
 *
 * The checkout is untrusted. A manifest's own SHA-256 values establish only
 * integrity between the receipt and files beside it; they cannot authorize a
 * file to address an existing page. This module therefore issues a recovery
 * override only when the receipt is bound to the current trusted source row:
 * its `(source_id, slug)` and importer-equivalent page content must agree.
 * The exported DB hash is a snapshot receipt, not authority: a first valid
 * recovery import can normalize a historical row to the current importer
 * hash. Rows whose current hash is not importer-shaped fall back to an exact
 * canonical render from the trusted row. Source-scoped recovery deliberately
 * supports only Markdown pages: code and image rows require their original
 * importers and cannot be faithfully replayed from this Markdown receipt.
 */

import { createHash } from 'crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import type { BrainEngine } from './engine.ts';
import { hashParsedMarkdownForImport } from './import-content-hash.ts';
import { parseMarkdown, serializePageToMarkdown } from './markdown.ts';

const MANIFEST_FILENAME = '.gbrain-export-manifest.json';

interface ExportManifestPage {
  slug: string;
  db_content_hash: string | null;
  markdown_sha256: string;
}

interface ExportManifest {
  schema_version: 1;
  source_id: string;
  source_page_count: number;
  page_count: number;
  raw_sidecar_count: number;
  pages: ExportManifestPage[];
}

/**
 * Opaque capability issued only while this module verifies both a recovery
 * receipt and its matching trusted source row. The WeakSet gives
 * importFromFile a runtime distinction between a checked recovery mapping and
 * a caller-supplied lookalike object.
 */
export interface VerifiedRecoverySlugOverride {
  readonly relativePath: string;
  readonly slug: string;
  readonly sourceId: string;
}

interface IssuedRecoverySlugOverride {
  relativePath: string;
  slug: string;
  sourceId: string;
  dbContentHash: string | null;
  markdownSha256: string;
  /** Present only for source rows that predate import content hashes. */
  canonicalMarkdownSha256?: string;
}

const verifiedRecoverySlugOverrides = new WeakSet<object>();
const verifiedRecoverySlugOverrideValues = new WeakMap<object, IssuedRecoverySlugOverride>();
// A same-source receipt seals the import surface. Keep that fact separate from
// the page capabilities: an empty ordinary map means "no receipt", while an
// empty sealed map means "a verified empty recovery snapshot".
const sealedRecoveryOverrideMaps = new WeakSet<object>();

function createVerifiedRecoverySlugOverride(
  value: IssuedRecoverySlugOverride,
): VerifiedRecoverySlugOverride {
  const override: VerifiedRecoverySlugOverride = {
    relativePath: value.relativePath,
    slug: value.slug,
    sourceId: value.sourceId,
  };
  // The public shape is convenient for callers, but it is not the authority:
  // retain the receipt + source-row binding privately and freeze the object so
  // a holder cannot retarget a valid capability to another stored slug.
  verifiedRecoverySlugOverrideValues.set(override, value);
  verifiedRecoverySlugOverrides.add(override);
  return Object.freeze(override);
}

function issuedOverride(value: unknown): IssuedRecoverySlugOverride | undefined {
  if (typeof value !== 'object' || value === null || !verifiedRecoverySlugOverrides.has(value)) {
    return undefined;
  }
  return verifiedRecoverySlugOverrideValues.get(value);
}

/**
 * Resolve a path's recovery capability. Ordinary checkouts still return
 * `undefined` for paths with no override; a checked same-source recovery
 * snapshot instead fails closed. Call this immediately before every import
 * use as well as during preflight, so a file added after inventory verification
 * cannot fall back to ordinary path-derived identity.
 */
export function getVerifiedRecoverySlugOverrideForPath(
  overrides: ReadonlyMap<string, VerifiedRecoverySlugOverride>,
  repoPath: string,
  relativePath: string,
): VerifiedRecoverySlugOverride | undefined {
  const override = overrides.get(relativePath);
  if (override === undefined && sealedRecoveryOverrideMaps.has(overrides)) {
    failManifest(repoPath, `unexpected recovery file ${relativePath}`);
  }
  return override;
}

/** A recovery capability no longer matches the trusted source at write time. */
export class RecoverySlugOverrideInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoverySlugOverrideInvalidError';
  }
}

/**
 * Recheck a capability immediately before parsing/writing a file. This closes
 * the file TOCTOU window between manifest loading and import, and verifies the
 * source row still has the identity that issued the capability.
 */
export async function isVerifiedRecoverySlugOverride(
  engine: BrainEngine,
  value: unknown,
  relativePath: string,
  sourceId: string,
  content: Buffer,
): Promise<boolean> {
  const issued = issuedOverride(value);
  if (
    issued === undefined
    || issued.relativePath !== relativePath
    || issued.sourceId !== sourceId
    || sha256(content) !== issued.markdownSha256
  ) {
    return false;
  }

  const current = await engine.getPage(issued.slug, { sourceId });
  if (!current || (current.content_hash ?? null) !== issued.dbContentHash) {
    return false;
  }

  // Historical rows can legitimately have no import content hash. In that
  // case, re-render the trusted row at use time rather than treating a null
  // value as an authority wildcard.
  if (issued.canonicalMarkdownSha256 !== undefined) {
    const tags = await engine.getTags(issued.slug, { sourceId });
    const canonical = Buffer.from(serializePageToMarkdown(current, tags), 'utf8');
    if (sha256(canonical) !== issued.canonicalMarkdownSha256) return false;
  }

  return true;
}

/**
 * Bind a verified recovery capability to the final page write. The preflight
 * check above protects the file bytes, but cannot hold a database lock while
 * parsing and (potentially) embedding. Recheck the trusted row inside the
 * import transaction so an intervening manual/MCP change wins rather than
 * being silently overwritten by the historical recovery snapshot.
 */
export async function assertVerifiedRecoverySlugOverrideForWrite(
  tx: BrainEngine,
  value: unknown,
  sourceId: string,
  slug: string,
): Promise<void> {
  const issued = issuedOverride(value);
  if (issued === undefined || issued.sourceId !== sourceId || issued.slug !== slug) {
    throw new RecoverySlugOverrideInvalidError(
      `Unverified recovery slug override for ${issued?.relativePath ?? slug}: receipt or trusted source page changed.`,
    );
  }

  // Lock the active source row before comparing its identity. The lock stays
  // held through putPage in the caller's transaction, making check-and-write
  // atomic across Postgres and PGLite.
  const rows = await tx.executeRaw<{ content_hash: string | null; page_kind: string }>(
    `SELECT content_hash, page_kind
       FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL
      FOR UPDATE`,
    [sourceId, slug],
  );
  const current = rows[0];
  if (
    !current
    || current.page_kind !== 'markdown'
    || (current.content_hash ?? null) !== issued.dbContentHash
  ) {
    throw new RecoverySlugOverrideInvalidError(
      `Unverified recovery slug override for ${issued.relativePath}: trusted source page changed before write.`,
    );
  }

  // Legacy rows can have no importer content hash. Preserve the same
  // canonical-render binding used at preflight, now while the page row is
  // locked through the final write.
  if (issued.canonicalMarkdownSha256 !== undefined) {
    const page = await tx.getPage(slug, { sourceId });
    if (!page) {
      throw new RecoverySlugOverrideInvalidError(
        `Unverified recovery slug override for ${issued.relativePath}: trusted source page changed before write.`,
      );
    }
    const tags = await tx.getTags(slug, { sourceId });
    const canonical = Buffer.from(serializePageToMarkdown(page, tags), 'utf8');
    if (sha256(canonical) !== issued.canonicalMarkdownSha256) {
      throw new RecoverySlugOverrideInvalidError(
        `Unverified recovery slug override for ${issued.relativePath}: trusted source page changed before write.`,
      );
    }
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function failManifest(repoPath: string, detail: string): never {
  throw new Error(
    `Invalid source-scoped recovery manifest in ${repoPath}: ${detail}. ` +
    'Recreate the checkout with `gbrain export --source <id> --dir <new-private-dir>` before syncing.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function requireNonNegativeInteger(
  value: unknown,
  field: string,
  repoPath: string,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    failManifest(repoPath, `${field} must be a non-negative integer`);
  }
  return value;
}

function readManifestJson(repoPath: string, manifestPath: string): unknown {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    // A present receipt that cannot be read is not equivalent to an absent
    // receipt: continuing would downgrade a damaged recovery checkout to
    // path-derived identity and can recreate a legacy-slug duplicate.
    failManifest(
      repoPath,
      `could not parse ${MANIFEST_FILENAME} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function parseManifest(repoPath: string, parsed: unknown): ExportManifest {
  if (!isRecord(parsed)) failManifest(repoPath, 'manifest must be a JSON object');
  if (parsed.schema_version !== 1) failManifest(repoPath, 'unsupported schema_version');
  if (typeof parsed.source_id !== 'string' || parsed.source_id.length === 0) {
    failManifest(repoPath, 'source_id must be a non-empty string');
  }
  const sourcePageCount = requireNonNegativeInteger(parsed.source_page_count, 'source_page_count', repoPath);
  const pageCount = requireNonNegativeInteger(parsed.page_count, 'page_count', repoPath);
  const rawSidecarCount = requireNonNegativeInteger(parsed.raw_sidecar_count, 'raw_sidecar_count', repoPath);
  if (!Array.isArray(parsed.pages)) failManifest(repoPath, 'pages must be an array');
  if (pageCount !== parsed.pages.length || sourcePageCount !== parsed.pages.length) {
    failManifest(repoPath, 'page counts do not describe a complete export');
  }

  const pages: ExportManifestPage[] = parsed.pages.map((value, index) => {
    if (!isRecord(value)) failManifest(repoPath, `pages[${index}] must be an object`);
    if (typeof value.slug !== 'string' || value.slug.length === 0) {
      failManifest(repoPath, `pages[${index}].slug must be a non-empty string`);
    }
    if (value.db_content_hash !== null && (
      typeof value.db_content_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.db_content_hash)
    )) {
      failManifest(repoPath, `pages[${index}].db_content_hash must be a SHA-256 digest or null`);
    }
    if (typeof value.markdown_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.markdown_sha256)) {
      failManifest(repoPath, `pages[${index}].markdown_sha256 must be a SHA-256 digest`);
    }
    return {
      slug: value.slug,
      db_content_hash: value.db_content_hash === null ? null : value.db_content_hash.toLowerCase(),
      markdown_sha256: value.markdown_sha256.toLowerCase(),
    };
  });

  return {
    schema_version: 1,
    source_id: parsed.source_id,
    source_page_count: sourcePageCount,
    page_count: pageCount,
    raw_sidecar_count: rawSidecarCount,
    pages,
  };
}

function recoveryRelativePath(slug: string, repoPath: string): string {
  if (
    slug.includes('\0') ||
    slug.includes('\\') ||
    isAbsolute(slug) ||
    slug.split('/').some(part => part.length === 0 || part === '.' || part === '..')
  ) {
    failManifest(repoPath, `unsafe stored slug ${JSON.stringify(slug)}`);
  }
  return `${slug}.md`;
}

function assertInside(root: string, candidate: string, repoPath: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    failManifest(repoPath, `${label} escapes the recovery checkout`);
  }
}

function assertRegularPathWithoutSymlinkParents(
  repoPath: string,
  relativePath: string,
): void {
  let current = repoPath;
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      failManifest(repoPath, `missing exported page ${relativePath}`);
    }
    if (stat.isSymbolicLink()) {
      failManifest(repoPath, `recovery page ${relativePath} uses a symlink`);
    }
  }
  if (!lstatSync(current).isFile()) {
    failManifest(repoPath, `recovery page ${relativePath} is not a regular file`);
  }
}

/**
 * A same-source recovery checkout is a sealed snapshot, not a normal working
 * tree. The manifest already proves every listed page, but the import walker
 * would otherwise accept an extra visible file under ordinary path-derived
 * identity. Reject it before sync begins, so an addition cannot create a
 * second page whose path happens to normalize a legacy stored slug.
 *
 * Hidden entries intentionally stay outside this inventory: the export
 * manifest itself, Git metadata, and optional `.raw` sidecars are not
 * syncable page inputs. The ordinary sync walker prunes those directories
 * too. Every listed page is still checked separately, including an unusual
 * hidden stored-slug path.
 */
function assertRecoveryHasNoUnlistedVisibleFiles(
  repoPath: string,
  expectedPagePaths: ReadonlySet<string>,
): void {
  function walk(directory: string, relativeDirectory: string): void {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch (error) {
      failManifest(
        repoPath,
        `could not inspect recovery directory ${relativeDirectory || '.'} (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    for (const entry of entries) {
      // Both git-aware and filesystem import walks prune hidden paths. They
      // cannot turn a recovery override into a page, so they are not part of
      // this page-input inventory.
      if (entry.startsWith('.')) continue;

      const relativePath = relativeDirectory === '' ? entry : `${relativeDirectory}/${entry}`;
      const fullPath = join(directory, entry);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(fullPath);
      } catch (error) {
        failManifest(
          repoPath,
          `could not inspect recovery path ${relativePath} (${error instanceof Error ? error.message : String(error)})`,
        );
      }

      if (stat.isSymbolicLink()) {
        failManifest(repoPath, `unexpected recovery path ${relativePath} uses a symlink`);
      }
      if (stat.isDirectory()) {
        walk(fullPath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        failManifest(repoPath, `unexpected recovery path ${relativePath} is not a regular file`);
      }
      if (!expectedPagePaths.has(relativePath)) {
        failManifest(repoPath, `unexpected recovery file ${relativePath}`);
      }
    }
  }

  walk(repoPath, '');
}

async function verifyPageAgainstTrustedSource(
  engine: BrainEngine,
  page: ExportManifestPage,
  sourceId: string,
  relativePath: string,
  content: Buffer,
  repoPath: string,
): Promise<{ dbContentHash: string | null; canonicalMarkdownSha256?: string }> {
  const sourcePage = await engine.getPage(page.slug, { sourceId });
  if (!sourcePage) {
    failManifest(repoPath, `no active trusted source page exists for ${page.slug}`);
  }

  const dbContentHash = sourcePage.content_hash ?? null;

  // Most source rows originated through importFromContent, so this one pure
  // parse/hash check is the fast, exact authority binding used by the importer
  // itself. It is intentionally not a manifest-only check. Do not require
  // page.db_content_hash to equal dbContentHash here: a legitimate first
  // recovery sync can normalize a historical/programmatic hash to this
  // importer-shaped value while leaving the static export receipt unchanged.
  if (dbContentHash !== null) {
    const parsed = parseMarkdown(content.toString('utf8'), relativePath);
    if (hashParsedMarkdownForImport(parsed) === dbContentHash) {
      return { dbContentHash };
    }
  }

  // Some historical/programmatic rows have no importer hash (or a legacy
  // engine-computed shape). Compare their recovery file byte-for-byte with a
  // fresh canonical render of the trusted DB page rather than widening trust.
  const tags = await engine.getTags(page.slug, { sourceId });
  const canonical = Buffer.from(serializePageToMarkdown(sourcePage, tags), 'utf8');
  if (!canonical.equals(content)) {
    failManifest(repoPath, `Markdown content does not match the trusted source page for ${relativePath}`);
  }
  return {
    dbContentHash,
    canonicalMarkdownSha256: sha256(canonical),
  };
}

async function assertManifestMatchesTrustedSourceCount(
  engine: BrainEngine,
  manifest: ExportManifest,
  sourceId: string,
  repoPath: string,
): Promise<void> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL`,
    [sourceId],
  );
  const actualCount = Number(rows[0]?.n ?? Number.NaN);
  if (!Number.isSafeInteger(actualCount) || actualCount < 0) {
    failManifest(repoPath, `could not read the active source page count for ${sourceId}`);
  }
  if (actualCount !== manifest.source_page_count) {
    failManifest(
      repoPath,
      `source page count ${manifest.source_page_count} does not match the trusted active source count ${actualCount}`,
    );
  }
}

/**
 * Recovery exports serialize pages as Markdown. Code and image rows need their
 * own source-path-aware importers, so accepting a receipt that names either
 * kind could delete it under `--strategy code` or re-chunk it as Markdown.
 * Query once per receipt, before collection or reconciliation can mutate data.
 */
async function assertTrustedSourceHasOnlyMarkdownPages(
  engine: BrainEngine,
  sourceId: string,
  repoPath: string,
): Promise<void> {
  const rows = await engine.executeRaw<{ slug: string; page_kind: string }>(
    `SELECT slug, page_kind
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND page_kind <> 'markdown'
      ORDER BY slug
      LIMIT 1`,
    [sourceId],
  );
  if (rows.length > 0) {
    const page = rows[0]!;
    failManifest(
      repoPath,
      `source-scoped recovery supports only markdown pages; `
      + `${page.slug} is a ${page.page_kind} page. `
      + 'Use the original source checkout for code or image recovery.',
    );
  }
}

/**
 * Return verified `repo-relative path -> stored slug` overrides for a recovery
 * checkout. An absent manifest, or a parseable manifest that explicitly names
 * another source, is an ordinary checkout and gets no override. Any malformed
 * manifest, altered receipt, untrusted page identity, or changed source row
 * fails closed before sync imports a single page.
 */
export async function loadVerifiedRecoverySlugOverrides(
  engine: BrainEngine,
  repoPath: string,
  sourceId: string,
): Promise<ReadonlyMap<string, VerifiedRecoverySlugOverride>> {
  const manifestPath = join(repoPath, MANIFEST_FILENAME);
  let manifestStat: ReturnType<typeof lstatSync>;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return new Map();
    failManifest(
      repoPath,
      `could not inspect ${MANIFEST_FILENAME} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  // Do not use existsSync() here: it follows symlinks and would downgrade a
  // dangling manifest symlink to an "absent" receipt.
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    failManifest(repoPath, `${MANIFEST_FILENAME} must be a regular file`);
  }

  // Source identity decides whether this file has any authority at all. Read
  // only enough JSON to make that decision first: another source's future
  // manifest schema must not block a normal import of this checkout. A
  // missing/invalid identity is fail-closed because a present receipt cannot
  // safely be downgraded to ordinary path-derived import behavior.
  const manifestJson = readManifestJson(repoPath, manifestPath);
  if (!isRecord(manifestJson) || typeof manifestJson.source_id !== 'string' || manifestJson.source_id.length === 0) {
    failManifest(repoPath, 'source_id must be a non-empty string');
  }
  if (manifestJson.source_id !== sourceId) return new Map();
  const manifest = parseManifest(repoPath, manifestJson);
  await assertManifestMatchesTrustedSourceCount(engine, manifest, sourceId, repoPath);
  await assertTrustedSourceHasOnlyMarkdownPages(engine, sourceId, repoPath);

  const rootResolved = resolve(repoPath);
  const rootReal = realpathSync(repoPath);
  const manifestReal = realpathSync(manifestPath);
  assertInside(rootReal, manifestReal, repoPath, MANIFEST_FILENAME);

  const overrides = new Map<string, VerifiedRecoverySlugOverride>();
  for (const page of manifest.pages) {
    const relativePath = recoveryRelativePath(page.slug, repoPath);
    if (overrides.has(relativePath)) {
      failManifest(repoPath, `duplicate recovery path ${relativePath}`);
    }

    const filePath = resolve(repoPath, relativePath);
    assertInside(rootResolved, filePath, repoPath, `recovery page ${relativePath}`);
    assertRegularPathWithoutSymlinkParents(repoPath, relativePath);
    const fileReal = realpathSync(filePath);
    assertInside(rootReal, fileReal, repoPath, `recovery page ${relativePath}`);
    const content = readFileSync(filePath);
    if (sha256(content) !== page.markdown_sha256) {
      failManifest(repoPath, `SHA-256 mismatch for ${relativePath}`);
    }

    const binding = await verifyPageAgainstTrustedSource(
      engine,
      page,
      sourceId,
      relativePath,
      content,
      repoPath,
    );
    overrides.set(
      relativePath,
      createVerifiedRecoverySlugOverride({
        relativePath,
        slug: page.slug,
        sourceId,
        dbContentHash: binding.dbContentHash,
        markdownSha256: page.markdown_sha256,
        canonicalMarkdownSha256: binding.canonicalMarkdownSha256,
      }),
    );
  }

  assertRecoveryHasNoUnlistedVisibleFiles(repoPath, new Set(overrides.keys()));
  sealedRecoveryOverrideMaps.add(overrides);

  return overrides;
}
