import { accessSync, closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquirePageLock } from './page-lock.ts';
import { parseLearningLoopFence, renderLearningLoopFence, isLearningTransitionPermit, learningLoopHasProtectedState, learningLoopProtectedStateHash, type LearningTransitionPermit } from './learning-loop-knowledge.ts';
import { parseFactsFence } from './facts-fence.ts';
import type { BrainEngine } from './engine.ts';
import { syncLockId, withRefreshingLock } from './db-lock.ts';
import { activeV2DestinationBinding } from './learning-loop.ts';
import { computeBrainIdFromConfig } from './upgrade-checkpoint.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

export type CanonicalWriterMode = 'ordinary_content' | 'non_lineage_fact' | 'learning_transition' | 'checkout_rebuild';
export interface SourceQualifiedCanonicalTarget { brain_id: string; source_id: string; canonical_slug: string; configured_root: string; }
export interface SourceQualifiedMutation { engine: BrainEngine; sourceId: string; slug: string; brainId?: string; }
export type CanonicalWriteTarget = SourceQualifiedCanonicalTarget;
export interface SourceWriteLease { readonly __brand: 'SourceWriteLease'; readonly brain_id: string; readonly source_id: string; readonly configured_root: string; readonly root_realpath: string; readonly token: string; readonly dev: number; readonly ino: number; }
export interface CanonicalWriteOptions { mode: CanonicalWriterMode; lockRoot?: string; sourceLease: SourceWriteLease; transitionPermit?: LearningTransitionPermit; beforeRename?: () => void; expectedManaged?: ManagedExpectation | boolean; }
export type ManagedExpectation = 'expected' | 'not_expected' | 'unknown';
export type PageDbMutationClass = 'canonical_reconciliation' | 'db_first_content' | 'destructive_admin' | 'derived_only';
export interface PageDbMutationPermit {
  readonly __brand: 'PageDbMutationPermit';
  readonly brain_id: string;
  readonly source_id: string;
  readonly canonical_slug: string;
  readonly mutation_class: PageDbMutationClass;
  readonly managed: boolean;
  readonly canonical_sha256: string | null;
  readonly lease_token: string | null;
}
export interface ExpectedManagedState {
  readonly managed: boolean;
  readonly canonical: string;
  readonly canonical_sha256: string;
  readonly permit: PageDbMutationPermit;
}
export interface ExpectedManagedPreflightOptions {
  /** A replay/active-run/derived-row hint. Hints can only make the check stricter. */
  expected?: ManagedExpectation | boolean;
  /** Optional previously accepted protected-state hash. Mismatch is a trust failure. */
  protectedStateHash?: string | null;
  mutationClass?: PageDbMutationClass;
}
const liveLeases = new WeakSet<object>();
const liveLeaseTokens = new Set<string>();
const mutationPermits = new WeakSet<object>();
const sourceLeaseContext = new AsyncLocalStorage<SourceWriteLease>();
const FACTS = /<!--- gbrain:facts:begin -->[\s\S]*?<!--- gbrain:facts:end -->/g;
const META = /<!-- gbrain:learning-loop:v1:begin -->[\s\S]*?<!-- gbrain:learning-loop:v1:end -->/g;
function validateTarget(t: SourceQualifiedCanonicalTarget): void {
  const parts = t.canonical_slug.split('/');
  if (!t.brain_id || !t.source_id || !t.canonical_slug || t.canonical_slug.includes('\0') || isAbsolute(t.canonical_slug) || parts.some(x => !x || x === '..' || x === '.')) {
    throw new Error('invalid canonical target');
  }
}
function markerCount(s: string, marker: string): number { return s.split(marker).length - 1; }
function blocks(s: string): [string, string] { const f = [...s.matchAll(FACTS)], m = [...s.matchAll(META)]; const malformed = markerCount(s, '<!--- gbrain:facts:begin -->') !== f.length || markerCount(s, '<!--- gbrain:facts:end -->') !== f.length || markerCount(s, '<!-- gbrain:learning-loop:v1:begin -->') !== m.length || markerCount(s, '<!-- gbrain:learning-loop:v1:end -->') !== m.length; if (malformed || f.length > 1 || m.length > 1 || (m.length && !parseLearningLoopFence(m[0][0]))) throw new Error('malformed or duplicate protected fence'); return [f[0]?.[0] ?? '', m[0]?.[0] ?? '']; }
function prepare(input: string, old: string, mode: CanonicalWriterMode, permit?: LearningTransitionPermit): string {
  const previous = blocks(old);
  const next = blocks(input);
  const managed = Boolean(previous[1]);
  if (!managed && next[1]) {
    throw new Error('managed_state_unavailable: metadata creation requires the lineage reducer');
  }
  if (managed && mode === 'learning_transition') {
    const previousKnowledge = parseLearningLoopFence(previous[1])!.value;
    const nextKnowledge = parseLearningLoopFence(next[1] ?? '')?.value;
    if (!permit || !isLearningTransitionPermit(permit, previousKnowledge, nextKnowledge)) {
      throw new Error('managed_state_unavailable: transition permit required');
    }
    return input;
  }
  if (managed && mode === 'non_lineage_fact' && next[1] && next[1] !== previous[1]) {
    throw new Error('managed_state_unavailable: protected metadata fence changed');
  }
  if (managed && mode !== 'non_lineage_fact' && next.some((value, index) => value && value !== previous[index])) {
    throw new Error('managed_state_unavailable: protected fence changed');
  }
  let output = input;
  for (let index = 0; index < 2; index++) {
    // Fence-write appends a replacement facts table in non_lineage_fact mode.
    // Restoring the previous table would wipe the inserted row. Ordinary
    // managed writes still omit the fence and must restore it from disk.
    if (index === 0 && mode === 'non_lineage_fact' && next[0]) continue;
    if (previous[index]) {
      output = next[index] ? output.replace(next[index], previous[index]) : `${output.trimEnd()}\n\n${previous[index]}\n`;
    }
  }
  const staged = blocks(output);
  if (managed && ((mode !== 'non_lineage_fact' && staged[0] !== previous[0]) || staged[1] !== previous[1])) {
    throw new Error('managed_state_unavailable: staged fences changed');
  }
  return output;
}

