import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SEASCAPE_ANALYTICS_STATUS_DIR,
  DEFAULT_SEASCAPE_OPS_SNAPSHOT_DIR,
  planSeascapeIngest,
  type SeascapeIngestPagePlan,
} from './seascape-collector.ts';

export const DEFAULT_CODEX_CLOSEOUT_DIR = join(homedir(), '.codex', 'state', 'closeout-receipts');

export interface PromotedEventCandidate {
  date: string;
  entity: string;
  event: string;
  source_receipt: string;
  wikilinks: string[];
  kind: 'seascape_rollup' | 'codex_closeout';
}

export interface PromotedEventFeedPlan {
  schema_version: 1;
  receipt_type: 'promoted_event_feed_plan';
  status: 'ready' | 'partial' | 'empty';
  generated_at: string;
  event_count: number;
  events: PromotedEventCandidate[];
  inputs: {
    seascape_ops_snapshot_dir: string;
    seascape_analytics_status_dir: string;
    codex_closeout_dir: string;
    codex_closeout_limit: number;
  };
  warnings: string[];
}

interface CloseoutReceipt {
  generated_at?: string;
  root?: string;
  invocation_root?: string;
  branch?: string;
  classification?: string;
  protected_branch?: boolean;
  staged_paths?: unknown[] | number;
  unstaged_paths?: unknown[] | number;
  untracked_paths?: unknown[] | number;
  verification?: unknown[] | number;
  verification_commands?: unknown[] | number;
  receipt_files?: {
    markdown?: string;
    json?: string;
  };
  markdown_receipt?: string;
  json_receipt?: string;
}

export function planPromotedEventFeed(opts: {
  seascapeOpsSnapshotDir?: string;
  seascapeAnalyticsStatusDir?: string;
  codexCloseoutDir?: string;
  codexCloseoutLimit?: number;
} = {}): PromotedEventFeedPlan {
  const seascapeOpsSnapshotDir = opts.seascapeOpsSnapshotDir ?? DEFAULT_SEASCAPE_OPS_SNAPSHOT_DIR;
  const seascapeAnalyticsStatusDir = opts.seascapeAnalyticsStatusDir ?? DEFAULT_SEASCAPE_ANALYTICS_STATUS_DIR;
  const codexCloseoutDir = opts.codexCloseoutDir ?? DEFAULT_CODEX_CLOSEOUT_DIR;
  const codexCloseoutLimit = opts.codexCloseoutLimit ?? 25;
  const warnings: string[] = [];

  const seascapePlan = planSeascapeIngest({
    opsSnapshotDir: seascapeOpsSnapshotDir,
    analyticsStatusDir: seascapeAnalyticsStatusDir,
  });
  warnings.push(...seascapePlan.warnings.map((warning) => `seascape: ${warning}`));

  const seascapeEvents = seascapePlan.groups.flatMap((group) =>
    group.pages.flatMap((page) => eventsFromSeascapePage(page)),
  );
  const codexEvents = eventsFromCodexCloseouts(codexCloseoutDir, codexCloseoutLimit, warnings);
  const events = [...seascapeEvents, ...codexEvents]
    .sort((a, b) => b.date.localeCompare(a.date) || a.entity.localeCompare(b.entity));

  const status: PromotedEventFeedPlan['status'] = events.length === 0
    ? 'empty'
    : warnings.length > 0 || seascapePlan.status !== 'ready'
      ? 'partial'
      : 'ready';

  return {
    schema_version: 1,
    receipt_type: 'promoted_event_feed_plan',
    status,
    generated_at: new Date().toISOString(),
    event_count: events.length,
    events,
    inputs: {
      seascape_ops_snapshot_dir: seascapeOpsSnapshotDir,
      seascape_analytics_status_dir: seascapeAnalyticsStatusDir,
      codex_closeout_dir: codexCloseoutDir,
      codex_closeout_limit: codexCloseoutLimit,
    },
    warnings,
  };
}

function eventsFromSeascapePage(page: SeascapeIngestPagePlan): PromotedEventCandidate[] {
  return (page.timeline_entries ?? []).map((entry) => {
    const [date, ...rest] = entry.split(' ');
    const event = rest.join(' ').trim();
    return {
      date: validDate(date) ? date : 'unknown',
      entity: page.slug,
      event,
      source_receipt: page.primary_source_path,
      wikilinks: unique([`[[${page.slug}]]`, ...extractWikilinks(page.summary_lines.join('\n'))]),
      kind: 'seascape_rollup' as const,
    };
  }).filter((event) => event.date !== 'unknown' && event.event.length > 0);
}

function eventsFromCodexCloseouts(dir: string, limit: number, warnings: string[]): PromotedEventCandidate[] {
  if (!existsSync(dir)) {
    warnings.push(`codex: closeout directory not found: ${dir}`);
    return [];
  }
  const files = walkJsonFiles(dir)
    .filter((file) => !file.endsWith('/latest.json'))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, Math.max(0, limit));

  const events: PromotedEventCandidate[] = [];
  for (const file of files) {
    const receipt = loadCloseout(file, warnings);
    if (!receipt) continue;
    const date = datePortion(receipt.generated_at) ?? datePortion(statSync(file).mtime.toISOString());
    if (!date) continue;
    const root = cleanString(receipt.root) || cleanString(receipt.invocation_root) || 'unknown repo';
    const repoLabel = repoLabelFromRoot(root);
    const branch = cleanString(receipt.branch) || 'unknown branch';
    const dirtyCount = countField(receipt.staged_paths) + countField(receipt.unstaged_paths) + countField(receipt.untracked_paths);
    const verificationCount = countField(receipt.verification ?? receipt.verification_commands);
    const state = dirtyCount === 0 ? 'clean' : `${dirtyCount} dirty path${dirtyCount === 1 ? '' : 's'}`;
    events.push({
      date,
      entity: repoLabel,
      event: `Closeout recorded on ${branch}: ${state}; verification commands ${verificationCount}.`,
      source_receipt: closeoutReceiptPath(receipt) || file,
      wikilinks: [`[[projects/${slugPart(repoLabel)}]]`],
      kind: 'codex_closeout',
    });
  }
  return events;
}

function walkJsonFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
    }
  }
  return out;
}

function loadCloseout(file: string, warnings: string[]): CloseoutReceipt | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CloseoutReceipt;
  } catch (error) {
    warnings.push(`codex: skipped unreadable closeout receipt ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function extractWikilinks(text: string): string[] {
  return Array.from(text.matchAll(/\[\[([^\]]+)\]\]/g), (match) => `[[${match[1]}]]`);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function countField(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

function repoLabelFromRoot(root: string): string {
  const parts = root.split('/').filter(Boolean);
  const worktreeIndex = parts.indexOf('.worktrees');
  if (worktreeIndex > 0) return parts[worktreeIndex - 1] ?? parts.at(-1) ?? root;
  return parts.at(-1) ?? root;
}

function datePortion(value?: string | null): string | null {
  const clean = cleanString(value);
  const match = clean.match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function validDate(value?: string): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function cleanString(value?: string | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function closeoutReceiptPath(receipt: CloseoutReceipt): string {
  return cleanString(receipt.receipt_files?.markdown)
    || cleanString(receipt.markdown_receipt)
    || cleanString(receipt.receipt_files?.json)
    || cleanString(receipt.json_receipt);
}

function slugPart(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'unknown';
}

export const __testing = {
  eventsFromCodexCloseouts,
  eventsFromSeascapePage,
};
