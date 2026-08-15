import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

export interface AutopilotLockState {
  exists: boolean;
  pid: number | null;
  running: boolean;
  fresh: boolean;
}

export type AutopilotLockDecision =
  | { action: 'acquire' }
  | { action: 'exit'; holderPid: number }
  | { action: 'takeover'; reason: 'dead' | 'stale' | 'unreadable' };

export type AutopilotInstallTarget = 'macos' | 'linux-systemd' | 'ephemeral-container' | 'linux-cron';

export interface AutopilotScheduleTargetReadback {
  target: AutopilotInstallTarget;
  installed: boolean;
  path?: string;
  active?: boolean | null;
  enabled?: boolean | null;
  detail: string;
}

export interface AutopilotScheduleReadback {
  installed: boolean;
  targets: AutopilotScheduleTargetReadback[];
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

export function decideAutopilotLockAcquisition(lock: AutopilotLockState): AutopilotLockDecision {
  if (!lock.exists) return { action: 'acquire' };
  // PID liveness is authoritative. A long synchronous phase can leave an old
  // mtime even while the holder is healthy; never start a second autopilot in
  // that case.
  if (lock.running && lock.pid !== null) return { action: 'exit', holderPid: lock.pid };
  if (lock.pid !== null) return { action: 'takeover', reason: 'dead' };
  if (!lock.fresh) return { action: 'takeover', reason: 'stale' };
  return { action: 'takeover', reason: 'unreadable' };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function inspectAutopilotLock(
  lockPath: string,
  nowMs: number = Date.now(),
  isAlive: (pid: number) => boolean = isPidAlive,
): AutopilotLockState {
  if (!existsSync(lockPath)) {
    return { exists: false, pid: null, running: false, fresh: false };
  }

  let pid: number | null = null;
  let running = false;
  let fresh = false;

  try {
    const stat = statSync(lockPath);
    fresh = ((nowMs - stat.mtimeMs) / 60000) < 10;
  } catch {
    fresh = false;
  }

  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      pid = parsed;
      running = isAlive(parsed);
    }
  } catch {
    pid = null;
    running = false;
  }

  return { exists: true, pid, running, fresh };
}

export function autopilotPlistPath(): string {
  return join(process.env.HOME || '', 'Library', 'LaunchAgents', 'com.gbrain.autopilot.plist');
}

export function autopilotSystemdUnitPath(): string {
  return join(process.env.HOME || '', '.config', 'systemd', 'user', 'gbrain-autopilot.service');
}

export function autopilotEphemeralStartScriptPath(): string {
  return join(process.env.HOME || '', '.gbrain', 'start-autopilot.sh');
}

/**
 * Identify an automation schedule line, while leaving a status-only watchdog
 * line intact. The latter is a monitor, not an install receipt.
 */
export function crontabIndicatesAutopilotInstall(crontab: string): boolean {
  return crontab.split('\n').some((line) => {
    if (line.trimStart().startsWith('#')) return false;
    if (line.includes('autopilot-run.sh')) return true;
    return line.includes('gbrain autopilot') && !line.includes('--status');
  });
}

export function readAutopilotSchedule(timeoutMs?: number): AutopilotScheduleReadback {
  const targets: AutopilotScheduleTargetReadback[] = [];
  const home = process.env.HOME || '';
  const probeOptions = timeoutMs !== undefined && timeoutMs > 0 ? { timeout: timeoutMs } : {};

  const plist = autopilotPlistPath();
  let launchdActive: boolean | null = null;
  if (existsSync(plist)) {
    try {
      const out = execSync('launchctl list 2>/dev/null || true', { encoding: 'utf-8', ...probeOptions });
      launchdActive = out.includes('com.gbrain.autopilot');
    } catch {
      launchdActive = null;
    }
  }
  targets.push({
    target: 'macos',
    installed: existsSync(plist),
    path: plist,
    active: existsSync(plist) ? launchdActive : false,
    detail: existsSync(plist)
      ? `launchd plist present${launchdActive === null ? '' : launchdActive ? ' and loaded' : ' but not loaded'}`
      : 'launchd plist absent',
  });

  const unit = autopilotSystemdUnitPath();
  let systemdEnabled: boolean | null = null;
  let systemdActive: boolean | null = null;
  if (existsSync(unit)) {
    try {
      execSync('systemctl --user is-enabled --quiet gbrain-autopilot.service', { stdio: 'pipe', timeout: Math.min(timeoutMs ?? 3000, 3000) });
      systemdEnabled = true;
    } catch {
      systemdEnabled = false;
    }
    try {
      execSync('systemctl --user is-active --quiet gbrain-autopilot.service', { stdio: 'pipe', timeout: Math.min(timeoutMs ?? 3000, 3000) });
      systemdActive = true;
    } catch {
      systemdActive = false;
    }
  }
  targets.push({
    target: 'linux-systemd',
    installed: existsSync(unit),
    path: unit,
    active: existsSync(unit) ? systemdActive : false,
    enabled: existsSync(unit) ? systemdEnabled : false,
    detail: existsSync(unit)
      ? `systemd user unit present${systemdEnabled === null ? '' : systemdEnabled ? ', enabled' : ', not enabled'}${systemdActive === null ? '' : systemdActive ? ', active' : ', inactive'}`
      : 'systemd user unit absent',
  });

  const startScript = autopilotEphemeralStartScriptPath();
  targets.push({
    target: 'ephemeral-container',
    installed: existsSync(startScript),
    path: startScript,
    active: null,
    detail: existsSync(startScript)
      ? 'ephemeral start script present; host bootstrap must invoke it'
      : 'ephemeral start script absent',
  });

  let cronInstalled = false;
  let cronDetail = 'crontab unavailable or no autopilot entry';
  try {
    const crontab = execSync('crontab -l 2>/dev/null || true', { encoding: 'utf-8', ...probeOptions });
    const lines = crontab.split('\n').filter((line) => crontabIndicatesAutopilotInstall(line));
    cronInstalled = crontabIndicatesAutopilotInstall(crontab);
    cronDetail = cronInstalled ? lines.map((line) => line.trim()).join(' | ') : 'no crontab autopilot entry';
  } catch {
    /* leave unavailable detail */
  }
  targets.push({
    target: 'linux-cron',
    installed: cronInstalled,
    path: join(home, '.gbrain', 'autopilot-run.sh'),
    active: cronInstalled ? null : false,
    detail: cronDetail,
  });

  return {
    installed: targets.some((target) => target.installed),
    targets,
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
