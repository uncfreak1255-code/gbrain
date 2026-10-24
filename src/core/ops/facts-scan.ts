import type { OperationContext } from './contract.ts';
import { OperationError, verbError } from './contract.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam, sourceScopeOpts } from './context.ts';
import { resolveReadEligibility } from '../eligibility/policy.ts';
import { resolveExcludePrivatePages } from '../search/private-visibility.ts';

const SCAN_PARAMS = new Set(['scan', 'since', 'after_id', 'through_id', 'source_id', 'limit', 'include_expired']);
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3}0*)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Parse an ISO datetime, refusing impossible calendar values Date would silently roll over,
 * sub-millisecond digits Date would truncate, year zero (absent in PostgreSQL), and years past
 * 9999, whose expanded ISO form would not round-trip as a continuation cutoff.
 */
function parseScanSince(value: unknown): Date | null {
  const m = typeof value === 'string' ? ISO_DATETIME.exec(value) : null;
  if (!m) return null;
  const [y, mo, d, h, mi, sec, oh = 0, om = 0] = m.slice(1).map(part => part === undefined ? undefined : Number(part)) as number[];
  // Computed directly: Date.UTC maps years 0-99 to 1900-1999.
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (daysInMonth === undefined || d < 1 || d > daysInMonth) return null;
  if (h > 23 || mi > 59 || sec > 59 || oh > 23 || om > 59) return null;
  const parsed = new Date(value as string);
  return y >= 1 && Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() >= 1 && parsed.getUTCFullYear() <= 9999 ? parsed : null;
}

/** Recall's v1 error contract for source failures: helper errors become verb errors. */
export function recallSourceError(error: unknown): unknown {
  if (!(error instanceof OperationError)) return error;
  const code = error.code === 'permission_denied' ? 'scope_denied'
    : error.code === 'unknown_source' ? 'not_found'
      : error.code === 'invalid_params' ? 'invalid_params' : null;
  if (code === null) return error;
  return Object.assign(verbError(code, error.message,
    error.suggestion ?? 'Choose a permitted active source, or omit source_id to use your existing scope.',
    error.detail ?? error.code), error.fix ? { fix: error.fix } : {});
}

/** Optional recall mode: complete bounded fact traversal, never a relevance query. */
export async function recallFactScan(ctx: OperationContext, p: Record<string, unknown>, recallParams: readonly string[]) {
  // Reject only declared recall options that scans cannot honor; undeclared keys
  // stay with the dispatcher's mcp.strict_params policy (warn ignores them).
  if (recallParams.some(key => !SCAN_PARAMS.has(key) && p[key] !== undefined)) {
    throw verbError('invalid_params', 'Fact scans cannot be combined with other recall filters or budgets.',
      'Use only scan, since, source_id, after_id, through_id, limit, and include_expired.');
  }
  const since = parseScanSince(p.since);
  if (!since) {
    throw verbError('invalid_params', 'Fact scans require since as an absolute ISO datetime.',
      'Pass a fixed ISO datetime (millisecond precision at most) with a timezone and preserve it across pages.');
  }
  const cursor = (name: string, fallback?: number): number | undefined => {
    const value = p[name] ?? fallback;
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw verbError('invalid_params', `Fact scan ${name} must be a nonnegative safe-integer fact ID.`,
        'Retain the exact cursor IDs returned by the scan.');
    }
    return value;
  };
  const afterId = cursor('after_id', 0)!;
  const throughId = cursor('through_id');
  const limit = p.limit ?? 100;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw verbError('invalid_params', 'Fact scan limit must be an integer from 1 to 100.', 'Use limit: 100.');
  }
  if ((afterId > 0 && throughId === undefined) || (throughId !== undefined && afterId > throughId)) {
    throw verbError('invalid_params', 'Invalid fact scan cursor: after_id requires and cannot exceed through_id.',
      'Start with after_id: 0, then retain through_id and next_after_id from the first page.');
  }
  let sources: string[];
  try {
    const requested = parseSourceIdParam(p.source_id, 'recall scan');
    const scope = requested === undefined ? sourceScopeOpts(ctx) : federatedSearchScope(ctx, requested);
    sources = [...new Set(scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : []))];
  } catch (error) {
    throw recallSourceError(error);
  }
  if (sources.length !== 1) {
    throw verbError('invalid_params', 'Fact scans require one concrete authorized source.',
      'Pass source_id for the single source to scan; federated and all-source scans are unsupported.');
  }
  let sourceId: string;
  try {
    sourceId = parseSourceIdParam(sources[0], 'recall scan')!;
    await assertExplicitSourceLive(ctx, sourceId);
  } catch (error) {
    throw recallSourceError(error);
  }
  const page = await ctx.engine.scanFacts(sourceId, since, {
    afterId, throughId, limit,
    activeOnly: p.include_expired !== true,
    visibility: ctx.remote === false ? undefined : ['world'],
    excludePrivate: await resolveExcludePrivatePages(ctx.engine, ctx.remote),
    eligibility: await resolveReadEligibility(ctx),
  });
  return {
    protocol_version: 1,
    facts: page.facts.map(({ embedding: _embedding, embedded_at: _embeddedAt, ...fact }) => ({
      ...fact, fact_id: String(fact.id), provenance: fact.source,
    })),
    total: page.facts.length,
    scan: {
      version: 1, source_id: sourceId, since: since.toISOString(), after_id: afterId,
      through_id: page.throughId, next_after_id: page.nextAfterId, has_more: page.hasMore,
    },
  };
}
