import type {
  BrainEngine,
  PurgeDeletedPageCandidate,
  PurgeDeletedPagesResult,
} from './engine.ts';
import { assertManagedPageMutationAllowed } from './canonical-page-write.ts';

interface PurgeCandidateRow extends PurgeDeletedPageCandidate {
  id: number;
}

interface DeletedPageRow {
  id: number;
}

export const PURGE_LIVE_CANDIDATE_LIMIT = 1_000;
export const PURGE_LIFECYCLE_FALLBACK_ATTEMPTS = 64;
export const PURGE_DRY_RUN_CANDIDATE_LIMIT = 10_000;

const CANDIDATE_PREDICATE_SQL = `
  candidate.deleted_at IS NOT NULL
  AND candidate.deleted_at < now() - ($1 || ' hours')::interval
  AND NOT EXISTS (
    SELECT 1
      FROM sources AS owner
     WHERE owner.id = candidate.source_id
       AND owner.embedding_drain_token IS NOT NULL
  )
`;

const SELECT_DRY_RUN_CANDIDATES_SQL = `
  SELECT candidate.id, candidate.slug, candidate.source_id, candidate.deleted_at
    FROM pages AS candidate
   WHERE ${CANDIDATE_PREDICATE_SQL}
   ORDER BY candidate.source_id, candidate.slug, candidate.id
   LIMIT $2
`;

/*
 * Migration 137's current cascade blockers. Keeping these out of the live
 * batch avoids turning expected lifecycle state into thousands of savepoint
 * probes. The bounded savepoint fallback below remains the race/future-schema
 * fence; row triggers are still authoritative.
 */
const SELECT_LIVE_CANDIDATES_SQL = `
  SELECT candidate.id, candidate.slug, candidate.source_id, candidate.deleted_at
    FROM pages AS candidate
   WHERE ${CANDIDATE_PREDICATE_SQL}
     AND NOT EXISTS (
       SELECT 1
         FROM files AS file
         JOIN sources AS file_source ON file_source.id = file.source_id
        WHERE file.page_id = candidate.id
          AND (file_source.archived OR file_source.embedding_drain_token IS NOT NULL)
     )
     AND NOT EXISTS (
       SELECT 1
         FROM links AS link
         JOIN pages AS referenced_page
           ON referenced_page.id IN (link.from_page_id, link.to_page_id, link.origin_page_id)
         JOIN sources AS referenced_source ON referenced_source.id = referenced_page.source_id
        WHERE candidate.id IN (link.from_page_id, link.to_page_id)
          AND referenced_source.embedding_drain_token IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM links AS link
         JOIN pages AS referenced_page
           ON referenced_page.id IN (link.from_page_id, link.to_page_id)
         JOIN sources AS referenced_source ON referenced_source.id = referenced_page.source_id
        WHERE link.origin_page_id = candidate.id
          AND candidate.id NOT IN (link.from_page_id, link.to_page_id)
          AND (referenced_source.archived OR referenced_source.embedding_drain_token IS NOT NULL)
     )
     AND NOT EXISTS (
       SELECT 1
         FROM content_chunks AS chunk
         JOIN code_edges_chunk AS edge ON edge.from_chunk_id = chunk.id
         JOIN sources AS edge_source ON edge_source.id = edge.source_id
        WHERE chunk.page_id = candidate.id
          AND edge_source.embedding_drain_token IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM content_chunks AS chunk
         JOIN code_edges_chunk AS edge ON edge.to_chunk_id = chunk.id
         JOIN sources AS edge_source ON edge_source.id = edge.source_id
        WHERE chunk.page_id = candidate.id
          AND edge_source.embedding_drain_token IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM content_chunks AS chunk
         JOIN code_edges_symbol AS edge ON edge.from_chunk_id = chunk.id
         JOIN sources AS edge_source ON edge_source.id = edge.source_id
        WHERE chunk.page_id = candidate.id
          AND edge_source.embedding_drain_token IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM synthesis_evidence AS evidence
         JOIN pages AS synthesis_page ON synthesis_page.id = evidence.synthesis_page_id
         JOIN sources AS synthesis_source ON synthesis_source.id = synthesis_page.source_id
        WHERE evidence.take_page_id = candidate.id
          AND synthesis_source.embedding_drain_token IS NOT NULL
     )
   ORDER BY candidate.source_id, candidate.slug, candidate.id
   LIMIT $2
`;

const DELETE_CANDIDATE_BATCH_SQL = `
  DELETE FROM pages AS candidate
   WHERE candidate.id = ANY($1::int[])
     AND candidate.deleted_at IS NOT NULL
     AND candidate.deleted_at < now() - ($2 || ' hours')::interval
     AND NOT EXISTS (
       SELECT 1
         FROM sources AS owner
        WHERE owner.id = candidate.source_id
          AND owner.embedding_drain_token IS NOT NULL
     )
  RETURNING candidate.id
`;

