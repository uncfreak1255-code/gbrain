/**
 * issue #1678 — bounded single-hold drain for extract_atoms.
 *
 * The operator/agent escape hatch for a backlog the routine cycle won't touch
 * (pack-gated off) or can't keep up with. Design per Codex #8/#9/#10:
 *
 *  - SINGLE continuous lock hold (no release/reacquire between batches). The
 *    caller wraps the loop in `withRefreshingLock(cycleLockIdFor(sourceId))` —
 *    the SAME lock id the routine cycle uses for that source — so the two
 *    genuinely contend (no source-vs-legacy lock mismatch) and there's no
 *    release-gap where autopilot/sync could mutate pages mid-drain (which would
 *    let the drain extract atoms from stale content).
 *  - REDISCOVER eligibility each batch (the injected `runBatch` re-runs the
 *    NOT-EXISTS-on-source_hash discovery), so stale content simply doesn't
 *    match — no cross-window cursor of page lists.
 *  - BOUNDED by a wallclock window; reports `remaining` so a cron/agent loop
 *    knows whether to run again.
 *
 * Pure over injected deps: no DB, no LLM, no lock primitive imported here, so
 * the loop logic is unit-testable. The wiring helper `runExtractAtomsDrainForSource`
 * (below) builds the real deps; it uses DYNAMIC imports so this module's static
 * graph stays empty and the pure-loop unit tests don't drag in db-lock / cycle.
 */

import type { BrainEngine } from '../engine.ts';
import { redactConnectionInfo } from '../audit/redact-connection-info.ts';

const MAX_FAILURE_SAMPLES = 20;
const MAX_FAILURE_ERROR_LENGTH = 200;

export interface ExtractAtomsDrainFailure {
  source: string;
  error: string;
  error_class?: string;
  error_code?: string;
}

export interface ExtractAtomsDrainBatchResult {
  extracted: number;
  skipped: number;
  /** Phase status from the inner extractor. */
  status?: 'ok' | 'warn' | 'fail' | 'skipped';
  /** Failure samples from the inner extractor. */
  failures?: ReadonlyArray<ExtractAtomsDrainFailure>;
  /** Total failures when the supplied samples are bounded. */
  failure_count?: number;
  /** True when the supplied failure samples are incomplete. */
  failures_truncated?: boolean;
  /** True when the inner phase stopped at its caller deadline. */
  deadline_elapsed?: boolean;
}

function normalizeFailure(failure: ExtractAtomsDrainFailure): ExtractAtomsDrainFailure {
  return {
    source: failure.source,
    error: redactConnectionInfo(failure.error).replace(/\s+/g, ' ').trim().slice(0, MAX_FAILURE_ERROR_LENGTH),
    ...(failure.error_class ? { error_class: failure.error_class.slice(0, 80) } : {}),
    ...(failure.error_code ? { error_code: failure.error_code.slice(0, 80) } : {}),
  };
}

export interface ExtractAtomsDrainDeps {
  /**
   * Run the loop body while holding the cycle lock. Implemented by the caller
   * via `withRefreshingLock`. MUST throw when the lock is held by another
   * process (e.g. `LockUnavailableError`) — the drain lets that propagate so
   * the caller can report `cycle_already_running` and exit, matching the
   * routine cycle's skip contract.
   */
  withLock: <T>(work: () => Promise<T>) => Promise<T>;
  /** Process one bounded batch (rediscovers eligibility). Returns its outcome. */
  runBatch: (info: { deadlineMs: number }) => Promise<ExtractAtomsDrainBatchResult>;
  /** Count remaining eligible-but-unextracted pages, or null on query error. */
  countRemaining: () => Promise<number | null>;
  /** Injectable clock. Production: Date.now. */
  now: () => number;
  /** Optional progress sink (one line per batch). */
  onBatch?: (info: { batch: number; extracted: number; remaining: number | null }) => void;
}

export interface ExtractAtomsDrainOpts {
  /** Wallclock budget in ms. The loop stops after this elapses. */
  windowMs: number;
  /** Hard cap on batches (belt-and-suspenders against a 0-progress loop). Default 1000. */
  maxBatches?: number;
}

