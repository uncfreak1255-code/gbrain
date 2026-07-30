/**
 * Destructive operation guard — v0.26.5
 *
 * Protects against accidental data loss in gbrain by requiring explicit
 * confirmation for operations that cascade-delete pages, chunks, or embeddings.
 *
 * Three layers:
 *   1. Impact preview — always shown before destructive actions
 *   2. Confirmation gate — requires --confirm-destructive or interactive "type source name"
 *   3. Soft-delete with TTL — sources are tombstoned for 72h before permanent deletion
 *
 * Design principle: the blast radius should be visible BEFORE you pull the trigger,
 * and recoverable AFTER you pull it (within a grace period).
 */

import type { BrainEngine } from './engine.ts';
import {
  beginSourceArchiveDrain,
  cancelSourceArchiveDrain,
  lockSourceDrainForFinalize,
  waitForSourceEmbeddingLeases,
} from './source-embedding-lease.ts';
import { MinionQueue } from './minions/queue.ts';

// ── Types ───────────────────────────────────────────────────

export interface DestructiveImpact {
  sourceId: string;
  sourceName: string;
  pageCount: number;
  chunkCount: number;
  embeddingCount: number;
  fileCount: number;
  /** Human-readable summary line */
  summary: string;
}

export interface SoftDeletedSource {
  id: string;
  name: string;
  deletedAt: Date;
  expiresAt: Date;
  pageCount: number;
}

// ── Constants ───────────────────────────────────────────────

/** Hours before a soft-deleted source is permanently purged. */
export const SOFT_DELETE_TTL_HOURS = 72;

/** Threshold: operations affecting this many pages or more require confirmation. */
export const CONFIRM_THRESHOLD_PAGES = 1;

// ── Impact Assessment ───────────────────────────────────────

/**
 * Compute the blast radius of deleting a source.
 */
