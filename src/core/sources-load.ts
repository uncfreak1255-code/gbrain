/**
 * Shared source-table loader (v0.40 Federated Sync v2 — D7).
 *
 * Before v0.40, the only caller that enumerated `sources` was `runList` in
 * src/commands/sources.ts. v0.40 adds four more enumerators: `gbrain sync --all`
 * fan-out, autopilot per-source dispatch, `gbrain sources status`, and the
 * `federation_health` doctor check. Going from 1→5 inline SELECTs invites
 * silent drift the next time someone adds a column to `sources`.
 *
 * This module is the single source of truth for that read path. Adding a
 * column means updating exactly one projection.
 *
 * Engine-agnostic: works on both Postgres and PGLite (same SQL surface).
 *
 * Why no engine method: BrainEngine parity would force PGLite + Postgres
 * implementations even though both run identical SQL through `executeRaw`.
 * A shared helper hits the bar at lower cost.
 */
import type { BrainEngine } from './engine.ts';
import { sourceArchiveDrainPurpose } from './source-embedding-lease.ts';

export interface SourceRow {
  id: string;
  name: string;
  local_path: string | null;
  last_commit: string | null;
  last_sync_at: Date | null;
  /** Postgres returns object; PGLite returns JSON string. Parse via `parseSourceConfig`. */
  config: Record<string, unknown> | string;
  created_at: Date;
  archived?: boolean;
  embedding_drain_token?: string | null;
  /**
   * v0.41.32.0: newest COMMIT timestamp observed at last sync (HEAD committer
   * time). The REMOTE staleness path reads this column so it never shells out
   * to git on a DB-supplied local_path. Optional because the forward-reference
   * fallback SELECT below omits it on pre-v109 brains; null/undefined → the
   * reader falls back to wall-clock.
   */
  newest_content_at?: Date | null;
}

export interface LoadAllSourcesOpts {
  /** Include soft-archived rows (default false). */
  includeArchived?: boolean;
  /** Only return sources with config.federated === true (default false). */
  federatedOnly?: boolean;
}

/** Parse `sources.config` to a plain object regardless of driver shape. */
export function parseSourceConfig(config: unknown): Record<string, unknown> {
  if (typeof config === 'string') {
    try { return JSON.parse(config) as Record<string, unknown>; } catch { return {}; }
  }
  if (typeof config === 'object' && config !== null) return config as Record<string, unknown>;
  return {};
}

/** True iff the source's config.federated field is the literal boolean true. */
export function isSourceFederated(config: unknown): boolean {
  const parsed = parseSourceConfig(config);
  return parsed.federated === true;
}

/** True only when a source may accept new single-source work. */
export function isSourceActive(
  source: {
    archived?: boolean | null;
    embedding_drain_token?: string | null;
  } | null | undefined,
): boolean {
  return source != null
    && source.archived !== true
    && source.embedding_drain_token == null;
}

const SOURCE_BASE_PROJECTION =
  'id, name, local_path, last_commit, last_sync_at, config, created_at';

/**
 * Read source rows through a newest-to-oldest projection ladder.
 *
 * Migration v133 added embedding_drain_token after archived (v17) and
 * newest_content_at (v109). A pre-v133 brain must not lose its real archived
 * value merely because the newest column is absent: that would make an
 * archived source appear active. Each compatibility rung therefore preserves
 * archived until a query containing archived itself proves the column is
 * unavailable. Missing fields are projected as typed NULLs so every caller
 * receives one stable SourceRow shape.
 */
async function querySourcesCompat(
  engine: BrainEngine,
  suffix: string,
  params: unknown[] = [],
): Promise<SourceRow[]> {
  const projections = [
    `${SOURCE_BASE_PROJECTION}, archived, newest_content_at, embedding_drain_token`,
    `${SOURCE_BASE_PROJECTION}, archived, newest_content_at, NULL::text AS embedding_drain_token`,
    `${SOURCE_BASE_PROJECTION}, archived, NULL::timestamptz AS newest_content_at, NULL::text AS embedding_drain_token`,
  ];

  for (const projection of projections) {
    try {
      return await engine.executeRaw<SourceRow>(
        `SELECT ${projection} FROM public.sources ${suffix}`,
        params,
      );
    } catch (error) {
      if (!isUndefinedColumnError(error)) throw error;
    }
  }

  // Historical pre-v0.26.5 schema: archived itself does not exist. Only this
  // final rung may synthesize archived=false.
  const rows = await engine.executeRaw<SourceRow>(
    `SELECT ${SOURCE_BASE_PROJECTION} FROM public.sources ${suffix}`,
    params,
  );
  return rows.map((row) => ({
    ...row,
    archived: false,
    newest_content_at: null,
    embedding_drain_token: null,
  }));
}

/** Recovery guidance shared by single-source active-work entry points. */
export function sourceDrainResumeMessage(sourceId: string, drainToken?: string | null): string {
  const purpose = sourceArchiveDrainPurpose(drainToken ?? null);
  if (purpose === 'migration') {
    return `Source "${sourceId}" has an interrupted engine-migration drain; `
      + 'rerun the engine migration before continuing.';
  }
  const candidateFlag = purpose === 'hygiene_candidate'
    ? ' --if-hygiene-candidate'
    : '';
  return `Source "${sourceId}" has an interrupted archive drain; resume with `
    + `\`gbrain sources archive ${sourceId}${candidateFlag}\` before continuing.`;
}

/**
 * Enumerate every source. Order: 'default' first, then alphabetical by id.
 *
 * Caller filters in-process when the predicate is cheap (federatedOnly,
 * includeArchived). For source-id targeted reads use `fetchSource` instead
 * (single-row SELECT).
 */
export async function loadAllSources(
  engine: BrainEngine,
  opts: LoadAllSourcesOpts = {},
): Promise<SourceRow[]> {
  const rows = await querySourcesCompat(
    engine,
    `ORDER BY (id = 'default') DESC, id`,
  );

  let filtered = rows;
  if (!opts.includeArchived) {
    filtered = filtered.filter(
      (r) => r.archived !== true && r.embedding_drain_token == null,
    );
  }
  if (opts.federatedOnly) {
    filtered = filtered.filter((r) => isSourceFederated(r.config));
  }
  return filtered;
}

/** Single-row fetch — kept here so callers don't grow yet-another SELECT. */
export async function fetchSource(
  engine: BrainEngine,
  id: string,
): Promise<SourceRow | null> {
  const rows = await querySourcesCompat(engine, 'WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Driver-tolerant 42703 detector. Mirrors src/core/utils.ts pattern. */
function isUndefinedColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string };
  if (e.code === '42703') return true;
  return typeof e.message === 'string' && /column .* does not exist/i.test(e.message);
}