/** Match only GBrain source-lifecycle guards, never a generic FK failure. */
export function isSourceLifecyclePurgeConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const raw = error as { code?: unknown; sqlState?: unknown; message?: unknown };
  const code = typeof raw.code === 'string'
    ? raw.code
    : typeof raw.sqlState === 'string'
      ? raw.sqlState
      : '';
  if (code !== '23503') return false;
  const message = typeof raw.message === 'string' ? raw.message : '';
  return /^(?:error:\s*)?Cannot delete from [\w."-]+: (?:page )?source .+ is draining\s*$/i
    .test(message)
    || /^(?:error:\s*)?Cannot write [\w."-]+: (?:page )?source .+ is archived or draining\s*$/i
      .test(message);
}

function mapCandidate(row: PurgeCandidateRow): PurgeCandidateRow {
  return {
    id: Number(row.id),
    slug: String(row.slug),
    source_id: String(row.source_id),
    deleted_at: row.deleted_at instanceof Date
      ? row.deleted_at
      : new Date(String(row.deleted_at)),
  };
}

async function selectLiveCandidates(
  engine: BrainEngine,
  hours: number,
): Promise<PurgeCandidateRow[]> {
  const rows = await engine.executeRaw<PurgeCandidateRow>(
    SELECT_LIVE_CANDIDATES_SQL,
    [hours, PURGE_LIVE_CANDIDATE_LIMIT],
  );
  return rows.map(mapCandidate).slice(0, PURGE_LIVE_CANDIDATE_LIMIT);
}

async function deleteCandidateBatch(
  engine: BrainEngine,
  candidates: PurgeCandidateRow[],
  hours: number,
  savepointCounter: { value: number },
  attemptsRemaining: { value: number },
): Promise<number[]> {
  if (candidates.length === 0) return [];
  if (attemptsRemaining.value <= 0) return [];
  attemptsRemaining.value -= 1;
  const savepoint = `purge_deleted_${savepointCounter.value++}`;
  try {
    return await engine.savepoint(savepoint, async (savepointEngine) => {
      const rows = await savepointEngine.executeRaw<DeletedPageRow>(
        DELETE_CANDIDATE_BATCH_SQL,
        [candidates.map((candidate) => candidate.id), hours],
      );
      return rows.map((row) => Number(row.id));
    });
  } catch (error) {
    if (!isSourceLifecyclePurgeConflict(error)) throw error;
    if (candidates.length === 1) return [];
    const midpoint = Math.floor(candidates.length / 2);
    const left = await deleteCandidateBatch(
      engine,
      candidates.slice(0, midpoint),
      hours,
      savepointCounter,
      attemptsRemaining,
    );
    const right = await deleteCandidateBatch(
      engine,
      candidates.slice(midpoint),
      hours,
      savepointCounter,
      attemptsRemaining,
    );
    return [...left, ...right];
  }
}

/**
 * Purge aged tombstones without letting one lifecycle-protected cascade roll
 * back unrelated pages. Known blockers are prefiltered. A guarded race rolls
 * back to an engine-owned savepoint and splits under a hard attempt ceiling;
 * unattempted or blocked rows remain. New guarded cascade paths must extend the
 * prefilter before they can make forward-progress guarantees.
 * Dry-run is a point-in-time candidate preview, not a reservation or a promise
 * that every cascade can execute in one bounded sweep.
 */
export async function purgeDeletedPagesSafely(
  engine: BrainEngine,
  olderThanHours: number,
  opts?: { dryRun?: boolean },
): Promise<PurgeDeletedPagesResult> {
  const hours = Math.max(0, Math.floor(olderThanHours));
  if (opts?.dryRun) {
    const previewRows = await engine.executeRaw<PurgeCandidateRow>(
      SELECT_DRY_RUN_CANDIDATES_SQL,
      [hours, PURGE_DRY_RUN_CANDIDATE_LIMIT + 1],
    );
    const truncated = previewRows.length > PURGE_DRY_RUN_CANDIDATE_LIMIT;
    const candidates = previewRows
      .slice(0, PURGE_DRY_RUN_CANDIDATE_LIMIT)
      .map(mapCandidate);
    return {
      slugs: candidates.map((candidate) => candidate.slug),
      count: candidates.length,
      candidates: candidates.map(({ slug, source_id, deleted_at }) => ({
        slug,
        source_id,
        deleted_at,
      })),
      truncated,
      candidate_limit: PURGE_DRY_RUN_CANDIDATE_LIMIT,
    };
  }

  return engine.transaction(async (transaction) => {
    const candidates = await selectLiveCandidates(transaction, hours);
    for (const candidate of candidates) {
      await assertManagedPageMutationAllowed(
        transaction,
        candidate.slug,
        candidate.source_id,
        'destructive_admin',
      );
    }
    const deletedIds = new Set(await deleteCandidateBatch(
      transaction,
      candidates,
      hours,
      { value: 1 },
      { value: PURGE_LIFECYCLE_FALLBACK_ATTEMPTS },
    ));
    const slugs = candidates
      .filter((candidate) => deletedIds.has(candidate.id))
      .map((candidate) => candidate.slug);
    return { slugs, count: slugs.length };
  });
}
