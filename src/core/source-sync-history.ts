/**
 * Newest terminal sync job per source.
 *
 * Used by autopilot's freshness gate to tell a DETERMINISTIC failure (an
 * invalid recovery checkout, which cannot clear without an operator re-export)
 * apart from an ordinary transient one. See `source-recovery-block.ts` for why
 * that distinction has to exist.
 */

import type { BrainEngine } from './engine.ts';
import type { TerminalSyncJobLike } from './source-recovery-block.ts';

/**
 * The most recent sync job for `sourceId`, newest first by id.
 *
 * Returns null when the source has no sync history, when `minion_jobs` does
 * not exist (pre-v0.11 brains), or when the query fails for any reason. Null
 * means "nothing proven", and the caller treats that as dispatch-allowed — so
 * a failure to read history can never wedge a source that is actually fine.
 */
export async function newestTerminalSyncJob(
  engine: BrainEngine,
  sourceId: string,
): Promise<TerminalSyncJobLike | null> {
  try {
    const rows = await engine.executeRaw<{ status: string; error_text: string | null }>(
      `SELECT status, error_text
         FROM minion_jobs
        WHERE name = 'sync'
          AND data->>'sourceId' = $1
        ORDER BY id DESC
        LIMIT 1`,
      [sourceId],
    );
    const row = rows[0];
    if (!row) return null;
    return { status: row.status, error: row.error_text };
  } catch {
    // No table, no permission, engine hiccup — all mean "cannot prove a block".
    return null;
  }
}
