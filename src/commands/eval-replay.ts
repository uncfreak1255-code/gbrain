/**
 * gbrain eval replay — replay captured eval_candidates against current brain (v0.25.0).
 *
 * The contributor-facing half of BrainBench-Real:
 *
 *   1. capture some real traffic    (default-on, lands in eval_candidates)
 *   2. snapshot it                  (gbrain eval export --since 7d > baseline.ndjson)
 *   3. make a code change           (tune RRF_K, edit hybrid.ts, swap an embed model)
 *   4. replay against the snapshot  (gbrain eval replay --against baseline.ndjson)
 *
 * Outputs three numbers a contributor can read at a glance:
 *
 *   - mean Jaccard@k between captured retrieved_slugs and current run's slugs
 *   - top-1 stability rate (was the #1 result the same?)
 *   - mean latency delta (current - captured), positive = slower now
 *
 * Best-effort by design. Replay is NOT pure — your brain has more pages than
 * when the capture was taken, embeddings may have drifted, and the OPENAI key
 * may be different. The metrics describe "did this change hurt retrieval on
 * the queries you actually serve" not "do these match the baseline byte for
 * byte." Use it before merging anything that touches src/core/search/ or the
 * query/search op handlers.
 *
 * Usage:
 *   gbrain eval replay --against captured.ndjson [--limit N] [--json]
 *                      [--top-regressions K] [--verbose]
 */

import { readFileSync, existsSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import type { EvalReplaySurface, SearchResult } from '../core/types.ts';
import { hybridSearch, hybridSearchCached } from '../core/search/hybrid.ts';
import { expandQuery } from '../core/search/expansion.ts';
import { dedupResults } from '../core/search/dedup.ts';

interface ReplayOpts {
  help?: boolean;
  against?: string;
  limit?: number;
  json?: boolean;
  verbose?: boolean;
  topRegressions?: number;
  /** v0.32.3 — search-lite mode to replay under. */
  mode?: 'conservative' | 'balanced' | 'tokenmax';
  /** v0.32.3 [CDX-13] — force the per-call limit to a constant across modes. */
  compareLimit?: number | 'captured';
}

export interface ReplayRowResult {
  /** Captured row's id, for back-referencing into the source NDJSON. */
  id: number;
  tool_name: 'query' | 'search';
  /** Present for baseline files written by `gbrain bench publish`. */
  query_hash?: string;
  query: string;
  /** Set-overlap score in [0, 1]. 1.0 = identical retrieved set. */
  jaccard: number;
  /** True when current top result matches captured top result. */
  top1Match: boolean;
  /** Captured retrieved_slugs (as-is from NDJSON). */
  captured_slugs: string[];
  /** Current run's slugs (deduped, in result order). */
  current_slugs: string[];
  /** Wall-clock latency (ms) of the current re-run. */
  current_latency_ms: number;
  /** latency delta = current - captured. Positive = slower now. */
  latency_delta_ms: number;
  /** True if the row was skipped (e.g. captured query was empty). */
  skipped?: boolean;
  /** Reason the row was skipped, if any. */
  skip_reason?: string;
  /** True if the row threw during replay; current_slugs is empty. */
  errored?: boolean;
  error_message?: string;
  replay_surface_label?: string;
}

export interface PrivacySafeReplayDrillRow {
  id: number;
  tool_name: 'query' | 'search';
  query_hash: string | null;
  jaccard: number;
  top1_match: boolean;
  captured_count: number;
  current_count: number;
  captured_latency_ms: number;
  current_latency_ms: number;
  latency_delta_ms: number;
  skipped?: boolean;
  errored?: boolean;
  reason?: string;
}

export interface PrivacySafeReplayDrill {
  rows_considered: number;
  top_low_overlap: PrivacySafeReplayDrillRow[];
  top_latency_regressions: PrivacySafeReplayDrillRow[];
  skipped: PrivacySafeReplayDrillRow[];
  errored: PrivacySafeReplayDrillRow[];
  privacy: {
    excludes: string[];
  };
}

function parseArgs(args: string[]): ReplayOpts {
  const opts: ReplayOpts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--against':
        if (!next) break;
        opts.against = next;
        i++;
        break;
      case '--limit':
        if (!next) break;
        opts.limit = parseInt(next, 10);
        i++;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--top-regressions':
        if (!next) break;
        opts.topRegressions = parseInt(next, 10);
        i++;
        break;
      case '--mode':
        if (!next) break;
        if (next === 'conservative' || next === 'balanced' || next === 'tokenmax') {
          opts.mode = next;
        } else {
          throw new Error(`--mode must be one of conservative|balanced|tokenmax (got: ${next})`);
        }
        i++;
        break;
      case '--compare-limit':
        if (!next) break;
        opts.compareLimit = next === 'captured' ? 'captured' : parseInt(next, 10);
        i++;
        break;
    }
  }
  return opts;
}

