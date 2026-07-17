// v0.41.2.1 — page-based discovery + source-hash idempotency for
// extract_atoms. Hermetic PGLite tests; no DATABASE_URL needed.
//
// Pins the contracts from /plan-eng-review:
//   D1: source-hash existence check replaces frontmatter marker
//   D2: single raw SQL with NOT EXISTS subquery
//   D9 #1: sourceId threaded through every putPage
//   D9 #3: content_hash IS NOT NULL filter (no crash on null)
//   D9 #4: dream_generated:'true' pages excluded
//   D9 #5: integration assertion deferred to cycle.ts test
//
// Plus PageDiscovery shape, transcript-side idempotency, dual-source
// merge, dedup, dry-run, fail-soft on executeRaw errors.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  runPhaseExtractAtoms,
  discoverExtractablePages,
} from '../src/core/cycle/extract-atoms.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { createHash } from 'node:crypto';
import { emptyHome, withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function stubChat(text: string): (o: ChatOpts) => Promise<ChatResult> {
  return async (_o: ChatOpts) => ({
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });
}

/**
 * Stub that returns a unique-title atom on each call so atoms write to
 * distinct slugs (`atoms/<source-date>/<stem>-<identity-hash>`) instead of upserting
 * into one row. Needed for tests that count atoms after multiple work items.
 */
function stubChatUnique(): (o: ChatOpts) => Promise<ChatResult> {
  let counter = 0;
  return async (_o: ChatOpts) => {
    counter++;
    const text = `[{"title":"unique-atom-${counter}","atom_type":"insight","body":"b${counter}"}]`;
    return {
      text,
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5',
      providerId: 'anthropic',
    };
  };
}

const LONG_CONTENT = 'a'.repeat(800); // > MIN_PAGE_CHARS_FOR_EXTRACTION (500)

async function seedPage(opts: {
  slug: string;
  type: string;
  content_hash?: string | null;
  frontmatter?: Record<string, unknown>;
  source_id?: string;
  compiled_truth?: string;
}) {
  await engine.putPage(
    opts.slug,
    {
      type: opts.type as never,
      title: opts.slug,
      compiled_truth: opts.compiled_truth ?? LONG_CONTENT,
      timeline: '',
      frontmatter: opts.frontmatter ?? {},
      content_hash: opts.content_hash === null ? undefined : (opts.content_hash ?? `hash-for-${opts.slug}`),
    },
    { sourceId: opts.source_id ?? 'default' },
  );
  // PGLite stores content_hash as the engine's computed hash by default.
  // For tests that need a specific hash, overwrite via raw SQL.
  if (opts.content_hash && opts.content_hash !== `hash-for-${opts.slug}`) {
    await engine.executeRaw(
      `UPDATE pages SET content_hash = $1 WHERE slug = $2 AND source_id = $3`,
      [opts.content_hash, opts.slug, opts.source_id ?? 'default'],
    );
  }
  if (opts.content_hash === null) {
    await engine.executeRaw(
      `UPDATE pages SET content_hash = NULL WHERE slug = $1 AND source_id = $2`,
      [opts.slug, opts.source_id ?? 'default'],
    );
  }
}

describe('v0.41.2.1: discoverExtractablePages SQL contract', () => {
  test('discovers legacy and pack-extractable types, excluding synthesis outputs', async () => {
    for (const type of ['meeting', 'source', 'article', 'video', 'book', 'original', 'note']) {
      await seedPage({ slug: `${type}/x`, type });
    }
    await seedPage({ slug: 'wiki/concepts/skip-me', type: 'concept' });

    const discovered = await discoverExtractablePages(engine, 'default');
    const slugs = discovered.map((d) => d.slug).sort();
    expect(slugs).toEqual([
      'article/x',
      'book/x',
      'meeting/x',
      'note/x',
      'original/x',
      'source/x',
      'video/x',
    ]);
  });

  test('honors brain-wide DB schema-pack selection', async () => {
    await engine.setConfig('schema_pack', 'gbrain-investor');
    await seedPage({ slug: 'theses/db-selected', type: 'thesis' });

    const discovered = await withEnv(
      { GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined },
      () => discoverExtractablePages(engine, 'default'),
    );
    expect(discovered.map((page) => page.slug)).toEqual(['theses/db-selected']);
  });

  test('honors per-source DB schema-pack selection without widening siblings', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('dept-x', 'dept-x') ON CONFLICT DO NOTHING`,
    );
    await engine.setConfig('schema_pack.source.dept-x', 'gbrain-investor');
    await seedPage({ slug: 'theses/default-skip', type: 'thesis' });
    await seedPage({ slug: 'theses/dept-include', type: 'thesis', source_id: 'dept-x' });

    const [fromDefault, fromDept] = await withEnv(
      { GBRAIN_HOME: emptyHome(), GBRAIN_SCHEMA_PACK: undefined },
      () => Promise.all([
        discoverExtractablePages(engine, 'default'),
        discoverExtractablePages(engine, 'dept-x'),
      ]),
    );
    expect(fromDefault).toEqual([]);
    expect(fromDept.map((page) => page.slug)).toEqual(['theses/dept-include']);
  });

  test('NOT EXISTS subquery skips pages whose source_hash has completed atoms', async () => {
    // Page content_hash is 20 chars; substring(from 1 for 16) yields the
    // first 16 chars. The seeded atom must carry exactly those 16 chars
    // in frontmatter.source_hash to match the subquery's comparison.
    await seedPage({ slug: 'meeting/old', type: 'meeting', content_hash: 'oldhash1234567890abc' });
    await seedPage({ slug: 'meeting/new', type: 'meeting', content_hash: 'newhash1234567890abc' });
    await engine.putPage(
      'atoms/2026-05-20/old-insight',
      {
        type: 'atom' as never,
        title: 'Old',
        compiled_truth: 'body',
        timeline: '',
        // 'oldhash1234567890abc'.slice(0, 16) = 'oldhash123456789'
        frontmatter: { source_hash: 'oldhash123456789' },
      },
      { sourceId: 'default' },
    );

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['meeting/new']);
  });

  test('current partial atom writes leave the source eligible for retry', async () => {
    await seedPage({ slug: 'meeting/partial', type: 'meeting', content_hash: 'partial1234567890abc' });
    await engine.putPage(
      'atoms/undated-partial/first',
      {
        type: 'atom' as never,
        title: 'First',
        compiled_truth: 'body',
        timeline: '',
        frontmatter: {
          source_hash: 'partial123456789',
          source_complete: false,
          extracted_by: 'extract_atoms-v0.46.0.0',
        },
      },
      { sourceId: 'default' },
    );

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['meeting/partial']);
  });

  test('markdown-greenfield pages excluded', async () => {
    await seedPage({ slug: 'meeting/normal', type: 'meeting' });
    await seedPage({
      slug: 'meeting/greenfield',
      type: 'meeting',
      frontmatter: { imported_from: 'markdown-greenfield' },
    });

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['meeting/normal']);
  });

  test('dream_generated:true pages excluded (D9 #4 — no self-consumption)', async () => {
    await seedPage({ slug: 'original/normal', type: 'original' });
    await seedPage({
      slug: 'original/from-dream',
      type: 'original',
      frontmatter: { dream_generated: true },
    });

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['original/normal']);
  });

  test('pages with NULL content_hash excluded (D9 #3 — no .slice crash)', async () => {
    await seedPage({ slug: 'meeting/with-hash', type: 'meeting' });
    await seedPage({ slug: 'meeting/no-hash', type: 'meeting', content_hash: null });

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['meeting/with-hash']);
    // .slice(0, 16) on hash would crash for null; the filter prevents that
    expect(() => discovered[0].contentHash.slice(0, 16)).not.toThrow();
  });

  test('pages shorter than MIN_PAGE_CHARS_FOR_EXTRACTION excluded', async () => {
    await seedPage({ slug: 'meeting/long', type: 'meeting', compiled_truth: 'a'.repeat(600) });
    await seedPage({ slug: 'meeting/short', type: 'meeting', compiled_truth: 'short' });

    const discovered = await discoverExtractablePages(engine, 'default');
    expect(discovered.map((d) => d.slug)).toEqual(['meeting/long']);
  });

  test('sourceId scopes both candidate AND atom-existence subquery (federated-brain isolation)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('dept-x', 'dept-x') ON CONFLICT DO NOTHING`,
    );
    await seedPage({ slug: 'meeting/a-default', type: 'meeting' });
    await seedPage({ slug: 'meeting/a-dept-x', type: 'meeting', source_id: 'dept-x' });

    const discoveredDefault = await discoverExtractablePages(engine, 'default');
    expect(discoveredDefault.map((d) => d.slug)).toEqual(['meeting/a-default']);
    const discoveredDept = await discoverExtractablePages(engine, 'dept-x');
    expect(discoveredDept.map((d) => d.slug)).toEqual(['meeting/a-dept-x']);
  });

  test('affectedSlugs filter narrows candidates when provided', async () => {
    await seedPage({ slug: 'meeting/a', type: 'meeting' });
    await seedPage({ slug: 'meeting/b', type: 'meeting' });
    await seedPage({ slug: 'meeting/c', type: 'meeting' });

    const discovered = await discoverExtractablePages(engine, 'default', ['meeting/a', 'meeting/c']);
    expect(discovered.map((d) => d.slug).sort()).toEqual(['meeting/a', 'meeting/c']);
  });

  test('executeRaw failure returns [] (fail-soft, transcript path proceeds)', async () => {
    // Inject a SQL error by passing a sourceId that breaks the query —
    // actually easier: temporarily replace executeRaw to throw.
    const realExecute = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw =
      async () => { throw new Error('synthetic discovery failure'); };
    try {
      const discovered = await discoverExtractablePages(engine, 'default');
      expect(discovered).toEqual([]);
    } finally {
      (engine as unknown as { executeRaw: typeof engine.executeRaw }).executeRaw = realExecute;
    }
  });
});