export async function assessDestructiveImpact(
  engine: BrainEngine,
  sourceId: string,
): Promise<DestructiveImpact | null> {
  // Fetch source metadata
  const sources = await engine.executeRaw<{ id: string; name: string }>(
    `SELECT id, name FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (sources.length === 0) return null;

  const src = sources[0];

  // Count pages
  const pageRows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
    [sourceId],
  );
  const pageCount = pageRows[0]?.n ?? 0;

  // Count chunks
  const chunkRows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM content_chunks cc
     JOIN pages p ON cc.page_id = p.id
     WHERE p.source_id = $1`,
    [sourceId],
  );
  const chunkCount = chunkRows[0]?.n ?? 0;

  // Count embeddings (chunks with non-null embedding vectors)
  const embedRows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM content_chunks cc
     JOIN pages p ON cc.page_id = p.id
     WHERE p.source_id = $1 AND cc.embedding IS NOT NULL`,
    [sourceId],
  );
  const embeddingCount = embedRows[0]?.n ?? 0;

  // Count files in storage (if any). PGLite has no `files` table — that
  // surface is Postgres-only (CLAUDE.md: "No files table" for PGLite). Probe
  // the table existence via information_schema so this works on both engines.
  let fileCount = 0;
  const filesTableRows = await engine.executeRaw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'files'
     ) AS exists`,
  );
  if (filesTableRows[0]?.exists) {
    const fileRows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM files WHERE source_id = $1`,
      [sourceId],
    );
    fileCount = fileRows[0]?.n ?? 0;
  }

  const parts: string[] = [];
  if (pageCount > 0) parts.push(`${pageCount.toLocaleString()} pages`);
  if (chunkCount > 0) parts.push(`${chunkCount.toLocaleString()} chunks`);
  if (embeddingCount > 0) parts.push(`${embeddingCount.toLocaleString()} embeddings`);
  if (fileCount > 0) parts.push(`${fileCount.toLocaleString()} files`);

  const summary = parts.length > 0
    ? `⚠️  This will permanently delete: ${parts.join(', ')}`
    : `Source "${sourceId}" has no data (safe to remove).`;

  return {
    sourceId,
    sourceName: src.name,
    pageCount,
    chunkCount,
    embeddingCount,
    fileCount,
    summary,
  };
}

// ── Confirmation Gate ───────────────────────────────────────

/**
 * Check whether the caller has provided sufficient confirmation for a
 * destructive operation. Returns an error message if blocked, or null if OK.
 */
export function checkDestructiveConfirmation(
  impact: DestructiveImpact,
  opts: {
    yes?: boolean;
    confirmDestructive?: boolean;
    dryRun?: boolean;
  },
): string | null {
  // Dry run always passes (no side effects)
  if (opts.dryRun) return null;

  // No data = no risk
  if (impact.pageCount === 0 && impact.chunkCount === 0 && impact.fileCount === 0) {
    return null;
  }

  // --confirm-destructive is the explicit "I know what I'm doing" flag
  if (opts.confirmDestructive) return null;

  // --yes alone is NOT sufficient for destructive operations with data.
  // This is the key behavior change: --yes used to be enough, now you
  // need --confirm-destructive when there's actual data at stake.
  if (opts.yes && impact.pageCount === 0) return null;

  return (
    `\n${impact.summary}\n\n` +
    `To proceed, pass --confirm-destructive (or use soft-delete: gbrain sources archive ${impact.sourceId}).\n` +
    `To preview without side effects: --dry-run`
  );
}

// ── Soft Delete ─────────────────────────────────────────────

/**
 * Soft-delete a source: mark `archived = true` with a 72h TTL. Pages remain
 * in DB; the source is hidden from search via `buildVisibilityClause` and
 * federation is disabled via the existing `config.federated` JSONB key. After
 * TTL expires, the autopilot purge phase or manual `gbrain sources purge`
 * permanently removes the row (cascade delete to pages + chunks).
 *
 * v0.26.5: archive state moved from `config` JSONB keys to real columns
 * (`archived`, `archived_at`, `archive_expires_at`). Migration v34 backfills
 * pre-v0.26.5 rows. Faster filter, no reserved-key footgun. The `federated`
 * key stays in JSONB because federation has its own toggle path.
 */
export async function softDeleteSource(
  engine: BrainEngine,
  sourceId: string,
): Promise<SoftDeletedSource | null> {
  return (await softDeleteSourceGuarded(engine, sourceId)).result;
}

export interface SoftDeleteGuardDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Two-phase archive with provider wait and any expensive guard outside the
 * final transaction. A committed drain blocks new source work, so the final
 * exclusive section needs only exact source/token validation plus the UPDATE.
 */
export async function softDeleteSourceGuarded(
  engine: BrainEngine,
  sourceId: string,
  guard?: (engine: BrainEngine) => Promise<SoftDeleteGuardDecision>,
): Promise<{ result: SoftDeletedSource | null; reason: string }> {
  const drain = await beginSourceArchiveDrain(engine, sourceId);
  if (!drain) return { result: null, reason: 'source_not_active' };

  const expiresClause = `now() + (${SOFT_DELETE_TTL_HOURS} || ' hours')::interval`;
  let final: {
    row: { id: string; name: string; archived_at: string; archive_expires_at: string } | null;
    reason: string;
  };
  try {
    await waitForSourceEmbeddingLeases(engine, drain);
    if (guard) {
      const decision = await guard(engine);
      if (!decision.allowed) {
        await cancelSourceArchiveDrain(engine, drain);
        return { result: null, reason: decision.reason };
      }
    }
    final = await engine.transaction(async (tx) => {
      await tx.executeRaw(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('gbrain:source-lifecycle', 0)
         )`,
      );
      const readiness = await lockSourceDrainForFinalize(tx, drain);
      if (readiness.status === 'already_archived') {
        return { row: null, reason: 'source_not_active' };
      }
      const rows = await tx.executeRaw<{
        id: string;
        name: string;
        archived_at: string;
        archive_expires_at: string;
      }>(
        `UPDATE public.sources
            SET archived = true,
                archived_at = now(),
                archive_expires_at = ${expiresClause},
                embedding_drain_token = NULL,
                config = COALESCE(config, '{}'::jsonb) || '{"federated": false}'::jsonb
          WHERE id = $1
            AND archived IS NOT TRUE
            AND embedding_drain_token = $2
            AND embedding_drain_epoch = $3
        RETURNING id, name, archived_at, archive_expires_at`,
        [sourceId, drain.token, drain.epoch],
      );
      return {
        row: rows[0] ?? null,
        reason: rows.length === 1 ? 'archived' : 'archive_update_failed',
      };
    });
  } catch (caught) {
    // Fail safe: an uncertain provider token or DB failure keeps the source in
    // drain state. A later archive invocation adopts the same token+epoch and
    // resumes; we never reopen provider egress on uncertain state.
    throw caught;
  }
  if (!final.row) {
    await cancelSourceArchiveDrain(engine, drain);
    return { result: null, reason: final.reason };
  }
  const row = final.row;

  const pageRows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM public.pages WHERE source_id = $1`,
    [sourceId],
  );
  const pageCount = pageRows[0]?.n ?? 0;

  return {
    result: {
      id: sourceId,
      name: row.name,
      deletedAt: new Date(row.archived_at),
      expiresAt: new Date(row.archive_expires_at),
      pageCount,
    },
    reason: 'archived',
  };
}

/**
 * Restore a soft-deleted source (un-archive). Returns true iff a row was
 * restored. Idempotent-as-false on "already active" or "not found".
 *
 * v0.26.5: clears the column-based archive state and (by default) flips
 * `config.federated = true` so the source re-enters federated search. The
 * `--no-federate` operator opt-out keeps federation disabled.
 */
export async function restoreSource(
  engine: BrainEngine,
  sourceId: string,
  refederate: boolean = true,
): Promise<boolean> {
  const federatedPatch = refederate ? '{"federated": true}' : '{"federated": false}';
  const rows = await engine.executeRaw<{ id: string }>(
    `UPDATE sources
     SET archived = false,
         archived_at = NULL,
         archive_expires_at = NULL,
         config = COALESCE(config, '{}'::jsonb) || $1::jsonb
     WHERE id = $2 AND archived = true
     RETURNING id`,
    [federatedPatch, sourceId],
  );
  return rows.length > 0;
}

/**
 * List all soft-deleted (archived) sources.
 *
 * v0.26.5: filters via the real `archived` column instead of JSONB
 * containment. Faster, indexable on demand, no JSONB reserved-key collision
 * with future config schemas.
 */
export async function listArchivedSources(
  engine: BrainEngine,
): Promise<SoftDeletedSource[]> {
  const rows = await engine.executeRaw<{
    id: string;
    name: string;
    archived_at: string;
    archive_expires_at: string;
    page_count: number;
  }>(
    `SELECT
        s.id, s.name, s.archived_at, s.archive_expires_at,
        COALESCE((SELECT COUNT(*)::int FROM pages p WHERE p.source_id = s.id), 0) AS page_count
     FROM sources s
     WHERE s.archived = true
     ORDER BY s.archived_at DESC`,
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    deletedAt: new Date(row.archived_at),
    expiresAt: new Date(row.archive_expires_at),
    pageCount: row.page_count,
  }));
}

/**
 * Permanently purge sources whose 72h TTL has expired. Cascades to pages
 * (and content_chunks via existing FKs). Returns the ids of purged sources.
 *
 * v0.26.5: moved from JSONB-driven iteration to a single set-based DELETE
 * with `archived = true AND archive_expires_at <= now()`. Server-side
 * filter; one round-trip; cascade-friendly.
 */
export async function purgeExpiredSources(
  engine: BrainEngine,
): Promise<string[]> {
  // Terminalize archived-source work while the registry row still exists.
  // After deletion, the queue's legacy-identifier compatibility predicate
  // would otherwise make an orphaned job claimable again.
  const expired = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources
      WHERE archived = true
        AND archive_expires_at IS NOT NULL
        AND archive_expires_at <= now()
      ORDER BY id`,
  );
  const expiredIds = expired.map((row) => row.id);
  if (expiredIds.length === 0) return [];
  return purgeArchivedSourceIds(engine, expiredIds, true);
}

