import { describe, expect, test } from 'bun:test';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectSeascapeWritebacks } from '../src/core/advisor/collect-seascape-writebacks.ts';
import { runAdvisor } from '../src/core/advisor/run.ts';
import type { AdvisorCollector, AdvisorContext } from '../src/core/advisor/types.ts';
import type { Page } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

function page(overrides: Partial<Page> = {}): Page {
  return {
    id: 1,
    slug: 'wiki/originals/ideas/seascape-strategy-dream',
    type: 'original',
    title: 'Seascape strategy dream',
    compiled_truth: `# Seascape strategy dream

Session: 019example
Date: 2026-06-28
Repo: seascape-hub

## What Happened

Proof: owner readback completed.
Decision: promote the strategy update after human review.
Seascape Hub strategy canon update.
`,
    timeline: '',
    frontmatter: {
      dream_generated: true,
      session_id: '019example',
      started_at: '2026-06-28T10:00:00Z',
    },
    created_at: new Date('2026-06-28T10:00:00Z'),
    updated_at: new Date('2026-06-28T10:00:00Z'),
    source_id: 'default',
    ...overrides,
  };
}

function ctx(overrides: Partial<AdvisorContext> = {}): AdvisorContext {
  return {
    engine: ({
      executeRaw: async <T>() => {
        return [
          {
            id: 'seascape-hub-src',
            name: 'gstack-code-hub-ae4800f6-9c4839',
            local_path: '/Users/sawbeck/Projects/seascape-hub',
            last_commit: null,
            last_sync_at: new Date('2026-06-28T12:00:00Z'),
            config: '{"federated":true}',
            created_at: new Date('2026-06-01T00:00:00Z'),
          },
          {
            id: 'sawyer-hub',
            name: 'sawyer-hub',
            local_path: '/Users/sawbeck/Projects/sawyer-hub',
            last_commit: null,
            last_sync_at: new Date('2026-06-28T12:00:00Z'),
            config: '{"federated":true}',
            created_at: new Date('2026-06-01T00:00:00Z'),
          },
        ] as unknown as T[];
      },
      listPages: async () => [page()],
      getConfig: async () => null,
      getStats: async () => ({ page_count: 0, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
      getHealth: async () => ({
        page_count: 0, embed_coverage: 1, stale_pages: 0, orphan_pages: 0, missing_embeddings: 0,
        brain_score: 100, dead_links: 0, link_coverage: 1, timeline_coverage: 1, most_connected: [],
        embed_coverage_score: 1, link_density_score: 1, timeline_coverage_score: 1, no_orphans_score: 1, no_dead_links_score: 1,
      }),
    }) as unknown as AdvisorContext['engine'],
    config: {} as AdvisorContext['config'],
    version: '0.43.0.0',
    workspace: null,
    skillsDir: null,
    now: new Date('2026-06-28T12:00:00Z'),
    remote: false,
    ...overrides,
  };
}

describe('collectSeascapeWritebacks', () => {
  test('returns a candidate finding with owner, proof, and a dry-run draft payload', async () => {
    const gbHome = mkdtempSync(join(tmpdir(), 'gbrain-writeback-collector-'));
    try {
      await withEnv({ GBRAIN_HOME: gbHome }, async () => {
        const findings = await collectSeascapeWritebacks.collect(ctx());
        expect(findings).toHaveLength(1);
        const candidate = findings[0]?.writeback_candidate;
        expect(candidate?.owner).toBe('seascape-hub');
        expect(candidate?.proof.qualified).toBe(true);
        expect(candidate?.draft?.writes).toBe(false);
        expect(candidate?.draft?.review_command_argv).toEqual([
          'gbrain',
          'call',
          '--source',
          'default',
          'get_page',
          JSON.stringify({ slug: 'wiki/originals/ideas/seascape-strategy-dream' }),
        ]);
        expect(candidate?.draft?.body).toContain('## Proposed writeback');
      });
    } finally {
      rmSync(gbHome, { recursive: true, force: true });
    }
  });

  test('returns a true all-clear when the collector succeeds but finds no candidate', async () => {
    const gbHome = mkdtempSync(join(tmpdir(), 'gbrain-writeback-collector-empty-'));
    try {
      await withEnv({ GBRAIN_HOME: gbHome }, async () => {
        const findings = await collectSeascapeWritebacks.collect(ctx({
          engine: ({
            executeRaw: async () => [
              {
                id: 'seascape-hub-src',
                name: 'gstack-code-hub-ae4800f6-9c4839',
                local_path: '/Users/sawbeck/Projects/seascape-hub',
                last_commit: null,
                last_sync_at: new Date('2026-06-28T12:00:00Z'),
                config: '{"federated":true}',
                created_at: new Date('2026-06-01T00:00:00Z'),
              },
            ],
            listPages: async () => [],
            getConfig: async () => null,
            getStats: async () => ({ page_count: 0, chunk_count: 0, embedded_count: 0, link_count: 0, tag_count: 0, timeline_entry_count: 0, pages_by_type: {} }),
            getHealth: async () => ({
              page_count: 0, embed_coverage: 1, stale_pages: 0, orphan_pages: 0, missing_embeddings: 0,
              brain_score: 100, dead_links: 0, link_coverage: 1, timeline_coverage: 1, most_connected: [],
              embed_coverage_score: 1, link_density_score: 1, timeline_coverage_score: 1, no_orphans_score: 1, no_dead_links_score: 1,
            }),
          }) as unknown as AdvisorContext['engine'],
        }));
        expect(findings).toEqual([]);
      });
    } finally {
      rmSync(gbHome, { recursive: true, force: true });
    }
  });
});

describe('runAdvisor collector failures', () => {
  test('surfaces collector failures as visible findings instead of silent all-clear', async () => {
    const failingCollector: AdvisorCollector = {
      id: 'boom',
      collect: async () => {
        throw new Error('collector exploded');
      },
    };
    const report = await runAdvisor(ctx(), { collectors: [failingCollector] });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.id).toBe('collector_failed:boom');
    expect(report.findings[0]?.detail).toContain('collector exploded');
  });
});
