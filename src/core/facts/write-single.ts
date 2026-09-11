/**
 * MEMORY_VERBS v1 — `writeSingleFact`: the zero-LLM single-fact write seam
 * behind the `remember` verb [E1].
 *
 * `runFactsPipeline` is extraction-first (LLM-gated in extract.ts) and cannot
 * back a verb whose fact arrives pre-formed. This module reuses the pipeline's
 * post-extraction stages directly: resolve → dedup (embedding cosine, same
 * 0.95 threshold) → fence-first write (markdown durability) with the same
 * legacy DB-only fallbacks (thin-client, unparented, stub-guard).
 *
 * Supersession [X1, frozen as implementation-defined]: minimal deterministic
 * rule, zero LLM — when the top dedup candidate scores >= threshold with the
 * SAME kind but DIFFERENT text, the new fact supersedes it (a near-duplicate
 * with changed content is an update: "X at Acme" → "X left Acme"). Same text
 * → plain duplicate (existing id returned, nothing written).
 *
 * Degradation (documented in the protocol doc): with no embedding provider,
 * dedup/supersession are skipped on the fence path and near-duplicates may
 * insert — `degraded_dedup: true` tells the caller.
 *
 * Provenance (c6): callers pass free-text provenance which lands on
 * `NewFact.source` verbatim — this seam deliberately does NOT take a
 * FactsBackstopCtx (whose `source` union is pipeline-internal).
 */

import type { BrainEngine, FactInsertStatus, NewFact } from '../engine.ts';
import type { ResolutionSource } from '../entities/resolve.ts';

const DEDUP_THRESHOLD = 0.95;
const DEDUP_CANDIDATE_LIMIT = 5;

/**
 * #4755: null-like entity tokens LLM extractors emit for subjectless
 * statements. A caller passing the STRING "null" means what JSON `null`
 * means — no entity. Without this filter the token sails past the
 * non-empty check, fails resolution, falls back to itself as the slug,
 * and the facts land unreachable under entity_slug='null' (the stub
 * guard rightly refuses to create the page, so no page renders them and
 * no entity lookup can reach them).
 */
const NULL_LIKE_ENTITY_TOKENS: ReadonlySet<string> = new Set([
  'null', 'undefined', 'none', 'n/a', 'nil', '-',
]);

/** True when an entity ref is absent or a null-like placeholder token. */
export function isNullLikeEntity(entity: string | null | undefined): boolean {
  if (entity == null) return true;
  const t = entity.trim().toLowerCase();
  return t === '' || NULL_LIKE_ENTITY_TOKENS.has(t);
}

export interface SingleFactInput {
  fact: string;
  /** Free-text attribution, stored verbatim as the fact's `source`. */
  provenance: string;
  kind?: NewFact['kind'];
  /** Free-form entity ref; canonicalized via resolveEntitySlugWithSource. */
  entity?: string | null;
  /** Facts-layer default 'private'; the remember VERB passes 'world' [F2]. */
  visibility?: 'private' | 'world';
  validUntil?: Date | null;
  sessionId?: string | null;
  confidence?: number;
}

export interface SingleFactResult {
  id: number;
  status: FactInsertStatus;
  entity_slug: string | null;
  valid_until: Date | null;
  /** True when no embedding provider — dedup/supersession skipped. */
  degraded_dedup: boolean;
}

export async function writeSingleFact(
  engine: BrainEngine,
  sourceId: string,
  input: SingleFactInput,
): Promise<SingleFactResult> {
  const { resolveEntitySlugWithSource } = await import('../entities/resolve.ts');
  const { isAvailable, embedOne } = await import('../ai/gateway.ts');
  const { withPageLock } = await import('../page-lock.ts');

  const factText = input.fact.trim();
  const kind = input.kind ?? 'fact';
  const visibility = input.visibility ?? 'private';
  const validUntil = input.validUntil ?? null;
  const { isFactWithdrawn } = await import('./withdrawal.ts');
  if (await isFactWithdrawn(engine, sourceId, visibility, factText)) {
    const { verbError } = await import('../ops/contract.ts');
    throw verbError('invalid_params', 'fact_withdrawn: this exact claim was explicitly forgotten in this source and visibility.',
      'Remember a corrected claim. Repeating the old claim does not restore withdrawn memory.');
  }

  // Resolve before taking the write lock so aliases converge on one entity
  // bucket without holding a cross-process lock across provider work.
  const entityRef = isNullLikeEntity(input.entity) ? null : input.entity!.trim();
  const resolved = entityRef
    ? await resolveEntitySlugWithSource(engine, sourceId, entityRef)
    : null;
  const resolvedSlug = entityRef ? (resolved?.slug ?? entityRef) : null;
  const resolutionSource = resolved?.source ?? null;

  // Embedding is slow provider work. Keep it outside the critical section;
  // the locked dedup query below re-reads current rows before any write.
  let embedding: Float32Array | null = null;
  let degradedDedup = false;
  if (isAvailable('embedding')) {
    try {
      embedding = await embedOne(factText);
    } catch {
      degradedDedup = true;
    }
  } else {
    degradedDedup = true;
  }

  // Serialize only facts that can participate in the same dedup/supersession
  // decision. Different entities and visibility tiers remain independent.
  const lockBucket = JSON.stringify([sourceId, visibility, resolvedSlug]);
  return withPageLock(`fact-write:${lockBucket}`, () => writeSingleFactLocked(
    engine,
    sourceId,
    input,
    { factText, kind, visibility, validUntil, resolvedSlug, resolutionSource, embedding, degradedDedup },
  ));
}

