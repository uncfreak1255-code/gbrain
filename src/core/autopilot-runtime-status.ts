import type {
  ZeroPaidSpendFileState,
  ZeroPaidSpendWrapperDeclaration,
} from './ai/zero-paid-spend-status.ts';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export type AutopilotInstallTarget = 'macos' | 'linux-systemd' | 'ephemeral-container' | 'linux-cron';
export type AutopilotState = 'not_installed' | 'disabled' | 'paused' | 'never_run' | 'stale' | 'fresh';

export interface AutopilotRuntimeLock {
  pid: number | null;
  zero_paid_spend: boolean | null;
  managed_worker: boolean | null;
  worker_pid: number | null;
}

export function writeAutopilotRuntimeLock(
  lockPath: string,
  runtime: { zero_paid_spend: boolean; worker_pid: number | null },
  pid = process.pid,
): void {
  const payload = {
    zero_paid_spend: runtime.zero_paid_spend,
    managed_worker: runtime.worker_pid !== null,
    worker_pid: runtime.worker_pid,
  };
  writeFileSync(lockPath, `${pid}\n${JSON.stringify(payload)}\n`);
}

export function readLaunchdDisabledOverrideForLabel(label: string, uid: number): boolean | null {
  try {
    const output = execFileSync('launchctl', ['print-disabled', `gui/${uid}`], { encoding: 'utf8' });
    return parseLaunchdDisabledOverride(output, label);
  } catch {
    return null;
  }
}

export function readLaunchdJobPidForLabel(label: string, uid: number): number | null {
  try {
    const output = execFileSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8' });
    return parseLaunchdJobPid(output);
  } catch {
    return null;
  }
}

export interface AutopilotStatusReport {
  installed: boolean;
  install_target: AutopilotInstallTarget | null;
  state: AutopilotState;
  disabled_reason: string | null;
  launchd_disabled_override: boolean | null;
  paused_reason: string | null;
  heartbeat_age_seconds: number | null;
  stale_after_seconds: number;
  last_log: string;
  zero_paid_spend: {
    live_managed_worker: boolean | null;
    managed_worker: boolean | null;
    durable_autopilot: ZeroPaidSpendFileState;
    wrapper_declaration: ZeroPaidSpendWrapperDeclaration;
    configuration_consistent: boolean;
  };
}

const UNKNOWN_ZERO_SPEND_CONFIGURATION = {
  durable_autopilot: 'missing' as const,
  wrapper_declaration: 'missing' as const,
  configuration_consistent: false,
};

/** Strictly parse the PID-first lock record. Noncanonical bytes never become
 * runtime enforcement evidence; a one-line legacy PID remains readable. */
export function parseAutopilotRuntimeLock(raw: string): AutopilotRuntimeLock {
  const normalized = raw.replace(/\r?\n$/, '');
  const lines = normalized.split(/\r?\n/);
  const pid = /^[1-9]\d*$/.test(lines[0] ?? '') ? Number(lines[0]) : Number.NaN;
  const fallback: AutopilotRuntimeLock = {
    pid: Number.isSafeInteger(pid) ? pid : null,
    zero_paid_spend: null,
    managed_worker: null,
    worker_pid: null,
  };
  if (fallback.pid === null || lines.length !== 2) return fallback;
  try {
    const payload = JSON.parse(lines[1]) as unknown;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return fallback;
    const record = payload as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 3 || keys[0] !== 'managed_worker' || keys[1] !== 'worker_pid' || keys[2] !== 'zero_paid_spend') return fallback;
    if (typeof record.zero_paid_spend !== 'boolean' || typeof record.managed_worker !== 'boolean') return fallback;
    if (record.worker_pid !== null && (!Number.isSafeInteger(record.worker_pid) || (record.worker_pid as number) <= 0)) return fallback;
    if (record.managed_worker !== (record.worker_pid !== null)) return fallback;
    const canonicalPayload = JSON.stringify({
      zero_paid_spend: record.zero_paid_spend,
      managed_worker: record.managed_worker,
      worker_pid: record.worker_pid,
    });
    if (lines[1] !== canonicalPayload) return fallback;
    return {
      pid: fallback.pid,
      zero_paid_spend: record.zero_paid_spend,
      managed_worker: record.managed_worker,
      worker_pid: record.worker_pid as number | null,
    };
  } catch {
    return fallback;
  }
}

export function parseLaunchdDisabledOverride(output: string, label: string): boolean | null {
  const line = output.split(/\r?\n/).find((candidate) => candidate.includes(`"${label}"`));
  if (!line) return null;
  const match = /=>\s*(true|false|enabled|disabled)\b/.exec(line);
  if (!match) return null;
  return match[1] === 'true' || match[1] === 'disabled';
}

export function parseLaunchdJobPid(output: string): number | null {
  const match = /^\s*pid\s*=\s*([1-9]\d*)\s*$/m.exec(output);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : null;
}

export function autopilotStatusExitCode(state: AutopilotState): number {
  if (state === 'disabled') return 2;
  if (state === 'stale' || state === 'never_run' || state === 'paused') return 1;
  return 0;
}

export function classifyAutopilotStatus(input: {
  installed: boolean;
  installTarget: AutopilotInstallTarget | null;
  disabledReason: string | null;
  launchdDisabledOverride?: boolean | null;
  pausedReason?: string | null;
  heartbeatAgeSeconds: number | null;
  intervalSeconds: number;
  lastLog: string;
  runtime?: AutopilotRuntimeLock | null;
  runtimeOwnerVerified?: boolean;
  runtimeWorkerVerified?: boolean;
  zeroPaidSpendConfiguration?: typeof UNKNOWN_ZERO_SPEND_CONFIGURATION | {
    durable_autopilot: ZeroPaidSpendFileState;
    wrapper_declaration: ZeroPaidSpendWrapperDeclaration;
    configuration_consistent: boolean;
  };
}): AutopilotStatusReport {
  const staleAfter = Number.isFinite(input.intervalSeconds) && input.intervalSeconds > 0
    ? input.intervalSeconds * 6
    : 1800;
  const pausedReason = input.pausedReason ?? null;
  const launchdDisabledOverride = input.launchdDisabledOverride ?? null;
  const disabledReason = input.disabledReason ?? (
    launchdDisabledOverride === true ? 'launchd persistent disabled override is enabled' : null
  );
  let state: AutopilotState;
  if (disabledReason !== null) state = 'disabled';
  else if (!input.installed) state = 'not_installed';
  else if (pausedReason !== null) state = 'paused';
  else if (input.heartbeatAgeSeconds === null) state = 'never_run';
  else state = input.heartbeatAgeSeconds > staleAfter ? 'stale' : 'fresh';

  const configured = input.zeroPaidSpendConfiguration ?? UNKNOWN_ZERO_SPEND_CONFIGURATION;
  const runtimeOwnedAndFresh = state === 'fresh' && input.runtimeOwnerVerified === true;
  const managedWorker = runtimeOwnedAndFresh ? input.runtime?.managed_worker ?? null : null;
  return {
    installed: input.installed,
    install_target: input.installTarget,
    state,
    disabled_reason: disabledReason,
    launchd_disabled_override: launchdDisabledOverride,
    paused_reason: pausedReason,
    heartbeat_age_seconds: input.heartbeatAgeSeconds,
    stale_after_seconds: staleAfter,
    last_log: input.lastLog,
    zero_paid_spend: {
      live_managed_worker: managedWorker === true && input.runtimeWorkerVerified === true
        ? input.runtime?.zero_paid_spend ?? null
        : null,
      managed_worker: managedWorker,
      ...configured,
    },
  };
}
