import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ingestCorpusInput, inspectCorpusInput, isLikelyYouTubePlaylist } from '../src/core/corpus.ts';

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
});
