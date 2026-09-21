import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';

export type AutopilotLockHolder =
  | { state: 'dead' }
  | { state: 'self' }
  | { state: 'alive-autopilot' }
  | { state: 'alive-foreign' }
  | { state: 'alive-unknown' };

export interface AutopilotLockProbeDeps {
  isPidAlive?: (pid: number) => boolean;
  readProcessCommand?: (pid: number) => string | null;
  readProcessExecutable?: (pid: number) => string | null;
}

function readCommandToken(command: string, start: number): { value: string; next: number } | null {
  let index = start;
  while (index < command.length && /\s/.test(command[index])) index++;
  if (index >= command.length) return null;
  if (command[index] === '"') {
    const end = command.indexOf('"', index + 1);
    if (end < 0) return null;
    return { value: command.slice(index + 1, end), next: end + 1 };
  }
  let end = index;
  while (end < command.length && !/\s/.test(command[end])) end++;
  return { value: command.slice(index, end), next: end };
}

/** Require the exact release entrypoint immediately before the autopilot
 * subcommand. Basename-only matching is intentionally insufficient: an
 * arbitrary /tmp/gbrain must not authenticate a zero-spend receipt. */
export function commandMatchesAutopilotEntrypoint(
  command: string,
  entrypoint: string,
  launcher: string,
): boolean {
  const normalizedCommand = command.replace(/\\/g, '/').trim();
  const normalizedEntrypoint = entrypoint.replace(/\\/g, '/').trim();
  const normalizedLauncher = launcher.replace(/\\/g, '/').trim();
  if (!normalizedEntrypoint.startsWith('/') || !normalizedLauncher.startsWith('/')) return false;
  const first = readCommandToken(normalizedCommand, 0);
  if (first === null) return false;
  const entry = first.value === normalizedLauncher
    ? readCommandToken(normalizedCommand, first.next)
    : first;
  if (entry === null || entry.value !== normalizedEntrypoint) return false;
  const subcommand = readCommandToken(normalizedCommand, entry.next);
  return subcommand?.value === 'autopilot';
}

export function verifyAutopilotRuntimeOwner(
  pid: number,
  entrypoint: string,
  launcher: string,
  deps: AutopilotLockProbeDeps = {},
): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const probeAlive = deps.isPidAlive ?? isPidAlive;
  if (!probeAlive(pid)) return false;
  const command = (deps.readProcessCommand ?? readProcessCommand)(pid);
  if (command === null || !commandMatchesAutopilotEntrypoint(command, entrypoint, launcher)) return false;
  const executable = (deps.readProcessExecutable ?? readProcessExecutable)(pid);
  if (executable === null) return false;
  const normalizedExecutable = executable.replace(/\\/g, '/');
  return normalizedExecutable === launcher.replace(/\\/g, '/')
    || normalizedExecutable === entrypoint.replace(/\\/g, '/');
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ProcessCommandProbeDeps {
  /** Injected for tests; defaults to fs.readFileSync of /proc/<pid>/cmdline. */
  readCmdlineFile?: (path: string) => Buffer | string;
  /** Injected for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Injected for tests; defaults to child_process.execFileSync (ps / powershell). */
  execFile?: (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string;
}

/**
 * Best-effort process command lookup. On Linux, /proc/<pid>/cmdline is read
 * first (no subprocess, works even when `ps` is unavailable or restricted —
 * e.g. minimal containers), falling back to `ps -o args=` elsewhere (#4300).
 * Windows has neither /proc nor `ps`, so it asks CIM via powershell instead
 * (#4563) — without this every holder classified as alive-unknown there.
 */
export function readProcessCommand(pid: number, deps: ProcessCommandProbeDeps = {}): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const exec = deps.execFile ?? execFileSync;
  if ((deps.platform ?? process.platform) === 'win32') {
    // Get-CimInstance, not wmic (removed on Win11 24H2). pid is validated
    // finite/positive above, so the WQL filter is injection-safe. Return
    // early: the POSIX probes below are guaranteed to throw on Windows.
    try {
      const out = exec('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  }
  const readCmdline = deps.readCmdlineFile ?? readFileSync;
  try {
    const raw = readCmdline(`/proc/${pid}/cmdline`);
    // argv is NUL-separated with a trailing NUL; normalize to a space-joined line.
    const cmd = raw.toString().split('\0').filter((part) => part.length > 0).join(' ').trim();
    if (cmd.length > 0) return cmd;
  } catch {
    // Not Linux (no /proc) or unreadable — fall through to ps.
  }
  try {
    const out = exec('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** OS-reported executable identity, independent of forgeable argv[0]. */
export function readProcessExecutable(pid: number, deps: ProcessCommandProbeDeps = {}): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const platform = deps.platform ?? process.platform;
  const exec = deps.execFile ?? execFileSync;
  if (platform === 'win32') {
    try {
      const out = exec('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty ExecutablePath`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim();
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  }
  if (platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
  }
  try {
    const out = exec('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    const executable = out.split(/\r?\n/).find((line) => line.startsWith('n/'))?.slice(1) ?? '';
    return executable.length > 0 ? executable : null;
  } catch {
    return null;
  }
}

export function looksLikeGbrainAutopilotCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, '/').trim();
  // Bind the ownership signal to the command shape, not mere word presence.
  // `gbrain status autopilot` is a client process and must never authenticate
  // as the long-lived `gbrain autopilot` lock holder.
  const packaged = /(?:^|\s)(?:"(?:[^"]*\/)?gbrain(?:\.exe)?"|(?:\S*\/)?gbrain(?:\.exe)?)\s+autopilot(?:\s|$)/i;
  const sourceCli = /(?:^|\s)(?:"[^"]*(?:\/|^)cli\.(?:ts|js|mjs)"|\S*(?:\/|^)cli\.(?:ts|js|mjs))\s+autopilot(?:\s|$)/i;
  return packaged.test(normalized) || sourceCli.test(normalized);
}

export function classifyAutopilotLockHolder(
  pid: number,
  currentPid: number = process.pid,
  deps: AutopilotLockProbeDeps = {},
): AutopilotLockHolder {
  if (!Number.isFinite(pid) || pid <= 0) return { state: 'dead' };
  if (pid === currentPid) return { state: 'self' };

  const probeAlive = deps.isPidAlive ?? isPidAlive;
  if (!probeAlive(pid)) return { state: 'dead' };

  const probeCommand = deps.readProcessCommand ?? readProcessCommand;
  const command = probeCommand(pid);
  if (command === null) return { state: 'alive-unknown' };
  return looksLikeGbrainAutopilotCommand(command)
    ? { state: 'alive-autopilot' }
    : { state: 'alive-foreign' };
}
