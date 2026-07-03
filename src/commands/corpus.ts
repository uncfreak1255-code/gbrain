import type { BrainEngine } from '../core/engine.ts';
import { ingestCorpusInput, inspectCorpusInput } from '../core/corpus.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

const HELP = `gbrain corpus — inspect and prepare large source corpora for Sawyer-shaped briefs

USAGE
  gbrain corpus inspect <url-or-path> [--json] [--limit N]
  gbrain corpus ingest <url-or-path> --source <source-id> --out <dir> --json
  gbrain corpus review <corpus-id> --source <source-id> --json
  gbrain corpus brief <corpus-id> --profile sawyer --json

V1 STATUS
  inspect is implemented for local transcript directories and YouTube playlist
  metadata. ingest is implemented for local transcript directories only.
  review/brief are reserved command shapes and currently return a clear
  not-implemented error instead of doing partial hidden work.

EXAMPLES
  gbrain corpus inspect ./ai-engineer-fair-transcripts --json
  gbrain corpus inspect "https://www.youtube.com/playlist?list=..." --json
`;

interface ParsedFlags {
  json: boolean;
  limit?: number;
  source?: string;
  out?: string;
}

export async function runCorpus(_engine: BrainEngine | null, args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const [subcommand, input] = args;
  if (subcommand !== 'inspect' && subcommand !== 'ingest') {
    console.error(
      `gbrain corpus ${subcommand ?? ''} is not implemented yet. ` +
        'Use "gbrain corpus inspect <url-or-path> --json" or local-directory "gbrain corpus ingest".',
    );
    setCliExitVerdict(2);
    return;
  }
  if (!input || input.startsWith('--')) {
    console.error(`Usage: gbrain corpus ${subcommand} <url-or-path> [--json] [--limit N]`);
    setCliExitVerdict(2);
    return;
  }

  const flags = parseFlags(args.slice(2));
  if (subcommand === 'ingest') {
    if (!flags.source || !flags.out) {
      console.error('Usage: gbrain corpus ingest <url-or-path> --source <source-id> --out <dir> [--json] [--limit N]');
      setCliExitVerdict(2);
      return;
    }
    try {
      const result = await ingestCorpusInput(input, {
        sourceId: flags.source,
        outDir: flags.out,
        maxItems: flags.limit,
      });
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printHumanIngest(result);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      setCliExitVerdict(1);
    }
    return;
  }

  try {
    const inspection = await inspectCorpusInput(input, { maxItems: flags.limit });
    if (flags.json) {
      console.log(JSON.stringify(inspection, null, 2));
      return;
    }
    printHumanInspection(inspection);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    setCliExitVerdict(1);
  }
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    if (arg === '--limit') {
      const n = Number(args[++i]);
      if (Number.isInteger(n) && n > 0) flags.limit = n;
      continue;
    }
    if (arg === '--source') {
      flags.source = args[++i];
      continue;
    }
    if (arg === '--out') {
      flags.out = args[++i];
    }
  }
  return flags;
}

function printHumanInspection(inspection: Awaited<ReturnType<typeof inspectCorpusInput>>): void {
  console.log(`${inspection.title}`);
  console.log(`kind: ${inspection.kind}`);
  console.log(`corpus: ${inspection.corpus_id}`);
  console.log(`items: ${inspection.item_count}`);
  if (inspection.warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const warning of inspection.warnings) console.log(`- ${warning}`);
  }
  if (inspection.items.length > 0) {
    console.log('');
    console.log('Items:');
    for (const item of inspection.items.slice(0, 10)) {
      const duration = item.duration_seconds === null ? '' : ` (${Math.round(item.duration_seconds)}s)`;
      console.log(`- ${item.title}${duration}`);
    }
    if (inspection.items.length > 10) {
      console.log(`... ${inspection.items.length - 10} more`);
    }
  }
  console.log('');
  console.log('Next:');
  for (const command of inspection.next_supported_commands) console.log(`- ${command}`);
}

function printHumanIngest(result: Awaited<ReturnType<typeof ingestCorpusInput>>): void {
  console.log(`corpus: ${result.corpus_id}`);
  console.log(`source: ${result.source_id}`);
  console.log(`out: ${result.out_dir}`);
  console.log(`manifest: ${result.manifest_path}`);
  console.log(`pages: ${result.pages_written.length}`);
  console.log(`transcripts: ${result.transcripts_written.length}`);
}