/** Permanently remove one archived source after terminalizing queued work. */
export async function purgeArchivedSource(
  engine: BrainEngine,
  sourceId: string,
): Promise<boolean> {
  const state = await engine.executeRaw<{ archived: boolean }>(
    `SELECT archived FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (state[0]?.archived !== true) return false;
  return (await purgeArchivedSourceIds(engine, [sourceId], false)).length === 1;
}

async function purgeArchivedSourceIds(
  engine: BrainEngine,
  sourceIds: readonly string[],
  requireExpired: boolean,
): Promise<string[]> {
  const uniqueSourceIds = [...new Set(sourceIds)];
  if (uniqueSourceIds.length === 0) return [];

  // Purge is not ordinary best-effort queue maintenance. Wait for every
  // matching row lock, cancel running/waiting descendants, and reclassify
  // failed/dead rows so retryJob cannot revive them after the registry row is
  // gone. The normal cleanup path retains SKIP LOCKED and leaves failed/dead
  // receipts intact.
  await new MinionQueue(engine).cancelArchivedSourceJobs(uniqueSourceIds, {
    waitForLocks: true,
    includeRetryableTerminal: true,
  });

  return engine.transaction(async (tx) => {
    await tx.executeRaw(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('gbrain:source-lifecycle', 0)
       )`,
    );
    const locked = await tx.executeRaw<{ id: string }>(
      `SELECT id FROM public.sources
        WHERE id = ANY($1::text[])
          AND archived = true
          ${requireExpired
            ? 'AND archive_expires_at IS NOT NULL AND archive_expires_at <= now()'
            : ''}
        ORDER BY id
        FOR UPDATE`,
      [uniqueSourceIds],
    );
    const lockedIds = locked.map((row) => row.id);
    if (lockedIds.length === 0) return [];

    const remaining = await new MinionQueue(tx).countRevivableArchivedSourceJobs(lockedIds);
    if (remaining > 0) {
      throw new Error(
        `Refusing to purge ${lockedIds.join(', ')}: ${remaining} source job(s) remain runnable or retryable`,
      );
    }

    const rows = await tx.executeRaw<{ id: string }>(
      `DELETE FROM public.sources
        WHERE id = ANY($1::text[])
          AND archived = true
          ${requireExpired
            ? 'AND archive_expires_at IS NOT NULL AND archive_expires_at <= now()'
            : ''}
      RETURNING id`,
      [lockedIds],
    );
    return rows.map((row) => row.id);
  });
}

