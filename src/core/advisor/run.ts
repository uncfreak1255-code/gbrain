/**
 * advisor/run.ts — runs the collectors and ranks the findings.
 *
 * Hardcoded v1 collector list (open-Q4): a static array keeps ordering
 * deterministic and the surface auditable. Each collector runs in its OWN
 * try/catch so one failure never kills the whole report. Workspace-dependent
 * collectors (A1) are dropped over MCP.
 */

import type { AdvisorCollector, AdvisorContext, AdvisorFinding, AdvisorReport, AdvisorSeverity } from './types.ts';
import { collectVersion } from './collect-version.ts';
import { collectMigration } from './collect-migration.ts';
import { collectSchemaPack } from './collect-schema-pack.ts';
import { collectStalledJobs } from './collect-stalled-jobs.ts';
import { collectUsageShape } from './collect-usage-shape.ts';
import { collectSeascapeWritebacks } from './collect-seascape-writebacks.ts';
import { collectSetupSmells } from './collect-setup-smells.ts';
import { collectUninstalledBrainPack } from './collect-uninstalled-brain-pack.ts';
import { collectUninstalledBundled } from './collect-uninstalled-bundled.ts';

/** Deterministic v1 collector order (also the secondary sort key for ranking). */
export const COLLECTORS: AdvisorCollector[] = [
  collectVersion,
  collectMigration,
  collectSchemaPack,
  collectStalledJobs,
  collectUsageShape,
  collectSeascapeWritebacks,
  collectSetupSmells,
  collectUninstalledBrainPack,
  collectUninstalledBundled,
];

const SEV_RANK: Record<AdvisorSeverity, number> = { critical: 0, warn: 1, info: 2 };

/**
 * Rank: critical > warn > info, ties broken by collector order (stable). All
 * criticals are always kept; the info tail is capped so the agent isn't buried.
 */
export function rankFindings(findings: AdvisorFinding[], opts: { infoCap?: number } = {}): AdvisorFinding[] {
  const order = new Map(COLLECTORS.map((c, i) => [c.id, i] as const));
  const sorted = [...findings].sort((a, b) => {
    const s = SEV_RANK[a.severity] - SEV_RANK[b.severity];
    if (s !== 0) return s;
    return (order.get(a.collector) ?? 99) - (order.get(b.collector) ?? 99);
  });
  const infoCap = opts.infoCap ?? 10;
  const out: AdvisorFinding[] = [];
  let infoSeen = 0;
  for (const f of sorted) {
    if (f.severity === 'info') {
      if (infoSeen >= infoCap) continue;
      infoSeen++;
    }
    out.push(f);
  }
  return out;
}

/**
 * Run every collector and return a ranked report. Resilient: a collector that
 * throws contributes nothing and never aborts the others.
 */
export async function runAdvisor(
  ctx: AdvisorContext,
  opts: { collectors?: AdvisorCollector[] } = {},
): Promise<AdvisorReport> {
  const all: AdvisorFinding[] = [];
  const collectors = opts.collectors ?? COLLECTORS;
  for (const c of collectors) {
    try {
      const found = await c.collect(ctx);
      for (const f of found) {
        // A1: drop workspace-dependent findings over MCP.
        if (ctx.remote && f.workspace_dependent) continue;
        all.push(f);
      }
    } catch (err) {
      all.push({
        id: `collector_failed:${c.id}`,
        severity: 'warn',
        title: `Advisor collector "${c.id}" failed; this is not a trustworthy all-clear.`,
        detail: `Collector error: ${(err as Error).message || 'unknown error'}`,
        fix: { command_argv: null },
        collector: c.id,
        ask_user: true,
      });
    }
  }
  const ranked = rankFindings(all);
  const worst: AdvisorSeverity | null =
    ranked.some((f) => f.severity === 'critical')
      ? 'critical'
      : ranked.some((f) => f.severity === 'warn')
        ? 'warn'
        : ranked.length > 0
          ? 'info'
          : null;
  return {
    version: ctx.version,
    generated_at: ctx.now.toISOString(),
    findings: ranked,
    worst,
  };
}