async function writeSingleFactLocked(
  engine: BrainEngine,
  sourceId: string,
  input: SingleFactInput,
  prepared: {
    factText: string;
    kind: NonNullable<NewFact['kind']>;
    visibility: 'private' | 'world';
    validUntil: Date | null;
    resolvedSlug: string | null;
    resolutionSource: ResolutionSource | null;
    embedding: Float32Array | null;
    degradedDedup: boolean;
  },
): Promise<SingleFactResult> {
  const { cosineSimilarity } = await import('./classify.ts');
  const { writeFactsToFence, lookupSourceLocalPath } = await import('./fence-write.ts');
  const {
    factText, kind, visibility, validUntil, resolvedSlug, resolutionSource,
    embedding, degradedDedup,
  } = prepared;

  // A replay must see historical rows too. Similarity candidates contain only
  // current beliefs; otherwise replaying a corrected claim corrects it BACK.
  const recorded = await findRecordedFact(engine, sourceId, {
    fact: factText, entity: resolvedSlug, kind, provenance: input.provenance,
    sessionId: input.sessionId, visibility,
  });
  if (recorded) return {
    id: recorded.id, status: 'duplicate', entity_slug: resolvedSlug,
    valid_until: recorded.valid_until, degraded_dedup: false,
  };

  // Dedup + supersession decision (same candidates + threshold as the pipeline).
  let supersedeId: number | null = null;
  if (resolvedSlug && embedding) {
    const candidates = await engine.findCandidateDuplicates(sourceId, resolvedSlug, factText, {
      embedding,
      k: DEDUP_CANDIDATE_LIMIT,
      visibility,
    });
    let top: (typeof candidates)[number] | null = null;
    let topScore = -1;
    for (const c of candidates) {
      if (!c.embedding) continue;
      const s = cosineSimilarity(embedding, c.embedding);
      if (s > topScore) {
        topScore = s;
        top = c;
      }
    }
    if (top && topScore >= DEDUP_THRESHOLD) {
      const textDiffers = collapse(top.fact) !== collapse(factText);
      if (top.kind === kind && textDiffers) {
        supersedeId = top.id; // X1: near-duplicate with changed content = update
      } else {
        return {
          id: top.id,
          status: 'duplicate',
          entity_slug: resolvedSlug,
          valid_until: top.valid_until ?? null,
          degraded_dedup: false,
        };
      }
    }
  }

  const newFact: NewFact = {
    fact: factText,
    kind,
    entity_slug: resolvedSlug,
    visibility,
    source: input.provenance,
    source_session: input.sessionId ?? null,
    confidence: input.confidence ?? 1.0,
    valid_until: validUntil,
    embedding,
  };

  // Fence-first write (markdown durability — same policy as the pipeline):
  // requires a resolved, prefixed entity slug and a local_path. Everything
  // else takes the legacy DB-only insertFact path, which also handles the
  // supersedeId bookkeeping engine-side.
  const localPath = resolvedSlug ? await lookupSourceLocalPath(engine, sourceId) : null;
  const fenceable = resolvedSlug !== null && localPath !== null;

  if (fenceable) {
    const result = await writeFactsToFence(
      engine,
      { sourceId, localPath, slug: resolvedSlug, resolutionSource },
      [
        {
          fact: factText,
          kind,
          notability: 'medium',
          source: input.provenance,
          context: null,
          visibility,
          confidence: input.confidence ?? 1.0,
          validFrom: new Date(),
          validUntil,
          embedding,
          sessionId: input.sessionId ?? null,
        },
      ],
    );

    if (result.fenceWriteFailed) {
      // Parse-validate rejected the .tmp (quarantined). Hard failure — do NOT
      // fall through to a DB row whose fence is broken (pipeline policy).
      throw new Error(
        `facts fence write failed for ${resolvedSlug} — .tmp quarantined; see the facts write-failure JSONL log`,
      );
    }
    if (!result.stubGuardBlocked && !result.legacyFallback && !result.targetUnresolvable) {
      const newId = result.ids[0];
      if (supersedeId !== null && newId !== undefined) {
        await expireSuperseded(engine, supersedeId, newId);
        return {
          id: newId,
          status: 'superseded',
          entity_slug: resolvedSlug,
          valid_until: validUntil,
          degraded_dedup: degradedDedup,
        };
      }
      return {
        id: newId,
        status: 'inserted',
        entity_slug: resolvedSlug,
        valid_until: validUntil,
        degraded_dedup: degradedDedup,
      };
    }
    // stubGuardBlocked / legacyFallback (sync.write_through off, or the
    // defensive null-localPath echo) / targetUnresolvable (#4204: source
    // tree unusable) → DB-only path below.
  }

  const inserted = await engine.insertFact(newFact, { // gbrain-allow-direct-insert: writeSingleFact legacy path for unparented / thin-client / stub-guarded facts (mirrors the pipeline's fallback buckets)
    source_id: sourceId,
    ...(supersedeId !== null ? { supersedeId } : {}),
  });

  return {
    id: inserted.id,
    status: supersedeId !== null ? 'superseded' : inserted.status,
    entity_slug: resolvedSlug,
    valid_until: validUntil,
    degraded_dedup: degradedDedup,
  };
}

