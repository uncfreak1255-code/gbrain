import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';

export type AutopilotLockHolder =
  | { state: 'dead' }
  | { state: 'self' }
  | { state: 'alive-autopilot' }
  | { state: 'alive-foreign' }
  | { state: 'alive-unknown' };

export interface AutopilotLockProbeDeps {
  isPidAlive?: (pid: number) => boolean;
  readProcessCommand?: (pid: number) => string | null;
  readProcessArgv?: (pid: number) => string[] | null;
  readProcessExecutable?: (pid: number) => string | null;
  readProcessParentPid?: (pid: number) => number | null;
  /** Injected for tests; defaults to realpathSync and fails closed on error. */
  resolveCanonicalPath?: (path: string) => string | null;
}

function readCommandToken(command: string, start: number): { value: string; next: number } | null {
  let index = start;
  while (index < command.length && /\s/.test(command[index])) index++;
  if (index >= command.length) return null;
  if (command[index] === '"') {
    const end = command.indexOf('"', index + 1);
    if (end < 0) return null;
    if (end + 1 < command.length && !/\s/.test(command[end + 1])) return null;
    return { value: command.slice(index + 1, end), next: end + 1 };
  }
  let end = index;
  while (end < command.length && !/\s/.test(command[end])) end++;
  return { value: command.slice(index, end), next: end };
}

function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isAbsoluteFsPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function isCompiledLauncherName(name: string | undefined): boolean {
  return name === 'gbrain' || name === 'gbrain.exe';
}

function isRuntimeLauncherName(name: string | undefined): boolean {
  return name === 'bun' || name === 'bun.exe' || name === 'node' || name === 'node.exe';
}

function defaultResolveCanonicalPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function resolveNormalizedPath(
  path: string,
  resolveCanonicalPath: (path: string) => string | null,
): string | null {
  const resolved = resolveCanonicalPath(path);
  return resolved === null ? null : normalizeFsPath(resolved);
}

function canonicalPathsEqual(
  left: string,
  right: string,
  resolveCanonicalPath: (path: string) => string | null,
): boolean {
  const normalizedLeft = normalizeFsPath(left);
  const normalizedRight = normalizeFsPath(right);
  if (normalizedLeft === normalizedRight) return true;
  const resolvedLeft = isAbsoluteFsPath(normalizedLeft)
    ? resolveNormalizedPath(left, resolveCanonicalPath)
    : null;
  if (resolvedLeft === normalizedRight) return true;
  const resolvedRight = isAbsoluteFsPath(normalizedRight)
    ? resolveNormalizedPath(right, resolveCanonicalPath)
    : null;
  return resolvedLeft !== null && resolvedLeft === resolvedRight;
}

function launcherTokenMatches(
  token: string,
  expectedLauncher: string,
  resolveCanonicalPath: (path: string) => string | null,
): boolean {
  if (canonicalPathsEqual(token, expectedLauncher, resolveCanonicalPath)) return true;
  const launcherName = normalizeFsPath(expectedLauncher).split('/').at(-1)?.toLowerCase();
  const tokenName = normalizeFsPath(token);
  // `#!/usr/bin/env bun` leaves argv[0] as the runtime basename. Bind this
  // only to bun/node — a compiled gbrain launcher still requires its path.
  return isRuntimeLauncherName(launcherName)
    && !tokenName.includes('/')
    && tokenName.toLowerCase() === launcherName;
}

function scriptTokenMatches(
  token: string | undefined,
  expectedEntrypoint: string,
  resolveCanonicalPath: (path: string) => string | null,
): boolean {
  if (token === undefined) return false;
  return canonicalPathsEqual(token, expectedEntrypoint, resolveCanonicalPath);
}

