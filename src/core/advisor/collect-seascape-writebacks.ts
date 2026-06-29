import type { Page } from '../types.ts';
import { loadAllSources } from '../sources-load.ts';
import { matchSeascapeLaneForSource } from '../seascape-lanes.ts';
import { evaluateSeascapeWritebackCandidate, type WritebackCandidate } from '../writeback-candidate.ts';
import {
  applyWritebackSuppression,
  buildWritebackSuppressionEntry,
  loadWritebackSuppressionState,
  saveWritebackSuppressionState,
  upsertWritebackSuppression,
} from '../writeback-suppression.ts';
import type { AdvisorCollector, AdvisorFinding } from './types.ts';

const RECENT_WRITEBACK_WINDOW_DAYS = 30;
const MAX_SCAN_PAGES = 50;
const MAX_FINDINGS = 5;

export const collectSeascapeWritebacks: AdvisorCollector = {
  id: 'seascape-writebacks',
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];
    const sources = await loadAllSources(ctx.engine, { includeArchived: false });
    const seascapeSources = sources
      .map((source) => ({ source, lane: matchSeascapeLaneForSource(source) }))
      .filter((entry): entry is { source: (typeof sources)[number]; lane: NonNullable<typeof entry.lane> } => entry.lane !== null);

    if (seascapeSources.length === 0) return [];

    const activeLaneIds = new Set(seascapeSources.map((entry) => entry.lane.id));
    const seascapeSourceIds = new Set(seascapeSources.map((entry) => entry.source.id));
    const updatedAfter = new Date(ctx.now.getTime() - RECENT_WRITEBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const recentPages = await ctx.engine.listPages({
      limit: MAX_SCAN_PAGES,
      updated_after: updatedAfter.toISOString(),
    });
    let suppressionState = loadWritebackSuppressionState();
    let suppressionDirty = false;

    for (const page of recentPages) {
      if (!isCollectorInputPage(page, seascapeSourceIds)) continue;

      const evaluation = applyWritebackSuppression(
        evaluateSeascapeWritebackCandidate(page, { now: ctx.now, staleDays: RECENT_WRITEBACK_WINDOW_DAYS }),
        suppressionState,
      );

      if (evaluation.verdict === 'candidate' && evaluation.candidate) {
        if (!activeLaneIds.has(evaluation.candidate.owner)) continue;
        const candidate = withDryRunDraft(evaluation.candidate, page);
        findings.push({
          id: `seascape_writeback:${candidate.candidate_id}`,
          severity: 'info',
          title: `${candidate.owner_display_name}: review writeback candidate from ${candidate.source.slug}.`,
          detail: `${candidate.reason} Proof: ${candidate.proof.summary} Next: ${candidate.next_step}`,
          fix: { command_argv: null },
          collector: 'seascape-writebacks',
          ask_user: true,
          writeback_candidate: candidate,
        });
        if (findings.length >= MAX_FINDINGS) break;
        continue;
      }

      const suppressionEntry = buildWritebackSuppressionEntry(evaluation, ctx.now);
      if (suppressionEntry) {
        suppressionState = upsertWritebackSuppression(suppressionState, suppressionEntry);
        suppressionDirty = true;
      }
    }

    if (!ctx.remote && suppressionDirty) {
      saveWritebackSuppressionState(suppressionState);
    }

    return findings;
  },
};

function isCollectorInputPage(page: Page, seascapeSourceIds: Set<string>): boolean {
  if (seascapeSourceIds.has(page.source_id)) return false;
  return page.frontmatter?.dream_generated === true || page.frontmatter?.dream_generated === 'true';
}

function withDryRunDraft(candidate: WritebackCandidate, page: Page): WritebackCandidate {
  return {
    ...candidate,
    draft: {
      writes: false,
      title: `${candidate.owner_display_name} draft from ${candidate.source.title}`,
      review_command_argv: [
        'gbrain',
        'call',
        '--source',
        page.source_id,
        'get_page',
        JSON.stringify({ slug: page.slug }),
      ],
      body: [
        `# ${candidate.owner_display_name} Draft`,
        '',
        `Source page: ${candidate.source.slug}`,
        `Owner lane: ${candidate.owner_display_name} (${candidate.owner_operator_alias})`,
        `Proof: ${candidate.proof.summary}`,
        '',
        '## Proposed writeback',
        candidate.reason,
        '',
        '## Human check before any canon edit',
        candidate.next_step,
        '',
        '## Source excerpt',
        excerpt(page.compiled_truth),
      ].join('\n'),
    },
  };
}

function excerpt(text: string, maxChars = 220): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars - 3).trimEnd() + '...';
}