/**
 * Fence-path supersession bookkeeping: expire the old row through the fence
 * (strikethrough + valid_until, the same surface `forget` uses) and link
 * `superseded_by` for the audit trail. Both steps best-effort — the new fact
 * is already durably written; a partial supersede is an audit gap, not data
 * loss.
 */
async function expireSuperseded(engine: BrainEngine, oldId: number, newId: number): Promise<void> {
  try {
    const { forgetFactInFence } = await import('./forget.ts');
    await forgetFactInFence(engine, oldId, { reason: `superseded by fact #${newId}` });
  } catch {
    /* best-effort */
  }
  try {
    await engine.executeRaw(`UPDATE facts SET superseded_by = $1 WHERE id = $2`, [newId, oldId]);
  } catch {
    /* best-effort */
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Active exact claims deduplicate across capture lanes. Historical replay
 * identity includes provenance, session, and visibility so a new statement
 * can revisit an old belief without a private row suppressing a world write.
 * Extraction can match all historical rows: an import cannot establish a
 * fresh user reversal. Source/entity stay confined. */
export async function findRecordedFact(
  engine: BrainEngine,
  sourceId: string,
  input: { fact: string; entity: string | null; kind: string; provenance: string; visibility: 'private' | 'world'; sessionId?: string | null; matchAnyHistorical?: boolean },
): Promise<{ id: number; valid_until: Date | null } | null> {
  const rows = await engine.executeRaw<{ id: number; valid_until: Date | string | null }>(
    `SELECT id, valid_until FROM facts
     WHERE source_id = $1 AND entity_slug IS NOT DISTINCT FROM $2::text
       AND kind = $3 AND lower(regexp_replace(btrim(fact), '[[:space:]]+', ' ', 'g')) = $4
       AND visibility = $8
       AND ((expired_at IS NULL AND (valid_until IS NULL OR valid_until > NOW()))
         OR $7::boolean
         OR (source = $5 AND source_session IS NOT DISTINCT FROM $6::text
           AND ($6::text IS NOT NULL OR superseded_by IS NOT NULL)))
     ORDER BY
       CASE WHEN expired_at IS NULL AND (valid_until IS NULL OR valid_until > NOW()) THEN 0 ELSE 1 END,
       id DESC
     LIMIT 1`,
    [sourceId, input.entity, input.kind, collapse(input.fact), input.provenance, input.sessionId ?? null, input.matchAnyHistorical ?? false, input.visibility],
  );
  const row = rows[0];
  return row ? { id: Number(row.id), valid_until: row.valid_until ? new Date(row.valid_until) : null } : null;
}
