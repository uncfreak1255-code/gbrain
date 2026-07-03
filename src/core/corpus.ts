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

export interface CorpusReviewOpts {
  sourceId: string;
  corpusDir?: string;
  now?: Date;
}

export interface CorpusReviewResult {
  schema_version: 1;
  corpus_id: string;
  corpus_slug: string;
  source_id: string;
  corpus_dir: string;
  reviewed_at: string;
  review_pages_written: string[];
  warnings: string[];
}

export interface CorpusBriefOpts {
  profile: 'sawyer';
  corpusDir?: string;
  now?: Date;
}

export interface CorpusBriefResult {
  schema_version: 1;
  corpus_id: string;
  corpus_slug: string;
  profile: 'sawyer';
  corpus_dir: string;
  brief_path: string;
  item_count: number;
  warnings: string[];
}

interface CorpusManifest extends CorpusInspection {
  source_id: string;
  out_dir: string;
  pages_dir: string;
  transcripts_dir: string;
  pages_written: string[];
  transcripts_written: string[];
}

interface TranscriptDigest {
  text: string;
  summary: string;
  keyIdeas: string[];
  bestSegment: string;
  caveats: string[];
  whoShouldCare: string;
  topics: string[];
  excerptPointers: string[];
  score: number;
  relevance: {
    seascape: string[];
    gbrainAgents: string[];
    operatingSystem: string[];
    strongClaims: string[];
    hypeCaveats: string[];
    nextActions: string[];
  };
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

export async function reviewCorpus(
  corpusRef: string,
  opts: CorpusReviewOpts,
): Promise<CorpusReviewResult> {
  validateSourceId(opts.sourceId);
  const now = opts.now ?? new Date();
  const { manifest, corpusDir } = loadCorpusManifest(corpusRef, opts.corpusDir);
  if (manifest.source_id !== opts.sourceId) {
    throw new Error(`Corpus source mismatch: manifest has ${manifest.source_id}, got ${opts.sourceId}`);
  }

  const reviewPagesWritten: string[] = [];
  const warnings = [...manifest.warnings];
  for (const item of manifest.items) {
    const transcriptPath = transcriptPathForItem(manifest, item);
    if (!transcriptPath) {
      warnings.push(`No transcript copy found for ${item.id}; skipped review.`);
      continue;
    }
    const digest = digestTranscript(readFileSync(transcriptPath, 'utf8'), item);
    const pagePath = pagePathForItem(manifest, item);
    const markdown = buildReviewedPage(manifest, item, digest, {
      sourceId: opts.sourceId,
      transcriptOut: transcriptPath,
      reviewedAt: now.toISOString(),
    });
    writeFileEnsuringDir(pagePath, markdown);
    reviewPagesWritten.push(pagePath);
  }

  return {
    schema_version: 1,
    corpus_id: manifest.corpus_id,
    corpus_slug: manifest.corpus_slug,
    source_id: opts.sourceId,
    corpus_dir: corpusDir,
    reviewed_at: now.toISOString(),
    review_pages_written: reviewPagesWritten,
    warnings,
  };
}

export async function briefCorpus(
  corpusRef: string,
  opts: CorpusBriefOpts,
): Promise<CorpusBriefResult> {
  if (opts.profile !== 'sawyer') {
    throw new Error(`Unsupported corpus brief profile: ${opts.profile}`);
  }
  const { manifest, corpusDir } = loadCorpusManifest(corpusRef, opts.corpusDir);
  const reviewed = manifest.items.map((item) => ({
    item,
    digest: digestTranscript(readTranscriptForItem(manifest, item), item),
  })).sort((a, b) => b.digest.score - a.digest.score || a.item.title.localeCompare(b.item.title));

  const briefPath = join(manifest.pages_dir, 'analysis', 'content-briefs', `${manifest.corpus_slug}-sawyer.md`);
  const body = buildSawyerBrief(manifest, reviewed, opts.now ?? new Date());
  writeFileEnsuringDir(briefPath, body);

  return {
    schema_version: 1,
    corpus_id: manifest.corpus_id,
    corpus_slug: manifest.corpus_slug,
    profile: opts.profile,
    corpus_dir: corpusDir,
    brief_path: briefPath,
    item_count: reviewed.length,
    warnings: manifest.warnings,
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

function buildReviewedPage(
  inspection: CorpusManifest,
  item: CorpusItem,
  digest: TranscriptDigest,
  opts: { sourceId: string; transcriptOut: string; reviewedAt: string },
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
    corpus_reviewed_at: opts.reviewedAt,
    corpus_review_method: 'deterministic-transcript-heuristic',
    relevance_score: digest.score,
  };
  const body = [
    `# ${item.title}`,
    '',
    '## Summary',
    digest.summary,
    '',
    '## Key Ideas',
    ...digest.keyIdeas.map((idea) => `- ${idea}`),
    '',
    '## Best Segment',
    digest.bestSegment,
    '',
    '## Caveats',
    ...digest.caveats.map((caveat) => `- ${caveat}`),
    '',
    '## Who Should Care',
    digest.whoShouldCare,
    '',
    '## Tags / Topics',
    ...digest.topics.map((topic) => `- ${topic}`),
    '',
    '## Transcript Excerpt Pointers',
    ...digest.excerptPointers.map((pointer) => `- ${pointer}`),
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
    tags: ['corpus-review', inspection.corpus_slug, ...digest.topics.slice(0, 6)],
  });
}

function buildSawyerBrief(
  manifest: CorpusManifest,
  reviewed: Array<{ item: CorpusItem; digest: TranscriptDigest }>,
  now: Date,
): string {
  const frontmatter = {
    corpus_id: manifest.corpus_id,
    corpus_slug: manifest.corpus_slug,
    source_id: manifest.source_id,
    profile: 'sawyer',
    generated_at: now.toISOString(),
    brief_method: 'deterministic-transcript-heuristic',
  };
  const top = reviewed.slice(0, 5);
  const skip = reviewed.filter(({ digest }) => digest.score <= 1).slice(0, 5);
  const body = [
    `# ${manifest.title} - Sawyer Brief`,
    '',
    'This deterministic v1 brief ranks the corpus from transcript text and source metadata only. Related GBrain context retrieval has not run yet; relevance labels below are heuristic inferences, not saved Sawyer-memory claims.',
    '',
    '## Best use of your time',
    ...bulletRank(top, ({ item, digest }, index) => `${index + 1}. ${sourceLink(item)} - ${digest.summary} (${scoreLabel(digest.score)})`),
    '',
    '## Watch/read first',
    ...bulletRank(top.slice(0, 3), ({ item, digest }) => `${sourceLink(item)} - Best segment: ${digest.bestSegment}`),
    '',
    '## Skip or skim',
    ...(skip.length > 0
      ? bulletRank(skip, ({ item, digest }) => `${sourceLink(item)} - ${digest.caveats[0] ?? 'Low actionable signal in the transcript.'}`)
      : ['- No obvious skip-only items from the available transcripts.']),
    '',
    '## Relevant to Seascape',
    ...briefBucket(reviewed, 'seascape'),
    '',
    '## Relevant to GBrain / agents',
    ...briefBucket(reviewed, 'gbrainAgents'),
    '',
    '## Relevant to Sawyer operating system',
    ...briefBucket(reviewed, 'operatingSystem'),
    '',
    '## Strong claims worth testing',
    ...flatClaims(reviewed, 'strongClaims', '- No strong testable claims detected by the deterministic pass.'),
    '',
    '## Caveats / likely hype',
    ...flatClaims(reviewed, 'hypeCaveats', '- Main caveat: this pass has not used a model reviewer or Sawyer-memory retrieval yet.'),
    '',
    '## Source gaps',
    ...sourceGaps(manifest, reviewed),
    '',
    '## Next actions',
    ...flatClaims(reviewed, 'nextActions', '- Run the later model-backed review gate before changing decisions from this corpus.'),
  ].join('\n');
  return serializeMarkdown(frontmatter, body, '', {
    type: 'analysis',
    title: `${manifest.title} - Sawyer Brief`,
    tags: ['content-brief', 'sawyer', manifest.corpus_slug],
  });
}

function loadCorpusManifest(corpusRef: string, corpusDir?: string): { manifest: CorpusManifest; corpusDir: string } {
  const candidate = corpusDir ? resolve(corpusDir) : resolve(corpusRef);
  if (!existsSync(candidate)) {
    throw new Error(`Corpus manifest not found: ${candidate}`);
  }
  const manifestPath = statSync(candidate).isDirectory() ? join(candidate, 'manifest.json') : candidate;
  if (!existsSync(manifestPath)) {
    throw new Error(`Corpus manifest not found: ${manifestPath}`);
  }
  const root = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CorpusManifest;
  validateLoadedManifest(manifest);
  return {
    manifest: {
      ...manifest,
      out_dir: root,
      pages_dir: join(root, 'pages'),
      transcripts_dir: join(root, 'transcripts'),
      pages_written: safeContainedPaths(manifest.pages_written, root),
      transcripts_written: safeContainedPaths(manifest.transcripts_written, root),
    },
    corpusDir: root,
  };
}

function transcriptPathForItem(manifest: CorpusManifest, item: CorpusItem): string | null {
  if (!existsSync(manifest.transcripts_dir)) return null;
  const found = readdirSync(manifest.transcripts_dir)
    .sort()
    .find((name) => name.startsWith(`${item.id}.`) && LOCAL_TRANSCRIPT_EXTENSIONS.has(extname(name).toLowerCase()));
  if (!found) return null;
  const full = join(manifest.transcripts_dir, found);
  const stat = lstatSync(full);
  return stat.isFile() && !stat.isSymbolicLink() ? full : null;
}

function pagePathForItem(manifest: CorpusManifest, item: CorpusItem): string {
  const pagePath = join(manifest.pages_dir, 'media', 'conferences', manifest.corpus_slug, `${item.id}.md`);
  if (!isInside(manifest.pages_dir, pagePath)) {
    throw new Error(`Unsafe corpus page path for item: ${item.id}`);
  }
  return pagePath;
}

function readTranscriptForItem(manifest: CorpusManifest, item: CorpusItem): string {
  const transcriptPath = transcriptPathForItem(manifest, item);
  return transcriptPath ? readFileSync(transcriptPath, 'utf8') : '';
}

function safeContainedPaths(paths: string[] | undefined, root: string): string[] {
  if (!Array.isArray(paths)) return [];
  return paths
    .map((path) => resolve(path))
    .filter((path) => isInside(root, path));
}

function validateLoadedManifest(manifest: CorpusManifest): void {
  validateSlugComponent(manifest.corpus_slug, 'corpus_slug');
  if (!Array.isArray(manifest.items)) throw new Error('Corpus manifest items must be an array.');
  for (const item of manifest.items) {
    validateSlugComponent(item.id, `item id ${item.id}`);
  }
}

function validateSlugComponent(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) {
    throw new Error(`Unsafe corpus manifest ${label}: ${String(value)}`);
  }
}