function atomic(
  path: string,
  bytes: string,
  root: string,
  validateLease: () => void,
  beforeRename?: () => void,
): void {
  const lexicalParent = dirname(path);
  const parent = realpathSync(lexicalParent);
  if (!contained(parent, root)) throw new Error('canonical target rebind');
  const parentIdentity = statSync(parent);
  const destination = join(parent, basename(path));
  const tmp = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    beforeRename?.();
    validateLease();
    const checkedParent = statSync(parent);
    if (checkedParent.dev !== parentIdentity.dev || checkedParent.ino !== parentIdentity.ino || !contained(destination, root)) {
      throw new Error('canonical target rebind');
    }
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    blocks(bytes);
    validateLease();
    const currentParent = statSync(parent);
    if (currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino || !contained(destination, root)) {
      throw new Error('canonical target rebind');
    }
    renameSync(tmp, destination);
    validateLease();
    const directory = openSync(parent, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* noop */ }
    try { unlinkSync(tmp); } catch { /* noop */ }
    throw error;
  }
}
function contained(p:string,r:string):boolean { const rel=relative(resolve(r),resolve(p)); return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel)); }

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function assertManagedFactRowsPresent(
  value: Parameters<typeof learningLoopProtectedStateHash>[0],
  facts: ReturnType<typeof parseFactsFence>['facts'],
): void {
  const factRows = new Set(facts.map(row => row.rowNum));
  for (const raw of Object.values(value.managed_rows)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('managed_state_unavailable: managed fact row mapping is malformed');
    }
    const rowNum = Number((raw as Record<string, unknown>).row_num);
    if (!Number.isSafeInteger(rowNum) || rowNum < 1) {
      throw new Error('managed_state_unavailable: managed fact row mapping is malformed');
    }
    if (!factRows.has(rowNum)) {
      throw new Error('managed_state_unavailable: managed fact row is absent from canonical facts');
    }
  }
}

function withDerivedProtectedStateHash(content: string): string {
  const parsed = parseLearningLoopFence(content);
  if (!parsed) return content;
  const facts = parseFactsFence(content);
  if (facts.warnings.length > 0 && learningLoopHasProtectedState(parsed.value)) {
    throw new Error('managed_state_unavailable: protected facts fence is malformed');
  }
  assertManagedFactRowsPresent(parsed.value, facts.facts);
  const protected_state_hash = learningLoopProtectedStateHash(parsed.value, facts.facts);
  return content.replace(parsed.raw, renderLearningLoopFence({ ...parsed.value, protected_state_hash }));
}
function targetPath(target: SourceQualifiedCanonicalTarget, lease: SourceWriteLease): string {
  return join(lease.root_realpath, `${target.canonical_slug}.md`);
}
function expectedBoolean(value: ManagedExpectation | boolean | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : value === 'expected' ? true : value === 'not_expected' ? false : undefined;
}

