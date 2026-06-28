import { createHash } from 'node:crypto';

import type { SeascapeLaneId } from './seascape-lanes.ts';
import { SEASCAPE_LANES } from './seascape-lanes.ts';
import type { Page } from './types.ts';

export const DEFAULT_WRITEBACK_STALE_DAYS = 30;

export type WritebackEvaluationVerdict =
  | 'candidate'
  | 'memory_only'
  | 'ambiguous_owner'
  | 'no_owner'
  | 'stale'
  | 'suppressed';

export interface WritebackProof {
  qualified: boolean;
  summary: string;
  markers: string[];
}

export interface WritebackDraft {
  writes: false;
  title: string;
  body: string;
}

export interface WritebackCandidateSource {
  slug: string;
  title: string;
  source_id: string;
}

export interface WritebackCandidate {
  schema_version: 1;
  candidate_id: string;
  owner: SeascapeLaneId;
  owner_display_name: string;
  owner_operator_alias: string;
  source: WritebackCandidateSource;
  proof: WritebackProof;
  reason: string;
  next_step: string;
  draft: WritebackDraft | null;
}

export interface WritebackEvaluation {
  verdict: WritebackEvaluationVerdict;
  candidate: WritebackCandidate | null;
  matched_owners: SeascapeLaneId[];
  proof: WritebackProof;
  reason: string | null;
  suppression_key: string | null;
}

export function evaluateSeascapeWritebackCandidate(
  page: Page,
  opts: { now?: Date; staleDays?: number } = {},
): WritebackEvaluation {
  const text = buildWritebackText(page);
  const proof = detectWritebackProof(page, text);
  const laneMatches = scoreSeascapeOwners(text)
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score);

  if (laneMatches.length === 0) {
    return {
      verdict: 'no_owner',
      candidate: null,
      matched_owners: [],
      proof,
      reason: null,
      suppression_key: null,
    };
  }

  const topScore = laneMatches[0]!.score;
  const topMatches = laneMatches.filter((match) => match.score === topScore);
  const suppressionKey = buildSuppressionKey(page, topMatches.map((match) => match.lane.id), proof);

  if (topMatches.length > 1) {
    return {
      verdict: 'ambiguous_owner',
      candidate: null,
      matched_owners: topMatches.map((match) => match.lane.id),
      proof,
      reason: 'Multiple Seascape owner lanes matched with equal confidence; fail closed instead of hinting the wrong repo.',
      suppression_key: suppressionKey,
    };
  }

  const lane = topMatches[0]!.lane;
  if (!proof.qualified) {
    return {
      verdict: 'memory_only',
      candidate: null,
      matched_owners: [lane.id],
      proof,
      reason: `${lane.display_name} matched, but the page is still memory-only and lacks enough proof markers for canon review.`,
      suppression_key: suppressionKey,
    };
  }

  const staleDays = opts.staleDays ?? DEFAULT_WRITEBACK_STALE_DAYS;
  if (isWritebackStale(page, opts.now ?? new Date(), staleDays)) {
    return {
      verdict: 'stale',
      candidate: null,
      matched_owners: [lane.id],
      proof,
      reason: `Candidate is older than ${staleDays} days and should not surface as fresh writeback work unchanged.`,
      suppression_key: suppressionKey,
    };
  }

  const candidate: WritebackCandidate = {
    schema_version: 1,
    candidate_id: `${lane.id}:${page.source_id}:${page.slug}`,
    owner: lane.id,
    owner_display_name: lane.display_name,
    owner_operator_alias: lane.operator_alias,
    source: {
      slug: page.slug,
      title: page.title,
      source_id: page.source_id,
    },
    proof,
    reason: `Traceable ${lane.operator_alias} residue is ready for human review in ${lane.display_name}.`,
    next_step: lane.default_next_step,
    draft: null,
  };

  return {
    verdict: 'candidate',
    candidate,
    matched_owners: [lane.id],
    proof,
    reason: candidate.reason,
    suppression_key: suppressionKey,
  };
}

function scoreSeascapeOwners(text: string): Array<{ lane: (typeof SEASCAPE_LANES)[number]; score: number }> {
  return SEASCAPE_LANES.map((lane) => ({
    lane,
    score: lane.candidate_matchers.reduce((sum, re) => sum + (re.test(text) ? 1 : 0), 0),
  }));
}

function detectWritebackProof(page: Page, text: string): WritebackProof {
  const frontmatterText = Object.entries(page.frontmatter ?? {})
    .map(([key, value]) => `${key}: ${formatFrontmatterValue(value)}`)
    .join('\n');
  const markers: string[] = [];
  const combined = `${frontmatterText}\n${text}`;

  if (/\b(session_id|started_at|session_started|source_path|source_hash_suffix|transcript_suffix|source_uri|ingested_via|ingested_at|Date|Repo)\b/i.test(combined)) {
    markers.push('traceability');
  }
  if (/\b(Receipt|Proof|Decision|What Happened|Source|Origin|Transcript|Readback)\b/i.test(combined)) {
    markers.push('proof');
  }

  const qualified = markers.includes('traceability') && markers.includes('proof');
  return {
    qualified,
    summary: qualified
      ? 'Traceable residue with explicit proof markers.'
      : markers.includes('traceability')
        ? 'Traceability markers exist, but proof/readback markers are still missing.'
        : 'Memory-only residue with no independent proof markers yet.',
    markers,
  };
}

function buildWritebackText(page: Page): string {
  return `${page.title}\n${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`;
}

function buildSuppressionKey(page: Page, owners: SeascapeLaneId[], proof: WritebackProof): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({
      slug: page.slug,
      source_id: page.source_id,
      owners,
      proof: proof.markers,
      title: page.title,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline,
      frontmatter: page.frontmatter ?? {},
      updated_at: page.updated_at instanceof Date ? page.updated_at.toISOString() : String(page.updated_at ?? ''),
    }))
    .digest('hex')
    .slice(0, 16);
  return `writeback:${hash}`;
}

function isWritebackStale(page: Page, now: Date, staleDays: number): boolean {
  const updated = page.updated_at instanceof Date ? page.updated_at : new Date(page.updated_at);
  if (!(updated instanceof Date) || Number.isNaN(updated.getTime())) return false;
  const ageMs = now.getTime() - updated.getTime();
  return ageMs > staleDays * 24 * 60 * 60 * 1000;
}

function formatFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatFrontmatterValue).join(', ');
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, inner]) => `${key}: ${formatFrontmatterValue(inner)}`)
      .join(', ');
  }
  if (value == null) return '';
  return String(value);
}