export interface ExtractAtomsDrainResult {
  phase: 'extract_atoms';
  status: 'ok' | 'warn';
  extracted: number;
  skipped: number;
  /** Total inner extraction failures across all processed batches. */
  failure_count: number;
  /** Bounded, redacted samples of inner extraction failures. */
  failures: ExtractAtomsDrainFailure[];
  /** True when failure samples were omitted from the result. */
  failures_truncated: boolean;
  /** True when a batch or the drain window ended at its deadline. */
  deadline_elapsed: boolean;
  /** Eligible pages still pending after the window. null if the count errored. */
  remaining: number | null;
  /** Batches actually processed. */
  batches: number;
  /** Why the loop stopped: drained | window | no_progress | max_batches. */
  stopped: 'drained' | 'window' | 'no_progress' | 'max_batches';
}

export async function runExtractAtomsDrain(
  deps: ExtractAtomsDrainDeps,
  opts: ExtractAtomsDrainOpts,
): Promise<ExtractAtomsDrainResult> {
  const maxBatches = opts.maxBatches ?? 1000;
  return deps.withLock(async () => {
    const deadline = deps.now() + opts.windowMs;
    let extracted = 0;
    let skipped = 0;
    let batches = 0;
    let failureCount = 0;
    const failures: ExtractAtomsDrainFailure[] = [];
    let failuresTruncated = false;
    let status: ExtractAtomsDrainResult['status'] = 'ok';
    let deadlineElapsed = false;
    let stopped: ExtractAtomsDrainResult['stopped'] = 'window';

    while (deps.now() < deadline) {
      if (batches >= maxBatches) { stopped = 'max_batches'; break; }

      const before = await deps.countRemaining();
      if (before === 0) { stopped = 'drained'; break; }

      const r = await deps.runBatch({ deadlineMs: deadline });
      extracted += r.extracted;
      skipped += r.skipped;
      batches++;
      const batchFailures = r.failures ?? [];
      const declaredFailureCount = typeof r.failure_count === 'number'
        && Number.isFinite(r.failure_count)
        && r.failure_count >= 0
        ? Math.floor(r.failure_count)
        : 0;
      failureCount += Math.max(declaredFailureCount, batchFailures.length);
      if (r.status === 'warn' || r.status === 'fail' || batchFailures.length > 0) status = 'warn';
      if (r.failures_truncated === true) failuresTruncated = true;
      for (const failure of batchFailures) {
        if (failures.length < MAX_FAILURE_SAMPLES) failures.push(normalizeFailure(failure));
        else failuresTruncated = true;
      }
      deadlineElapsed ||= r.deadline_elapsed === true;
      deps.onBatch?.({ batch: batches, extracted: r.extracted, remaining: before });

      if (deps.now() >= deadline) {
        stopped = 'window';
        deadlineElapsed = true;
        break;
      }

      // Stop if a batch made zero forward progress — extraction is failing or
      // everything left is ineligible (e.g. all skipped). Prevents a hot loop
      // that spends budget without draining.
      if (r.extracted === 0 && r.skipped === 0) { stopped = 'no_progress'; break; }
    }

    const remaining = await deps.countRemaining();
    if (stopped === 'window') deadlineElapsed = true;
    if (remaining === 0) stopped = 'drained';
    return {
      phase: 'extract_atoms',
      status,
      extracted,
      skipped,
      failure_count: failureCount,
      failures,
      failures_truncated: failuresTruncated || failureCount > failures.length,
      deadline_elapsed: deadlineElapsed,
      remaining,
      batches,
      stopped,
    };
  });
}

// ─── Shared wiring helper (v0.42.x #1685 DECISION 5A) ──────────────────────
//
// ONE drain path, three callers: `gbrain dream --phase extract_atoms --drain`
// (dream.ts), the `extract-atoms-drain` Minion handler (jobs.ts), and the
// autopilot auto-drain submission (which routes through the handler). Before
// this helper the lock/batch/count wiring lived inline in dream.ts:482; a second
// copy in the handler would let lock id / window default / defer-on-lock-busy
// drift. Keeping the wiring here means those three callers can't diverge.
//
// Imports are dynamic so the pure `runExtractAtomsDrain` above stays cheap to
// import in unit tests (no db-lock / cycle / extract-atoms in the static graph).
//
// `LockUnavailableError` is NOT caught here — the pure loop's `withLock`
// (withRefreshingLock) throws it and it propagates to the caller, because each
// caller reports the busy-lock case differently (dream → exit 3;
// handler → `{ deferred: true }`). That matches the contract documented on
// `ExtractAtomsDrainDeps.withLock`.