/** Resolve the one live canonical root allowed for a source. */
export async function resolveEffectiveCanonicalRoot(
  engine: Pick<BrainEngine, 'executeRaw' | 'getConfig'>,
  sourceId: string,
): Promise<string | null> {
  const rawSources = await engine.executeRaw<{ id: string; local_path: string | null }>(
    'SELECT id, local_path FROM sources ORDER BY id',
  );
  const sources = Array.isArray(rawSources) ? rawSources : [];
  const selected = sources.find(source => source.id === sourceId);
  if (selected?.local_path) return selected.local_path;
  if (sourceId === 'default' && sources.length === 1 && sources[0]?.id === 'default') {
    return engine.getConfig('sync.repo_path');
  }
  return null;
}

function managedHintFromBody(body: string, slug: string, sourceId: string): boolean {
  if (!body) return false;
  let fence: ReturnType<typeof parseLearningLoopFence>;
  try { fence = parseLearningLoopFence(body); }
  catch { throw new Error('managed_state_unavailable: malformed managed row marker'); }
  if (!fence) return false;
  if (fence.value.source_id !== sourceId || fence.value.canonical_slug !== slug) {
    throw new Error('managed_state_unavailable: managed row marker target mismatch');
  }
  return true;
}

function activeDestinationHint(
  engine: Pick<BrainEngine, 'learningLoopLedgerConfig'>,
  slug: string,
  sourceId: string,
): boolean {
  const ledgerConfig = engine.learningLoopLedgerConfig?.();
  const active = ledgerConfig ? activeV2DestinationBinding({ config: ledgerConfig }) : undefined;
  return Boolean(active && active.source_id === sourceId && active.canonical_slug === slug);
}

async function expectedManagedByDurableHint(
  engine: Pick<BrainEngine, 'executeRaw' | 'learningLoopLedgerConfig'>,
  slug: string,
  sourceId: string,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ compiled_truth: string | null; timeline: string | null }>(
    'SELECT compiled_truth, timeline FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1', [slug, sourceId],
  );
  const body = [rows[0]?.compiled_truth, rows[0]?.timeline].filter(Boolean).join('\n');
  return managedHintFromBody(body, slug, sourceId) || activeDestinationHint(engine, slug, sourceId);
}

async function expectedManagedByDurableHints(
  engine: Pick<BrainEngine, 'executeRaw' | 'learningLoopLedgerConfig'>,
  slugs: readonly string[],
  sourceId: string,
): Promise<Map<string, boolean>> {
  const hints = new Map<string, boolean>();
  if (slugs.length === 0) return hints;
  const rows = await engine.executeRaw<{ slug: string; compiled_truth: string | null; timeline: string | null }>(
    'SELECT slug, compiled_truth, timeline FROM pages WHERE source_id = $1 AND slug = ANY($2::text[])',
    [sourceId, slugs],
  );
  const bySlug = new Map(rows.map(row => [row.slug, row]));
  const ledgerConfig = engine.learningLoopLedgerConfig?.();
  const active = ledgerConfig ? activeV2DestinationBinding({ config: ledgerConfig }) : undefined;
  for (const slug of slugs) {
    const row = bySlug.get(slug);
    const body = [row?.compiled_truth, row?.timeline].filter(Boolean).join('\n');
    hints.set(slug, managedHintFromBody(body, slug, sourceId)
      || Boolean(active && active.source_id === sourceId && active.canonical_slug === slug));
  }
  return hints;
}

/**
 * Inspect the exact source-qualified canonical target before a DB mutation.
 * Missing or malformed state is never treated as unmanaged when a caller has
 * an expectation hint. The returned permit is module-created and cannot be
 * forged by copying its fields.
 */
