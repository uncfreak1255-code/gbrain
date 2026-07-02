import type { BrainEngine } from '../core/engine.ts';
import {
  DEFAULT_SEASCAPE_ANALYTICS_STATUS_DIR,
  DEFAULT_SEASCAPE_OPS_SNAPSHOT_DIR,
  planSeascapeIngest,
  printSeascapeSummary,
  writeSeascapeIngest,
} from '../core/seascape-collector.ts';

interface SeascapeArgs {
  subcmd: 'ingest' | 'help';
  dryRun: boolean;
  write: boolean;
  json: boolean;
  source?: string;
  opsSnapshotDir: string;
  analyticsStatusDir: string;
}

interface SeascapeDeps {
  plan?: typeof planSeascapeIngest;
  writePlan?: typeof writeSeascapeIngest;
  printSummary?: typeof printSeascapeSummary;
}

const HELP = `Usage: gbrain seascape ingest [options]

Narrow Seascape operating-memory rollup collector. Defaults to dry-run and
prints a privacy-screened V1 plan before any write.

Options:
  --ops-snapshot-dir PATH      Hostaway snapshot directory
  --analytics-status-dir PATH  seascape-analytics docs/status directory
  --write                      Write the planned rollup pages into GBrain
  --dry-run                    Print the plan only (default)
  --source ID                  Write under a specific GBrain source
  --json                       JSON output
  --help                       Show this help

Defaults:
  ops snapshots: ${DEFAULT_SEASCAPE_OPS_SNAPSHOT_DIR}
  analytics status: ${DEFAULT_SEASCAPE_ANALYTICS_STATUS_DIR}

V1 policy:
  - keeps the first cut to portfolio/property rollups plus the latest
    GA4/GSC/search/AI visibility/attribution receipts
  - skips raw guest rows, raw payment rows, message previews, and listing
    free-text fields
  - requires an explicit --source on --write so the rollups do not land in
    an accidental fallback source
`;

export async function runSeascape(engine: BrainEngine | null, args: string[], deps: SeascapeDeps = {}): Promise<void> {
  const parsed = parseArgs(args);
  const plan = deps.plan ?? planSeascapeIngest;
  const writePlan = deps.writePlan ?? writeSeascapeIngest;
  const printSummary = deps.printSummary ?? printSeascapeSummary;

  if (parsed.subcmd === 'help') {
    console.log(HELP);
    return;
  }

  const summary = plan({
    opsSnapshotDir: parsed.opsSnapshotDir,
    analyticsStatusDir: parsed.analyticsStatusDir,
  });

  if (!parsed.write || parsed.dryRun) {
    printSummary(summary, parsed.json);
    return;
  }

  if (!engine) throw new Error('gbrain seascape ingest --write requires a local engine');
  if (!parsed.source) throw new Error('gbrain seascape ingest --write requires --source <id> so the rollup lane is explicit');
  const result = await writePlan(engine, summary, { sourceId: parsed.source });
  if (parsed.json) {
    console.log(JSON.stringify({ dry_run_summary: summary, write: result }, null, 2));
    return;
  }
  printSummary(summary, false);
  console.log(`written: ${result.written}`);
  for (const slug of result.slugs) console.log(`  ${slug}`);
}

function parseArgs(args: string[]): SeascapeArgs {
  const normalized = args[0] === 'seascape' ? args.slice(1) : args;
  const out: SeascapeArgs = {
    subcmd: (normalized[0] as SeascapeArgs['subcmd']) ?? 'help',
    dryRun: true,
    write: false,
    json: false,
    opsSnapshotDir: DEFAULT_SEASCAPE_OPS_SNAPSHOT_DIR,
    analyticsStatusDir: DEFAULT_SEASCAPE_ANALYTICS_STATUS_DIR,
  };
  if (out.subcmd !== 'ingest') out.subcmd = 'help';
  for (let i = 1; i < normalized.length; i++) {
    const current = normalized[i];
    const next = normalized[i + 1];
    if (current === '--help' || current === '-h') out.subcmd = 'help';
    else if (current === '--json') out.json = true;
    else if (current === '--write') { out.write = true; out.dryRun = false; }
    else if (current === '--dry-run') { out.dryRun = true; out.write = false; }
    else if (current === '--source' && next) { out.source = next; i++; }
    else if (current === '--ops-snapshot-dir' && next) { out.opsSnapshotDir = next; i++; }
    else if (current === '--analytics-status-dir' && next) { out.analyticsStatusDir = next; i++; }
  }
  return out;
}

export const __testing = {
  parseArgs,
};