function argvMatchesReleaseCommand(
  argv: string[],
  entrypoint: string,
  launcher: string,
  command: readonly string[],
  resolveCanonicalPath: (path: string) => string | null,
): boolean {
  const commandAt = (index: number): boolean =>
    command.every((part, offset) => argv[index + offset] === part);
  const launcherName = normalizeFsPath(launcher).split('/').at(-1)?.toLowerCase();
  const compiledLauncher = isCompiledLauncherName(launcherName);
  return (scriptTokenMatches(argv[0], entrypoint, resolveCanonicalPath) && commandAt(1))
    || (launcherTokenMatches(argv[0] ?? '', launcher, resolveCanonicalPath)
      && scriptTokenMatches(argv[1], entrypoint, resolveCanonicalPath)
      && commandAt(2))
    || (compiledLauncher
      && launcherTokenMatches(argv[0] ?? '', launcher, resolveCanonicalPath)
      && commandAt(1));
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

/** Kernel argv for the documented `bun install -g` shim is
 * `["bun", "~/.bun/bin/gbrain", "autopilot", ...]`. Accept that only when the
 * shim's canonical target is the status-process entrypoint. */
export function argvMatchesAutopilotEntrypoint(
  argv: string[],
  entrypoint: string,
  launcher: string,
  resolveCanonicalPath: (path: string) => string | null = defaultResolveCanonicalPath,
): boolean {
  return argvMatchesReleaseCommand(
    argv,
    entrypoint,
    launcher,
    ['autopilot'],
    resolveCanonicalPath,
  );
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
  const argv = (deps.readProcessArgv ?? readProcessArgv)(pid);
  const resolveCanonicalPath = deps.resolveCanonicalPath ?? defaultResolveCanonicalPath;
  if (argv === null || !argvMatchesAutopilotEntrypoint(argv, entrypoint, launcher, resolveCanonicalPath)) return false;
  const executable = (deps.readProcessExecutable ?? readProcessExecutable)(pid);
  if (executable === null) return false;
  const normalizedExecutable = executable.replace(/\\/g, '/');
  return normalizedExecutable === launcher.replace(/\\/g, '/')
    || normalizedExecutable === entrypoint.replace(/\\/g, '/');
}

export function verifyServiceManagedAutopilotRuntimeOwner(
  pid: number,
  servicePid: number | null,
  entrypoint: string,
  launcher: string,
  deps: AutopilotLockProbeDeps = {},
): boolean {
  if (servicePid === null || pid !== servicePid) return false;
  return verifyAutopilotRuntimeOwner(pid, entrypoint, launcher, deps);
}

export function verifyAutopilotManagedWorker(
  workerPid: number | null,
  parentPid: number,
  registeredWorkerPids: number[],
  entrypoint: string,
  launcher: string,
  deps: AutopilotLockProbeDeps = {},
): boolean {
  if (workerPid === null || workerPid <= 0) return false;
  const probeAlive = deps.isPidAlive ?? isPidAlive;
  if (!probeAlive(workerPid)) return false;
  const readParent = deps.readProcessParentPid ?? readProcessParentPid;
  if (readParent(workerPid) !== parentPid) return false;
  const readArgv = deps.readProcessArgv ?? readProcessArgv;
  return registeredWorkerPids.some((pid) => {
    if (!probeAlive(pid)) return false;
    const direct = pid === workerPid;
    if (!direct && readParent(pid) !== workerPid) return false;
    const argv = readArgv(pid);
    if (argv === null) return false;
    const executable = (deps.readProcessExecutable ?? readProcessExecutable)(pid);
    if (executable === null) return false;
    const expectedEntrypoint = normalizeFsPath(entrypoint);
    const expectedLauncher = normalizeFsPath(launcher);
    const normalizedExecutable = normalizeFsPath(executable);
    if (normalizedExecutable !== expectedLauncher && normalizedExecutable !== expectedEntrypoint) return false;
    const resolveCanonicalPath = deps.resolveCanonicalPath ?? defaultResolveCanonicalPath;
    return argvMatchesReleaseCommand(
      argv,
      entrypoint,
      launcher,
      ['jobs', 'work'],
      resolveCanonicalPath,
    );
  });
}

export function verifyAutopilotRuntimeTree(
  runtime: { pid: number | null; worker_pid: number | null } | null,
  options: {
    servicePid: number | null;
    serviceManaged: boolean;
    entrypoint: string;
    launcher: string;
    registeredWorkerPids: number[];
  },
): { ownerVerified: boolean; workerVerified: boolean } {
  if (runtime?.pid === null || runtime === null) return { ownerVerified: false, workerVerified: false };
  const ownerVerified = options.serviceManaged
    ? verifyServiceManagedAutopilotRuntimeOwner(
      runtime.pid, options.servicePid, options.entrypoint, options.launcher,
    )
    : verifyAutopilotRuntimeOwner(runtime.pid, options.entrypoint, options.launcher);
  return {
    ownerVerified,
    workerVerified: ownerVerified && verifyAutopilotManagedWorker(
      runtime.worker_pid,
      runtime.pid,
      options.registeredWorkerPids,
      options.entrypoint,
      options.launcher,
    ),
  };
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

export function readProcessArgv(pid: number, deps: ProcessCommandProbeDeps = {}): string[] | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') return readDarwinProcessArgv(pid);
  if (platform !== 'linux') return null;
  try {
    const raw = (deps.readCmdlineFile ?? readFileSync)(`/proc/${pid}/cmdline`);
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    const argv = text.split('\0');
    if (argv.at(-1) === '') argv.pop();
    return argv.length > 0 && argv.every((arg) => arg.length > 0) ? argv : null;
  } catch {
    return null;
  }
}

export function parseDarwinProcessArgs(raw: Buffer): string[] | null {
  if (raw.length < 5) return null;
  const argc = raw.readInt32LE(0);
  if (!Number.isSafeInteger(argc) || argc <= 0 || argc > 4096) return null;
  let cursor = raw.indexOf(0, 4);
  if (cursor < 0) return null;
  while (cursor < raw.length && raw[cursor] === 0) cursor++;
  const argv: string[] = [];
  for (let i = 0; i < argc; i++) {
    const end = raw.indexOf(0, cursor);
    if (end < 0) return null;
    argv.push(raw.subarray(cursor, end).toString('utf8'));
    cursor = end + 1;
  }
  return argv;
}

function readDarwinProcessArgv(pid: number): string[] | null {
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const handle = dlopen('libSystem.B.dylib', {
      sysctl: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    const mib = Buffer.alloc(12);
    mib.writeInt32LE(1, 0); // CTL_KERN
    mib.writeInt32LE(49, 4); // KERN_PROCARGS2
    mib.writeInt32LE(pid, 8);
    const output = Buffer.alloc(1024 * 1024);
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(output.length));
    const result = handle.symbols.sysctl(ptr(mib), 3, ptr(output), ptr(length), null, 0);
    const used = Number(length.readBigUInt64LE());
    if (result !== 0 || !Number.isSafeInteger(used) || used <= 0 || used > output.length) return null;
    return parseDarwinProcessArgs(output.subarray(0, used));
  } catch {
    return null;
  }
}

export function readProcessParentPid(pid: number): number | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).trim();
    const parentPid = Number(output);
    return /^[1-9]\d*$/.test(output) && Number.isSafeInteger(parentPid) ? parentPid : null;
  } catch {
    return null;
  }
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