export function inspectExpectedManagedState(
  target: SourceQualifiedCanonicalTarget,
  lease: SourceWriteLease,
  options: ExpectedManagedPreflightOptions = {},
): ExpectedManagedState {
  validateTarget(target);
  checkLease(target, lease);
  const path = targetPath(target, lease);
  let canonical = '';
  try { canonical = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (expectedBoolean(options.expected) === true) throw new Error('managed_state_unavailable: canonical page is missing');
  }
  let managed = false;
  if (canonical) {
    let parsed: ReturnType<typeof parseLearningLoopFence>;
    try { parsed = parseLearningLoopFence(canonical); }
    catch { throw new Error('managed_state_unavailable: malformed protected fence'); }
    if (parsed) {
      managed = true;
      const identity = parsed.value;
      if (identity.brain_id !== target.brain_id || identity.source_id !== target.source_id || identity.canonical_slug !== target.canonical_slug) {
        throw new Error('managed_state_unavailable: metadata target mismatch');
      }
      const facts = parseFactsFence(canonical);
      if (facts.warnings.length > 0 && learningLoopHasProtectedState(identity)) {
        throw new Error('managed_state_unavailable: protected facts fence is malformed');
      }
      assertManagedFactRowsPresent(identity, facts.facts);
      const expectedProtectedStateHash = learningLoopProtectedStateHash(identity, facts.facts);
      if ((identity.protected_state_hash !== undefined && identity.protected_state_hash !== expectedProtectedStateHash)
        || (learningLoopHasProtectedState(identity) && identity.protected_state_hash === undefined)
        || (options.protectedStateHash !== undefined && options.protectedStateHash !== null && options.protectedStateHash !== expectedProtectedStateHash)) {
        throw new Error('managed_state_unavailable: protected state hash mismatch');
      }
    }
  }
  const expected = expectedBoolean(options.expected);
  if (expected === true && !managed) throw new Error('managed_state_unavailable: expected managed state is absent');
  if (expected === false && managed) throw new Error('managed_state_unavailable: unexpected managed state');
  const canonical_sha256 = canonical ? sha256(canonical) : sha256('');
  const permit = Object.freeze({
    __brand: 'PageDbMutationPermit' as const,
    brain_id: target.brain_id, source_id: target.source_id, canonical_slug: target.canonical_slug,
    mutation_class: options.mutationClass ?? 'canonical_reconciliation',
    managed, canonical_sha256: managed ? canonical_sha256 : null,
    lease_token: lease.token,
  });
  mutationPermits.add(permit);
  return { managed, canonical, canonical_sha256, permit };
}

export function assertPageDbMutationPermit(
  permit: PageDbMutationPermit,
  target: SourceQualifiedCanonicalTarget,
  mutationClass: PageDbMutationClass,
): void {
  if (!permit || !mutationPermits.has(permit) || permit.__brand !== 'PageDbMutationPermit'
    || permit.brain_id !== target.brain_id || permit.source_id !== target.source_id
    || permit.canonical_slug !== target.canonical_slug || permit.mutation_class !== mutationClass) {
    throw new Error('managed_state_unavailable: invalid page DB mutation permit');
  }
  if (permit.lease_token === null || !liveLeaseTokens.has(permit.lease_token)) throw new Error('managed_state_unavailable: stale page DB mutation permit');
}

/** Reconcile a page row only from bytes that were returned by the canonical sink. */
export function reconcileCanonicalReadback(
  target: SourceQualifiedCanonicalTarget,
  lease: SourceWriteLease,
  readback: string,
  permit: PageDbMutationPermit,
): string {
  checkLease(target, lease);
  assertPageDbMutationPermit(permit, target, 'canonical_reconciliation');
  const path = targetPath(target, lease);
  let actual: string;
  try { actual = readFileSync(path, 'utf8'); } catch { throw new Error('managed_state_unavailable: canonical readback unavailable'); }
  if (sha256(actual) !== permit.canonical_sha256 && permit.managed) throw new Error('managed_state_unavailable: canonical readback hash changed');
  if (actual !== readback) throw new Error('managed_state_unavailable: canonical readback mismatch');
  const inspected = inspectExpectedManagedState(target, lease, { expected: permit.managed });
  if (inspected.canonical !== readback) throw new Error('managed_state_unavailable: canonical readback changed');
  return actual;
}

/**
 * Guard for legacy path-only writers. Such a lane is safe only outside a
 * managed canonical page; it must reject before touching bytes when either
 * the current or proposed content carries Learning Loop metadata.
 */
export function assertUnmanagedPathMutation(path: string, nextContent?: string): void {
  let current = '';
  try { current = readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    if (current) parseLearningLoopFence(current);
    if (nextContent) parseLearningLoopFence(nextContent);
  } catch {
    throw new Error('managed_state_unavailable: malformed protected fence');
  }
  if (parseLearningLoopFence(current) || (nextContent && parseLearningLoopFence(nextContent))) {
    throw new Error('managed_state_unavailable: path-only writer cannot mutate managed canonical page');
  }
}

