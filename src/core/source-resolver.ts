/**
 * Source resolution for CLI commands (v0.18.0).
 *
 * Resolution priority (highest first):
 *   1. Explicit --source <id> flag (caller passes this as `explicit`)
 *   2. GBRAIN_SOURCE env var
 *   3. .gbrain-source dotfile in CWD or any ancestor directory
 *   4. Registered source whose local_path contains CWD, or whose git
 *      common-dir matches CWD's linked worktree family
 *   5. Brain-level default via `gbrain sources default <id>`
 *   5.5. Single non-default source with local_path, when unambiguous
 *   6. Literal 'default' (backward compat for pre-v0.17 brains)
 *
 * This helper is shared by the sources CLI, future sync/extract/query
 * commands (Steps 4/5), and the operation layer (Step 2+).
 */

import { execFileSync } from 'node:child_process';
import { join, dirname, relative, resolve } from 'path';
import type { BrainEngine } from './engine.ts';
import { SOURCE_ID_RE, isValidSourceId } from './source-id.ts';
import { readTrustedDotfile, realpathOrResolve } from './path-confine.ts';
import { isUndefinedColumnError } from './utils.ts';

const DOTFILE = '.gbrain-source';
// Canonical SOURCE_ID_RE imported from `source-id.ts` (single source of truth).
// Re-exported below as `__testing.SOURCE_ID_RE` for legacy test imports.
// Two validator shapes per codex r2 P1-F:
//   - `isValidSourceId(s)`: boolean — used by tiers that silently fall through
//     on invalid input (dotfile tier 3, brain_default tier 5)
//   - explicit throw — used by tiers that must reject loudly with a tailored
//     message (explicit `--source` flag tier 1, GBRAIN_SOURCE env tier 2).
//     Tier-specific messages are clearer than the generic assertValidSourceId
//     error, so the throws stay inline.