function printHelp(): void {
  console.error(`gbrain eval replay — replay captured queries against current brain

USAGE:
  gbrain eval replay --against FILE.ndjson [flags]

FLAGS:
  --against FILE        NDJSON file from \`gbrain eval export\` (required).
  --limit N             Replay at most N rows (default: replay all).
                        Each row hits OpenAI once for query embedding —
                        cap aggressively when iterating locally.
  --top-regressions K   Print the K rows with the worst Jaccard scores.
                        Default 5 in human mode, 0 in --json.
  --compare-limit N|captured
                        Force current replay to a fixed K, or to each row's
                        captured result count. Useful when smart result cutting
                        changed how many rows came back.
  --json                Emit one JSON object on stdout instead of a table.
                        Stable shape for CI consumption.
  --verbose             Include every row's per-row diff (large output).
  --help, -h            Show this help.

OUTPUT (human mode):
  Replayed N captured queries (M skipped, K errored)
  Mean Jaccard@k:   0.873
  Top-1 stability:  87% (N=87 / 100)
  Mean latency Δ:   +12ms (current slower)

  Top 5 regressions:
    0.20  "find every reference to widget-co"   captured=12  current=3
    ...

EXIT CODE:
  0 — replay completed (regardless of regression magnitude).
  1 — invalid args, --against not found, or NDJSON parse failure.

NOTES:
  Replay is best-effort. Your brain has more pages than when the snapshot
  was taken; embeddings may have drifted; OPENAI_API_KEY may be different.
  Use the metrics to spot regressions on REAL queries, not as a hash check.
`);
}

interface CapturedRow {
  schema_version: number;
  id: number;
  tool_name: 'query' | 'search';
  query: string;
  retrieved_slugs: string[];
  retrieved_chunk_ids?: number[];
  source_ids?: string[];
  expand_enabled?: boolean | null;
  detail?: 'low' | 'medium' | 'high' | null;
  detail_resolved?: 'low' | 'medium' | 'high' | null;
  vector_enabled?: boolean;
  expansion_applied?: boolean;
  latency_ms: number;
  remote?: boolean;
  job_id?: number | null;
  subagent_id?: number | null;
  created_at?: string;
  query_hash?: string;
  /**
   * v0.36 (D16 / CDX-10): the embedding column that ran at capture time.
   * Optional for back-compat — pre-v0.36 exports won't have it. NULL or
   * missing means "use the current default."
   */
  embedding_column?: string | null;
  replay_surface?: EvalReplaySurface | string | null;
}

/**
 * Parse NDJSON. One object per non-blank line. Single bad line throws — it's
 * a corrupt export and silently dropping rows would mask real bugs.
 *
 * v0.41 (codex round-1 #3): SKIPS the `_kind: 'baseline_metadata'` header line
 * that `gbrain bench publish` writes. The header carries metadata (label,
 * thresholds, source_hash, etc) that must NOT be counted as a captured row.
 */