/** Engine-sink guard for mutations which can replace canonical content. */
export async function assertManagedPageMutationAllowed(
  engine: Pick<BrainEngine, 'executeRaw' | 'getConfig' | 'learningLoopLedgerConfig'>,
  slug: string,
  sourceId: string,
  mutationClass: PageDbMutationClass,
  permit?: PageDbMutationPermit,
): Promise<void> {
  if (permit && (permit.source_id !== sourceId || permit.canonical_slug !== slug)) {
    throw new Error('managed_state_unavailable: canonical permit target mismatch');
  }
  const expectedManaged = await expectedManagedByDurableHint(engine, slug, sourceId);
  const root = await resolveEffectiveCanonicalRoot(engine, sourceId);
  if (!root) {
    if (expectedManaged) throw new Error('managed_state_unavailable: expected canonical root is unavailable');
    return;
  }
  const path = join(resolve(root), `${slug}.md`);
  let content: string;
  try { content = readFileSync(path, 'utf8'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code === 'ENOENT' || code === 'ENOTDIR') && !permit && !expectedManaged) return;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('managed_state_unavailable: canonical permit target is missing');
    throw error;
  }
  let fence: ReturnType<typeof parseLearningLoopFence>;
  try { fence = parseLearningLoopFence(content); }
  catch { throw new Error('managed_state_unavailable: malformed protected fence'); }
  if (!fence) {
    if (expectedManaged) throw new Error('managed_state_unavailable: expected managed state is absent');
    return;
  }
  if (permit && (permit.brain_id !== fence.value.brain_id
    || permit.source_id !== fence.value.source_id
    || permit.canonical_slug !== fence.value.canonical_slug
    || sourceId !== fence.value.source_id || slug !== fence.value.canonical_slug)) {
    throw new Error('managed_state_unavailable: canonical permit target mismatch');
  }
  if (mutationClass !== 'derived_only') {
    if (mutationClass === 'canonical_reconciliation' && permit) {
      assertPageDbMutationPermit(permit, { brain_id: fence.value.brain_id, source_id: fence.value.source_id, canonical_slug: fence.value.canonical_slug, configured_root: root }, mutationClass);
      if (!permit.managed || permit.canonical_sha256 !== sha256(content)) throw new Error('managed_state_unavailable: canonical permit hash mismatch');
      return;
    }
    throw new Error('managed_state_unavailable: managed canonical page mutation rejected');
  }
}

/**
 * Guard a slug mutation whose SQL may be unscoped. When sourceId is omitted,
 * assert every source that currently holds a matching row — the same set the
 * unscoped UPDATE would touch.
 */
export async function assertManagedSlugMutationAllowed(
  engine: Pick<BrainEngine, 'executeRaw' | 'getConfig' | 'learningLoopLedgerConfig'>,
  slug: string,
  sourceId: string | undefined,
  mutationClass: PageDbMutationClass,
  rowState: 'active' | 'deleted' = 'active',
): Promise<void> {
  if (sourceId) {
    await assertManagedPageMutationAllowed(engine, slug, sourceId, mutationClass);
    return;
  }
  const deletedClause = rowState === 'deleted' ? 'IS NOT NULL' : 'IS NULL';
  const rows = await engine.executeRaw<{ source_id: string }>(
    `SELECT DISTINCT source_id FROM pages WHERE slug = $1 AND deleted_at ${deletedClause}`,
    [slug],
  );
  const sourceIds = [...new Set((Array.isArray(rows) ? rows : []).map(row => row.source_id).filter(Boolean))];
  if (sourceIds.length === 0) {
    await assertManagedPageMutationAllowed(engine, slug, 'default', mutationClass);
    return;
  }
  for (const id of sourceIds) {
    await assertManagedPageMutationAllowed(engine, slug, id, mutationClass);
  }
}