export interface DrainForSourceOpts {
  /**
   * The source id used for cycle-lock identity, or `undefined` for the legacy
   * unscoped cycle lock.
   * `undefined` → `cycleLockIdFor(undefined)` = the bare `gbrain-cycle` lock the
   * unscoped routine cycle holds; a real id → `gbrain-cycle:<id>`. Either way the
   * drain and the matching routine cycle genuinely contend (Codex #9).
   */
  sourceId: string | undefined;
  /**
   * Source to count/extract. Defaults to `sourceId ?? 'default'` for legacy
   * callers. Bare CLI drains can resolve cwd to a concrete extraction source
   * while still holding the legacy unscoped cycle lock.
   */
  extractionSourceId?: string;
  /** Wallclock budget in seconds. */
  windowSeconds: number;
  /** Brain checkout dir, threaded to `runPhaseExtractAtoms` (optional — DB-only ok). */
  brainDir?: string;
  /** Hard batch cap (belt-and-suspenders). */
  maxBatches?: number;
  /** Optional per-batch progress sink (stderr line in dream; job progress in the handler). */
  onBatch?: ExtractAtomsDrainDeps['onBatch'];
}

export async function runExtractAtomsDrainForSource(
  engine: BrainEngine,
  opts: DrainForSourceOpts,
): Promise<ExtractAtomsDrainResult> {
  const { withRefreshingLock } = await import('../db-lock.ts');
  const { runPhaseExtractAtoms, countExtractAtomsBacklog } = await import('./extract-atoms.ts');
  const { cycleLockIdFor } = await import('../cycle.ts');

  const extractionSourceId = opts.extractionSourceId ?? opts.sourceId ?? 'default';
  const lockId = cycleLockIdFor(opts.sourceId);

  return runExtractAtomsDrain(
    {
      withLock: (work) => withRefreshingLock(engine, lockId, work, { ttlMinutes: 5 }),
      runBatch: async ({ deadlineMs }) => {
        const r = await runPhaseExtractAtoms(engine, {
          sourceId: extractionSourceId,
          dryRun: false,
          brainDir: opts.brainDir,
          // Drain mode is advertised by doctor as a DB-page backlog fix.
          // Suppress transcript discovery so the window cannot be spent on
          // filesystem transcripts while page backlog stays unchanged.
          _transcripts: [],
          deadlineMs,
        });
        const d = (r.details ?? {}) as Record<string, unknown>;
        const failures = Array.isArray(d.failures)
          ? d.failures.filter((failure): failure is ExtractAtomsDrainFailure => {
              if (!failure || typeof failure !== 'object') return false;
              const value = failure as Record<string, unknown>;
              return typeof value.source === 'string' && typeof value.error === 'string';
            })
          : [];
        const phaseFailure = r.status === 'fail' && r.error
          ? [{
              source: extractionSourceId,
              error: r.error.message,
              error_class: r.error.class,
              error_code: r.error.code,
            }]
          : [];
        const allFailures = [...failures, ...phaseFailure];
        const declaredFailureCount = typeof d.failure_count === 'number'
          && Number.isFinite(d.failure_count)
          && d.failure_count >= 0
          ? Math.floor(d.failure_count)
          : 0;
        return {
          extracted: Number(d.atoms_extracted ?? 0),
          skipped: Number(d.duplicates_skipped ?? 0),
          status: r.status,
          failures: allFailures,
          failure_count: Math.max(declaredFailureCount, allFailures.length),
          failures_truncated: d.failures_truncated === true || declaredFailureCount > allFailures.length,
          deadline_elapsed: d.deadline_elapsed === true,
        };
      },
      countRemaining: () => countExtractAtomsBacklog(engine, extractionSourceId),
      now: Date.now,
      onBatch: opts.onBatch,
    },
    { windowMs: opts.windowSeconds * 1000, maxBatches: opts.maxBatches },
  );
}
