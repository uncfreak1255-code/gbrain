/**
 * Source-scoped recovery export identity.
 *
 * A recovery export writes each page at `<stored-slug>.md`. Legacy stored
 * slugs can contain characters that the current path slugifier normalizes, so
 * importing that checkout by path alone can fabricate a second page. This
 * module accepts an override only from a complete, source-matching export
 * manifest whose page bytes still match the exported SHA-256 receipt.
 *
 * The manifest never authorizes a path to claim an unrelated slug: each entry
 * may map only the literal `<entry.slug>.md` path back to that same slug.
 * Files without a verified entry keep importFromFile's normal path-authority
 * and frontmatter anti-spoof behavior.
 */

import { createHash } from 'crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';

const MANIFEST_FILENAME = '.gbrain-export-manifest.json';

interface ExportManifestPage {
  slug: string;
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
 * Opaque capability issued only while this module verifies a manifest page.
 * The WeakSet gives importFromFile a runtime distinction between a checked
 * recovery mapping and a caller-supplied lookalike object.
 */
export interface VerifiedRecoverySlugOverride {
  readonly relativePath: string;
  readonly slug: string;
  readonly sourceId: string;
}

const verifiedRecoverySlugOverrides = new WeakSet<object>();
const verifiedRecoverySlugOverrideValues = new WeakMap<object, {
  relativePath: string;
  slug: string;
  sourceId: string;
}>();

function createVerifiedRecoverySlugOverride(
  relativePath: string,
  slug: string,
  sourceId: string,
): VerifiedRecoverySlugOverride {
  const override: VerifiedRecoverySlugOverride = { relativePath, slug, sourceId };
  // The public shape is convenient for callers, but it is not the authority:
  // retain the issued tuple privately and freeze the object so a holder cannot
  // retarget a valid path capability to a different stored slug.
  verifiedRecoverySlugOverrideValues.set(override, { relativePath, slug, sourceId });
  verifiedRecoverySlugOverrides.add(override);
  return Object.freeze(override);
}

/**
 * Recovery identity is valid only for the exact manifest-listed path that
 * received the capability. Callers cannot manufacture this proof from a
 * structurally similar object.
 */
export function isVerifiedRecoverySlugOverride(
  value: unknown,
  relativePath: string,
  sourceId: string,
): value is VerifiedRecoverySlugOverride {
  const issued = typeof value === 'object' && value !== null
    ? verifiedRecoverySlugOverrideValues.get(value)
    : undefined;
  return (
    typeof value === 'object'
    && value !== null
    && verifiedRecoverySlugOverrides.has(value)
    && issued?.relativePath === relativePath
    && issued.sourceId === sourceId
  );
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
    if (typeof value.markdown_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.markdown_sha256)) {
      failManifest(repoPath, `pages[${index}].markdown_sha256 must be a SHA-256 digest`);
    }
    return { slug: value.slug, markdown_sha256: value.markdown_sha256.toLowerCase() };
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
 * Return verified `repo-relative path -> stored slug` overrides for a recovery
 * checkout. An absent manifest, or a parseable manifest that explicitly names
 * another source, is an ordinary checkout and gets no override. Any malformed
 * manifest, or one that names the requested source but is incomplete, changed,
 * or unsafe, fails closed before sync imports a single page.
 */
export function loadVerifiedRecoverySlugOverrides(
  repoPath: string,
  sourceId: string,
): ReadonlyMap<string, VerifiedRecoverySlugOverride> {
  const manifestPath = join(repoPath, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return new Map();

  let manifestStat: ReturnType<typeof lstatSync>;
  try {
    manifestStat = lstatSync(manifestPath);
  } catch {
    return new Map();
  }
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
    if (sha256(readFileSync(filePath)) !== page.markdown_sha256) {
      failManifest(repoPath, `SHA-256 mismatch for ${relativePath}`);
    }
    overrides.set(
      relativePath,
      createVerifiedRecoverySlugOverride(relativePath, page.slug, sourceId),
    );
  }

  return overrides;
}