/** Batch form of assertManagedPageMutationAllowed for delete/sync loops. */
export async function assertManagedPagesMutationAllowed(
  engine: Pick<BrainEngine, 'executeRaw' | 'getConfig' | 'learningLoopLedgerConfig'>,
  slugs: readonly string[],
  sourceId: string,
  mutationClass: PageDbMutationClass,
): Promise<void> {
  const unique = [...new Set(slugs)];
  if (unique.length === 0) return;
  if (unique.length === 1) {
    await assertManagedPageMutationAllowed(engine, unique[0]!, sourceId, mutationClass);
    return;
  }
  const root = await resolveEffectiveCanonicalRoot(engine, sourceId);
  const hints = await expectedManagedByDurableHints(engine, unique, sourceId);
  for (const slug of unique) {
    const expectedManaged = hints.get(slug) === true;
    if (!root) {
      if (expectedManaged) throw new Error('managed_state_unavailable: expected canonical root is unavailable');
      continue;
    }
    const path = join(resolve(root), `${slug}.md`);
    let content = '';
    try { content = readFileSync(path, 'utf8'); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === 'ENOENT' || code === 'ENOTDIR') && !expectedManaged) continue;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error('managed_state_unavailable: canonical permit target is missing');
      throw error;
    }
    let fence: ReturnType<typeof parseLearningLoopFence>;
    try { fence = parseLearningLoopFence(content); }
    catch { throw new Error('managed_state_unavailable: malformed protected fence'); }
    if (!fence) {
      if (expectedManaged) throw new Error('managed_state_unavailable: expected managed state is absent');
      continue;
    }
    if (sourceId !== fence.value.source_id || slug !== fence.value.canonical_slug) {
      throw new Error('managed_state_unavailable: canonical permit target mismatch');
    }
    if (mutationClass !== 'derived_only') {
      throw new Error('managed_state_unavailable: managed canonical page mutation rejected');
    }
  }
}

interface RegisteredSourceMatch { id: string; root: string }

