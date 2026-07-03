import { describe, expect, test } from 'bun:test';
import {
  buildConversationFormatCoverageCheck,
} from '../src/commands/doctor.ts';
import { isConversationFactsCandidatePage } from '../src/core/conversation-parser/candidates.ts';
import type { Page } from '../src/core/types.ts';
import type {
  ParseConversationOpts,
  ParseResult,
} from '../src/core/conversation-parser/parse.ts';

function page(slug: string, title: string, body = 'body'): Page {
  const now = new Date('2026-07-02T00:00:00Z');
  return {
    id: 1,
    slug,
    type: 'conversation',
    title,
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
    created_at: now,
    updated_at: now,
    source_id: 'default',
  };
}

function parserFor(unmatchedSlugs: Set<string>) {
  return (
    _body: string,
    opts?: ParseConversationOpts,
  ): ParseResult => {
    const slug = opts?.page?.slug ?? '';
    if (unmatchedSlugs.has(slug)) {
      return { messages: [], phase: 'no_match' };
    }
    return {
      messages: [{ speaker: 'A', timestamp: '2026-07-02T00:00:00Z', text: 'hi' }],
      phase: 'regex_match',
      matched_pattern_id: 'imessage-slack',
    };
  };
}

describe('conversation_format_coverage doctor check', () => {
  test('conversation candidate filter excludes indexed repo test fixtures', () => {
    expect(
      isConversationFactsCandidatePage(page('test/e2e/fixtures/meetings/weekly-sync-mar28', 'Fixture')),
    ).toBe(false);
    expect(
      isConversationFactsCandidatePage(page('conversations/weekly-sync-mar28', 'Real import')),
    ).toBe(true);
  });

  test('warns with deterministic details and concrete unmatched examples', () => {
    const sample = [
      page('conversations/zeta', 'Zeta call'),
      page('conversations/alpha', 'Alpha call'),
      page('conversations/beta', 'Beta call'),
      page('conversations/gamma', 'Gamma call'),
      page('conversations/delta', 'Delta call'),
      page('conversations/epsilon', 'Epsilon call'),
      page('conversations/matched', 'Matched call'),
    ];

    const check = buildConversationFormatCoverageCheck(
      sample,
      parserFor(new Set(sample.slice(0, 6).map((p) => p.slug))),
    );

    expect(check.status).toBe('warn');
    expect(check.message).toContain('6/7 conversation pages (85.7%) match no built-in pattern');
    expect(check.message).toContain('gbrain conversation-parser scan conversations/alpha');
    expect(check.message).not.toContain('LLM fallback');
    expect(check.message).not.toContain('<slug>');
    expect(check.details).toEqual({
      total_pages: 7,
      matched_pages: 1,
      unmatched_pages: 6,
      unmatched_pct: 85.7,
      pattern_counts: {
        _no_match: 6,
        'imessage-slack': 1,
      },
      unmatched_examples: [
        { slug: 'conversations/alpha', title: 'Alpha call' },
        { slug: 'conversations/beta', title: 'Beta call' },
        { slug: 'conversations/delta', title: 'Delta call' },
        { slug: 'conversations/epsilon', title: 'Epsilon call' },
        { slug: 'conversations/gamma', title: 'Gamma call' },
      ],
    });
  });

  test('ok result still includes machine-readable pattern counts', () => {
    const check = buildConversationFormatCoverageCheck(
      [page('conversations/one', 'One'), page('conversations/two', 'Two')],
      parserFor(new Set()),
    );

    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({
      total_pages: 2,
      matched_pages: 2,
      unmatched_pages: 0,
      unmatched_pct: 0,
      pattern_counts: { 'imessage-slack': 2 },
      unmatched_examples: [],
    });
  });

  test('quotes unmatched slug in paste-ready scan command', () => {
    const hostileSlug = "conversations/bad slug; echo nope";
    const check = buildConversationFormatCoverageCheck(
      [page(hostileSlug, 'Unsafe slug')],
      parserFor(new Set([hostileSlug])),
    );

    expect(check.status).toBe('warn');
    expect(check.message).toContain("gbrain conversation-parser scan 'conversations/bad slug; echo nope'");
  });
});
