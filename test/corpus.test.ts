import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { briefCorpus, ingestCorpusInput, inspectCorpusInput, isLikelyYouTubePlaylist, reviewCorpus } from '../src/core/corpus.ts';

describe('corpus inspect', () => {
  test('inspects local transcript directories with stable provenance fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    try {
      mkdirSync(join(root, 'day-1'));
      writeFileSync(join(root, 'day-1', '01-opening-keynote.txt'), 'Hello Sawyer\nThis matters for agents.\n');
      writeFileSync(join(root, '02-panel.json'), JSON.stringify({
        title: 'Panel on proof',
        url: 'https://example.com/panel',
        duration_seconds: 123,
        segments: [{ start: 0, end: 10, text: 'Proof first.' }],
      }));

      const result = await inspectCorpusInput(root, {
        now: new Date('2026-07-02T12:00:00.000Z'),
      });

      expect(result.kind).toBe('local_transcript_dir');
      expect(result.schema_version).toBe(1);
      expect(result.item_count).toBe(2);
      expect(result.inspected_at).toBe('2026-07-02T12:00:00.000Z');
      expect(result.items[0].title).toBe('Panel on proof');
      expect(result.items[0].canonical_url).toBe('https://example.com/panel');
      expect(result.items[0].duration_seconds).toBe(123);
      expect(result.items[0].segments_available).toBe(true);
      expect(result.items[1].title).toBe('01 opening keynote');
      expect(result.items[1].content_hash).toHaveLength(64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects YouTube playlist URLs', () => {
    expect(isLikelyYouTubePlaylist('https://www.youtube.com/playlist?list=abc')).toBe(true);
    expect(isLikelyYouTubePlaylist('https://www.youtube.com/watch?v=123&list=abc')).toBe(true);
    expect(isLikelyYouTubePlaylist('https://youtu.be/123')).toBe(false);
    expect(isLikelyYouTubePlaylist('/tmp/transcripts')).toBe(false);
  });

  test('skips symlinked files and directories in local transcript directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-corpus-outside-'));
    try {
      writeFileSync(join(root, 'inside.txt'), 'inside\n');
      writeFileSync(join(outside, 'outside.txt'), 'outside\n');
      symlinkSync(join(outside, 'outside.txt'), join(root, 'linked-file.txt'));
      symlinkSync(outside, join(root, 'linked-dir'));

      const result = await inspectCorpusInput(root, {
        now: new Date('2026-07-02T12:00:00.000Z'),
      });

      expect(result.item_count).toBe(1);
      expect(result.items[0].title).toBe('inside');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('inspects YouTube playlist metadata through yt-dlp seam', async () => {
    const runYtDlp = (() => ({
      status: 0,
      stdout: JSON.stringify({
        title: 'AI Conference',
        entries: [
          { id: 'abc123', title: 'Opening', duration: 42, uploader: 'Conference' },
        ],
      }),
      stderr: '',
    })) as never;

    const result = await inspectCorpusInput('https://www.youtube.com/playlist?list=abc', {
      now: new Date('2026-07-02T12:00:00.000Z'),
      runYtDlp,
    });

    expect(result.kind).toBe('youtube_playlist');
    expect(result.title).toBe('AI Conference');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].canonical_url).toBe('https://www.youtube.com/watch?v=abc123');
    expect(result.items[0].extraction_method).toBe('yt-dlp:flat-playlist');
    expect(result.warnings[0]).toContain('metadata only');
  });

  test('ingests local transcript directories into manifest, transcript copies, and review page drafts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-out-'));
    try {
      writeFileSync(join(root, 'agent-talk.txt'), 'Agents need receipts.\n');

      const result = await ingestCorpusInput(root, {
        sourceId: 'briefs-test',
        outDir: out,
        now: new Date('2026-07-02T12:00:00.000Z'),
      });

      expect(result.pages_written).toHaveLength(1);
      expect(result.transcripts_written).toHaveLength(1);
      expect(existsSync(result.manifest_path)).toBe(true);
      expect(readFileSync(result.transcripts_written[0], 'utf8')).toBe('Agents need receipts.\n');

      const page = readFileSync(result.pages_written[0], 'utf8');
      expect(page).toContain('type: source');
      expect(page).toContain('source_id: briefs-test');
      expect(page).toContain('## Summary');
      expect(page).toContain('## Source');

      const manifest = JSON.parse(readFileSync(result.manifest_path, 'utf8'));
      expect(manifest.source_id).toBe('briefs-test');
      expect(manifest.pages_written).toEqual(result.pages_written);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('uses markdown source frontmatter for corpus metadata and reviews the markdown body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-out-'));
    try {
      writeFileSync(join(root, 'agent-loop-source.md'), [
        '---',
        'title: Agent Loop Source',
        "source_url: 'https://example.com/agent-loop'",
        'duration_seconds: 45',
        'segments:',
        '  - start: 0',
        '    text: Frontmatter segment metadata is not used by the markdown review path yet.',
        '---',
        '',
        '# Agent Loop Source',
        '',
        'Agents need proof receipts, evals, and stop rules before workflow decisions change.',
        '',
      ].join('\n'));

      const inspection = await inspectCorpusInput(root, {
        now: new Date('2026-07-02T12:00:00.000Z'),
      });

      expect(inspection.items[0].title).toBe('Agent Loop Source');
      expect(inspection.items[0].canonical_url).toBe('https://example.com/agent-loop');
      expect(inspection.items[0].duration_seconds).toBe(45);
      expect(inspection.items[0].segments_available).toBe(false);

      const ingest = await ingestCorpusInput(root, {
        sourceId: 'briefs-test',
        outDir: out,
        now: new Date('2026-07-02T12:00:00.000Z'),
      });
      const review = await reviewCorpus(ingest.out_dir, {
        sourceId: 'briefs-test',
        now: new Date('2026-07-02T13:00:00.000Z'),
      });
      const brief = await briefCorpus(ingest.out_dir, {
        profile: 'sawyer',
        now: new Date('2026-07-02T14:00:00.000Z'),
      });

      const page = readFileSync(review.review_pages_written[0], 'utf8');
      expect(page).toContain('https://example.com/agent-loop');
      expect(page).toContain('Agents need proof receipts');
      expect(page).toContain('## Best Excerpt');
      expect(readFileSync(brief.brief_path, 'utf8')).toContain('Best excerpt:');
      expect(readFileSync(brief.brief_path, 'utf8')).not.toContain('Best excerpt: 00:00 -');
      expect(page).not.toContain('title: Agent Loop Source\\nsource_url');
      expect(page).not.toContain('## Summary\n# Agent Loop Source');
      expect(page).not.toContain('00:00 - Agents need proof receipts');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('frontmatter-only markdown sources do not review yaml as transcript text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-out-'));
    try {
      writeFileSync(join(root, 'metadata-only.md'), [
        '---',
        'title: Metadata Only Source',
        "source_url: 'https://example.com/metadata-only'",
        'segments:',
        '  - start: 0',
        '    text: This frontmatter should not become transcript text.',
        '---',
        '',
      ].join('\n'));

      const ingest = await ingestCorpusInput(root, {
        sourceId: 'briefs-test',
        outDir: out,
        now: new Date('2026-07-02T12:00:00.000Z'),
      });
      const review = await reviewCorpus(ingest.out_dir, {
        sourceId: 'briefs-test',
        now: new Date('2026-07-02T13:00:00.000Z'),
      });

      const page = readFileSync(review.review_pages_written[0], 'utf8');
      expect(page).toContain('Metadata Only Source has no usable transcript text yet.');
      expect(page).not.toContain('This frontmatter should not become transcript text');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('text transcripts starting with separators are not parsed as markdown frontmatter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-out-'));
    try {
      writeFileSync(join(root, 'separator-led.txt'), [
        '---',
        'This separator is part of the transcript, not YAML frontmatter.',
        '---',
        'Agents need proof receipts after the separator.',
        '',
      ].join('\n'));

      const ingest = await ingestCorpusInput(root, {
        sourceId: 'briefs-test',
        outDir: out,
        now: new Date('2026-07-02T12:00:00.000Z'),
      });
      const review = await reviewCorpus(ingest.out_dir, {
        sourceId: 'briefs-test',
        now: new Date('2026-07-02T13:00:00.000Z'),
      });

      const page = readFileSync(review.review_pages_written[0], 'utf8');
      expect(page).toContain('This separator is part of the transcript');
      expect(page).toContain('Agents need proof receipts after the separator.');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('ingest uses collision-resistant item ids for slug-equivalent paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-out-'));
    try {
      mkdirSync(join(root, 'a'));
      writeFileSync(join(root, 'a-b.txt'), 'top level\n');
      writeFileSync(join(root, 'a', 'b.txt'), 'nested\n');

      const result = await ingestCorpusInput(root, {
        sourceId: 'briefs-test',
        outDir: out,
        now: new Date('2026-07-02T12:00:00.000Z'),
      });

      expect(result.pages_written).toHaveLength(2);
      expect(new Set(result.pages_written).size).toBe(2);
      expect(result.transcripts_written).toHaveLength(2);
      expect(new Set(result.transcripts_written).size).toBe(2);
      expect(result.transcripts_written.map(p => readFileSync(p, 'utf8')).sort()).toEqual([
        'nested\n',
        'top level\n',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('ingest refuses YouTube playlists until transcript capture exists', async () => {
    await expect(ingestCorpusInput('https://www.youtube.com/playlist?list=abc', {
      sourceId: 'briefs-test',
      outDir: '/tmp/unused',
    })).rejects.toThrow('local transcript directories only');
  });

  test('review fills source-backed review pages from local corpus transcripts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-out-'));
    try {
      writeFileSync(join(root, 'agent-proof.json'), JSON.stringify({
        title: 'Agent Proof Talk',
        url: 'https://example.com/agent-proof',
        segments: [
          { start: 75, text: 'Agents need retrieval, evals, and proof receipts before workflow automation changes decisions.' },
          { start: 130, text: 'Spend should stay bounded by small experiments.' },
        ],
      }));
      const ingest = await ingestCorpusInput(root, {
        sourceId: 'briefs-test',
        outDir: out,
        now: new Date('2026-07-02T12:00:00.000Z'),
      });

      const review = await reviewCorpus(ingest.out_dir, {
        sourceId: 'briefs-test',
        now: new Date('2026-07-02T13:00:00.000Z'),
      });

      expect(review.review_pages_written).toHaveLength(1);
      const page = readFileSync(review.review_pages_written[0], 'utf8');
      expect(page).toContain('corpus_review_method: deterministic-transcript-heuristic');
      expect(page).toContain('## Key Ideas');
      expect(page).toContain('## Best Segment');
      expect(page).toContain('01:15 - Agents need retrieval');
      expect(page).toContain('## Transcript Excerpt Pointers');
      expect(page).not.toContain('TODO');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('brief ranks reviewed items into Sawyer-specific required sections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-out-'));
    try {
      writeFileSync(join(root, 'gbrain-agents.txt'), 'GBrain agents need retrieval evals, proof receipts, spend budgets, and bounded workflow experiments before decisions change.\n');
      writeFileSync(join(root, 'lightweight-general.txt'), 'A casual hallway update with no actionable technical detail.\n');
      const ingest = await ingestCorpusInput(root, {
        sourceId: 'briefs-test',
        outDir: out,
        now: new Date('2026-07-02T12:00:00.000Z'),
      });
      await reviewCorpus(ingest.out_dir, {
        sourceId: 'briefs-test',
        now: new Date('2026-07-02T13:00:00.000Z'),
      });

      const brief = await briefCorpus(ingest.out_dir, {
        profile: 'sawyer',
        now: new Date('2026-07-02T14:00:00.000Z'),
      });

      const body = readFileSync(brief.brief_path, 'utf8');
      expect(body).toContain('## Best use of your time');
      expect(body).toContain('## Watch/read first');
      expect(body).toContain('## Skip or skim');
      expect(body).toContain('## Relevant to Seascape');
      expect(body).toContain('## Relevant to GBrain / agents');
      expect(body).toContain('## Relevant to Sawyer operating system');
      expect(body).toContain('## Strong claims worth testing');
      expect(body).toContain('## Caveats / likely hype');
      expect(body).toContain('## Source gaps');
      expect(body).toContain('## Next actions');
      expect(body).toContain('Related GBrain context retrieval has not run yet');
      expect(body.indexOf('gbrain agents')).toBeLessThan(body.indexOf('lightweight general'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('review and brief do not trust writable paths from a crafted manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-out-'));
    const outside = mkdtempSync(join(tmpdir(), 'gbrain-corpus-outside-'));
    try {
      writeFileSync(join(root, 'agent-proof.txt'), 'Agents need proof receipts and evals.\n');
      const ingest = await ingestCorpusInput(root, {
        sourceId: 'briefs-test',
        outDir: out,
        now: new Date('2026-07-02T12:00:00.000Z'),
      });
      const manifest = JSON.parse(readFileSync(ingest.manifest_path, 'utf8'));
      manifest.pages_dir = outside;
      manifest.transcripts_written = [join(outside, 'outside.txt')];
      writeFileSync(ingest.manifest_path, JSON.stringify(manifest, null, 2));

      const review = await reviewCorpus(ingest.manifest_path, {
        sourceId: 'briefs-test',
        now: new Date('2026-07-02T13:00:00.000Z'),
      });
      const brief = await briefCorpus(ingest.manifest_path, {
        profile: 'sawyer',
        now: new Date('2026-07-02T14:00:00.000Z'),
      });

      expect(review.review_pages_written[0].startsWith(ingest.out_dir)).toBe(true);
      expect(brief.brief_path.startsWith(ingest.out_dir)).toBe(true);
      expect(existsSync(join(outside, 'analysis'))).toBe(false);
      expect(existsSync(join(outside, 'media'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('review and brief reject unsafe manifest slug components', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-out-'));
    try {
      writeFileSync(join(root, 'agent-proof.txt'), 'Agents need proof receipts and evals.\n');
      const ingest = await ingestCorpusInput(root, {
        sourceId: 'briefs-test',
        outDir: out,
        now: new Date('2026-07-02T12:00:00.000Z'),
      });
      const manifest = JSON.parse(readFileSync(ingest.manifest_path, 'utf8'));
      manifest.corpus_slug = '../../../../target';
      writeFileSync(ingest.manifest_path, JSON.stringify(manifest, null, 2));

      await expect(briefCorpus(ingest.manifest_path, { profile: 'sawyer' })).rejects.toThrow('Unsafe corpus manifest corpus_slug');

      manifest.corpus_slug = 'safe-corpus';
      manifest.items[0].id = '../target';
      writeFileSync(ingest.manifest_path, JSON.stringify(manifest, null, 2));

      await expect(reviewCorpus(ingest.manifest_path, { sourceId: 'briefs-test' })).rejects.toThrow('Unsafe corpus manifest item id');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('brief does not linkify unsafe corpus metadata URLs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-corpus-test-'));
    const out = mkdtempSync(join(tmpdir(), 'gbrain-corpus-out-'));
    try {
      writeFileSync(join(root, 'unsafe-link.json'), JSON.stringify({
        title: 'Bad [link] title',
        url: 'javascript:alert(1)',
        text: 'Agents need proof receipts and evals before workflow decisions.',
      }));
      const ingest = await ingestCorpusInput(root, {
        sourceId: 'briefs-test',
        outDir: out,
        now: new Date('2026-07-02T12:00:00.000Z'),
      });
      await reviewCorpus(ingest.out_dir, {
        sourceId: 'briefs-test',
        now: new Date('2026-07-02T13:00:00.000Z'),
      });
      const brief = await briefCorpus(ingest.out_dir, {
        profile: 'sawyer',
        now: new Date('2026-07-02T14:00:00.000Z'),
      });

      const body = readFileSync(brief.brief_path, 'utf8');
      expect(body).not.toContain('](javascript:alert(1))');
      expect(body).toContain('Bad \\[link\\] title');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
