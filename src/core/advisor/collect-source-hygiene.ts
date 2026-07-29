import type { SourceHygienePacket } from '../source-hygiene.ts';
import type { AdvisorCollector, AdvisorFinding } from './types.ts';

export function sourceHygieneFindings(packet: SourceHygienePacket): AdvisorFinding[] {
  const findings: AdvisorFinding[] = [];
  for (const source of packet.sources) {
    if (source.classification === 'recovery_required') {
      const protectedData = source.source_id === 'default' || (source.dependent_row_count ?? 0) > 0;
      const actionableManagedRecovery =
        source.recovery_mode === 'managed_clone_sync' &&
        source.safe_for_agent_review &&
        source.proposed_command_argv !== null;
      findings.push({
        id: `source_recovery_required:${source.source_id}`,
        severity: protectedData ? 'critical' : 'warn',
        title: `Recover source ${source.source_id} before sync or paid work.`,
        detail: source.recovery_mode === 'managed_clone_sync'
          ? 'This is a managed checkout with trusted recovery metadata; sync is allowed only after the current evidence remains clear.'
          : 'This source contains data or lacks enough proof for automatic cleanup. Preserve it and restore its checkout manually.',
        fix: { command_argv: source.proposed_command_argv },
        collector: 'source_hygiene',
        ask_user: !actionableManagedRecovery,
        workspace_dependent: true,
      });
    } else if (source.classification === 'archive_candidate') {
      findings.push({
        id: `source_archive_candidate:${source.source_id}`,
        severity: 'warn',
        title: `Review empty missing source ${source.source_id} for soft archive.`,
        detail: 'An agent should try to disprove the zero-content evidence, archive at most one source, then reread state. Never purge automatically; archive is reversible for 72 hours.',
        fix: { command_argv: source.proposed_command_argv },
        collector: 'source_hygiene',
        ask_user: false,
        workspace_dependent: true,
      });
    }
  }
  return findings;
}

export const collectSourceHygiene: AdvisorCollector = {
  id: 'source_hygiene',
  async collect(ctx) {
    // Trust boundary: return before importing or calling any filesystem helper.
    if (ctx.remote !== false) return [];
    const { inspectSourceHygiene } = await import('../source-hygiene.ts');
    const packet = await inspectSourceHygiene(ctx.engine, { inspectFilesystem: true });
    return sourceHygieneFindings(packet);
  },
};