function parseNdjson(content: string): CapturedRow[] {
  const lines = content.split('\n');
  const rows: CapturedRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let row: CapturedRow & { _kind?: string };
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new Error(`NDJSON parse error on line ${i + 1}: ${(err as Error).message}`);
    }
    // v0.41: drop baseline metadata header before it can pollute counts.
    if (row._kind === 'baseline_metadata') continue;
    if (typeof row.schema_version !== 'number') {
      throw new Error(`Line ${i + 1} missing schema_version — not from \`gbrain eval export\`?`);
    }
    if (row.schema_version !== 1) {
      throw new Error(
        `Line ${i + 1} has schema_version=${row.schema_version}; this replay only supports v1. ` +
        `Upgrade gbrain or re-export.`,
      );
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Set-Jaccard between two slug arrays. Order ignored, dupes collapsed.
 * Both empty → 1.0 (identical empty sets, no information lost).
 */
function jaccardSlugs(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  let intersection = 0;
  for (const s of setA) if (setB.has(s)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

function normalizeReplaySurface(raw: CapturedRow['replay_surface']): EvalReplaySurface | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return normalizeReplaySurface(JSON.parse(raw) as EvalReplaySurface);
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object') return null;
  if (raw.schema_version !== 1) return null;
  if (raw.pipeline !== 'query_op_v1' && raw.pipeline !== 'search_op_v1') return null;
  return raw;
}

function sourceScopeFromSurface(surface: EvalReplaySurface): { sourceId?: string; sourceIds?: string[] } {
  if (surface.sourceIds && surface.sourceIds.length > 0) {
    return { sourceIds: surface.sourceIds };
  }
  if (surface.sourceId) return { sourceId: surface.sourceId };
  return {};
}

function replaySurfaceLabel(row: CapturedRow, surface: EvalReplaySurface | null): string {
  if (surface) {
    const labels: string[] = [surface.pipeline];
    if (surface.privacy_scrubbed) labels.push('privacy_scrubbed');
    if (
      surface.pipeline === 'query_op_v1'
      && surface.expansion
      && !surface.expansionQueries?.length
    ) {
      labels.push('expansion_unpinned');
    }
    return labels.join('_');
  }
  return row.tool_name === 'query' ? 'legacy_bare_hybrid' : 'legacy_keyword';
}

export function replayExpansionOpts(
  surface: EvalReplaySurface,
  rowExpandEnabled: boolean | null | undefined,
): {
  expansion: boolean;
  expandFn?: (query: string) => Promise<string[]>;
  useCache?: boolean;
} {
  const expansion = surface.expansion ?? rowExpandEnabled ?? false;
  const pinnedQueries =
    expansion && surface.expansionQueries?.length
      ? [...surface.expansionQueries]
      : undefined;

  return {
    expansion,
    expandFn: expansion
      ? pinnedQueries
        ? async () => [...pinnedQueries]
        : expandQuery
      : undefined,
    // A warm semantic-cache row can bypass expandFn entirely. Pinned replay
    // must execute the stored variants, so it always disables the cache.
    useCache: pinnedQueries ? false : surface.useCache,
  };
}

async function replayRow(engine: BrainEngine, row: CapturedRow, opts: ReplayOpts = {}): Promise<ReplayRowResult> {
  const captured_slugs = row.retrieved_slugs ?? [];
  const startedAt = Date.now();
  const replaySurface = normalizeReplaySurface(row.replay_surface);
  const replay_surface_label = replaySurfaceLabel(row, replaySurface);

  // Default replay limit follows the captured replay surface when present.
  // Legacy rows keep the historical bare replay default below.
  // v0.32.3 [CDX-13]: --compare-limit forces a constant K across modes so
  // Jaccard@k actually measures quality drift, not K-drift. When set, it
  // overrides the captured K and the mode's default searchLimit.
  const limit = opts.compareLimit === 'captured'
    ? Math.max(captured_slugs.length, 1)
    : opts.compareLimit ?? replaySurface?.limit ?? Math.max(captured_slugs.length, 20);

  // search → bare keyword path. query → hybrid path (vector + keyword + RRF).
  // detail and expansion are threaded in from the captured row so the same
  // logic runs that produced the original retrieval.
  let current: SearchResult[];
  try {
    if (replaySurface?.pipeline === 'search_op_v1') {
      if (replaySurface.keywordOnly) {
        const raw = await engine.searchKeyword(row.query, {
          limit,
          offset: replaySurface.offset ?? 0,
          ...sourceScopeFromSurface(replaySurface),
        });
        current = dedupResults(raw);
      } else {
        current = await hybridSearchCached(engine, row.query, {
          limit,
          offset: replaySurface.offset ?? 0,
          expansion: false,
          mode: opts.mode ?? replaySurface.mode,
          embeddingColumn: replaySurface.embeddingColumn ?? row.embedding_column ?? undefined,
          ...sourceScopeFromSurface(replaySurface),
        });
      }
    } else if (replaySurface?.pipeline === 'query_op_v1') {
      const expansionOpts = replayExpansionOpts(replaySurface, row.expand_enabled);
      current = await hybridSearchCached(engine, row.query, {
        limit,
        offset: replaySurface.offset ?? 0,
        expansion: expansionOpts.expansion,
        expandFn: expansionOpts.expandFn,
        detail: replaySurface.detail ?? row.detail_resolved ?? row.detail ?? undefined,
        mode: opts.mode ?? replaySurface.mode,
        language: replaySurface.language,
        symbolKind: replaySurface.symbolKind,
        nearSymbol: replaySurface.nearSymbol,
        walkDepth: replaySurface.walkDepth,
        salience: replaySurface.salience,
        recency: replaySurface.recency,
        since: replaySurface.since,
        until: replaySurface.until,
        tokenBudget: replaySurface.tokenBudget,
        useCache: expansionOpts.useCache,
        intentWeighting: replaySurface.intentWeighting,
        crossModal: replaySurface.crossModal,
        embeddingColumn: replaySurface.embeddingColumn ?? row.embedding_column ?? undefined,
        adaptiveReturn: replaySurface.adaptiveReturn,
        autocut: replaySurface.autocut,
        relationalRetrieval: replaySurface.relationalRetrieval,
        ...sourceScopeFromSurface(replaySurface),
      });
    } else if (row.tool_name === 'search') {
      const dedupedRaw = await engine.searchKeyword(row.query, { limit });
      current = dedupedRaw;
    } else {
      current = await hybridSearch(engine, row.query, {
        limit,
        detail: row.detail ?? undefined,
        expansion: row.expand_enabled ?? false,
        // v0.36 (D16 / CDX-10): replay the SAME column that ran at capture
        // time so config drift between capture and replay doesn't surface
        // as "regression." NULL/undefined falls through to resolver default.
        embeddingColumn: row.embedding_column ?? undefined,
      });
    }
  } catch (err) {
    return {
      id: row.id,
      tool_name: row.tool_name,
      query_hash: row.query_hash,
      query: row.query,
      jaccard: 0,
      top1Match: false,
      captured_slugs,
      current_slugs: [],
      current_latency_ms: Date.now() - startedAt,
      latency_delta_ms: Date.now() - startedAt - row.latency_ms,
      errored: true,
      error_message: (err as Error).message ?? String(err),
      replay_surface_label,
    };
  }

  const current_latency_ms = Date.now() - startedAt;
  // Dedup slugs while preserving order — same convention as search results.
  const seen = new Set<string>();
  const current_slugs: string[] = [];
  for (const r of current) {
    if (!seen.has(r.slug)) {
      seen.add(r.slug);
      current_slugs.push(r.slug);
    }
  }

  return {
    id: row.id,
    tool_name: row.tool_name,
    query_hash: row.query_hash,
    query: row.query,
    jaccard: jaccardSlugs(captured_slugs, current_slugs),
    top1Match: captured_slugs[0] !== undefined && current_slugs[0] === captured_slugs[0],
    captured_slugs,
    current_slugs,
    current_latency_ms,
    latency_delta_ms: current_latency_ms - row.latency_ms,
    replay_surface_label,
  };
}

export interface ReplaySummary {
  rows_total: number;
  rows_replayed: number;
  rows_skipped: number;
  rows_errored: number;
  /** Mean Jaccard across non-skipped, non-errored rows. */
  mean_jaccard: number;
  top1_stability_rate: number;
  mean_latency_delta_ms: number;
  /** Rows where current latency is more than 2x captured (regression alarm). */
  rows_over_2x_latency: number;
  /** Aggregate replay-surface labels, e.g. query_op_v1 or legacy_bare_hybrid. */
  replay_surface_counts: Record<string, number>;
}

function summarize(results: ReplayRowResult[]): ReplaySummary {
  const eligible = results.filter(r => !r.skipped && !r.errored);
  const meanJaccard = eligible.length === 0
    ? 0
    : eligible.reduce((a, r) => a + r.jaccard, 0) / eligible.length;
  const top1Rate = eligible.length === 0
    ? 0
    : eligible.filter(r => r.top1Match).length / eligible.length;
  const meanLatencyDelta = eligible.length === 0
    ? 0
    : eligible.reduce((a, r) => a + r.latency_delta_ms, 0) / eligible.length;
  const over2x = eligible.filter(r => {
    const captured = results.find(x => x.id === r.id);
    return captured && captured.current_latency_ms > 2 * (captured.current_latency_ms - captured.latency_delta_ms);
  }).length;
  const replaySurfaceCounts: Record<string, number> = {};
  for (const r of results) {
    const key = r.replay_surface_label ?? 'unknown';
    replaySurfaceCounts[key] = (replaySurfaceCounts[key] ?? 0) + 1;
  }

  return {
    rows_total: results.length,
    rows_replayed: eligible.length,
    rows_skipped: results.filter(r => r.skipped).length,
    rows_errored: results.filter(r => r.errored).length,
    mean_jaccard: meanJaccard,
    top1_stability_rate: top1Rate,
    mean_latency_delta_ms: meanLatencyDelta,
    rows_over_2x_latency: over2x,
    replay_surface_counts: replaySurfaceCounts,
  };
}

function printHumanSummary(summary: ReplaySummary, results: ReplayRowResult[], topRegressions: number): void {
  const total = summary.rows_total;
  const eligible = summary.rows_replayed;
  console.log(`Replayed ${eligible} of ${total} captured queries (${summary.rows_skipped} skipped, ${summary.rows_errored} errored)`);
  console.log(`Mean Jaccard@k:    ${summary.mean_jaccard.toFixed(3)}`);
  console.log(`Top-1 stability:   ${(summary.top1_stability_rate * 100).toFixed(1)}%`);
  const sign = summary.mean_latency_delta_ms >= 0 ? '+' : '';
  console.log(`Mean latency Δ:    ${sign}${summary.mean_latency_delta_ms.toFixed(0)}ms (current vs captured)`);
  if (summary.rows_over_2x_latency > 0) {
    console.log(`⚠ ${summary.rows_over_2x_latency} row(s) ran more than 2× slower than captured`);
  }

  if (topRegressions > 0) {
    const sorted = [...results]
      .filter(r => !r.skipped && !r.errored)
      .sort((a, b) => a.jaccard - b.jaccard)
      .slice(0, topRegressions);
    if (sorted.length > 0 && sorted[0]!.jaccard < 1.0) {
      console.log(`\nTop ${sorted.length} regression(s):`);
      for (const r of sorted) {
        const truncQuery = r.query.length > 60 ? r.query.slice(0, 57) + '...' : r.query;
        console.log(
          `  jaccard=${r.jaccard.toFixed(2)}  captured=${r.captured_slugs.length}  current=${r.current_slugs.length}  ` +
          `"${truncQuery}"`,
        );
      }
    }
  }

  if (summary.rows_errored > 0) {
    const errors = results.filter(r => r.errored).slice(0, 3);
    console.log(`\n${summary.rows_errored} row(s) errored. First ${errors.length}:`);
    for (const r of errors) {
      const truncQuery = r.query.length > 60 ? r.query.slice(0, 57) + '...' : r.query;
      console.log(`  id=${r.id}  "${truncQuery}"  ${r.error_message ?? ''}`);
    }
  }
}

/**
 * Programmatic entrypoint. Throws on error (no process.exit), returns the
 * computed summary + per-row results.
 *
 * v0.41 (codex round-2 #7): exposed so `gbrain eval gate --baseline` can
 * call replay in-process rather than spawning a subprocess. Subprocess
 * spawning would run the INSTALLED gbrain (drift risk for source-tree runs).
 */
export async function replayCore(
  engine: BrainEngine,
  opts: ReplayOpts,
): Promise<{ summary: ReplaySummary; results: ReplayRowResult[] }> {
  if (!opts.against) {
    throw new Error('replayCore: opts.against (path to NDJSON) is required');
  }
  if (!existsSync(opts.against)) {
    throw new Error(`File not found: ${opts.against}`);
  }
  const content = readFileSync(opts.against, 'utf-8');
  const rows = parseNdjson(content);
  if (rows.length === 0) {
    throw new Error(`${opts.against} is empty (no NDJSON rows)`);
  }

  const capped = opts.limit && opts.limit > 0 ? rows.slice(0, opts.limit) : rows;

  if (opts.mode) {
    try { await engine.setConfig('search.mode', opts.mode); } catch { /* swallow */ }
  }

  const results: ReplayRowResult[] = [];
  for (const row of capped) {
    if (!row.query || row.query.length === 0) {
      results.push({
        id: row.id,
        tool_name: row.tool_name,
        query_hash: row.query_hash,
        query: row.query ?? '',
        jaccard: 0,
        top1Match: false,
        captured_slugs: row.retrieved_slugs ?? [],
        current_slugs: [],
        current_latency_ms: 0,
        latency_delta_ms: 0,
        skipped: true,
        skip_reason: 'empty query',
        replay_surface_label: replaySurfaceLabel(row, normalizeReplaySurface(row.replay_surface)),
      });
      continue;
    }
    const r = await replayRow(engine, row, opts);
    results.push(r);
  }

  return { summary: summarize(results), results };
}

function toPrivacySafeDrillRow(row: ReplayRowResult): PrivacySafeReplayDrillRow {
  const capturedLatency = row.current_latency_ms - row.latency_delta_ms;
  const reason = row.skip_reason ?? (row.errored ? 'replay_error' : undefined);
  return {
    id: row.id,
    tool_name: row.tool_name,
    query_hash: row.query_hash ?? null,
    jaccard: row.jaccard,
    top1_match: row.top1Match,
    captured_count: row.captured_slugs.length,
    current_count: row.current_slugs.length,
    captured_latency_ms: capturedLatency,
    current_latency_ms: row.current_latency_ms,
    latency_delta_ms: row.latency_delta_ms,
    ...(row.skipped ? { skipped: true } : {}),
    ...(row.errored ? { errored: true } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function buildPrivacySafeReplayDrill(
  results: ReplayRowResult[],
  opts: { limit?: number } = {},
): PrivacySafeReplayDrill {
  const limit = Math.max(1, opts.limit ?? 5);
  const eligible = results.filter(r => !r.skipped && !r.errored);
  const topLowOverlap = [...eligible]
    .sort((a, b) => {
      if (a.jaccard !== b.jaccard) return a.jaccard - b.jaccard;
      if (a.top1Match !== b.top1Match) return a.top1Match ? 1 : -1;
      return b.latency_delta_ms - a.latency_delta_ms;
    })
    .slice(0, limit)
    .map(toPrivacySafeDrillRow);
  const topLatencyRegressions = [...eligible]
    .sort((a, b) => b.latency_delta_ms - a.latency_delta_ms)
    .slice(0, limit)
    .map(toPrivacySafeDrillRow);

  return {
    rows_considered: results.length,
    top_low_overlap: topLowOverlap,
    top_latency_regressions: topLatencyRegressions,
    skipped: results.filter(r => r.skipped).slice(0, limit).map(toPrivacySafeDrillRow),
    errored: results.filter(r => r.errored).slice(0, limit).map(toPrivacySafeDrillRow),
    privacy: {
      excludes: ['query', 'retrieved_slugs', 'current_slugs', 'page_titles', 'chunk_text'],
    },
  };
}

export async function runEvalReplay(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.against) {
    console.error('Error: --against FILE.ndjson is required\n');
    printHelp();
    process.exit(1);
  }

  if (!opts.json) {
    // Pre-flight: count rows so the "Replaying X of Y" line is accurate.
    // The programmatic path skips this nicety.
    try {
      const content = readFileSync(opts.against!, 'utf-8');
      const allRows = parseNdjson(content);
      const cappedCount = opts.limit && opts.limit > 0 ? Math.min(allRows.length, opts.limit) : allRows.length;
      console.error(
        `Replaying ${cappedCount}${cappedCount < allRows.length ? ` of ${allRows.length}` : ''} captured queries${opts.mode ? ` under mode=${opts.mode}` : ''}${opts.compareLimit ? ` (compare-limit=${opts.compareLimit})` : ''}…`,
      );
    } catch { /* swallow; replayCore will throw with the same message */ }
  }

  let summary: ReplaySummary;
  let results: ReplayRowResult[];
  try {
    const out = await replayCore(engine, opts);
    summary = out.summary;
    results = out.results;
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify({
      schema_version: 1,
      summary,
      results: opts.verbose ? results : undefined,
    }, null, 2));
    return;
  }

  const topN = opts.topRegressions ?? 5;
  printHumanSummary(summary, results, topN);
}