function readDotfileWalk(startDir: string): string | null {
  let dir = resolve(startDir);
  // Guard against infinite loops on malformed paths.
  for (let i = 0; i < 50; i++) {
    const candidate = join(dir, DOTFILE);
    // lstatSync (NOT statSync) so a planted symlink is seen here, not silently
    // followed-then-trusted. Any stat error (ENOENT / permission) → skip this
    // candidate and keep walking (fail-closed). On a multi-user host an
    // attacker who can write a shared ancestor dir could otherwise plant a
    // forged `.gbrain-source`; `isTrustedDotfile` refuses symlinks,
    // foreign-owned, and world-writable files (#418).
    const raw = readTrustedDotfile(candidate);
    if (raw !== null) {
      const content = raw.trim().split('\n')[0].trim();
      // Silent-fallback tier per codex P1-F: invalid dotfile content
      // (legacy ids with underscores, hand-edits with whitespace, etc.)
      // falls through to the next tier instead of throwing. The CLI's
      // explicit/env tiers throw; dotfiles are operator-edited and the
      // forgiving behavior preserves the resolver's existing semantics.
      if (isValidSourceId(content)) return content;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

interface RegisteredSourcePath {
  id: string;
  local_path: string;
  archived: boolean;
  draining: boolean;
  drain_requires_hygiene_candidate: boolean;
}

async function loadRegisteredPaths(engine: BrainEngine): Promise<RegisteredSourcePath[]> {
  try {
    return await engine.executeRaw<RegisteredSourcePath>(
      `SELECT id, local_path, archived,
              embedding_drain_token IS NOT NULL AS draining,
              embedding_drain_token LIKE 'hygiene-candidate:%'
                AS drain_requires_hygiene_candidate
         FROM sources WHERE local_path IS NOT NULL`,
    );
  } catch (error) {
    if (
      !isUndefinedColumnError(error, 'embedding_drain_token')
      && !isUndefinedColumnError(error, 'archived')
    ) throw error;
    try {
      const rows = await engine.executeRaw<
        Omit<RegisteredSourcePath, 'draining' | 'drain_requires_hygiene_candidate'>
      >(
        `SELECT id, local_path, archived FROM sources WHERE local_path IS NOT NULL`,
      );
      return rows.map((row) => ({
        ...row,
        draining: false,
        drain_requires_hygiene_candidate: false,
      }));
    } catch (legacyError) {
      if (!isUndefinedColumnError(legacyError, 'archived')) throw legacyError;
      const rows = await engine.executeRaw<
        Omit<
          RegisteredSourcePath,
          'archived' | 'draining' | 'drain_requires_hygiene_candidate'
        >
      >(
        `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
      );
      return rows.map((row) => ({
        ...row,
        archived: false,
        draining: false,
        drain_requires_hygiene_candidate: false,
      }));
    }
  }
}

interface SourcePathMatch {
  id: string;
  detail: string;
  pathLen: number;
}

type AutomaticSourceState =
  | 'active'
  | 'archived'
  | 'draining'
  | 'hygiene_candidate_draining';

interface GitWorktreeInfo {
  commonDir: string;
  topLevel: string;
  relativePath: string;
}

function gitCommonDir(startDir: string): string | null {
  try {
    return execFileSync(
      'git',
      ['-C', startDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return null;
  }
}

function gitTopLevel(startDir: string): string | null {
  try {
    return execFileSync(
      'git',
      ['-C', startDir, 'rev-parse', '--path-format=absolute', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return null;
  }
}

function canonicalPath(path: string): string {
  return realpathOrResolve(path);
}

function gitWorktreeInfo(startDir: string): GitWorktreeInfo | null {
  const commonDir = gitCommonDir(startDir);
  const topLevel = gitTopLevel(startDir);
  if (!commonDir || !topLevel) return null;
  const relativePath = relative(canonicalPath(topLevel), canonicalPath(startDir));
  return { commonDir, topLevel, relativePath };
}

function pathIsWithin(baseRelativePath: string, candidateRelativePath: string): boolean {
  if (!baseRelativePath || baseRelativePath === '.') return true;
  return candidateRelativePath === baseRelativePath || candidateRelativePath.startsWith(baseRelativePath + '/');
}

function pickRegisteredPathMatch(
  registered: RegisteredSourcePath[],
  cwd: string,
): SourcePathMatch | null {
  const cwdResolved = canonicalPath(cwd);
  let best: SourcePathMatch | null = null;

  for (const r of registered) {
    const p = canonicalPath(r.local_path);
    if (cwdResolved === p || cwdResolved.startsWith(p + '/')) {
      if (!best || p.length > best.pathLen) {
        best = { id: r.id, detail: p, pathLen: p.length };
      }
    }
  }

  if (best) return best;

  // Linked git worktrees can live outside the registered local_path (for
  // example Codex worktrees under ~/.codex/worktrees). They share the same
  // git common dir as the registered checkout, so use that as a durable
  // propagation signal instead of requiring per-worktree .gbrain-source files.
  const cwdGit = gitWorktreeInfo(cwdResolved);
  if (!cwdGit) return null;

  for (const r of registered) {
    const p = canonicalPath(r.local_path);
    const sourceGit = gitWorktreeInfo(p);
    if (!sourceGit || sourceGit.commonDir !== cwdGit.commonDir) continue;
    if (!pathIsWithin(sourceGit.relativePath, cwdGit.relativePath)) continue;
    if (!best || p.length > best.pathLen) {
      best = { id: r.id, detail: `${p} (git worktree)`, pathLen: p.length };
    }
  }

  return best;
}

/**
 * Resolve the source id for a CLI command.
 *
 * @param engine  Connected brain engine (for sources table lookups).
 * @param explicit  The --source <id> flag value, if the caller parsed one.
 * @param cwd  The working directory to walk for .gbrain-source. Defaults
 *             to process.cwd(). Exposed for testability.
 * @returns  The resolved source id. Falls back to 'default' if no other
 *           signal is present. Never returns null — every command must
 *           target exactly one default source.
 * @throws  If the resolved id doesn't correspond to a registered source
 *          (prevents silently writing to a nonexistent source and bloating
 *          pages with a dead FK).
 */
export async function resolveSourceId(
  engine: BrainEngine,
  explicit: string | null | undefined,
  cwd: string = process.cwd(),
): Promise<string> {
  // 1. Explicit flag wins.
  if (explicit) {
    if (!SOURCE_ID_RE.test(explicit)) {
      throw new Error(`Invalid --source value "${explicit}". Must match [a-z0-9-]{1,32}.`);
    }
    await assertSourceExists(engine, explicit);
    return explicit;
  }

  // 2. Env var.
  const env = process.env.GBRAIN_SOURCE;
  if (env && env.length > 0) {
    if (!SOURCE_ID_RE.test(env)) {
      throw new Error(`Invalid GBRAIN_SOURCE value "${env}". Must match [a-z0-9-]{1,32}.`);
    }
    await assertSourceExists(engine, env);
    return env;
  }

  // 3. .gbrain-source dotfile walk-up.
  const dotfile = readDotfileWalk(cwd);
  const dotfileState = dotfile
    ? await sourceStateOrThrowIfMissing(engine, dotfile)
    : null;
  if (dotfile && dotfileState === 'active') {
    return dotfile;
  }
  if (dotfile && dotfileState !== null && dotfileState !== 'active') {
    throw inactiveAutomaticRouteError(dotfile, '.gbrain-source', dotfileState);
  }

  // 4. Registered source whose local_path contains CWD.
  //    Uses longest-prefix match so nested-path configurations (e.g.
  //    gstack at ~/gstack + plans at ~/gstack/plans) pick the deepest.
  const registered = await loadRegisteredPaths(engine);
  const activeBest = pickRegisteredPathMatch(registered.filter((row) => !row.archived && !row.draining), cwd);
  const archivedBest = pickRegisteredPathMatch(registered.filter((row) => row.archived || row.draining), cwd);
  if (archivedBest && (!activeBest || archivedBest.pathLen > activeBest.pathLen)) {
    const source = registered.find((row) => row.id === archivedBest.id);
    const state: AutomaticSourceState = source?.archived
      ? 'archived'
      : source?.drain_requires_hygiene_candidate
        ? 'hygiene_candidate_draining'
        : 'draining';
    throw inactiveAutomaticRouteError(archivedBest.id, `local path ${archivedBest.detail}`, state);
  }
  if (activeBest) return activeBest.id;

  // 5. Brain-level default.
  // Silent-fallback tier per codex P1-F: an invalid `sources.default` config
  // value (operator hand-edit gone wrong, legacy underscore id) falls through
  // to tier 6 rather than throwing. Resolver stays robust to bad config.
  const globalDefault = await engine.getConfig('sources.default');
  if (globalDefault && isValidSourceId(globalDefault)) {
    const globalDefaultState = await sourceStateOrThrowIfMissing(engine, globalDefault);
    if (globalDefaultState === 'active') return globalDefault;
    throw inactiveAutomaticRouteError(globalDefault, 'sources.default', globalDefaultState);
  }

  // 5.5. Single-non-default-source convenience (v0.41.13, #1434).
  //      When NO brain_default is set AND exactly one registered source has
  //      local_path set AND it isn't 'default', route there. This closes
  //      the "532 silent edit failures" bug class where users with a single
  //      Vault-mounted source ran `gbrain sync` without --source and routed
  //      to source_id='default' (which held 0 pages). Conservative: fires
  //      only when there's literally one option — multi-source brains still
  //      require explicit --source or sources.default.
  //
  //      Placed AFTER brain_default per codex review: a user who explicitly
  //      set sources.default has stated intent, that wins over auto-routing.
  const soleNonDefault = await pickSoleNonDefaultSource(engine);
  if (soleNonDefault) return soleNonDefault;

  // 6. Fallback: the seeded 'default' source. Always exists post-migration
  //    v16 so this is a safe terminal.
  return 'default';
}

/**
 * Returns the id of the SINGLE registered non-default source with a
 * local_path, when exactly one such row exists. Returns null when:
 *   - zero non-default sources are registered (fresh install)
 *   - 2+ non-default sources are registered (ambiguous — user must pick)
 *   - the only non-default source has a NULL local_path (no on-disk shape)
 *   - the only registered source IS 'default'
 *
 * Excludes archived sources (`archived = false`) so a soft-deleted source
 * doesn't auto-resolve. Shared by `resolveSourceId` and `resolveSourceWithTier`
 * so the heuristic can't drift between the two entry points.
 */
async function pickSoleNonDefaultSource(engine: BrainEngine): Promise<string | null> {
  // archived column was added in v34 (v0.26.5). Older brains may not have
  // it — fall back to the un-archived query in that case via try/catch.
  let rows: Array<{ id: string }>;
  try {
    rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources
        WHERE local_path IS NOT NULL AND id != 'default'
          AND archived = false AND embedding_drain_token IS NULL`,
    );
  } catch (error) {
    if (isUndefinedColumnError(error, 'embedding_drain_token')) {
      try {
        rows = await engine.executeRaw<{ id: string }>(
          `SELECT id FROM sources
            WHERE local_path IS NOT NULL AND id != 'default'
              AND archived = false`,
        );
      } catch (legacyError) {
        if (!isUndefinedColumnError(legacyError, 'archived')) throw legacyError;
        rows = await engine.executeRaw<{ id: string }>(
          `SELECT id FROM sources WHERE local_path IS NOT NULL AND id != 'default'`,
        );
      }
    } else if (isUndefinedColumnError(error, 'archived')) {
      rows = await engine.executeRaw<{ id: string }>(
        `SELECT id FROM sources WHERE local_path IS NOT NULL AND id != 'default'`,
      );
    } else {
      throw error;
    }
  }
  if (rows.length === 1) return rows[0].id;
  return null;
}

/**
 * Format the one-line stderr nudge that fires when source resolution falls
 * through to the `sole_non_default` tier. Returns null when suppressed via
 * `GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE=1` (CI / scripted-pipeline ergonomics).
 *
 * Single source of truth so the wording stays consistent across every CLI
 * dispatch site that fires the nudge (sync, import, extract, etc.). Callers
 * print to stderr; this helper just builds the line.
 */
export function formatSoleNonDefaultNudge(sourceId: string): string | null {
  if (process.env.GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE === '1') return null;
  return `[gbrain] routing to source '${sourceId}' (sole non-default source registered; pass --source to override).`;
}

async function assertSourceExists(engine: BrainEngine, id: string): Promise<void> {
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) {
    throw sourceNotFoundError(id);
  }
}

/**
 * Automatic routing signals must not revive a soft-archived source. Explicit
 * flag/env routing keeps using assertSourceExists so restore and admin flows
 * can still name an archived source intentionally.
 *
 * A valid-but-unregistered automatic signal remains a loud error, matching
 * the pre-archive resolver contract. Pre-v34 brains do not have the archived
 * column, so every existing source is active there.
 */
async function sourceStateOrThrowIfMissing(engine: BrainEngine, id: string): Promise<AutomaticSourceState> {
  try {
    const rows = await engine.executeRaw<{
      id: string;
      archived: boolean;
      embedding_drain_token: string | null;
    }>(
      `SELECT id, archived, embedding_drain_token
         FROM sources WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) throw sourceNotFoundError(id);
    if (rows[0].archived === true) return 'archived';
    if (rows[0].embedding_drain_token?.startsWith('hygiene-candidate:')) {
      return 'hygiene_candidate_draining';
    }
    if (rows[0].embedding_drain_token !== null) return 'draining';
    return 'active';
  } catch (error) {
    if (isUndefinedColumnError(error, 'embedding_drain_token')) {
      try {
        const rows = await engine.executeRaw<{ id: string; archived: boolean }>(
          `SELECT id, archived FROM sources WHERE id = $1`,
          [id],
        );
        if (rows.length === 0) throw sourceNotFoundError(id);
        return rows[0].archived === true ? 'archived' : 'active';
      } catch (legacyError) {
        if (!isUndefinedColumnError(legacyError, 'archived')) throw legacyError;
        await assertSourceExists(engine, id);
        return 'active';
      }
    }
    if (isUndefinedColumnError(error, 'archived')) {
      await assertSourceExists(engine, id);
      return 'active';
    }
    throw error;
  }
}

function sourceNotFoundError(id: string): Error {
  return new Error(
    `Source "${id}" not found. Available sources: ` +
    `run \`gbrain sources list\` to see registered sources, ` +
    `or \`gbrain sources add ${id}\` to create it.`,
  );
}

function inactiveAutomaticRouteError(
  id: string,
  signal: string,
  state: Exclude<AutomaticSourceState, 'active'>,
): Error {
  if (state === 'draining' || state === 'hygiene_candidate_draining') {
    const candidateFlag = state === 'hygiene_candidate_draining'
      ? ' --if-hygiene-candidate'
      : '';
    return new Error(
      `Source "${id}" has an interrupted archive drain and cannot be selected automatically from ${signal}. ` +
      `Resume it with \`gbrain sources archive ${id}${candidateFlag}\` before running normal commands. ` +
      `Use --source ${id} only for an intentional archive or admin operation.`,
    );
  }
  return new Error(
    `Source "${id}" is archived and cannot be selected automatically from ${signal}. ` +
    `Restore it or update the stale route before running normal commands. ` +
    `Use --source ${id} only for an intentional restore or admin operation.`,
  );
}

/**
 * Get the local_path of the resolved source (per the resolveSourceId chain).
 *
 * Returns the on-disk brain repo path for the source the user is currently
 * operating against. Used by `gbrain storage status` and `gbrain export
 * --restore-only` to find the brain repo without raw SQL or bare try/catch.
 *
 * Resolution order:
 *   1. `sources.local_path` for the resolved source id (multi-source v0.18+ path)
 *   2. Legacy global `sync.repo_path` config key (pre-v0.18 default-source brains)
 *   3. null
 *
 * @returns local_path string, or null if no path is configured anywhere.
 * @throws  If DB error occurs (does NOT silently swallow). Callers handle
 *          the null case to provide their own fallback (typically a hard error
 *          telling the user to pass --repo).
 */
export async function getDefaultSourcePath(
  engine: BrainEngine,
  cwd: string = process.cwd(),
): Promise<string | null> {
  const sourceId = await resolveSourceId(engine, null, cwd);
  const rows = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (rows[0]?.local_path) return rows[0].local_path;

  // Legacy fallback: pre-v0.18 brains stored the repo path in the global
  // config table under sync.repo_path. The sources table exists but its
  // local_path is NULL for the seeded 'default' row. Fall back so storage
  // tiering works without forcing a `gbrain sources add . --path .` migration.
  const legacyPath = await engine.getConfig('sync.repo_path');
  return legacyPath ?? null;
}

/**
 * v0.37.7.0 — tier labels for `resolveSourceWithTier()`. Exported so
 * `gbrain sources current --json` and downstream consumers share a
 * canonical vocabulary instead of redefining strings inline.
 *
 * Order matches the 1-6 priority of `resolveSourceId()`.
 */
export const SOURCE_TIER_NAMES = [
  'flag',
  'env',
  'dotfile',
  'local_path',
  'brain_default',
  'sole_non_default',
  'seed_default',
] as const;
export type SourceTier = typeof SOURCE_TIER_NAMES[number];

/**
 * Same resolution chain as `resolveSourceId()`, but also returns
 * WHICH tier won. Additive — does not duplicate the logic; runs the
 * same six steps in the same order. Used by `gbrain sources current`
 * so users can verify the resolved source AND the reason it resolved
 * before destructive ops.
 *
 * @returns `{ source_id, tier, detail? }` where `detail` is an
 *          optional human-readable extra (e.g. the env-var name or
 *          the matched dotfile / local_path).
 */
export async function resolveSourceWithTier(
  engine: BrainEngine,
  explicit: string | null | undefined,
  cwd: string = process.cwd(),
): Promise<{ source_id: string; tier: SourceTier; detail?: string }> {
  // 1. Explicit flag wins.
  if (explicit) {
    if (!SOURCE_ID_RE.test(explicit)) {
      throw new Error(`Invalid --source value "${explicit}". Must match [a-z0-9-]{1,32}.`);
    }
    await assertSourceExists(engine, explicit);
    return { source_id: explicit, tier: 'flag', detail: `--source ${explicit}` };
  }

  // 2. Env var.
  const env = process.env.GBRAIN_SOURCE;
  if (env && env.length > 0) {
    if (!SOURCE_ID_RE.test(env)) {
      throw new Error(`Invalid GBRAIN_SOURCE value "${env}". Must match [a-z0-9-]{1,32}.`);
    }
    await assertSourceExists(engine, env);
    return { source_id: env, tier: 'env', detail: `GBRAIN_SOURCE=${env}` };
  }

  // 3. .gbrain-source dotfile walk-up.
  const dotfile = readDotfileWalk(cwd);
  const dotfileState = dotfile
    ? await sourceStateOrThrowIfMissing(engine, dotfile)
    : null;
  if (dotfile && dotfileState === 'active') {
    return { source_id: dotfile, tier: 'dotfile', detail: `.gbrain-source` };
  }
  if (dotfile && dotfileState !== null && dotfileState !== 'active') {
    throw inactiveAutomaticRouteError(dotfile, '.gbrain-source', dotfileState);
  }

  // 4. Registered source whose local_path contains CWD.
  const registered = await loadRegisteredPaths(engine);
  const activeBest = pickRegisteredPathMatch(registered.filter((row) => !row.archived && !row.draining), cwd);
  const archivedBest = pickRegisteredPathMatch(registered.filter((row) => row.archived || row.draining), cwd);
  if (archivedBest && (!activeBest || archivedBest.pathLen > activeBest.pathLen)) {
    const source = registered.find((row) => row.id === archivedBest.id);
    const state: AutomaticSourceState = source?.archived
      ? 'archived'
      : source?.drain_requires_hygiene_candidate
        ? 'hygiene_candidate_draining'
        : 'draining';
    throw inactiveAutomaticRouteError(archivedBest.id, `local path ${archivedBest.detail}`, state);
  }
  if (activeBest) {
    return { source_id: activeBest.id, tier: 'local_path', detail: activeBest.detail };
  }

  // 5. Brain-level default. Silent-fallback (P1-F) like tier 5 in resolveSourceId.
  const globalDefault = await engine.getConfig('sources.default');
  if (globalDefault && isValidSourceId(globalDefault)) {
    const globalDefaultState = await sourceStateOrThrowIfMissing(engine, globalDefault);
    if (globalDefaultState === 'active') {
      return { source_id: globalDefault, tier: 'brain_default', detail: 'sources.default config' };
    }
    throw inactiveAutomaticRouteError(globalDefault, 'sources.default', globalDefaultState);
  }

  // 5.5. Single-non-default-source convenience (v0.41.13, #1434).
  //      See resolveSourceId for the design rationale. Same helper, same
  //      precedence (AFTER brain_default).
  const soleNonDefault = await pickSoleNonDefaultSource(engine);
  if (soleNonDefault) {
    return {
      source_id: soleNonDefault,
      tier: 'sole_non_default',
      detail: `only non-default registered source with local_path`,
    };
  }

  // 6. Fallback: seeded 'default' source.
  return { source_id: 'default', tier: 'seed_default' };
}

/** Exposed for tests. */
export const __testing = {
  readDotfileWalk,
  pickRegisteredPathMatch,
  gitCommonDir,
  gitTopLevel,
  gitWorktreeInfo,
  SOURCE_ID_RE,
};
