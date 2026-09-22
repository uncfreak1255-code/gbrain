import type { BrainEngine } from '../core/engine.ts';
import type { MinionJobContext } from '../core/minions/types.ts';

type GlobalMaintenanceJob = Pick<MinionJobContext, 'id' | 'data' | 'signal' | 'deadlineAtMs'>;

// Scope answers "where/how often does this phase run?"; it does not answer
// "can this phase write through managed persistence?"  Keep this allowlist
// deliberately narrow: `orphans` is an audited read-only scan. Every other
// global/mixed phase needs an explicit coordinated-writer path before it can
// join managed Autopilot maintenance.
const MANAGED_COMPATIBLE_MAINTENANCE_PHASES = new Set<string>(['orphans']);

function isWriterCoordinatorFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const error = value as { code?: unknown; message?: unknown };
  return error.code === 'writer_coordinator_required'
    || (typeof error.message === 'string' && error.message.includes('writer_coordinator_required'));
}

function reportHasWriterCoordinatorFailure(report: { phases: Array<{ status: string; error?: unknown }> }): boolean {
  return report.phases.some((phase) => phase.status === 'fail' && isWriterCoordinatorFailure(phase.error));
}

/** Run brain-wide Autopilot maintenance without bypassing managed-writer ownership. */
export async function runAutopilotGlobalMaintenance(engine: BrainEngine, job: GlobalMaintenanceJob) {
  const { runCycle, MAINTENANCE_PHASES, LAST_GLOBAL_AT_KEY } = await import('../core/cycle.ts');
  const repoPath = typeof job.data.repoPath === 'string'
    ? job.data.repoPath
    : (await engine.getConfig('sync.repo_path')) ?? null;

  // Queued payloads are machine-authored too. Intersect them with the global
  // lane so stale or remote-submitted data cannot run source-scoped phases.
  const maintenanceSet = new Set<string>(MAINTENANCE_PHASES);
  const requested = Array.isArray(job.data.phases)
    ? (job.data.phases as string[]).filter((phase) => maintenanceSet.has(phase))
    : MAINTENANCE_PHASES;
  const phases = (requested.length > 0 ? requested : MAINTENANCE_PHASES) as typeof MAINTENANCE_PHASES;

  const { managedPersistenceEnabled } = await import('../core/persistence/ownership.ts');
  let persistenceStateReadFailed = false;
  let managed = true;
  try {
    managed = await managedPersistenceEnabled(engine);
  } catch {
    // An unavailable ownership read must not reopen legacy writers. Compatible
    // global phases remain useful and do not depend on that legacy write path.
    persistenceStateReadFailed = true;
  }

  let phasesRejectedByPersistence = managed
    ? phases.filter((phase) => !MANAGED_COMPATIBLE_MAINTENANCE_PHASES.has(phase))
    : [];
  let effectivePhases = phases.filter((phase) => !phasesRejectedByPersistence.includes(phase));
  const skipped = (extra: Record<string, unknown> = {}) => ({
    partial: false,
    status: 'skipped',
    report: {
      reason: 'all_phases_rejected_by_persistence',
      phases_rejected_by_persistence: phasesRejectedByPersistence,
      ...extra,
    },
    phases_rejected_by_persistence: phasesRejectedByPersistence,
    ...extra,
  });
  if (effectivePhases.length === 0) {
    return skipped(persistenceStateReadFailed ? { persistence_state_read_failed: true } : {});
  }

  const runSelectedPhases = (selectedPhases: typeof MAINTENANCE_PHASES) => runCycle(engine, {
    brainDir: repoPath,
    pull: false,
    signal: job.signal,
    deadlineAtMs: job.deadlineAtMs,
    // Private child queues need the owning job id for immediate recovery.
    privateQueueOwnerJobId: job.id,
    phases: selectedPhases,
    forceGlobalOrphans: true,
    yieldBetweenPhases: async () => { await new Promise<void>((resolve) => setImmediate(resolve)); },
  });

  let persistenceTransitionRecovered = false;
  const hasGuardedPhase = () => effectivePhases.some(
    (phase) => !MANAGED_COMPATIBLE_MAINTENANCE_PHASES.has(phase),
  );
  const recoverManagedTransition = async () => {
    phasesRejectedByPersistence = phases.filter((phase) => !MANAGED_COMPATIBLE_MAINTENANCE_PHASES.has(phase));
    effectivePhases = phases.filter((phase) => MANAGED_COMPATIBLE_MAINTENANCE_PHASES.has(phase));
    if (effectivePhases.length === 0) return null;
    persistenceTransitionRecovered = true;
    return runSelectedPhases(effectivePhases);
  };
  let report;
  try {
    report = await runSelectedPhases(effectivePhases);
  } catch (error) {
    // Activation can race the initial read. The legacy writer's own fence stays
    // authoritative; recover the durable job with only compatible phases.
    if (!isWriterCoordinatorFailure(error) || !hasGuardedPhase()) {
      throw error;
    }
    const recovered = await recoverManagedTransition();
    if (!recovered) return skipped({ persistence_transition_recovered: true });
    report = recovered;
  }

  // Some phase runners intentionally turn errors into failed phase records so
  // one maintenance pass can report every problem. Treat the writer fence the
  // same as a thrown fence: it is an activation race, not a completed pass.
  if (reportHasWriterCoordinatorFailure(report) && hasGuardedPhase()) {
    const recovered = await recoverManagedTransition();
    if (!recovered) return skipped({ persistence_transition_recovered: true });
    report = recovered;
  }

  const incompleteMixedPhase = report.phases.some((phase) => {
    if (phase.status === 'fail') return true;
    if (phase.phase !== 'synthesize' && phase.phase !== 'patterns') return false;
    if (phase.details.reason === 'insufficient_cycle_budget') return true;
    if (phase.phase === 'patterns') {
      return typeof phase.details.child_outcome === 'string' && phase.details.child_outcome !== 'completed';
    }
    const synthesis = phase.details.synthesis as { non_completed_jobs?: number } | undefined;
    const triage = phase.details.triage as { deferred?: number } | undefined;
    return (synthesis?.non_completed_jobs ?? 0) > 0
      || (triage?.deferred ?? 0) > 0
      || (Array.isArray(phase.details.budget_deferred_transcripts)
        && phase.details.budget_deferred_transcripts.length > 0);
  });
  if ((report.status === 'ok' || report.status === 'clean' || report.status === 'partial')
    && !incompleteMixedPhase && report.reason !== 'aborted' && report.reason !== 'lock_stolen') {
    try {
      await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date().toISOString());
    } catch (error) {
      console.warn(`[autopilot-global-maintenance] failed to stamp last_global_at: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    partial: report.status === 'partial' || report.status === 'failed',
    status: report.status,
    report,
    ...(phasesRejectedByPersistence.length > 0
      ? { phases_rejected_by_persistence: phasesRejectedByPersistence }
      : {}),
    ...(persistenceStateReadFailed ? { persistence_state_read_failed: true } : {}),
    ...(persistenceTransitionRecovered ? { persistence_transition_recovered: true } : {}),
  };
}
