import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { loadRecommendationContext } from '../src/core/remediation/context.ts';
import { _setGitHeadProbeForTests, _setGitCleanProbeForTests } from '../src/core/git-head.ts';
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';
import { withEnv } from './helpers/with-env.ts';

function makeEngine(
  sourceRow: Record<string, unknown>,
  staleExtractionPages = 0,
  opts: {
    sourceRows?: Array<{ id: string; local_path: string | null }>;
    atomBacklogs?: Record<string, number>;
    config?: Record<string, string | null>;
  } = {},
): any {
  const sourceRows = opts.sourceRows ?? [{
    id: String(sourceRow.id ?? 'default'),
    local_path: typeof sourceRow.local_path === 'string' ? sourceRow.local_path : null,
  }];
  return {
    getConfig: async (key: string) => {
      if (key in (opts.config ?? {})) return opts.config![key] ?? null;
      return key === 'sync.repo_path' ? '/brain' : null;
    },
    executeRaw: async (sql: string, params: unknown[]) => {
      if (sql.includes('count(*)::int AS count FROM pages')) {
        return [{ count: 120 }];
      }
      if (sql.includes('COUNT(*) AS cnt FROM pages p')) {
        const sourceId = typeof params[0] === 'string' ? params[0] : undefined;
        return [{ cnt: sourceId ? (opts.atomBacklogs?.[sourceId] ?? 0) : 0 }];
      }
      if (sql.includes('FROM sources') && sql.includes('ORDER BY id') && !sql.includes('WHERE local_path')) {
        return sourceRows;
      }
      return [sourceRow];
    },
    countStalePagesForExtraction: async () => staleExtractionPages,
  };
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

const LOCAL_CONTEXT_OPTS = {
  inspectLocalSourcePaths: true,
  sourceHygienePacket: {
    schema_version: 1 as const,
    filesystem_inspected: true,
    sources: [],
  },
};

function hygieneSource(
  sourceId: string,
  classification: 'healthy' | 'archive_candidate',
) {
  const archiveCandidate = classification === 'archive_candidate';
  return {
    source_id: sourceId,
    archived: false,
    draining: false,
    has_local_path: true,
    shared_path_source_count: 1,
    repo_state: archiveCandidate ? 'missing' as const : 'healthy' as const,
    remote_recovery_configured: false,
    managed_clone: false,
    configured_default: false,
    configured_default_known: true,
    source_config_known: true,
    dependent_row_count: 0,
    dependent_data_known: true,
    nonterminal_work_count: 0,
    work_state_known: true,
    live_sync_lock: false,
    lock_state_known: true,
    classification,
    recovery_mode: archiveCandidate ? 'archive_review' as const : 'none' as const,
    proposed_command_argv: archiveCandidate
      ? ['gbrain', 'sources', 'archive', sourceId, '--if-hygiene-candidate']
      : null,
    veto_reasons: [],
    safe_for_agent_review: true,
  };
}

describe('loadRecommendationContext sync freshness', () => {
  beforeEach(() => {
    _setGitHeadProbeForTests(() => 'new-head');
    _setGitCleanProbeForTests(() => true);
  });

  afterAll(() => {
    _setGitHeadProbeForTests(null);
    _setGitCleanProbeForTests(null);
  });

  test('recent commit mismatch does not force filesystem sync before stale DB extraction', async () => {
    const ctx = await loadRecommendationContext(makeEngine({
      id: 'gbrain',
      local_path: '/brain',
      last_commit: 'old-head',
      chunker_version: CHUNKER_VERSION,
      last_sync_at: hoursAgo(1),
    }, 10), LOCAL_CONTEXT_OPTS);

    expect(ctx.repoNeedsSync).toBe(false);
    expect(ctx.staleExtractionPages).toBe(10);
    expect(ctx.staleExtractionTotalPages).toBe(120);
    expect(ctx.extractionLagWarnPct).toBe(20);
  });

  test('old commit mismatch still recommends sync', async () => {
    const ctx = await loadRecommendationContext(makeEngine({
      id: 'gbrain',
      local_path: '/brain',
      last_commit: 'old-head',
      chunker_version: CHUNKER_VERSION,
      last_sync_at: hoursAgo(30),
    }), LOCAL_CONTEXT_OPTS);

    expect(ctx.repoNeedsSync).toBe(true);
  });

  test('matched archive candidate suppresses sync pending archive review', async () => {
    const ctx = await loadRecommendationContext(makeEngine({
      id: 'gbrain',
      local_path: '/brain',
      last_commit: 'old-head',
      chunker_version: CHUNKER_VERSION,
      last_sync_at: hoursAgo(30),
    }), {
      ...LOCAL_CONTEXT_OPTS,
      sourceHygienePacket: {
        schema_version: 1,
        filesystem_inspected: true,
        sources: [hygieneSource('gbrain', 'archive_candidate')],
      },
    });

    expect(ctx.repoNeedsSync).toBe(false);
  });

  test('unrelated archive candidate does not suppress a healthy selected source', async () => {
    const ctx = await loadRecommendationContext(makeEngine({
      id: 'gbrain',
      local_path: '/brain',
      last_commit: 'old-head',
      chunker_version: CHUNKER_VERSION,
      last_sync_at: hoursAgo(30),
    }), {
      ...LOCAL_CONTEXT_OPTS,
      sourceHygienePacket: {
        schema_version: 1,
        filesystem_inspected: true,
        sources: [
          hygieneSource('gbrain', 'healthy'),
          hygieneSource('empty-source', 'archive_candidate'),
        ],
      },
    });

    expect(ctx.repoNeedsSync).toBe(true);
  });

  test('chunker drift still recommends sync even when the source synced recently', async () => {
    _setGitHeadProbeForTests(() => 'same-head');
    const ctx = await loadRecommendationContext(makeEngine({
      id: 'gbrain',
      local_path: '/brain',
      last_commit: 'same-head',
      chunker_version: 'old-chunker',
      last_sync_at: hoursAgo(1),
    }), LOCAL_CONTEXT_OPTS);

    expect(ctx.repoNeedsSync).toBe(true);
  });

  test('future last_sync_at fails closed when git has moved', async () => {
    const ctx = await loadRecommendationContext(makeEngine({
      id: 'gbrain',
      local_path: '/brain',
      last_commit: 'old-head',
      chunker_version: CHUNKER_VERSION,
      last_sync_at: new Date(Date.now() + 60 * 60 * 1000),
    }), LOCAL_CONTEXT_OPTS);

    expect(ctx.repoNeedsSync).toBe(true);
  });

  test('honors configured sync freshness warning threshold', async () => {
    const ctx = await withEnv({ GBRAIN_SYNC_FRESHNESS_WARN_HOURS: '1' }, () =>
      loadRecommendationContext(makeEngine({
        id: 'gbrain',
        local_path: '/brain',
        last_commit: 'old-head',
        chunker_version: CHUNKER_VERSION,
        last_sync_at: hoursAgo(2),
      }), LOCAL_CONTEXT_OPTS),
    );

    expect(ctx.repoNeedsSync).toBe(true);
  });

  test('loads per-source extract_atoms backlog when active pack does not declare the phase', async () => {
    const ctx = await loadRecommendationContext(makeEngine({
      id: 'gbrain',
      local_path: '/brain',
      last_commit: 'new-head',
      chunker_version: CHUNKER_VERSION,
      last_sync_at: hoursAgo(1),
    }, 0, {
      sourceRows: [
        { id: 'default', local_path: '/brain' },
        { id: 'gbrain', local_path: '/Users/sawbeck/gbrain' },
        { id: 'empty', local_path: '/tmp/empty' },
      ],
      atomBacklogs: { default: 44, gbrain: 8, empty: 0 },
      config: { 'autopilot.auto_drain.window_seconds': '90' },
    }), LOCAL_CONTEXT_OPTS);

    expect(ctx.extractAtomsPackDeclaresPhase).toBe(false);
    expect(ctx.extractAtomsDrainWindowSeconds).toBe(90);
    expect(ctx.extractAtomsBacklogBySource).toEqual([
      { sourceId: 'default', backlog: 44, repoPath: '/brain' },
      { sourceId: 'gbrain', backlog: 8, repoPath: '/Users/sawbeck/gbrain' },
    ]);
  });

  test('remote/default planner context never probes a database-supplied path', async () => {
    _setGitHeadProbeForTests(() => { throw new Error('filesystem probe forbidden'); });
    _setGitCleanProbeForTests(() => { throw new Error('filesystem probe forbidden'); });

    const ctx = await loadRecommendationContext(makeEngine({
      id: 'gbrain',
      local_path: '/private/database-supplied-path',
      last_commit: 'old-head',
      chunker_version: CHUNKER_VERSION,
      last_sync_at: hoursAgo(1),
    }));

    expect(ctx.sourceHygiene).toBeUndefined();
    expect(ctx.repoNeedsSync).toBe(false);
  });
});
