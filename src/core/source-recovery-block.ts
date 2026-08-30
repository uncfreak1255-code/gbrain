/**
 * Durable dispatch block for sources whose recovery checkout is invalid.
 *
 * WHY THIS EXISTS. `assertManifestMatchesTrustedSourceCount` fails a sync when
 * the recovery checkout's frozen `source_page_count` no longer equals the live
 * page count for that source. That guard is CORRECT and must not be weakened:
 * a source-scoped sync imports the checkout INTO the database, so accepting a
 * stale checkout could overwrite or delete pages written since the export.
 *
 * The defect is lifecycle, not integrity. The mismatch is DETERMINISTIC — it
 * cannot resolve without a human re-export — but autopilot's per-source
 * freshness dispatch treats it as an ordinary retryable sync failure. Each
 * interval mints a fresh idempotency key, so the job is resubmitted, dies
 * after its retries, and repeats. Observed on the `default` source: 166 dead
 * sync jobs in 24h, one death roughly every five minutes, for three days,
 * every one of them failing on the same unchangeable condition.
 *
 * A cooldown is the wrong instrument here. Cooldowns are for transient
 * failures and are capped, so they convert a five-minute storm into a
 * two-hour storm. A failure that can never succeed without operator action
 * needs a BLOCK: stop dispatching, stay visible, and clear only when the
 * underlying condition actually changes.
 *
 * THE INVARIANT THIS PRESERVES:
 *   No destructive source sync may use a recovery checkout unless its complete
 *   page set, identities, and bytes are proven against the trusted source
 *   snapshot it claims to represent.
 *
 * Blocking dispatch preserves that invariant strictly — it removes attempts to
 * import an unproven checkout. It never imports anything the guard would have
 * rejected, and it cannot mask a different failure: only the recovery-manifest
 * signature blocks, and any newer terminal outcome supersedes the block.
 */

/**
 * Signature of the deterministic recovery-manifest failure.
 *
 * Deliberately anchored on the guard's own wording in
 * `src/core/source-recovery-manifest.ts` (`failManifest`). Matching narrowly
 * matters: a broad match would swallow transient failures that SHOULD retry.
 */
const RECOVERY_REQUIRED_SIGNATURE = /invalid source-scoped recovery manifest/i;

/** Terminal job statuses. A job in any other state proves nothing yet. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'dead', 'cancelled']);

export interface TerminalSyncJobLike {
  status?: string | null;
  /** Newest failure text for the job (error column or last history entry). */
  error?: string | null;
}

/** True when this text is the deterministic recovery-manifest failure. */
export function isRecoveryRequiredError(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return RECOVERY_REQUIRED_SIGNATURE.test(text);
}

export interface FreshnessDispatchDecision {
  /** Skip dispatching a freshness sync for this source. */
  skip: boolean;
  /** Machine-readable reason; null when not skipping. */
  reason: 'recovery_required' | null;
  /** Operator-facing remedy, present only when skipping. */
  remedy: string | null;
}

const DISPATCH_ALLOWED: FreshnessDispatchDecision = {
  skip: false,
  reason: null,
  remedy: null,
};

/**
 * Decide whether autopilot may dispatch a freshness sync for a source.
 *
 * Blocks ONLY when the newest TERMINAL sync job for the source died on the
 * recovery-manifest signature. Consequences of that narrowness, all deliberate:
 *
 *   - A newer terminal job of any other kind (including a success) supersedes
 *     the block, so a completed re-export resumes dispatch automatically with
 *     no state to clear by hand.
 *   - A non-terminal newest job (waiting/active) does not block: nothing is
 *     proven while a job is still in flight.
 *   - No job history at all does not block: a source that has never synced
 *     must be allowed to try.
 *
 * @param newestTerminalSyncJob The newest sync job for the source, or null.
 */
export function decideFreshnessDispatch(
  newestTerminalSyncJob: TerminalSyncJobLike | null | undefined,
): FreshnessDispatchDecision {
  const job = newestTerminalSyncJob;
  if (!job) return DISPATCH_ALLOWED;

  const status = typeof job.status === 'string' ? job.status.toLowerCase() : '';
  if (!TERMINAL_STATUSES.has(status)) return DISPATCH_ALLOWED;

  // A terminal SUCCESS clears the condition regardless of the error column,
  // which can still hold text from an earlier attempt of the same job.
  if (status === 'completed') return DISPATCH_ALLOWED;

  if (!isRecoveryRequiredError(job.error)) return DISPATCH_ALLOWED;

  return {
    skip: true,
    reason: 'recovery_required',
    remedy:
      'Recovery checkout does not match the trusted source. Re-export it with ' +
      '`gbrain export --source <id> --dir <new-private-dir>` and sync once by ' +
      'hand; freshness dispatch resumes on the next terminal outcome.',
  };
}

export const _internal = { RECOVERY_REQUIRED_SIGNATURE, TERMINAL_STATUSES };
