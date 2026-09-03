/**
 * Serve-resident maintenance sweep [CX-P0.1, CX-P0.3, CX2-4].
 *
 * Nothing previously ingested the transcript corpus into a live brain
 * (dream is disabled by default; the CLI can't open PGLite under a live
 * serve), and remote `put_page` deliberately skips auto link/timeline
 * extraction — so the graph never compounded from harness writes. The
 * sweep is the serve process's (the lock owner's) bounded, spend-gated
 * answer. Three passes, each individually fail-soft:
 *
 *   1. FACTS-FENCE RECONCILIATION [CX2-4] — zero-LLM. Recently-modified
 *      pages carrying a `## Facts` fence get reconciled into the facts DB
 *      index by the SAME cycle extractor the dream cycle uses
 *      (src/core/cycle/extract-facts.ts:runExtractFacts, scoped via
 *      opts.slugs). Fence rows carry explicit per-row visibility; the
 *      corpus pass below resolves unset visibility through
 *      resolveDefaultVisibility inside the shared pipeline (backstop.ts).
 *
 *   2. LINK/TIMELINE EXTRACTION [CX-P0.3] — zero-LLM, deterministic. The
 *      same per-page cores `gbrain extract links|timeline --source db`
 *      runs: extractPageLinks + parseTimelineEntries, endpoint-validated
 *      through resolveCandidateSources and batch-written via
 *      addLinksBatch / addTimelineEntriesBatch, then watermark-stamped
 *      (stampExtracted) since both kinds ran.
 *
 *   3. CORPUS INGEST [CX-P0.1] — LLM-backed, spend-gated. Unprocessed
 *      `.txt` files in the dream corpus dir run through the narrowest
 *      one-transcript entry (runFactsPipeline: extract → resolve → dedup
 *      → insert). KEYLESS RULE [CX-P0.5]: no extraction provider ⇒ skip
 *      with {reason:'keyless'} — agent-authored fences cover it. A
 *      `<file>.ingested` sidecar (written AFTER success — crash-safe,
 *      exactly-once) marks completion; a `<file>.in-progress` claim
 *      sidecar (O_EXCL) fences concurrent sweeps off the same file so
 *      two processes never double-pay one transcript's LLM call.
 *
 * Budget: a wall-clock budget aborts BETWEEN items (and threads an
 * AbortSignal into the fence pass + corpus extraction); the report
 * carries the partial counts. runMaintenanceSweep NEVER throws.
 *
 * Heavy dependencies (cycle extractor, extract command cores, facts
 * pipeline, gateway) are lazy-imported inside each pass — the
 * backstop.ts:335 precedent — so importing this module at serve boot is
 * cheap and a broken optional dep degrades to a skip, never a crash.
 */

