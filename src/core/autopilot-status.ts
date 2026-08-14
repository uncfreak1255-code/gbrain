import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { gbrainPath } from './config.ts';

export const AUTOPILOT_DISABLED_MARKER = 'autopilot-disabled';

export type AutopilotRuntimeState =
  | 'manual_disabled'
  | 'stale_lock'
  | 'not_installed'
  | 'running'
  | 'installed';

export type AutopilotLockStatus = 'absent' | 'running' | 'stale';

export interface AutopilotRuntimeInput {
  /** A supervisor artifact, not the lockfile, proves installation. */
  scheduleInstalled: boolean;
  lockfilePresent: boolean;
  pid: number | null;
  running: boolean;
  lockFresh: boolean;
  manualDisabledReason: string | null;
}

export interface AutopilotRuntimeStatus {
  installed: boolean;
  state: AutopilotRuntimeState;
  lock_status: AutopilotLockStatus;
  lockfile_present: boolean;
  pid: number | null;
  running: boolean;
  manual_disabled_reason: string | null;
}

/**
 * Classify the host-side automation state without treating a lock as an
 * installation receipt. A dead or unreadable lock is useful evidence of a
 * stale runtime, but it does not prove that a scheduler is installed.
 */
export function classifyAutopilotRuntime(input: AutopilotRuntimeInput): AutopilotRuntimeStatus {
  const lock_status: AutopilotLockStatus = !input.lockfilePresent
    ? 'absent'
    : input.running
      ? 'running'
      : 'stale';

  let state: AutopilotRuntimeState;
  if (input.manualDisabledReason !== null) {
    state = 'manual_disabled';
  } else if (input.running) {
    state = 'running';
  } else if (input.lockfilePresent) {
    state = 'stale_lock';
  } else if (!input.scheduleInstalled) {
    state = 'not_installed';
  } else {
    // A schedule artifact exists, but no process currently owns the lock.
    // Keep this distinct from both a stale lock and a clean machine.
    state = 'installed';
  }

  return {
    installed: input.scheduleInstalled,
    state,
    lock_status,
    lockfile_present: input.lockfilePresent,
    pid: input.pid,
    running: input.running,
    manual_disabled_reason: input.manualDisabledReason,
  };
}

export function autopilotDisabledMarkerPath(): string {
  return gbrainPath(AUTOPILOT_DISABLED_MARKER);
}

export function readManualAutomationDisabledReason(): string | null {
  try {
    const reason = readFileSync(autopilotDisabledMarkerPath(), 'utf8').trim();
    return reason || 'manual automation disabled';
  } catch {
    return null;
  }
}

export function writeManualAutomationDisabledMarker(reason = 'manual automation disabled'): void {
  const marker = autopilotDisabledMarkerPath();
  mkdirSync(gbrainPath(), { recursive: true });
  writeFileSync(marker, `${reason}\n`);
}

export function clearManualAutomationDisabledMarker(): void {
  try {
    unlinkSync(autopilotDisabledMarkerPath());
  } catch {
    /* marker absent */
  }
}

export function hasManualAutomationDisabledMarker(): boolean {
  return existsSync(autopilotDisabledMarkerPath());
}
