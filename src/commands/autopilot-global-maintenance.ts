import type { BrainEngine } from '../core/engine.ts';
import type { MinionJobContext } from '../core/minions/types.ts';

type GlobalMaintenanceJob = Pick<MinionJobContext, 'id' | 'data' | 'signal' | 'deadlineAtMs'>;

/** Run brain-wide Autopilot maintenance without bypassing managed-writer ownership. */
export async function runAutopilotGlobalMaintenance(engine: BrainEngine, job: GlobalMaintenanceJob) {
  const { runCycle, MAINTENANCE_PHASES, MIXED_PHASES, LAST_GLOBAL_AT_KEY } = await import('../core/cycle.ts');
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
  const mixedSet = new Set<string>(MIXED_PHASES);
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
    ? phases.filter((phase) => mixedSet.has(phase))
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
  let report;
  try {
    report = await runSelectedPhases(effectivePhases);
  } catch (error) {
    // Activation can race the initial read. The legacy writer's own fence stays
    // authoritative; recover the durable job with only compatible phases.
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : null;
    if (code !== 'writer_coordinator_required' || !effectivePhases.some((phase) => mixedSet.has(phase))) {
      throw error;
    }
    phasesRejectedByPersistence = phases.filter((phase) => mixedSet.has(phase));
    effectivePhases = phases.filter((phase) => !mixedSet.has(phase));
    if (effectivePhases.length === 0) {
      return skipped({ persistence_transition_recovered: true });
    }
    persistenceTransitionRecovered = true;
    report = await runSelectedPhases(effectivePhases);
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
