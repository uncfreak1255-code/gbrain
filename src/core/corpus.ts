import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { serializeMarkdown } from './markdown.ts';

export type CorpusInputKind = 'local_transcript_dir' | 'youtube_playlist';

export interface CorpusItem {
  id: string;
  title: string;
  canonical_url: string | null;
  local_path: string | null;
  duration_seconds: number | null;
  transcript_path: string | null;
  content_hash: string | null;
  extraction_method: string;
  segments_available: boolean;
  metadata: Record<string, unknown>;
}

export interface CorpusInspection {
  schema_version: 1;
  corpus_id: string;
  corpus_slug: string;
  input: string;
  kind: CorpusInputKind;
  title: string;
  inspected_at: string;
  item_count: number;
  items: CorpusItem[];
  warnings: string[];
  next_supported_commands: string[];
}

export interface InspectCorpusOpts {
  now?: Date;
  maxItems?: number;
  runYtDlp?: typeof spawnSync;
}

export interface CorpusIngestOpts extends InspectCorpusOpts {
  sourceId: string;
  outDir: string;
}

export interface CorpusIngestResult {
  schema_version: 1;
  corpus_id: string;
  corpus_slug: string;
  source_id: string;
  out_dir: string;
  manifest_path: string;
  pages_dir: string;
  transcripts_dir: string;
  pages_written: string[];
  transcripts_written: string[];
  warnings: string[];
}

const LOCAL_TRANSCRIPT_EXTENSIONS = new Set(['.txt', '.md', '.json']);

export async function inspectCorpusInput(
  input: string,
  opts: InspectCorpusOpts = {},
): Promise<CorpusInspection> {
  const now = opts.now ?? new Date();
  if (isLikelyYouTubePlaylist(input)) {
    return inspectYouTubePlaylist(input, now, opts);
  }
  return inspectLocalTranscriptDir(input, now, opts);
}

export async function ingestCorpusInput(
  input: string,
  opts: CorpusIngestOpts,
): Promise<CorpusIngestResult> {
  validateSourceId(opts.sourceId);
  if (isLikelyYouTubePlaylist(input)) {
    throw new Error('gbrain corpus ingest currently supports local transcript directories only.');
  }
  const inspection = await inspectCorpusInput(input, opts);
  if (inspection.kind !== 'local_transcript_dir') {
    throw new Error(`Unsupported corpus kind for ingest: ${inspection.kind}`);
  }

  const baseDir = resolve(opts.outDir, inspection.corpus_slug);
  const pagesDir = join(baseDir, 'pages');
  const transcriptsDir = join(baseDir, 'transcripts');
  mkdirSync(pagesDir, { recursive: true });
  mkdirSync(transcriptsDir, { recursive: true });

  const pagesWritten: string[] = [];
  const transcriptsWritten: string[] = [];
  for (const item of inspection.items) {
    if (!item.transcript_path) continue;
    const transcriptOut = join(transcriptsDir, item.id + extname(item.transcript_path));
    writeFileEnsuringDir(transcriptOut, '');
    copyFileSync(item.transcript_path, transcriptOut);
    transcriptsWritten.push(transcriptOut);

    const pagePath = join(pagesDir, 'media', 'conferences', inspection.corpus_slug, `${item.id}.md`);
    const markdown = buildReviewPageDraft(inspection, item, {
      sourceId: opts.sourceId,
      transcriptOut,
    });
    writeFileEnsuringDir(pagePath, markdown);
    pagesWritten.push(pagePath);
  }

  const manifestPath = join(baseDir, 'manifest.json');
  writeFileEnsuringDir(manifestPath, JSON.stringify({
    ...inspection,
    source_id: opts.sourceId,
    out_dir: baseDir,
    pages_dir: pagesDir,
    transcripts_dir: transcriptsDir,
    pages_written: pagesWritten,
    transcripts_written: transcriptsWritten,
  }, null, 2) + '\n');

  return {
    schema_version: 1,
    corpus_id: inspection.corpus_id,
    corpus_slug: inspection.corpus_slug,
    source_id: opts.sourceId,
    out_dir: baseDir,
    manifest_path: manifestPath,
    pages_dir: pagesDir,
    transcripts_dir: transcriptsDir,
    pages_written: pagesWritten,
    transcripts_written: transcriptsWritten,
    warnings: inspection.warnings,
  };
}