// ── Display Helpers ─────────────────────────────────────────

/**
 * Format an impact assessment for terminal display.
 */
export function formatImpact(impact: DestructiveImpact): string {
  const lines: string[] = [
    ``,
    `╔══════════════════════════════════════════════════════════╗`,
    `║  DESTRUCTIVE OPERATION — Impact Preview                 ║`,
    `╠══════════════════════════════════════════════════════════╣`,
    `║  Source:     ${impact.sourceName.padEnd(42)}║`,
    `║  Source ID:  ${impact.sourceId.padEnd(42)}║`,
    `║                                                          ║`,
    `║  Pages:      ${String(impact.pageCount.toLocaleString()).padEnd(42)}║`,
    `║  Chunks:     ${String(impact.chunkCount.toLocaleString()).padEnd(42)}║`,
    `║  Embeddings: ${String(impact.embeddingCount.toLocaleString()).padEnd(42)}║`,
    `║  Files:      ${String(impact.fileCount.toLocaleString()).padEnd(42)}║`,
    `╠══════════════════════════════════════════════════════════╣`,
    `║  ${impact.summary.padEnd(56)}║`,
    `╚══════════════════════════════════════════════════════════╝`,
    ``,
  ];
  return lines.join('\n');
}

export function formatSoftDelete(sd: SoftDeletedSource): string {
  const hours = Math.round((sd.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60));
  return [
    ``,
    `Source "${sd.id}" archived (soft-deleted).`,
    `  ${sd.pageCount.toLocaleString()} pages preserved for ${SOFT_DELETE_TTL_HOURS}h.`,
    `  Expires: ${sd.expiresAt.toISOString()} (~${hours}h from now)`,
    `  Removed from search. Data intact.`,
    ``,
    `  Restore:  gbrain sources restore ${sd.id}`,
    `  Purge now: gbrain sources purge ${sd.id} --confirm-destructive`,
    ``,
  ].join('\n');
}
