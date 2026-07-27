import { describe, expect, test } from 'bun:test';

import {
  applyWritebackSuppression,
  buildWritebackSuppressionEntry,
  upsertWritebackSuppression,
} from '../src/core/writeback-suppression.ts';
import {
  DEFAULT_WRITEBACK_STALE_DAYS,
  evaluateSeascapeWritebackCandidate,
  type WritebackEvaluation,
} from '../src/core/writeback-candidate.ts';
import type { Page } from '../src/core/types.ts';

function page(overrides: Partial<Page> = {}): Page {
  return {
    id: 1,
    slug: 'wiki/originals/ideas/example',
    type: 'original',
    title: 'Example writeback residue',
    compiled_truth: `# Example writeback residue

Session: 019example
Date: 2026-06-28
Repo: seascape-hub

## What Happened

Proof: owner readback completed.
Decision: promote the strategy update after human review.
`,
    timeline: '',
    frontmatter: {
      session_id: '019example',
      started_at: '2026-06-28T10:00:00Z',
    },
    created_at: new Date('2026-06-28T10:00:00Z'),
    updated_at: new Date('2026-06-28T10:00:00Z'),
    source_id: 'default',
    ...overrides,
  };
}

describe('evaluateSeascapeWritebackCandidate', () => {
  test('admits a proof-qualified Seascape candidate', () => {
    const result = evaluateSeascapeWritebackCandidate(page({
      compiled_truth: page().compiled_truth + '\nSeascape Hub strategy canon update.\n',
    }), { now: new Date('2026-06-29T00:00:00Z') });
    expect(result.verdict).toBe('candidate');
    expect(result.candidate?.owner).toBe('seascape-hub');
    expect(result.candidate?.proof.qualified).toBe(true);
  });

  test('rejects memory-only residue without independent proof', () => {
    const result = evaluateSeascapeWritebackCandidate(page({
      compiled_truth: '# Loose note\n\nSeascape Hub strategy idea without proof.',
      frontmatter: {},
    }));
    expect(result.verdict).toBe('memory_only');
    expect(result.candidate).toBeNull();
  });

  test('fails closed when owner classification is ambiguous', () => {
    const result = evaluateSeascapeWritebackCandidate(page({
      compiled_truth: `# Ambiguous owner

Session: 019example
Proof: readback
Seascape Hub
Sawyer Hub
`,
    }));
    expect(result.verdict).toBe('ambiguous_owner');
    expect(result.candidate).toBeNull();
    expect(result.matched_owners.sort()).toEqual(['sawyer-hub', 'seascape-hub']);
  });

  test('filters stale candidates instead of resurfacing them as fresh work', () => {
    const staleAt = new Date(Date.now() - (DEFAULT_WRITEBACK_STALE_DAYS + 2) * 24 * 60 * 60 * 1000);
    const result = evaluateSeascapeWritebackCandidate(page({
      updated_at: staleAt,
      compiled_truth: page().compiled_truth + '\nSeascape Hub strategy canon update.\n',
    }), { now: new Date() });
    expect(result.verdict).toBe('stale');
    expect(result.candidate).toBeNull();
  });
});

describe('writeback suppression', () => {
  test('unchanged rejected residue becomes suppressed after recording it once', () => {
    const rejected = evaluateSeascapeWritebackCandidate(page({
      compiled_truth: '# Loose note\n\nSeascape Hub strategy idea without proof.',
      frontmatter: {},
    }));
    expect(rejected.verdict).toBe('memory_only');

    const entry = buildWritebackSuppressionEntry(rejected as WritebackEvaluation, new Date('2026-06-28T12:00:00Z'));
    expect(entry).not.toBeNull();

    const state = upsertWritebackSuppression(
      { schema_version: 'gbrain-writeback-suppression-v1', entries: [] },
      entry!,
    );
    const suppressed = applyWritebackSuppression(rejected, state);

    expect(suppressed.verdict).toBe('suppressed');
    expect(suppressed.reason).toContain('remains suppressed');
  });
});
