import type { OperationContext } from './contract.ts';
import { verbError } from './contract.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam, sourceScopeOpts } from './context.ts';

const SCAN_PARAMS = new Set(['scan', 'since', 'after_id', 'through_id', 'source_id', 'limit', 'include_expired', '_meta', 'dry_run']);
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Optional recall mode: complete bounded fact traversal, never a relevance query. */
export async function recallFactScan(ctx: OperationContext, p: Record<string, unknown>) {
  if (Object.keys(p).some(key => !SCAN_PARAMS.has(key) && p[key] !== undefined)) {
    throw verbError('invalid_params', 'Fact scans cannot be combined with other recall filters or budgets.',
      'Use only scan, since, source_id, after_id, through_id, limit, and include_expired.');
  }
  const since = typeof p.since === 'string' && ISO_DATETIME.test(p.since) ? new Date(p.since) : null;
  if (!since || !Number.isFinite(since.getTime())) {
    throw verbError('invalid_params', 'Fact scans require since as an absolute ISO datetime.',
      'Pass a fixed ISO datetime with a timezone and preserve it across pages.');
  }
  const cursor = (name: string, fallback?: number): number | undefined => {
    const value = p[name] ?? fallback;
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2147483647) {
      throw verbError('invalid_params', `Fact scan ${name} must be a nonnegative int4 fact ID.`,
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
  const requested = parseSourceIdParam(p.source_id, 'recall scan');
  const scope = requested === undefined ? sourceScopeOpts(ctx) : federatedSearchScope(ctx, requested);
  const sources = [...new Set(scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : []))];
  if (sources.length !== 1) {
    throw verbError('invalid_params', 'Fact scans require one concrete authorized source.',
      'Pass source_id for the single source to scan; federated and all-source scans are unsupported.');
  }
  const sourceId = parseSourceIdParam(sources[0], 'recall scan')!;
  await assertExplicitSourceLive(ctx, sourceId);
  const page = await ctx.engine.scanFacts(sourceId, since, {
    afterId, throughId, limit,
    activeOnly: p.include_expired !== true,
    visibility: ctx.remote === false ? undefined : ['world'],
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