async function matchRegisteredSourceRoots(
  engine: Pick<BrainEngine, 'executeRaw' | 'getConfig'>,
  path: string,
): Promise<RegisteredSourceMatch[]> {
  const rawRows = await engine.executeRaw<{ id: string; local_path: string | null }>(
    'SELECT id, local_path FROM sources ORDER BY id',
  );
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const configuredRoots = rows.flatMap(row => row.local_path ? [{ id: row.id, path: row.local_path }] : []);
  if (rows.length === 1 && rows[0]?.id === 'default' && !rows[0].local_path) {
    const fallback = await engine.getConfig('sync.repo_path');
    if (fallback) configuredRoots.push({ id: 'default', path: fallback });
  }
  const lexicalCandidate = resolve(path);
  let realCandidate: string;
  try { realCandidate = realpathSync(lexicalCandidate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const missing: string[] = [];
    let cursor = lexicalCandidate;
    while (true) {
      const parent = dirname(cursor);
      missing.unshift(basename(cursor));
      try {
        realCandidate = join(realpathSync(parent), ...missing);
        break;
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT' || parent === cursor) throw parentError;
        cursor = parent;
      }
    }
  }
  const matches: RegisteredSourceMatch[] = [];
  for (const configured of configuredRoots) {
    const lexicalRoot = resolve(configured.path);
    let root: string;
    try {
      root = realpathSync(lexicalRoot);
      accessSync(root, constants.R_OK);
    }
    catch { throw new Error('managed_state_unavailable: registered source root is unreadable'); }
    const lexicalMatch = contained(lexicalCandidate, lexicalRoot);
    const realMatch = contained(realCandidate, root);
    if (lexicalMatch !== realMatch) {
      throw new Error('managed_state_unavailable: registered source path is symlink-ambiguous');
    }
    if (lexicalMatch) matches.push({ id: configured.id, root });
  }
  return matches;
}

function selectRegisteredSourceMatch(
  matches: RegisteredSourceMatch[],
  sourceId?: string,
): RegisteredSourceMatch | null {
  if (matches.length === 0) return null;
  if (sourceId) {
    const exact = matches.filter(match => match.id === sourceId);
    if (exact.length !== 1) {
      throw new Error('managed_state_unavailable: canonical path requires explicit unambiguous source identity');
    }
    return exact[0]!;
  }
  if (matches.length === 1) return matches[0]!;
  throw new Error('managed_state_unavailable: canonical path requires explicit unambiguous source identity');
}

/**
 * Rejection-only inventory for legacy path lanes. A path inside any
 * registered source root must carry the exact source identity; overlapping or
 * ambiguous realpaths fail closed before a writer can choose a source.
 */
export async function assertLegacyPathMutationAllowed(
  mutation: SourceQualifiedMutation,
  path: string,
): Promise<void> {
  const matches = await matchRegisteredSourceRoots(mutation.engine, path);
  if (matches.length === 0) return;
  const exact = matches.filter(match => match.id === mutation.sourceId);
  if (matches.length !== 1 || exact.length !== 1) {
    throw new Error('managed_state_unavailable: canonical path requires explicit unambiguous source identity');
  }
  throw new Error('managed_state_unavailable: registered canonical path cannot use legacy path lane');
}

/**
 * Route a CLI/path write: unique registered root → source-qualified canonical
 * write; no registered root → unmanaged path write. Ambiguous roots fail closed.
 */
export async function writeCanonicalPathMutation(
  engine: BrainEngine | undefined,
  path: string,
  content: string,
  opts: { sourceId?: string; slug?: string } = {},
): Promise<void> {
  if (!engine) {
    assertUnmanagedPathMutation(path, content);
    writeFileSync(path, content, 'utf8');
    return;
  }
  const selected = selectRegisteredSourceMatch(await matchRegisteredSourceRoots(engine, path), opts.sourceId);
  if (!selected) {
    assertUnmanagedPathMutation(path, content);
    writeFileSync(path, content, 'utf8');
    return;
  }
  const slug = opts.slug ?? relative(selected.root, resolve(path)).replace(/\.md$/, '');
  await writeSourceQualifiedCanonicalPage({ engine, sourceId: selected.id, slug }, content);
}

/** Write one explicitly source-qualified page through the canonical boundary. */
export async function writeSourceQualifiedCanonicalPage(
  mutation: SourceQualifiedMutation,
  content: string,
  mode: Extract<CanonicalWriterMode, 'ordinary_content' | 'non_lineage_fact'> = 'ordinary_content',
): Promise<string> {
  const root = await resolveEffectiveCanonicalRoot(mutation.engine, mutation.sourceId);
  if (!root) throw new Error('managed_state_unavailable: source canonical root is unavailable');
  const target: SourceQualifiedCanonicalTarget = {
    brain_id: mutation.brainId ?? computeBrainIdFromConfig(mutation.engine.learningLoopLedgerConfig?.() ?? {}),
    source_id: mutation.sourceId,
    canonical_slug: mutation.slug,
    configured_root: root,
  };
  validateTarget(target);
  const expectedManaged = await expectedManagedByDurableHint(mutation.engine, mutation.slug, mutation.sourceId);
  return withCanonicalSourceBoundary(mutation.engine, target, sourceLease => {
    mkdirSync(dirname(join(sourceLease.root_realpath, `${mutation.slug}.md`)), { recursive: true });
    return writeCanonicalPage(target, content, { mode, sourceLease, expectedManaged });
  });
}
export async function withSourceWriteLease<T>(target: SourceQualifiedCanonicalTarget, fn: (lease: SourceWriteLease) => Promise<T>, opts: { sourceLock: (target: SourceQualifiedCanonicalTarget) => Promise<() => Promise<void>> }): Promise<T> { const release=await opts.sourceLock(target); try { const configured_root=resolve(target.configured_root), root_realpath=realpathSync(configured_root), st=statSync(root_realpath); if(!st.isDirectory())throw new Error('canonical root unavailable'); const lease=Object.freeze({__brand:'SourceWriteLease' as const,brain_id:target.brain_id,source_id:target.source_id,configured_root,root_realpath,token:randomUUID(),dev:st.dev,ino:st.ino}); liveLeases.add(lease); liveLeaseTokens.add(lease.token); try{return await fn(lease);}finally{liveLeases.delete(lease); liveLeaseTokens.delete(lease.token);} } finally { await release(); } }
/** Acquire the existing per-source DB lock and expose its exact lease. */
export async function withCanonicalSourceBoundary<T>(
  engine: BrainEngine,
  target: SourceQualifiedCanonicalTarget,
  fn: (lease: SourceWriteLease) => Promise<T>,
): Promise<T> {
  const inherited = sourceLeaseContext.getStore();
  if (inherited
    && inherited.brain_id === target.brain_id
    && inherited.source_id === target.source_id
    && inherited.configured_root === resolve(target.configured_root)) {
    checkLease(target, inherited);
    return fn(inherited);
  }
  return withRefreshingLock(engine, syncLockId(target.source_id), async () => {
    const configured_root = resolve(target.configured_root);
    const root_realpath = realpathSync(configured_root);
    const st = statSync(root_realpath);
    if (!st.isDirectory()) throw new Error('canonical root unavailable');
    const lease = Object.freeze({ __brand: 'SourceWriteLease' as const,
      brain_id: target.brain_id, source_id: target.source_id, configured_root,
      root_realpath, token: randomUUID(), dev: st.dev, ino: st.ino });
    liveLeases.add(lease); liveLeaseTokens.add(lease.token);
    try { return await sourceLeaseContext.run(lease, () => fn(lease)); }
    finally { liveLeases.delete(lease); liveLeaseTokens.delete(lease.token); }
  });
}

/**
 * Bind a fresh recovery staging root while reusing the already-held source
 * lock. Only checkout rebuild owns this root-rebinding exception.
 */
export async function withCanonicalCheckoutRebuildBoundary<T>(
  target: SourceQualifiedCanonicalTarget,
  fn: (lease: SourceWriteLease) => Promise<T>,
  parentLease?: SourceWriteLease,
): Promise<T> {
  const parent = parentLease ?? sourceLeaseContext.getStore();
  if (!parent) throw new Error('managed_state_unavailable: checkout rebuild requires the live source boundary');
  if (!liveLeases.has(parent)) throw new Error('managed_state_unavailable: checkout rebuild source boundary is stale');
  if (parent.brain_id !== target.brain_id || parent.source_id !== target.source_id) {
    throw new Error('managed_state_unavailable: checkout rebuild source boundary identity mismatch');
  }
  const configured_root = resolve(target.configured_root);
  const root_realpath = realpathSync(configured_root);
  const st = statSync(root_realpath);
  if (!st.isDirectory()) throw new Error('canonical rebuild root unavailable');
  const lease = Object.freeze({ __brand: 'SourceWriteLease' as const,
    brain_id: target.brain_id, source_id: target.source_id, configured_root,
    root_realpath, token: randomUUID(), dev: st.dev, ino: st.ino });
  liveLeases.add(lease); liveLeaseTokens.add(lease.token);
  try { return await sourceLeaseContext.run(lease, () => fn(lease)); }
  finally { liveLeases.delete(lease); liveLeaseTokens.delete(lease.token); }
}
function checkLease(t:SourceQualifiedCanonicalTarget,l:SourceWriteLease):void { const configured=resolve(t.configured_root), real=realpathSync(configured), st=statSync(real); if(!l || !liveLeases.has(l) || l.__brand!=='SourceWriteLease' || l.brain_id!==t.brain_id || l.source_id!==t.source_id || l.configured_root!==configured || l.root_realpath!==real || l.dev!==st.dev || l.ino!==st.ino) throw new Error('invalid or stale SourceWriteLease'); }
export async function writeCanonicalPage(target: SourceQualifiedCanonicalTarget, content: string, options: CanonicalWriteOptions): Promise<string> {
  validateTarget(target);
  checkLease(target, options.sourceLease);
  const root = options.sourceLease.root_realpath;
  const path = join(root, `${target.canonical_slug}.md`);
  const lock = await acquirePageLock(target.canonical_slug, { lockRoot: options.lockRoot, brainId: target.brain_id, sourceId: target.source_id });
  if (!lock) throw new Error('canonical page is busy');
  try {
    const preflight = inspectExpectedManagedState(target, options.sourceLease, { expected: options.expectedManaged });
    const current = (() => {
      try { return readFileSync(path, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
    })();
    const currentKnowledge = parseLearningLoopFence(current)?.value;
    if (currentKnowledge && (currentKnowledge.brain_id !== target.brain_id || currentKnowledge.source_id !== target.source_id || currentKnowledge.canonical_slug !== target.canonical_slug)) {
      throw new Error('managed_state_unavailable: metadata target mismatch');
    }
    const candidate = options.mode === 'learning_transition' ? withDerivedProtectedStateHash(content) : content;
    const staged = prepare(candidate, current, options.mode, options.transitionPermit);
    if (currentKnowledge && options.mode === 'non_lineage_fact') {
      const facts = parseFactsFence(staged);
      if (facts.warnings.length > 0 && learningLoopHasProtectedState(currentKnowledge)) {
        throw new Error('managed_state_unavailable: protected facts fence is malformed');
      }
      assertManagedFactRowsPresent(currentKnowledge, facts.facts);
    }
    atomic(path, staged, root, () => {
      checkLease(target, options.sourceLease);
      // Repeat the expectation check after all caller barriers and immediately
      // before rename. A deleted/corrupted managed fence cannot downgrade to
      // an unmanaged write between preflight and commit.
      inspectExpectedManagedState(target, options.sourceLease, { expected: preflight.managed });
    }, options.beforeRename);
    const readback = readFileSync(path, 'utf8');
    if (readback !== staged) throw new Error('canonical readback mismatch');
    return readback;
  } finally {
    await lock.release();
  }
}
export const commitCanonicalPage=writeCanonicalPage;