import { join } from 'node:path';
import { readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import type { BrainEngine, LinkBatchInput, TimelineBatchInput } from './engine.ts';
import type { FactsBackstopCtx } from './facts/backstop.ts';
import { detectCapabilities, type CapabilityReport } from './capability.ts';

/** Delay before the serve-startup sweep fires (post-connect settle). */
export const STARTUP_SWEEP_DELAY_MS = 3_000;

/** Fence begin marker — duplicated from facts-fence.ts to keep this module light. */
const FACTS_FENCE_BEGIN_MARKER = 'gbrain:facts:begin';

/**
 * Cap on the candidate set the pass-1 leading-wildcard LIKE scans: the fence
 * marker can't use an index, so the LIKE runs over a recency-bounded subquery
 * (newest N rows in the window) instead of every matching-window row — a
 * bulk-sync day can't turn pass 1 into a whole-table scan.
 */
export const FENCE_LIKE_SCAN_CAP = 500;

/** Sidecar suffix marking a corpus file as processed. */
export const CORPUS_INGESTED_SUFFIX = '.ingested';

/**
 * Claim sidecar marking a corpus file as being ingested RIGHT NOW. Created
 * with O_EXCL (`wx`) before the LLM call so a manual `gbrain sweep --once`
 * and the serve-idle sweep (separate processes on a Postgres brain) can't
 * both pay for the same transcript. Replaced by the `.ingested` sidecar on
 * success; removed on failure so the next sweep retries.
 */
export const CORPUS_CLAIM_SUFFIX = '.in-progress';

/** Claims older than this belong to dead sweeps and are reclaimable. */
export const CORPUS_CLAIM_STALE_MS = 60 * 60 * 1000;

export interface SweepOpts {
  /** Source to sweep. Default 'default' (the serve's registered source). */
  sourceId?: string;
  /** Max pages per pass / corpus files per sweep. Default 20. */
  batchLimit?: number;
  /** Wall-clock budget; the sweep stops between items when exceeded. Default 5000. */
  budgetMs?: number;
  /**
   * Projected USD ceiling for the LLM-backed corpus pass. When omitted, the
   * value is read from `facts.sweep_max_usd`. Missing/invalid/non-positive
   * values fail closed for corpus ingest; zero-LLM passes still run.
   */
  maxCostUsd?: number;
  /** Recency window (days) for "recently-modified pages". Default 7. */
  recentDays?: number;
  /** Diagnostic sink (stderr in serve contexts). Default: silent. */
  log?: (msg: string) => void;
  /**
   * Capability report override (test seam / caller already computed one).
   * Default: detectCapabilities() — config-plane, no network.
   */
  capabilities?: CapabilityReport;
}

export interface SweepSkip {
  reason: string;
  count: number;
}

export interface SweepReport {
  corpusIngested: number;
  factsReconciled: number;
  linksExtracted: number;
  /** Stale sweep-owned edges reconciled away (#4196). */
  linksRemoved: number;
  timelineExtracted: number;
  /**
   * Effective pre-call USD ceiling applied to this sweep's corpus pass:
   * min(`facts.sweep_max_usd`, today's remaining per-day headroom). Set only
   * when the pass ran.
   */
  maxCostUsd?: number;
  /** Configured per-UTC-day ceiling (`facts.sweep_max_usd_per_day`), when valid. */
  dailyCapUsd?: number;
  /**
   * Today's (UTC) cumulative corpus spend across every sweep in every serve
   * process, including this sweep — the `facts.sweep_spend_ledger` row.
   */
  dailySpentUsd?: number;
  /** Actual gateway-recorded cost for this sweep's corpus pass. */
  spentUsd: number;
  skipped: SweepSkip[];
  durationMs: number;
}

/** Per-run projected USD ceiling for the corpus pass: `gbrain config set facts.sweep_max_usd 0.5`. */
export const SWEEP_RUN_CAP_CONFIG_KEY = 'facts.sweep_max_usd';
/** Per-UTC-day USD ceiling across every sweep in every serve process: `gbrain config set facts.sweep_max_usd_per_day 2`. */
export const SWEEP_DAILY_CAP_CONFIG_KEY = 'facts.sweep_max_usd_per_day';
/** Sweep-owned ledger row `{"day":"YYYY-MM-DD","usd":n}`: today's corpus spend so far. Unset it to reset the day. */
export const SWEEP_SPEND_LEDGER_CONFIG_KEY = 'facts.sweep_spend_ledger';

/** Which ceiling produced the run's effective cap — names the skip reason when it trips. */
export type SweepCapSource = 'run' | 'day';

export interface SweepSpendLedger { day: string; usd: number; }

/** UTC calendar day, the ledger's bucket (the budget audit rows are UTC too). */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function parsePositiveUsd(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function capExhaustedReason(source: SweepCapSource): string {
  return source === 'day' ? 'daily_cap_exhausted:corpus' : 'cost_cap_exhausted:corpus';
}

function capOvershootReason(source: SweepCapSource): string {
  return source === 'day' ? 'daily_cap_overshoot:corpus' : 'cost_cap_overshoot:corpus';
}

/** Parse one ledger row. `null` = no row; `'invalid'` = not `{"day":"YYYY-MM-DD","usd":n>=0}`. */
export function parseSweepSpendLedger(raw: unknown): SweepSpendLedger | null | 'invalid' {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return 'invalid';
  if (raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as { day?: unknown; usd?: unknown } | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid';
    if (typeof parsed.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.day)) return 'invalid';
    if (typeof parsed.usd !== 'number' || !Number.isFinite(parsed.usd) || parsed.usd < 0) return 'invalid';
    return { day: parsed.day, usd: parsed.usd };
  } catch {
    return 'invalid';
  }
}

/**
 * Read the per-day spend ledger. `null` = no row yet (a fresh brain);
 * `'invalid'` = a row the sweep cannot read — the caller fails closed on it
 * rather than reading a broken counter as zero.
 */
export async function readSweepSpendLedger(engine: BrainEngine): Promise<SweepSpendLedger | null | 'invalid'> {
  return parseSweepSpendLedger(await engine.getConfig(SWEEP_SPEND_LEDGER_CONFIG_KEY));
}

/**
 * Reserve `usd` of today's remaining headroom under `cap`, atomically, BEFORE
 * any provider call. Each case is one conditional statement, so two serve
 * processes cannot jointly exceed `cap` and a writer that started on an older
 * day cannot clobber a newer day's row:
 *   - a same-day row with room            → add `usd`;
 *   - no row, or a row from an OLDER day  → today's row starts at `usd`;
 *   - a same-day row without room, or a NEWER day → refused (`null`).
 * Throws on any DB or row-parse failure — the caller fails closed.
 */
export async function reserveSweepSpendToday(
  engine: BrainEngine,
  usd: number,
  cap: number,
  day: string = utcDay(),
): Promise<SweepSpendLedger | null> {
  if (!(Number.isFinite(usd) && usd > 0 && Number.isFinite(cap) && usd <= cap)) return null;
  const added = await engine.executeRaw<{ value: string }>(
    `UPDATE config
        SET value = jsonb_build_object('day', $2::text, 'usd', round((value::jsonb->>'usd')::numeric + $3::numeric, 6))::text
      WHERE key = $1
        AND value::jsonb->>'day' = $2::text
        AND (value::jsonb->>'usd')::numeric + $3::numeric <= $4::numeric
      RETURNING value`,
    [SWEEP_SPEND_LEDGER_CONFIG_KEY, day, String(usd), String(cap)],
  );
  const rows = added.length === 1 ? added : await engine.executeRaw<{ value: string }>(
    `INSERT INTO config (key, value)
       VALUES ($1, jsonb_build_object('day', $2::text, 'usd', round($3::numeric, 6))::text)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
         WHERE config.value::jsonb->>'day' < $2::text
      RETURNING value`,
    [SWEEP_SPEND_LEDGER_CONFIG_KEY, day, String(usd)],
  );
  if (rows.length !== 1) return null;
  const row = parseSweepSpendLedger(rows[0].value);
  if (row === null || row === 'invalid' || row.day !== day) {
    throw new Error(`${SWEEP_SPEND_LEDGER_CONFIG_KEY} reservation wrote a row the sweep cannot read`);
  }
  return row;
}

/**
 * Replace this run's reservation with what it actually spent: adds
 * (actual − reserved) to today's row, floored at 0, in one statement. Returns
 * the row after the write, or `null` when today's row is no longer today's
 * (the run straddled UTC midnight: its reservation stays booked to the day
 * that authorized it — an over-count, never an under-count). Throws on DB
 * failure — the caller keeps the reservation in force.
 */
export async function settleSweepSpendToday(
  engine: BrainEngine,
  reserved: number,
  actual: number,
  day: string = utcDay(),
): Promise<SweepSpendLedger | null> {
  const delta = (Number.isFinite(actual) ? Math.max(0, actual) : reserved) - reserved;
  const rows = await engine.executeRaw<{ value: string }>(
    `UPDATE config
        SET value = jsonb_build_object('day', $2::text, 'usd', round(GREATEST((value::jsonb->>'usd')::numeric + $3::numeric, 0), 6))::text
      WHERE key = $1 AND value::jsonb->>'day' = $2::text
      RETURNING value`,
    [SWEEP_SPEND_LEDGER_CONFIG_KEY, day, String(delta)],
  );
  if (rows.length !== 1) return null;
  const row = parseSweepSpendLedger(rows[0].value);
  return row === null || row === 'invalid' ? null : row;
}

/**
 * The sweep's pricing-override load is STRICT: the operator's declared rates
 * are part of the guard, so a row that cannot be read (DB error → throws) or
 * that does not parse as a complete rate table (`'invalid'`) refuses the pass
 * instead of silently repricing calls at the shipped table. (The shared
 * loadPricingOverrides is fail-open by design for non-guard callers.)
 */
async function loadSweepPricingOverrides(
  engine: BrainEngine,
): Promise<import('./budget/budget-tracker.ts').PricingOverrides | undefined | 'invalid'> {
  const raw = await engine.getConfig('pricing.overrides');
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'string') return 'invalid';
  if (raw.trim() === '') return undefined;
  let declared: unknown;
  try {
    declared = JSON.parse(raw);
  } catch {
    return 'invalid';
  }
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return 'invalid';
  const { parsePricingOverrides } = await import('./budget/budget-tracker.ts');
  const overrides = parsePricingOverrides(declared);
  // Every declared entry must survive parsing: a dropped entry is a rate the
  // operator meant to apply, and the shipped table would silently replace it.
  if (!overrides || Object.keys(overrides).length !== Object.keys(declared as object).length) return 'invalid';
  return overrides;
}

