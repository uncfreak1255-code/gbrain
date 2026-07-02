import {
  DEFAULT_CODEX_CLOSEOUT_DIR,
  planPromotedEventFeed,
} from '../core/promoted-events.ts';
import {
  DEFAULT_SEASCAPE_ANALYTICS_STATUS_DIR,
  DEFAULT_SEASCAPE_OPS_SNAPSHOT_DIR,
} from '../core/seascape-collector.ts';

interface PromotedEventsArgs {
  subcmd: 'plan' | 'help';
  json: boolean;
  seascapeOpsSnapshotDir: string;
  seascapeAnalyticsStatusDir: string;
  codexCloseoutDir: string;
  codexCloseoutLimit: number;
}

const HELP = `Usage: gbrain promoted-events plan [options]

Plan a small promoted-event feed from already-screened receipts. This is
read-only: it reports candidate event rows with date, entity, event,
source receipt, and wikilinks, but does not write pages or timeline rows.

Options:
  --seascape-ops-snapshot-dir PATH       Hostaway snapshot directory
  --seascape-analytics-status-dir PATH   seascape-analytics docs/status directory
  --codex-closeout-dir PATH              Codex closeout receipts directory
  --codex-closeout-limit N               Max timestamped closeout receipts (default 25)
  --json                                 JSON output
  --help                                 Show this help

Defaults:
  seascape ops snapshots: ${DEFAULT_SEASCAPE_OPS_SNAPSHOT_DIR}
  seascape analytics status: ${DEFAULT_SEASCAPE_ANALYTICS_STATUS_DIR}
  codex closeouts: ${DEFAULT_CODEX_CLOSEOUT_DIR}
`;

export async function runPromotedEvents(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.subcmd === 'help') {
    console.log(HELP);
    return;
  }
  const plan = planPromotedEventFeed({
    seascapeOpsSnapshotDir: parsed.seascapeOpsSnapshotDir,
    seascapeAnalyticsStatusDir: parsed.seascapeAnalyticsStatusDir,
    codexCloseoutDir: parsed.codexCloseoutDir,
    codexCloseoutLimit: parsed.codexCloseoutLimit,
  });
  if (parsed.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`status: ${plan.status}`);
  console.log(`event candidates: ${plan.event_count}`);
  console.log(`seascape ops: ${plan.inputs.seascape_ops_snapshot_dir}`);
  console.log(`seascape analytics: ${plan.inputs.seascape_analytics_status_dir}`);
  console.log(`codex closeouts: ${plan.inputs.codex_closeout_dir}`);
  for (const event of plan.events.slice(0, 20)) {
    console.log(`- ${event.date} ${event.entity}: ${event.event}`);
  }
  if (plan.warnings.length > 0) {
    console.log('warnings:');
    for (const warning of plan.warnings) console.log(`  - ${warning}`);
  }
}

function parseArgs(args: string[]): PromotedEventsArgs {
  const out: PromotedEventsArgs = {
    subcmd: (args[0] as PromotedEventsArgs['subcmd']) ?? 'help',
    json: false,
    seascapeOpsSnapshotDir: DEFAULT_SEASCAPE_OPS_SNAPSHOT_DIR,
    seascapeAnalyticsStatusDir: DEFAULT_SEASCAPE_ANALYTICS_STATUS_DIR,
    codexCloseoutDir: DEFAULT_CODEX_CLOSEOUT_DIR,
    codexCloseoutLimit: 25,
  };
  if (out.subcmd !== 'plan') out.subcmd = 'help';
  for (let i = 1; i < args.length; i++) {
    const current = args[i];
    const next = args[i + 1];
    if (current === '--help' || current === '-h') out.subcmd = 'help';
    else if (current === '--json') out.json = true;
    else if (current === '--seascape-ops-snapshot-dir' && next) { out.seascapeOpsSnapshotDir = next; i++; }
    else if (current === '--seascape-analytics-status-dir' && next) { out.seascapeAnalyticsStatusDir = next; i++; }
    else if (current === '--codex-closeout-dir' && next) { out.codexCloseoutDir = next; i++; }
    else if (current === '--codex-closeout-limit' && next) { out.codexCloseoutLimit = positiveInt(next, '--codex-closeout-limit'); i++; }
  }
  return out;
}

function positiveInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}

export const __testing = {
  parseArgs,
};