function isInside(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith('/'));
}

function digestTranscript(raw: string, item: CorpusItem): TranscriptDigest {
  const text = normalizeTranscriptText(raw);
  const sentences = splitSentences(text);
  const scored = sentences
    .map((sentence, index) => ({ sentence, index, score: scoreText(sentence) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0]?.sentence ?? (text.slice(0, 180) || 'No transcript text available.');
  const topSentences = scored.filter((s) => s.score > 0).slice(0, 4);
  const topics = topicsForText(`${item.title}\n${text}`);
  const score = Math.min(10, Math.max(0, topics.length + (topSentences[0]?.score ?? 0)));
  const relevance = relevanceForText(`${item.title}\n${text}`);
  const caveats = [
    'Generated by deterministic transcript heuristics; use a model-backed review before making a high-stakes decision.',
  ];
  if (!item.segments_available) caveats.push('No timestamped transcript segments were available.');
  if (!item.canonical_url) caveats.push('No canonical source URL was provided.');

  return {
    text,
    summary: summarize(sentences, item),
    keyIdeas: topSentences.length > 0
      ? topSentences.map((s) => s.sentence)
      : ['No high-signal technical claim detected in the available transcript text.'],
    bestSegment: bestSegment(raw, best, item),
    caveats,
    whoShouldCare: whoShouldCare(topics),
    topics,
    excerptPointers: excerptPointers(sentences, topSentences),
    score,
    relevance,
  };
}

function normalizeTranscriptText(raw: string): string {
  const parsed = safeJson(raw);
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const transcript = stringField(record.transcript) ?? stringField(record.text) ?? stringField(record.content);
    if (transcript) return transcript.replace(/\s+/g, ' ').trim();
    if (Array.isArray(record.segments)) {
      return record.segments
        .map((segment) => stringField((segment as Record<string, unknown>).text))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  return raw.replace(/\s+/g, ' ').trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 200);
}

function summarize(sentences: string[], item: CorpusItem): string {
  if (sentences.length === 0) return `${item.title} has no usable transcript text yet.`;
  return sentences.slice(0, 2).join(' ').slice(0, 500);
}

function bestSegment(raw: string, fallback: string, item: CorpusItem): string {
  const parsed = safeJson(raw);
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).segments)) {
    const segments = ((parsed as Record<string, unknown>).segments as unknown[])
      .map((segment) => segment as Record<string, unknown>)
      .filter((segment) => stringField(segment.text));
    const ranked = segments
      .map((segment, index) => ({ segment, index, score: scoreText(stringField(segment.text) ?? '') }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const best = ranked[0]?.segment;
    if (best) {
      const start = numberField(best.start) ?? 0;
      return `${formatTimestamp(start)} - ${stringField(best.text)}`;
    }
  }
  const timestamp = item.duration_seconds && item.duration_seconds > 0 ? '00:00' : 'n/a';
  return `${timestamp} - ${fallback}`;
}

function excerptPointers(sentences: string[], scored: Array<{ sentence: string; index: number; score: number }>): string[] {
  if (scored.length === 0) return ['No excerpt pointers available.'];
  return scored.slice(0, 3).map((s) => `Sentence ${s.index + 1}: ${s.sentence}`);
}

function relevanceForText(text: string): TranscriptDigest['relevance'] {
  const lower = text.toLowerCase();
  return {
    seascape: collectMatches(lower, [
      ['owner/guest operations', ['guest', 'booking', 'owner', 'reservation', 'pricing', 'revenue']],
      ['proof and measurement', ['metric', 'experiment', 'measurement', 'conversion', 'attribution']],
    ]),
    gbrainAgents: collectMatches(lower, [
      ['memory/retrieval architecture', ['memory', 'retrieval', 'search', 'embedding', 'context']],
      ['agent workflow design', ['agent', 'workflow', 'eval', 'tool', 'automation']],
    ]),
    operatingSystem: collectMatches(lower, [
      ['bounded operating loop', ['loop', 'decision', 'priority', 'focus', 'system']],
      ['spend/proof discipline', ['spend', 'cost', 'budget', 'proof', 'receipt']],
    ]),
    strongClaims: collectMatches(lower, [
      ['claim about agent reliability or eval quality', ['better than', 'always', 'never', 'must', 'guarantee']],
      ['claim about measurable business lift', ['increase', 'reduce', 'double', '10x', 'conversion']],
    ]),
    hypeCaveats: collectMatches(lower, [
      ['broad AI promise needs evidence', ['revolutionary', 'autonomous', 'replace', 'magic', 'transform']],
      ['missing proof detail', ['no benchmark', 'anecdot', 'demo']],
    ]),
    nextActions: collectMatches(lower, [
      ['design a small bounded experiment', ['experiment', 'pilot', 'prototype', 'test']],
      ['compare against current workflow', ['workflow', 'process', 'decision', 'operator']],
    ]),
  };
}

function collectMatches(lower: string, rules: Array<[string, string[]]>): string[] {
  return rules.filter(([, terms]) => terms.some((term) => lower.includes(term))).map(([label]) => label);
}

function topicsForText(text: string): string[] {
  const lower = text.toLowerCase();
  const topics: Array<[string, string[]]> = [
    ['agents', ['agent', 'tool', 'workflow', 'automation']],
    ['gbrain', ['gbrain', 'memory', 'retrieval', 'search', 'embedding']],
    ['seascape', ['seascape', 'guest', 'owner', 'booking', 'pricing', 'reservation']],
    ['proof', ['proof', 'receipt', 'eval', 'benchmark', 'measurement']],
    ['spend', ['spend', 'cost', 'budget']],
    ['operating-system', ['priority', 'decision', 'loop', 'focus']],
  ];
  const found = topics.filter(([, terms]) => terms.some((term) => lower.includes(term))).map(([topic]) => topic);
  return found.length > 0 ? found : ['general'];
}

function scoreText(text: string): number {
  const lower = text.toLowerCase();
  const weighted: Array<[string, number]> = [
    ['gbrain', 3],
    ['agent', 3],
    ['retrieval', 3],
    ['eval', 3],
    ['proof', 3],
    ['receipt', 2],
    ['seascape', 3],
    ['guest', 2],
    ['owner', 2],
    ['spend', 2],
    ['cost', 2],
    ['workflow', 2],
    ['decision', 2],
    ['experiment', 2],
  ];
  return weighted.reduce((sum, [term, weight]) => sum + (lower.includes(term) ? weight : 0), 0);
}

function whoShouldCare(topics: string[]): string {
  if (topics.includes('seascape')) return 'Sawyer, Seascape operators, and anyone changing guest/owner workflows.';
  if (topics.includes('gbrain') || topics.includes('agents')) return 'Sawyer and agents working on GBrain, retrieval, evals, or workflow automation.';
  if (topics.includes('proof') || topics.includes('spend')) return 'Sawyer when deciding whether a claim deserves a bounded experiment.';
  return 'Skim only unless the source connects to an active project.';
}

function bulletRank<T>(items: T[], render: (item: T, index: number) => string): string[] {
  return items.length > 0 ? items.map((item, index) => `- ${render(item, index)}`) : ['- No items available.'];
}

function briefBucket(
  reviewed: Array<{ item: CorpusItem; digest: TranscriptDigest }>,
  key: 'seascape' | 'gbrainAgents' | 'operatingSystem',
): string[] {
  const lines = reviewed
    .filter(({ digest }) => digest.relevance[key].length > 0)
    .slice(0, 5)
    .map(({ item, digest }) => `- ${sourceLink(item)} - Inference: ${digest.relevance[key].join('; ')}.`);
  return lines.length > 0 ? lines : ['- No direct match in the deterministic transcript pass.'];
}

function flatClaims(
  reviewed: Array<{ item: CorpusItem; digest: TranscriptDigest }>,
  key: 'strongClaims' | 'hypeCaveats' | 'nextActions',
  fallback: string,
): string[] {
  const lines = reviewed.flatMap(({ item, digest }) =>
    digest.relevance[key].map((claim) => `- ${sourceLink(item)} - ${claim}.`),
  ).slice(0, 8);
  return lines.length > 0 ? lines : [fallback];
}

function sourceGaps(manifest: CorpusManifest, reviewed: Array<{ item: CorpusItem; digest: TranscriptDigest }>): string[] {
  const gaps = [...manifest.warnings];
  const noUrls = reviewed.filter(({ item }) => !item.canonical_url).length;
  const noSegments = reviewed.filter(({ item }) => !item.segments_available).length;
  if (noUrls > 0) gaps.push(`${noUrls} item(s) lack canonical URLs.`);
  if (noSegments > 0) gaps.push(`${noSegments} item(s) lack timestamped segments.`);
  gaps.push('Sawyer personalization retrieval was not run in this deterministic v1 pass.');
  return gaps.map((gap) => `- ${gap}`);
}

function sourceLink(item: CorpusItem): string {
  const label = escapeMarkdownInline(item.title);
  const url = safeMarkdownUrl(item.canonical_url);
  return url ? `[${label}](${url})` : label;
}

function scoreLabel(score: number): string {
  if (score >= 8) return 'high Sawyer signal';
  if (score >= 4) return 'medium Sawyer signal';
  return 'low Sawyer signal';
}

function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function safeMarkdownUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (/[\u0000-\u001F\s]/.test(value)) return null;
    return value.replace(/\\/g, '%5C').replace(/\)/g, '%29');
  } catch {
    return null;
  }
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1');
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