export function isLikelyYouTubePlaylist(input: string): boolean {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, '');
    return (
      (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') &&
      (url.searchParams.has('list') || url.pathname.includes('/playlist'))
    );
  } catch {
    return false;
  }
}

function inspectLocalTranscriptDir(
  input: string,
  now: Date,
  opts: InspectCorpusOpts,
): CorpusInspection {
  const root = resolve(input);
  if (!existsSync(root)) {
    throw new Error(`Corpus path does not exist: ${input}`);
  }
  if (lstatSync(root).isSymbolicLink()) {
    throw new Error(`Corpus path must not be a symlink: ${input}`);
  }
  const rootStat = statSync(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Corpus path is not a directory: ${input}`);
  }

  const files = walkTranscriptFiles(root).slice(0, opts.maxItems ?? Number.POSITIVE_INFINITY);
  const items = files.map((file) => localFileToItem(root, file));
  const slug = slugify(basename(root));
  return {
    schema_version: 1,
    corpus_id: `local:${slug}:${hashShort(root)}`,
    corpus_slug: slug,
    input,
    kind: 'local_transcript_dir',
    title: basename(root),
    inspected_at: now.toISOString(),
    item_count: items.length,
    items,
    warnings: files.length === 0 ? ['No .txt, .md, or .json transcript files found.'] : [],
    next_supported_commands: [
      'gbrain corpus ingest <path> --source <source-id> --out <dir> --json',
      'gbrain corpus review <corpus-id> --source <source-id> --json',
      'gbrain corpus brief <corpus-id> --profile sawyer --json',
    ],
  };
}

function inspectYouTubePlaylist(
  input: string,
  now: Date,
  opts: InspectCorpusOpts,
): CorpusInspection {
  const run = opts.runYtDlp ?? spawnSync;
  const proc = run('yt-dlp', ['--flat-playlist', '--dump-single-json', input], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (proc.error) {
    throw new Error(
      'YouTube playlist inspect requires yt-dlp on PATH. Install yt-dlp or pass a local transcript directory.',
    );
  }
  if (proc.status !== 0) {
    const stderr = typeof proc.stderr === 'string' ? proc.stderr.trim() : '';
    throw new Error(`yt-dlp playlist inspect failed${stderr ? `: ${stderr}` : ''}`);
  }

  const parsed = JSON.parse(String(proc.stdout || '{}')) as Record<string, unknown>;
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const limited = entries.slice(0, opts.maxItems ?? Number.POSITIVE_INFINITY);
  const title = stringField(parsed.title) ?? 'YouTube playlist';
  const slug = slugify(title);
  const items = limited.map((raw, index) => {
    const entry = raw as Record<string, unknown>;
    const url = stringField(entry.url) ?? stringField(entry.webpage_url);
    const id = stringField(entry.id) ?? hashShort(`${url ?? title}:${index}`);
    return {
      id,
      title: stringField(entry.title) ?? `Video ${index + 1}`,
      canonical_url: canonicalYoutubeUrl(url, id),
      local_path: null,
      duration_seconds: numberField(entry.duration),
      transcript_path: null,
      content_hash: null,
      extraction_method: 'yt-dlp:flat-playlist',
      segments_available: false,
      metadata: {
        uploader: stringField(entry.uploader),
        channel: stringField(entry.channel),
      },
    };
  });

  return {
    schema_version: 1,
    corpus_id: `youtube:${slug}:${hashShort(input)}`,
    corpus_slug: slug,
    input,
    kind: 'youtube_playlist',
    title,
    inspected_at: now.toISOString(),
    item_count: items.length,
    items,
    warnings: ['Playlist inspect captures metadata only; transcript download is a later ingest step.'],
    next_supported_commands: [
      'gbrain corpus ingest <url> --source <source-id> --out <dir> --json',
      'gbrain corpus review <corpus-id> --source <source-id> --json',
      'gbrain corpus brief <corpus-id> --profile sawyer --json',
    ],
  };
}

function walkTranscriptFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    const entries = readdirSync(dir).sort();
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(full);
        continue;
      }
      if (!stat.isFile()) continue;
      if (LOCAL_TRANSCRIPT_EXTENSIONS.has(extname(entry).toLowerCase())) out.push(full);
    }
  };
  visit(root);
  return out;
}

function localFileToItem(root: string, file: string): CorpusItem {
  const text = readFileSync(file, 'utf8');
  const rel = relative(root, file);
  const parsedJson = extname(file).toLowerCase() === '.json' ? safeJson(text) : null;
  const metadata = parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
    ? parsedJson as Record<string, unknown>
    : {};
  return {
    id: `${slugify(rel.replace(/\.[^.]+$/, ''))}-${hashShort(rel)}`,
    title: stringField(metadata.title) ?? titleFromFilename(file),
    canonical_url: stringField(metadata.url) ?? stringField(metadata.canonical_url) ?? null,
    local_path: file,
    duration_seconds: numberField(metadata.duration_seconds) ?? numberField(metadata.duration),
    transcript_path: file,
    content_hash: sha256(text),
    extraction_method: 'local-transcript',
    segments_available: Array.isArray(metadata.segments),
    metadata: {
      relative_path: rel,
      bytes: Buffer.byteLength(text, 'utf8'),
    },
  };
}

function buildReviewPageDraft(
  inspection: CorpusInspection,
  item: CorpusItem,
  opts: { sourceId: string; transcriptOut: string },
): string {
  const frontmatter = {
    corpus_id: inspection.corpus_id,
    corpus_slug: inspection.corpus_slug,
    source_id: opts.sourceId,
    source_url: item.canonical_url,
    source_local_path: item.local_path,
    transcript_path: opts.transcriptOut,
    duration_seconds: item.duration_seconds,
    content_hash: item.content_hash,
    extraction_method: item.extraction_method,
    corpus_ingest_kind: inspection.kind,
    corpus_inspected_at: inspection.inspected_at,
  };
  const body = [
    `# ${item.title}`,
    '',
    '## Summary',
    'TODO: Review this source item.',
    '',
    '## Key Ideas',
    '- TODO',
    '',
    '## Best Segment',
    'TODO: Add timestamp and reason.',
    '',
    '## Caveats',
    '- TODO',
    '',
    '## Who Should Care',
    'TODO',
    '',
    '## Source',
    `- Corpus: ${inspection.title}`,
    `- URL: ${item.canonical_url ?? 'n/a'}`,
    `- Transcript: ${opts.transcriptOut}`,
    `- Content hash: ${item.content_hash ?? 'n/a'}`,
  ].join('\n');
  return serializeMarkdown(frontmatter, body, '', {
    type: 'source',
    title: item.title,
    tags: ['corpus-review', inspection.corpus_slug],
  });
}

function writeFileEnsuringDir(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (content.length > 0) writeFileSync(path, content, 'utf8');
}

function validateSourceId(sourceId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(sourceId)) {
    throw new Error(`Invalid --source value: ${sourceId}`);
  }
}

function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function titleFromFilename(file: string): string {
  return basename(file).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
}

function canonicalYoutubeUrl(url: string | undefined, id: string): string | null {
  if (url?.startsWith('http://') || url?.startsWith('https://')) return url;
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'corpus';
}

function hashShort(input: string): string {
  return sha256(input).slice(0, 12);
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