/**
 * Run one bounded maintenance sweep. Never throws — failures land in
 * report.skipped with a per-pass reason.
 */
export async function runMaintenanceSweep(
  engine: BrainEngine,
  opts: SweepOpts = {},
): Promise<SweepReport> {
  const started = Date.now();
  const sourceId = opts.sourceId ?? 'default';
  const batchLimit = Math.max(1, opts.batchLimit ?? 20);
  const budgetMs = Math.max(0, opts.budgetMs ?? 5_000);
  const recentDays = Math.max(1, opts.recentDays ?? 7);
  const log = opts.log ?? (() => {});
  const deadline = started + budgetMs;

  const report: SweepReport = {
    corpusIngested: 0,
    factsReconciled: 0,
    linksExtracted: 0,
    linksRemoved: 0,
    timelineExtracted: 0,
    spentUsd: 0,
    skipped: [],
    durationMs: 0,
  };

  const skip = (reason: string, count = 1): void => {
    if (count <= 0) return;
    const existing = report.skipped.find(s => s.reason === reason);
    if (existing) existing.count += count;
    else report.skipped.push({ reason, count });
  };
  const overBudget = () => Date.now() >= deadline;

  // Budget abort signal: threads into the fence pass's per-page loop and
  // the corpus extraction's network call so a long item can be interrupted
  // at its own checkpoints. unref'd — the sweep must never hold the
  // process open (the serve unref convention).
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(
    () => budgetController.abort(),
    Math.max(0, deadline - Date.now()),
  );
  budgetTimer.unref?.();

  const cutoffIso = new Date(started - recentDays * 86_400_000).toISOString();

  try {
    // ── Pass 1: facts-fence reconciliation [CX2-4] — zero-LLM ─────────
    try {
      if (overBudget()) {
        skip('budget_exhausted:facts_fence');
      } else {
        // The leading-wildcard LIKE can't use an index, so it scans only the
        // newest FENCE_LIKE_SCAN_CAP rows in the recency window (inner
        // subquery) rather than every row a bulk-sync day may have touched.
        const rows = await engine.executeRaw<{ slug: string }>(
          `SELECT slug FROM (
             SELECT slug, compiled_truth, updated_at FROM pages
              WHERE source_id = $1
                AND deleted_at IS NULL
                AND updated_at >= $2::timestamptz
              ORDER BY updated_at DESC
              LIMIT $4
           ) AS recent
            WHERE compiled_truth LIKE $3
            ORDER BY updated_at DESC
            LIMIT $5`,
          [sourceId, cutoffIso, `%${FACTS_FENCE_BEGIN_MARKER}%`, FENCE_LIKE_SCAN_CAP, batchLimit],
        );
        if (rows.length > 0) {
          const { runExtractFacts } = await import('./cycle/extract-facts.ts');
          const r = await runExtractFacts(engine, {
            slugs: rows.map(row => row.slug),
            sourceId,
            signal: budgetController.signal,
          });
          report.factsReconciled = r.factsInserted;
          if (r.guardTriggered) skip('facts_fence_guard');
          if (budgetController.signal.aborted) skip('budget_exhausted:facts_fence');
        }
      }
    } catch (e) {
      skip('facts_fence_error');
      log(`[sweep] facts-fence pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Pass 2: link/timeline extraction [CX-P0.3] — zero-LLM ─────────
    try {
      if (overBudget()) {
        skip('budget_exhausted:links_timeline');
      } else {
        await runLinksTimelinePass(engine, {
          sourceId,
          batchLimit,
          cutoffIso,
          overBudget,
          report,
          skip,
        });
      }
    } catch (e) {
      skip('links_timeline_error');
      log(`[sweep] links/timeline pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Pass 3: corpus ingest [CX-P0.1] — spend-gated [CX-P0.5] ───────
    try {
      if (overBudget()) {
        skip('budget_exhausted:corpus');
      } else {
        // Spend contract: the corpus pass never calls a paid provider without
        // BOTH a per-run and a per-day USD ceiling. The per-run cap bounds one
        // sweep; the per-day cap bounds the SUM of every sweep in every serve
        // process (each `gbrain serve` fires an idle sweep every 10 minutes,
        // so a per-run cap alone leaks cap × 6 × processes per hour). The
        // run's tracker is capped at min(run cap, today's remaining headroom),
        // which gives the day ceiling the same PRE-call reserve semantics as
        // the run ceiling. Missing or invalid keys fail closed.
        const runCap = opts.maxCostUsd !== undefined
          ? (Number.isFinite(opts.maxCostUsd) && opts.maxCostUsd > 0 ? opts.maxCostUsd : undefined)
          : parsePositiveUsd(await engine.getConfig(SWEEP_RUN_CAP_CONFIG_KEY));
        const dailyCap = parsePositiveUsd(await engine.getConfig(SWEEP_DAILY_CAP_CONFIG_KEY));
        const day = utcDay();
        const ledger = await readSweepSpendLedger(engine);
        const pricingOverrides = await loadSweepPricingOverrides(engine);
        if (runCap === undefined) {
          skip('cost_cap_missing_or_invalid:corpus');
        } else if (dailyCap === undefined) {
          skip('daily_cap_missing_or_invalid:corpus');
        } else if (ledger === 'invalid' || (ledger !== null && ledger.day > day)) {
          // A counter the sweep cannot read — or one from a day this clock has
          // not reached — is not zero: refuse, and leave the row for the
          // operator (`gbrain config unset facts.sweep_spend_ledger`).
          skip('daily_ledger_invalid:corpus');
          log(`[sweep] ${SWEEP_SPEND_LEDGER_CONFIG_KEY} is not a {"day","usd"} row for today or an earlier day — corpus pass refused; unset the row to reset the day`);
        } else if (pricingOverrides === 'invalid') {
          skip('pricing_overrides_invalid:corpus');
          log('[sweep] pricing.overrides is not a readable rate table — corpus pass refused rather than repriced at the shipped table');
        } else {
          const spentToday = ledger && ledger.day === day ? ledger.usd : 0;
          report.dailyCapUsd = dailyCap;
          if (spentToday >= dailyCap) {
            report.dailySpentUsd = spentToday;
            skip('daily_cap_exhausted:corpus');
          } else {
            const headroom = dailyCap - spentToday;
            const capSource: SweepCapSource = headroom < runCap ? 'day' : 'run';
            const effectiveCap = Math.min(runCap, headroom);
            const { BudgetTracker } = await import('./budget/budget-tracker.ts');
            const { withBudgetTracker } = await import('./ai/gateway.ts');
            const tracker = new BudgetTracker({
              maxCostUsd: effectiveCap,
              label: 'sweep:corpus',
              pricingOverrides,
            });
            report.maxCostUsd = effectiveCap;
            report.dailySpentUsd = spentToday;
            // WRITE-AHEAD: the pass calls this right before its first paid
            // call (after it knows it has work), booking the whole run
            // ceiling into today's row in one atomic, cap-checked statement.
            // Concurrent serve processes therefore cannot jointly exceed the
            // day cap, and a ledger that cannot be written refuses the pass
            // instead of letting it run unmetered. Idle sweeps with nothing
            // to ingest never touch the row.
            const booked: { row: SweepSpendLedger | null } = { row: null };
            const reserveDaySpend = async (): Promise<'reserved' | 'refused'> => {
              const row = await reserveSweepSpendToday(engine, effectiveCap, dailyCap, day);
              if (row === null) return 'refused';
              booked.row = row;
              report.dailySpentUsd = row.usd;
              return 'reserved';
            };
            try {
              await withBudgetTracker(tracker, () => runCorpusIngestPass(engine, {
                sourceId,
                batchLimit,
                overBudget,
                signal: budgetController.signal,
                capabilities: opts.capabilities,
                report,
                skip,
                log,
                costTracker: tracker,
                capSource,
                reserveDaySpend,
              }));
            } finally {
              // SETTLE on every exit path (cap hit, abort, error): replace
              // the reservation with the actual. If this write fails the
              // reservation stays booked — the day is over-counted, never
              // under-counted.
              report.spentUsd = tracker.snapshot().cumulativeCostUsd;
              if (booked.row) {
                try {
                  const settled = await settleSweepSpendToday(engine, effectiveCap, report.spentUsd, day);
                  if (settled) report.dailySpentUsd = settled.usd;
                } catch (e) {
                  skip('daily_ledger_settle_failed:corpus');
                  log(`[sweep] could not settle ${SWEEP_SPEND_LEDGER_CONFIG_KEY} (reservation of $${effectiveCap.toFixed(6)} stays booked): ${e instanceof Error ? e.message : String(e)}`);
                }
              }
            }
          }
        }
      }
    } catch (e) {
      skip('corpus_error');
      log(`[sweep] corpus pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (e) {
    // Structural failure outside every per-pass catch (should be
    // unreachable). The never-throw contract holds regardless.
    skip('sweep_error');
    log(`[sweep] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(budgetTimer);
  }

  report.durationMs = Date.now() - started;
  return report;
}

interface PassCtx {
  sourceId: string;
  batchLimit: number;
  overBudget: () => boolean;
  report: SweepReport;
  skip: (reason: string, count?: number) => void;
}

/**
 * Pass 2 body. Calls the SAME per-page cores as `gbrain extract
 * links|timeline --source db` (extract.ts:extractLinksFromDB /
 * extractTimelineFromDB): extractPageLinks + parseTimelineEntries, with
 * resolveCandidateSources doing the multi-source endpoint validation and
 * stampExtracted advancing the links_extracted_at watermark (both kinds
 * run here, so stamping is correct per extract.ts's C3/D6 rule).
 */
async function runLinksTimelinePass(
  engine: BrainEngine,
  ctx: PassCtx & { cutoffIso: string },
): Promise<void> {
  const { sourceId, batchLimit, cutoffIso, overBudget, report, skip } = ctx;

  const {
    extractPageLinks,
    parseTimelineEntries,
    makeResolver,
    isGlobalBasenameEnabled,
    isAutoLinkEnabled,
    isAutoTimelineEnabled,
  } = await import('./link-extraction.ts');

  // Respect the same operator kill switches put_page's inline hooks honor.
  const [linksEnabled, timelineEnabled] = await Promise.all([
    isAutoLinkEnabled(engine),
    isAutoTimelineEnabled(engine),
  ]);
  if (!linksEnabled) skip('auto_link_disabled');
  if (!timelineEnabled) skip('auto_timeline_disabled');
  if (!linksEnabled && !timelineEnabled) return;

  // #4196: honor the watermark this pass stamps, or repeated bounded sweeps
  // re-select the same newest batchLimit rows forever and page batchLimit+1
  // is never reached. Same predicate as the engines' buildStalePagesWhere
  // (no versionTs branch — extractor-version catch-up is `extract --stale`'s
  // job; the sweep is a recency back-stop). The µs to_char projection is the
  // #1768 stamp discipline: stamp the row's READ updated_at, not now(), so an
  // edit between SELECT and stamp stays stale and re-sweeps.
  const recent = await engine.executeRaw<{ slug: string; updated_at_iso: string }>(
    `SELECT slug,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND updated_at >= $2::timestamptz
        AND (links_extracted_at IS NULL OR updated_at > links_extracted_at)
      ORDER BY updated_at DESC
      LIMIT $3`,
    [sourceId, cutoffIso, batchLimit],
  );
  if (recent.length === 0) return;

  // resolveCandidateSources + stampExtracted are the shared helpers the
  // extract command exports precisely so sibling walkers can't drift from
  // its F10 multi-source resolution (see extract.ts:114).
  const { resolveCandidateSources, stampExtracted } = await import('../commands/extract.ts');

  const resolver = makeResolver(engine, { mode: 'batch', sourceId });
  const globalBasename = await isGlobalBasenameEnabled(engine);
  // #3190: pack-aware verbs — the sweep must type edges the same way the
  // extract command does or reconciliation flip-flops the link_type.
  const { loadActivePackForLocalEngine } = await import('./schema-pack/best-effort.ts');
  const pack = (await loadActivePackForLocalEngine(engine))?.manifest ?? null;

  type Extracted = Awaited<ReturnType<typeof extractPageLinks>>;

  const tlBatch: TimelineBatchInput[] = [];
  const processedRefs: Array<{ slug: string; source_id: string; extractedAt: string }> = [];
  const pageCandidates: Array<{ slug: string; candidates: Extracted['candidates'] }> = [];

  // Phase 1: per-page extraction. The per-slug getPage loop stays a loop —
  // BrainEngine has no batch read-by-slug-list primitive (resolveSlugsByPaths
  // is path→slug only), and the loop is bounded by batchLimit (default 20).
  for (let i = 0; i < recent.length; i++) {
    if (overBudget()) {
      skip('budget_exhausted:links_timeline', recent.length - i);
      break;
    }
    const slug = recent[i].slug;
    const page = await engine.getPage(slug, { sourceId });
    if (!page) continue;

    const fullContent = page.compiled_truth + '\n' + page.timeline;

    if (linksEnabled) {
      // skipFrontmatter matches user-invoked `gbrain extract links`
      // (frontmatter backfill stays a migration-orchestrator concern).
      const extracted = await extractPageLinks(
        slug, fullContent, page.frontmatter, page.type, resolver,
        { skipFrontmatter: true, globalBasename, pack },
      );
      if (extracted.candidates.length > 0) {
        pageCandidates.push({ slug, candidates: extracted.candidates });
      }
    }

    if (timelineEnabled) {
      for (const entry of parseTimelineEntries(fullContent)) {
        // Same row shape as extractTimelineFromDB's batch push (extract.ts):
        // #3957 — parsed source label threaded so FS- and DB-extracted rows
        // share one dedup shape; detail '' when empty.
        tlBatch.push({
          slug,
          date: entry.date,
          source: entry.source,
          summary: entry.summary,
          detail: entry.detail || '',
          source_id: sourceId,
        });
      }
    }

    processedRefs.push({ slug, source_id: sourceId, extractedAt: recent[i].updated_at_iso });
  }

  // Phase 2: endpoint validation is scoped to the slugs the candidates
  // actually name — NOT engine.listAllPageRefs() (the full (slug, source_id)
  // map, O(all pages) per sweep; the extract command amortizes that cost over
  // a whole-brain run, a recurring bounded sweep must not). The targeted
  // lookup keeps listAllPageRefs' visibility semantics (deleted_at IS NULL),
  // so resolveCandidateSources' F10 resolution is unchanged — it just sees
  // only the rows it can possibly use. Zero candidates ⇒ zero queries.
  const linkBatch: LinkBatchInput[] = [];
  if (pageCandidates.length > 0) {
    const needed = new Set<string>();
    for (const { slug, candidates } of pageCandidates) {
      needed.add(slug);
      for (const c of candidates) {
        needed.add(c.targetSlug);
        if (c.fromSlug) needed.add(c.fromSlug);
      }
    }
    const { allSlugs, slugToSources } = await lookupRefsForSlugs(engine, [...needed]);
    // #3478: the 'default' fallback is a federation feature — a sweep over an
    // isolated source must not push cross-source edges. Single-row fetchSource
    // (not loadAllSources) keeps the sweep's bounded-cost discipline; a missing
    // sources row fails closed to isolated.
    const { fetchSource, isSourceFederated } = await import('./sources-load.ts');
    const sourceRow = await fetchSource(engine, sourceId);
    const allowCrossSource = sourceRow !== null && isSourceFederated(sourceRow.config);
    for (const { slug, candidates } of pageCandidates) {
      for (const c of candidates) {
        // #2589: a cross_source drop here means the target exists only in
        // other sources and cross-source links are off — the sweep skips it
        // exactly like the extract paths do (extract.ts counts these; the
        // sweep has no drop ledger).
        const resolved = resolveCandidateSources(c, slug, sourceId, allSlugs, slugToSources, allowCrossSource);
        if (!resolved.ok) continue;
        linkBatch.push({
          from_slug: resolved.fromSlug,
          to_slug: c.targetSlug,
          link_type: c.linkType,
          context: c.context,
          link_source: c.linkSource,
          origin_slug: c.originSlug,
          origin_field: c.originField,
          from_source_id: resolved.fromSourceId,
          to_source_id: resolved.toSourceId,
          origin_source_id: sourceId,
        });
      }
    }
  }

  // Engine batch primitives self-retry; default auditSite labels apply
  // (BATCH_AUDIT_SITES is a closed enum owned by retry.ts).
  if (linkBatch.length > 0) {
    report.linksExtracted += await engine.addLinksBatch(linkBatch); // gbrain-allow-direct-insert: the sweep IS the extract path for workspace pages — remote put_page skips extraction by design [CX-P0.3]
  }
  if (tlBatch.length > 0) {
    report.timelineExtracted += await engine.addTimelineEntriesBatch(tlBatch); // gbrain-allow-direct-insert: same extract-path rationale as addLinksBatch above [CX-P0.3]
  }

  // #4196: reconcile removals. The sweep is the ONLY link extraction remote
  // put_page pages ever get (runAutoLink is skipped by design), so add-only
  // inserts leave a phantom edge forever once a page drops a reference.
  // Mirror runAutoLink's provenance-scoped removal (ops/pages.ts) — markdown /
  // NULL-legacy / wikilink-resolved only — minus its own-frontmatter clause:
  // the sweep extracts with skipFrontmatter, so its desired set can never
  // contain frontmatter candidates and deleting them would clobber valid
  // edges. 'manual' and 'mentions' are never touched. A page whose reconcile
  // fails (or is cut by budget) is left unstamped so the next sweep retries.
  const stampable = new Set(processedRefs.map(r => r.slug));
  if (linksEnabled) {
    const { autoLinkLockKey } = await import('./ops/pages.ts');
    const desiredBySlug = new Map<string, Set<string>>(
      processedRefs.map(r => [r.slug, new Set<string>()]),
    );
    for (const b of linkBatch) {
      // runAutoLink's exact key shape (ops/pages.ts outKeys).
      desiredBySlug.get(b.from_slug)?.add(
        `${b.to_slug}\u0000${b.link_type}\u0000${b.link_source ?? 'markdown'}`,
      );
    }
    for (const ref of processedRefs) {
      if (overBudget()) {
        skip('budget_exhausted:link_reconcile');
        stampable.delete(ref.slug);
        continue;
      }
      const desired = desiredBySlug.get(ref.slug)!;
      try {
        report.linksRemoved += await engine.transaction(async (tx) => {
          try {
            // Same advisory lock runAutoLink takes, so sweep reconciliation
            // serializes against a concurrent local put_page on the slug.
            await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
              autoLinkLockKey(sourceId, ref.slug),
            ]);
          } catch { /* engine without advisory locks — PGLite is single-process */ }
          const existing = await tx.getLinks(ref.slug, { sourceId });
          let removed = 0;
          for (const l of existing) {
            const reconcilable =
              l.link_source === 'markdown' || l.link_source == null ||
              l.link_source === 'wikilink-resolved';
            if (!reconcilable) continue;
            const key = `${l.to_slug}\u0000${l.link_type}\u0000${l.link_source ?? 'markdown'}`;
            if (desired.has(key)) continue;
            await tx.removeLink(ref.slug, l.to_slug, l.link_type, l.link_source ?? undefined, {
              fromSourceId: sourceId,
              toSourceId: l.to_source_id,
            });
            removed++;
          }
          return removed;
        });
      } catch {
        skip('link_reconcile_failed');
        stampable.delete(ref.slug);
      }
    }
  }

  // Stamp only when BOTH kinds ran for these pages (extract.ts C3/D6:
  // links_extracted_at covers links AND timeline). Per-ref extractedAt is the
  // page's read updated_at (#1768 µs discipline; D4 — an edit between SELECT
  // and stamp stays stale).
  if (linksEnabled && timelineEnabled) {
    const toStamp = processedRefs.filter(r => stampable.has(r.slug));
    if (toStamp.length > 0) await stampExtracted(engine, toStamp);
  }
}

/**
 * (slug, source_id) refs for EXACTLY the given slugs, chunked IN-list —
 * the bounded replacement for listAllPageRefs in the sweep's pass 2. Same
 * visibility as listAllPageRefs (deleted_at IS NULL).
 */
async function lookupRefsForSlugs(
  engine: BrainEngine,
  slugs: string[],
): Promise<{ allSlugs: Set<string>; slugToSources: Map<string, string[]> }> {
  const allSlugs = new Set<string>();
  const slugToSources = new Map<string, string[]>();
  const CHUNK = 200;
  for (let i = 0; i < slugs.length; i += CHUNK) {
    const chunk = slugs.slice(i, i + CHUNK);
    const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ');
    const rows = await engine.executeRaw<{ slug: string; source_id: string }>(
      `SELECT slug, source_id FROM pages
        WHERE deleted_at IS NULL AND slug IN (${placeholders})`,
      chunk,
    );
    for (const ref of rows) {
      allSlugs.add(ref.slug);
      const list = slugToSources.get(ref.slug) ?? [];
      list.push(ref.source_id);
      slugToSources.set(ref.slug, list);
    }
  }
  return { allSlugs, slugToSources };
}

/**
 * Pass 3 body. One `runFactsPipeline` call per unprocessed corpus file —
 * the narrowest existing entry that takes raw transcript text through
 * extract → resolve → dedup → insert. Visibility left unset so the
 * pipeline resolves the operator default via resolveDefaultVisibility
 * (backstop.ts:359, [ENG-8]). Sidecar written AFTER success only.
 *
 * Concurrency: a `<file>.in-progress` claim sidecar (O_EXCL create) fences
 * each file before its LLM call — a manual `gbrain sweep --once` racing the
 * serve-idle sweep never double-spends on the same transcript. Success
 * replaces the claim with the `.ingested` sidecar; failure removes the claim
 * (next sweep retries); claims older than CORPUS_CLAIM_STALE_MS belong to
 * dead sweeps and are reclaimed.
 */
async function runCorpusIngestPass(
  engine: BrainEngine,
  ctx: PassCtx & {
    signal: AbortSignal;
    capabilities?: CapabilityReport;
    log: (msg: string) => void;
    costTracker: import('./budget/budget-tracker.ts').BudgetTracker;
    capSource: SweepCapSource;
    /** Books the run ceiling into the day ledger; throws when the ledger cannot be written. */
    reserveDaySpend: () => Promise<'reserved' | 'refused'>;
  },
): Promise<void> {
  const { sourceId, batchLimit, overBudget, signal, report, skip, log, costTracker, capSource, reserveDaySpend } = ctx;

  // Corpus dir: dream's session corpus (transcripts.ts:66 precedent);
  // default ~/.gbrain/transcripts/corpus (GBRAIN_HOME-aware via configDir).
  let dir = await engine.getConfig('dream.synthesize.session_corpus_dir');
  if (!dir) {
    const { configDir } = await import('./config.ts');
    dir = join(configDir(), 'transcripts', 'corpus');
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // no corpus dir = nothing to ingest (not an error)
  }

  // ONE readdir feeds both the .txt listing and the sidecar checks (the old
  // shape ran two existsSync probes per file on top of the readdir).
  const entrySet = new Set(entries);
  const txtFiles = entries.filter(n => n.endsWith('.txt')).sort();
  if (txtFiles.length === 0) return;

  const alreadyIngested = txtFiles.filter(n => entrySet.has(n + CORPUS_INGESTED_SUFFIX));
  skip('already_ingested', alreadyIngested.length);

  const candidates = txtFiles
    .filter(n => !entrySet.has(n + CORPUS_INGESTED_SUFFIX))
    .slice(0, batchLimit);
  if (candidates.length === 0) return;

  // Ambient-writeback turn files (`.wb-` basenames) ride this pass as the
  // batch backstop when serve/IPC was away (OV2-11) — but they answer to the
  // AUTHORITATIVE `memory.auto_writeback` gate, resolved once per pass: off ⇒
  // terminal sidecar (operator intent beats a leftover hook-side bank), on ⇒
  // extracted with the lane's own provenance + salient notability filter.
  // Resolved BEFORE the keyless/kill-switch short-circuits so an operator's
  // OFF retires banked turns even when the brain cannot extract — otherwise
  // the files linger eligible and a later re-enable would extract turns the
  // operator already revoked (codex re-review, this wave).
  const { parseWbFileName, writebackOffSidecarJson } = await import('./context/corpus-segments.ts');
  const { resolveWritebackConfig } = await import('./facts/writeback-config.ts');
  const { loadConfig: loadFileCfg } = await import('./config.ts');
  const { isValidSourceId } = await import('./source-id.ts');
  // Gate semantics: never extract on a last-known-good ENABLED bundle — an
  // operator's off wins even during a DB blip; read_error, plane drift (DB
  // row absent + file mirror enabled = failed dual-write, not intent), and
  // an unrecognized mode value all skip wb files WITHOUT a terminal sidecar
  // so the next sweep retries them once the config is coherent.
  const wbCfg = await resolveWritebackConfig(engine, loadFileCfg(), { gate: true });
  // Genuinely-resolved OFF: terminal-sidecar the wb candidates regardless of
  // extraction capability (idempotent one-line writes; a lost race with a
  // concurrent sweep writing the same sidecar is benign).
  const wbGenuinelyOff = !wbCfg.enabled && wbCfg.mode_valid && !wbCfg.plane_drift && !wbCfg.read_error;
  const retireWbCandidatesIfOff = async (): Promise<Set<string>> => {
    const retired = new Set<string>();
    if (!wbGenuinelyOff) return retired;
    for (const name of candidates) {
      if (!parseWbFileName(name)) continue;
      try {
        await writeFile(join(dir, name) + CORPUS_INGESTED_SUFFIX, writebackOffSidecarJson());
        retired.add(name);
        skip('writeback_off');
      } catch { /* per-file best effort — the next sweep retries */ }
    }
    return retired;
  };

  // [CX-P0.5] Keyless rule: no extraction provider configured ⇒ skip the
  // whole pass. Agent-authored fences (pass 1) carry keyless memory.
  const caps = ctx.capabilities ?? detectCapabilities();
  if (!caps.extraction.available) {
    const retired = await retireWbCandidatesIfOff();
    skip('keyless', candidates.length - retired.size);
    return;
  }

  // Existing spend gate: operators flip facts.extraction_enabled off to
  // stop ALL fact extraction brain-wide (facts/extract.ts:43).
  const { isFactsExtractionEnabled } = await import('./facts/extract.ts');
  if (!(await isFactsExtractionEnabled(engine))) {
    const retired = await retireWbCandidatesIfOff();
    skip('extraction_disabled', candidates.length - retired.size);
    return;
  }

  if (candidates.length === 0) return; // nothing to pay for: never touch the ledger

  // Day-ledger reservation: the last gate before money moves. A refusal
  // means another process took today's headroom since our read; a throw
  // means the ledger is unwritable — both end the pass with zero calls.
  try {
    if ((await reserveDaySpend()) === 'refused') {
      skip('daily_cap_exhausted:corpus', candidates.length);
      return;
    }
  } catch (e) {
    skip('daily_ledger_write_failed:corpus', candidates.length);
    log(`[sweep] could not reserve in ${SWEEP_SPEND_LEDGER_CONFIG_KEY} — corpus pass refused: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  const { runFactsPipeline } = await import('./facts/backstop.ts');
  const { isDreamOutput } = await import('./cycle/transcript-discovery.ts');

  for (let i = 0; i < candidates.length; i++) {
    if (overBudget()) {
      skip('budget_exhausted:corpus', candidates.length - i);
      break;
    }
    const name = candidates[i];
    const full = join(dir, name);

    // Atomic claim BEFORE any spend — the losing sweep skips, never re-pays.
    const claimPath = full + CORPUS_CLAIM_SUFFIX;
    if (!(await acquireCorpusClaim(claimPath))) {
      skip('corpus_in_progress');
      continue;
    }

    let abortLoop = false;
    try {
      // Re-check under the claim: another sweep may have finished this file
      // between our readdir and our claim (it releases its claim only after
      // writing the .ingested sidecar, so this closes the double-spend gap).
      const doneAlready = await stat(full + CORPUS_INGESTED_SUFFIX).then(() => true, () => false);
      if (doneAlready) {
        skip('already_ingested');
        continue;
      }

      const wbMeta = parseWbFileName(name);
      if (wbMeta && wbCfg.read_error) {
        skip('writeback_gate_unreadable');
        continue; // no sidecar — retry next sweep once the config is readable
      }
      if (wbMeta && !wbCfg.enabled && (wbCfg.plane_drift || !wbCfg.mode_valid)) {
        // Diverged planes / unrecognized mode value ≠ operator intent: no
        // terminal sidecar — the file survives until the config re-coheres
        // (doctor names the re-sync command).
        skip(wbCfg.plane_drift ? 'writeback_plane_drift' : 'writeback_mode_invalid');
        continue;
      }
      if (wbMeta && !wbCfg.enabled) {
        await writeFile(full + CORPUS_INGESTED_SUFFIX, writebackOffSidecarJson());
        skip('writeback_off');
        continue;
      }

      const raw = await readFile(full, 'utf-8');

      // Anti-loop: never ingest dream-generated outputs. Marking them
      // processed is safe — the classification is deterministic and
      // permanent, and the sidecar stops the sweep re-reading them forever.
      if (isDreamOutput(raw)) {
        await writeFile(
          full + CORPUS_INGESTED_SUFFIX,
          JSON.stringify({ ingested_at: new Date().toISOString(), skipped: 'dream_output' }) + '\n',
        );
        skip('dream_output');
        continue;
      }

      // Source fidelity (adversarial review, this wave): wb files bank the
      // session's GBRAIN_SOURCE in their NAME, so the sweep fallback files
      // the turn into the SAME source the prompt-time IPC lane would have —
      // never the pass's source. Validated before use (source-isolation
      // invariant); a legacy/invalid segment falls back to the pass source.
      const wbSourceId = wbMeta?.sourceId && isValidSourceId(wbMeta.sourceId)
        ? wbMeta.sourceId
        : sourceId;
      const r = await runFactsPipeline(raw, {
        engine,
        sourceId: wbMeta ? wbSourceId : sourceId,
        sessionId: wbMeta ? wbMeta.sessionId : `sweep:corpus:${name}`,
        // Provenance tag outside FactsBackstopCtx's enumerated writers —
        // facts.source is free text at the DB layer; the cast only
        // side-steps the ctx union, which predates the sweep. Writeback turn
        // files keep their lane's provenance + salient notability filter so
        // batch-extracted turns are indistinguishable from prompt-harvested.
        source: wbMeta ? 'hook:writeback' : ('sweep:corpus' as FactsBackstopCtx['source']),
        mode: 'inline',
        remote: false,
        abortSignal: signal,
        ...(wbMeta && wbCfg.mode === 'salient' ? { notabilityFilter: 'medium-and-up' as const } : {}),
        // visibility deliberately unset → resolveDefaultVisibility [ENG-8]
      });

      // POST-check (adversarial review, same class the harvest FIFO pins):
      // runFactsPipeline returns NORMALLY with partial results when the
      // budget signal aborts mid-file. Writing `.ingested` here would
      // permanently mark a half-extracted file done — skip the sidecar,
      // release the claim, and let the next sweep retry it.
      if (signal.aborted) {
        skip('budget_exhausted:corpus', candidates.length - i);
        abortLoop = true;
        continue;
      }

      // Cathedral 5 — best-effort checkpoint-link publish when the backstop
      // ingests a compaction segment (queue overflow, serve down at compact
      // time, keyless-then-keyed): without this, every segment that falls to
      // the sweep loses its brain:// links forever. The harvest FIFO remains
      // the guaranteed lane (receipt retry); here a publish failure is
      // fail-open and `.ingested` is written regardless (facts are durable;
      // re-extracting just to retry a link append is the worse trade).
      let linksBanked = 0;
      if (r.entity_slugs.length) {
        try {
          const segs = await import('./context/corpus-segments.ts');
          const parsed = segs.parseSegmentFileName(name);
          if (parsed) {
            const verified: Array<{ slug: string; title: string }> = [];
            for (const slug of r.entity_slugs) {
              try {
                const page = await engine.getPage(slug, { sourceId });
                if (page) verified.push({ slug, title: page.title || slug });
              } catch { /* a non-resolvable link is never banked */ }
            }
            if (verified.length) {
              const ss = await import('./context/session-state.ts');
              const ledger = segs.readSegmentLedger(dir, parsed.sessionId);
              const n = Math.max(1, ledger.findIndex((e) => e.hash === parsed.hash) + 1);
              const ok = await ss.appendCheckpointManifest(
                engine, sourceId, null, parsed.sessionId, verified,
                { seg: parsed.hash, n },
              );
              if (ok) linksBanked = verified.length;
            }
          }
        } catch { /* link publish is best-effort on the backstop lane */ }
      }

      // Sidecar AFTER success — a crash before this line re-processes the
      // file next sweep (dedup absorbs the repeats), never loses it.
      await writeFile(
        full + CORPUS_INGESTED_SUFFIX,
        JSON.stringify({
          ingested_at: new Date().toISOString(),
          facts_inserted: r.inserted,
          facts_duplicate: r.duplicate,
          // Honesty: the sweep is the LAST attempt (the harvest lane already
          // declined to sidecar on this), so a non-transport extraction skip
          // is terminal HERE — record why instead of a silent zero-count.
          ...(r.skipped_reason ? { skipped: r.skipped_reason } : {}),
          ...(linksBanked ? { links_banked: linksBanked } : {}),
        }) + '\n',
      );
      report.corpusIngested += 1;
      if (costTracker.snapshot().cumulativeCostUsd > (report.maxCostUsd ?? Number.POSITIVE_INFINITY)) {
        // The last call's TRUE cost exceeded what reserve() projected (TX1):
        // name it even when no file is left to skip, or the report would show
        // a breached cap next to an empty skip list.
        skip(capOvershootReason(capSource));
        skip(capExhaustedReason(capSource), candidates.length - i - 1);
        abortLoop = true;
      }
    } catch (e) {
      const budgetError = findBudgetError(e);
      if (budgetError) {
        skip(budgetError.reason === 'no_pricing' ? 'cost_cap_no_pricing:corpus' : capExhaustedReason(capSource), candidates.length - i);
        abortLoop = true;
      } else if (e instanceof Error && e.name === 'AbortError') {
        skip('budget_exhausted:corpus', candidates.length - i);
        abortLoop = true;
      } else {
        skip('corpus_file_error');
        log(`[sweep] corpus ingest failed for ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      // Success (its .ingested sidecar now stands in) and failure (retry next
      // sweep) both release the claim.
      await rm(claimPath, { force: true }).catch(() => {});
    }
    if (abortLoop) break;
  }
}

function findBudgetError(error: unknown): import('./budget/budget-tracker.ts').BudgetExhausted | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if (current.name === 'BudgetExhausted' && 'reason' in current) {
      return current as import('./budget/budget-tracker.ts').BudgetExhausted;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Try to claim a corpus file for ingestion. O_EXCL (`wx`) create is the
 * atomic primitive; a live existing claim (< CORPUS_CLAIM_STALE_MS old)
 * means another sweep owns the file. Stale claims are removed and re-raced
 * (one contender wins the second `wx`). Never throws. EXPORTED (cathedral 5)
 * so the serve-side checkpoint harvest shares the exact same fencing — a
 * sweep and a harvest can never double-spend on one segment.
 */
export async function acquireCorpusClaim(claimPath: string): Promise<boolean> {
  const body = JSON.stringify({ claimed_at: new Date().toISOString(), pid: process.pid }) + '\n';
  const tryCreate = () =>
    writeFile(claimPath, body, { flag: 'wx', mode: 0o600 }).then(() => true, () => false);

  if (await tryCreate()) return true;
  try {
    const st = await stat(claimPath);
    if (Date.now() - st.mtimeMs <= CORPUS_CLAIM_STALE_MS) return false; // live claim
  } catch {
    // Claim vanished between wx-create and stat — its owner just released.
    // Treat as contended; a later sweep picks the file up if still needed.
    return false;
  }
  await rm(claimPath, { force: true }).catch(() => {});
  return tryCreate();
}

// ── Serve-startup arming [ENG-5] ─────────────────────────────────────────

export interface StartupSweepOpts {
  /** Post-connect settle delay. Default STARTUP_SWEEP_DELAY_MS (3s). */
  delayMs?: number;
  /** Source to sweep. Default 'default'. */
  sourceId?: string;
  /** Env for the GBRAIN_SWEEP kill switch. Default process.env. */
  env?: Record<string, string | undefined>;
  /** Timer seams (tests). Defaults: global setTimeout/clearTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Sweep body override (tests). Default: runMaintenanceSweep. */
  sweep?: (engine: BrainEngine) => Promise<unknown>;
}

/**
 * Arm the one-shot startup sweep for a serve process. Returns a cancel
 * handle for shutdown, or null when the GBRAIN_SWEEP=0 kill switch is set.
 * The timer is unref'd (never holds the process open) and the sweep body
 * swallows every error — best-effort by construction, same posture as the
 * resolve-IPC block in src/mcp/server.ts.
 */
export function armStartupSweep(
  engine: BrainEngine,
  opts: StartupSweepOpts = {},
): { cancel: () => void } | null {
  const env = opts.env ?? process.env;
  if (env.GBRAIN_SWEEP === '0') return null;

  const setT = opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn
    ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const run = opts.sweep
    ?? ((e: BrainEngine) => runMaintenanceSweep(e, { sourceId: opts.sourceId }));

  const handle = setT(() => {
    Promise.resolve()
      .then(() => run(engine))
      .catch(() => { /* startup sweep is best-effort; never crash serve */ });
  }, opts.delayMs ?? STARTUP_SWEEP_DELAY_MS);
  (handle as { unref?: () => void } | null)?.unref?.();

  return {
    cancel: () => {
      try { clearT(handle); } catch { /* noop */ }
    },
  };
}
