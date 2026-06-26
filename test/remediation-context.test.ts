import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { loadRecommendationContext } from '../src/core/remediation/context.ts';
import { _setGitHeadProbeForTests, _setGitCleanProbeForTests } from '../src/core/git-head.ts';
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';

function makeEngine(sourceRow: Record<string, unknown>, staleExtractionPages = 0): any {
  return {
    getConfig: async (key: string) => key === 'sync.repo_path' ? '/brain' : null,
    executeRaw: async () => [sourceRow],
    countStalePagesForExtraction: async () => staleExtractionPages,
  };
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

describe('loadRecommendationContext sync freshness', () => {
  let oldWarnHours: string | undefined;

  beforeEach(() => {
    oldWarnHours = process.env.GBRAIN_SYNC_FRESHNESS_WARN_HOURS;
    delete process.env.GBRAIN_SYNC_FRESHNESS_WARN_HOURS;
    _setGitHeadProbeForTests(() => 'new-head');
    _setGitCleanProbeForTests(() => true);
  });

  afterEach(() => {
    if (oldWarnHours === undefined) delete process.env.GBRAIN_SYNC_FRESHNESS_WARN_HOURS;
    else process.env.GBRAIN_SYNC_FRESHNESS_WARN_HOURS = oldWarnHours;
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
    }, 10));

    expect(ctx.repoNeedsSync).toBe(false);
    expect(ctx.staleExtractionPages).toBe(10);
  });

  test('old commit mismatch still recommends sync', async () => {
    const ctx = await loadRecommendationContext(makeEngine({
      id: 'gbrain',
      local_path: '/brain',
      last_commit: 'old-head',
      chunker_version: CHUNKER_VERSION,
      last_sync_at: hoursAgo(30),
    }));

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
    }));

    expect(ctx.repoNeedsSync).toBe(true);
  });

  test('future last_sync_at fails closed when git has moved', async () => {
    const ctx = await loadRecommendationContext(makeEngine({
      id: 'gbrain',
      local_path: '/brain',
      last_commit: 'old-head',
      chunker_version: CHUNKER_VERSION,
      last_sync_at: new Date(Date.now() + 60 * 60 * 1000),
    }));

    expect(ctx.repoNeedsSync).toBe(true);
  });

  test('honors configured sync freshness warning threshold', async () => {
    process.env.GBRAIN_SYNC_FRESHNESS_WARN_HOURS = '1';
    const ctx = await loadRecommendationContext(makeEngine({
      id: 'gbrain',
      local_path: '/brain',
      last_commit: 'old-head',
      chunker_version: CHUNKER_VERSION,
      last_sync_at: hoursAgo(2),
    }));

    expect(ctx.repoNeedsSync).toBe(true);
  });
});