describe('v0.41.2.1: runPhaseExtractAtoms — dual-source merge + idempotency', () => {
  test('dual-source merge: transcripts win on contentHash collision', async () => {
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [
        { filePath: '/transcript-A.txt', content: 'shared content', contentHash: 'sharedhash1234' },
      ],
      _pages: [
        // Same content hash → should be dedup-skipped in favor of transcript
        { slug: 'meeting/shared', content: 'shared content', contentHash: 'sharedhash1234' },
        { slug: 'meeting/unique', content: 'unique content', contentHash: 'uniquehash5678' },
      ],
      _chat: chat,
    });
    expect(result.status).toBe('ok');
    expect(result.details?.atoms_extracted).toBe(2); // transcript + page-unique
    expect(result.details?.duplicates_skipped).toBe(1); // page collided with transcript
    expect(result.details?.transcripts_processed).toBe(1);
    expect(result.details?.pages_processed).toBe(1);
  });

  test('atom frontmatter: page-origin uses source_slug, transcript-origin uses source_path', async () => {
    // Use stubChatUnique so the two work-items write to distinct slugs;
    // a constant title would upsert into one slug and mask one origin.
    const chat = stubChatUnique();
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'tc', contentHash: 'tchash1234567890ab' }],
      _pages: [{ slug: 'meeting/P', content: 'pc', contentHash: 'pchash1234567890ab' }],
      _chat: chat,
    });
    const rows = await engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> }>(
      `SELECT slug, frontmatter FROM pages WHERE type = 'atom' ORDER BY slug`,
    );
    expect(rows.length).toBe(2);
    const transcriptAtom = rows.find((r) => r.frontmatter.source_path !== undefined);
    const pageAtom = rows.find((r) => r.frontmatter.source_slug !== undefined);
    expect(transcriptAtom).toBeDefined();
    expect(transcriptAtom!.frontmatter.source_path).toBe('/T.txt');
    expect(transcriptAtom!.frontmatter.source_hash).toBe('tchash1234567890');
    expect(pageAtom).toBeDefined();
    expect(pageAtom!.frontmatter.source_slug).toBe('meeting/P');
    expect(pageAtom!.frontmatter.source_hash).toBe('pchash1234567890');
  });

  test('sourceId threads into putPage call (D9 #1 regression — atoms land in correct source)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('dept-x', 'dept-x') ON CONFLICT DO NOTHING`,
    );
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);
    await runPhaseExtractAtoms(engine, {
      sourceId: 'dept-x',
      _transcripts: [{ filePath: '/T.txt', content: 'tc', contentHash: 'tchash1234567890ab' }],
      _pages: [],
      _chat: chat,
    });
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE type = 'atom'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('dept-x');
  });

  test('transcript-side idempotency: re-discovered same-hash transcript skipped (closes pre-existing bug)', async () => {
    const chat = stubChatUnique();
    // First run writes the atom
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'c', contentHash: 'dedup1234567890abcd' }],
      _pages: [],
      _chat: chat,
    });
    // Second run on same content_hash should skip (no second atom written)
    const result2 = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'c', contentHash: 'dedup1234567890abcd' }],
      _pages: [],
      _chat: chat,
    });
    expect(result2.details?.duplicates_skipped).toBe(1);
    expect(result2.details?.atoms_extracted).toBe(0);
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(rows[0].count).toBe(1);
  });

  test('idempotency: full re-run on same brain produces zero new atoms', async () => {
    const chat = stubChatUnique();
    await seedPage({ slug: 'meeting/M', type: 'meeting', content_hash: 'mhash1234567890ab' });
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'tc', contentHash: 'thash1234567890ab' }],
      _chat: chat,
    });
    const before = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(before[0].count).toBe(2); // 1 transcript-atom + 1 page-atom

    // Second invocation — no work expected; both dedup paths fire
    const result2 = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'tc', contentHash: 'thash1234567890ab' }],
      _chat: chat,
    });
    expect(result2.details?.atoms_extracted).toBe(0);
    expect(result2.details?.duplicates_skipped).toBe(1); // transcript skipped
    expect(result2.details?.pages_total).toBe(0);        // discovery returned empty
    const after = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(after[0].count).toBe(before[0].count);
  });

  test('deterministic slug uses the source date and upserts a grown transcript', async () => {
    const title = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn ooo ppp';
    const chat = stubChat(`[{"title":"${title}","atom_type":"insight","body":"b"}]`);
    const filePath = '/srv/transcripts/2026-06-12-telegram.md';

    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath, content: 'first', contentHash: 'aaaa1111bbbb2222' }],
      _pages: [],
      _chat: chat,
    });
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath, content: 'first plus appended', contentHash: 'cccc3333dddd4444' }],
      _pages: [],
      _chat: chat,
    });

    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE type = 'atom'`,
    );
    expect(rows).toHaveLength(1);
    const slug = rows[0].slug;
    expect(slug.startsWith('atoms/2026-06-12/')).toBe(true);
    expect(slug).toMatch(/-[0-9a-f]{8}$/);
    const stem = slug.slice('atoms/2026-06-12/'.length).replace(/-[0-9a-f]{8}$/, '');
    expect(stem.endsWith('-')).toBe(false);
    expect(stem.length).toBeLessThanOrEqual(60);
  });

  test('same-title atoms with different content write to distinct slugs', async () => {
    const chat = stubChat(JSON.stringify([
      { title: 'Shared headline', atom_type: 'insight', body: 'First distinct idea.' },
      { title: 'Shared headline', atom_type: 'strategy', body: 'Second distinct idea.' },
    ]));

    await runPhaseExtractAtoms(engine, {
      _transcripts: [{
        filePath: '/srv/transcripts/2026-06-12-duplicate-title.md',
        content: 'source',
        contentHash: 'same-title-source',
      }],
      _pages: [],
      _chat: chat,
    });

    const rows = await engine.executeRaw<{ slug: string; compiled_truth: string }>(
      `SELECT slug, compiled_truth FROM pages WHERE type = 'atom' ORDER BY slug`,
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.slug)).size).toBe(2);
    expect(new Set(rows.map(row => row.compiled_truth))).toEqual(
      new Set(['First distinct idea.', 'Second distinct idea.']),
    );
  });

  test('undated sources use a stable source-derived bucket', async () => {
    const filePath = '/srv/transcripts/plain-name.md';
    const chat = stubChat('[{"title":"Stable","atom_type":"insight","body":"Same atom."}]');

    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath, content: 'first', contentHash: 'firsthash1234567' }],
      _pages: [],
      _chat: chat,
    });
    await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath, content: 'changed', contentHash: 'secondhash123456' }],
      _pages: [],
      _chat: chat,
    });

    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE type = 'atom'`,
    );
    const bucket = createHash('sha256').update(filePath).digest('hex').slice(0, 8);
    expect(rows).toHaveLength(1);
    expect(rows[0].slug.startsWith(`atoms/undated-${bucket}/`)).toBe(true);
  });

  test('the final atom write marks a source complete', async () => {
    const chat = stubChat(JSON.stringify([
      { title: 'First', atom_type: 'insight', body: 'One.' },
      { title: 'Second', atom_type: 'strategy', body: 'Two.' },
    ]));

    await runPhaseExtractAtoms(engine, {
      _transcripts: [{
        filePath: '/srv/transcripts/2026-06-12-complete.md',
        content: 'source',
        contentHash: 'complete-source-hash',
      }],
      _pages: [],
      _chat: chat,
    });

    const rows = await engine.executeRaw<{ complete: string }>(
      `SELECT frontmatter->>'source_complete' AS complete
         FROM pages WHERE type = 'atom' ORDER BY slug`,
    );
    expect(rows.map((row) => row.complete).sort()).toEqual(['false', 'true']);
    const existing = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages
        WHERE type = 'atom' AND frontmatter->>'source_complete' = 'true'`,
    );
    expect(existing[0].count).toBe(1);
  });

  test('PhaseResult.details has additive page fields populated', async () => {
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [
        { slug: 'meeting/a', content: 'a', contentHash: 'a1234567890abcde' },
        { slug: 'meeting/b', content: 'b', contentHash: 'b1234567890abcde' },
      ],
      _chat: chat,
    });
    expect(result.details?.pages_processed).toBe(2);
    expect(result.details?.pages_total).toBe(2);
    expect(result.details?.pages_skipped_budget).toBe(0);
    expect(result.details?.duplicates_skipped).toBe(0);
    expect(result.details?.atoms_extracted).toBe(2);
  });

  test('dry-run skips putPage for atoms', async () => {
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);
    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [{ filePath: '/T.txt', content: 'tc', contentHash: 'th1234567890abcde' }],
      _pages: [{ slug: 'meeting/M', content: 'mc', contentHash: 'mh1234567890abcde' }],
      _chat: chat,
      dryRun: true,
    });
    expect(result.details?.dry_run).toBe(true);
    expect(result.details?.atoms_extracted).toBe(2); // counted but not written
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type = 'atom'`,
    );
    expect(rows[0].count).toBe(0);
  });

  test('_pages: undefined triggers discovery; _pages: [] explicitly suppresses', async () => {
    await seedPage({ slug: 'meeting/discoverable', type: 'meeting', content_hash: 'discovered1234567' });
    const chat = stubChat(`[{"title":"x","atom_type":"insight","body":"b"}]`);

    // _pages explicitly [] → no page work
    const suppressed = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _pages: [],
      _chat: chat,
    });
    expect(suppressed.details?.pages_total).toBe(0);

    // _pages undefined → discovery fires
    const discovered = await runPhaseExtractAtoms(engine, {
      _transcripts: [],
      _chat: chat,
    });
    expect(discovered.details?.pages_total).toBe(1);
    expect(discovered.details?.atoms_extracted).toBe(1);
  });
});
