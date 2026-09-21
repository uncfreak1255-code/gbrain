import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS,
  decideLockAcquisition,
  isPidAlive,
} from '../src/commands/autopilot.ts';
import {
  commandMatchesAutopilotEntrypoint,
  argvMatchesAutopilotEntrypoint,
  looksLikeGbrainAutopilotCommand,
  readProcessArgv,
  readProcessCommand,
  readProcessExecutable,
  parseDarwinProcessArgs,
  verifyAutopilotManagedWorker,
  verifyAutopilotRuntimeOwner,
  verifyServiceManagedAutopilotRuntimeOwner,
} from '../src/core/autopilot-lock.ts';

let tmp: string;
let lockPath: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-lock-'));
  lockPath = join(tmp, 'autopilot.lock');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('isPidAlive', () => {
  test('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('returns false for invalid process ids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('decideLockAcquisition', () => {
  test('acquires when no lock exists', () => {
    expect(decideLockAcquisition(lockPath, process.pid)).toEqual({ action: 'acquire' });
  });

  test('takes over a lock whose holder is dead', () => {
    writeFileSync(lockPath, '4194303');
    expect(decideLockAcquisition(lockPath, process.pid)).toEqual({
      action: 'takeover',
      reason: 'dead pid 4194303',
    });
  });

  test('keeps a lock whose holder is a live gbrain autopilot process', () => {
    writeFileSync(lockPath, '1234');
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => 'gbrain autopilot --repo repo',
    })).toEqual({
      action: 'exit',
      holderPid: 1234,
      holderState: 'alive-autopilot',
    });
  });

  test('keeps a STALE lock whose holder is a live gbrain autopilot process', () => {
    // The age gate applies only to non-autopilot holders: a genuine autopilot
    // sibling is never stolen no matter how old the lockfile mtime is.
    writeFileSync(lockPath, '1234');
    const stale = new Date(Date.now() - AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS - 1000);
    utimesSync(lockPath, stale, stale);
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => 'gbrain autopilot --repo repo',
    })).toEqual({
      action: 'exit',
      holderPid: 1234,
      holderState: 'alive-autopilot',
    });
  });

  test('keeps a fresh lock when the live PID command is unrecognized', () => {
    writeFileSync(lockPath, '1234');
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => '/sbin/launchd',
    })).toEqual({
      action: 'exit',
      holderPid: 1234,
      holderState: 'alive-foreign',
    });
  });

  test('takes over a stale lock when the PID was reused by a foreign process', () => {
    writeFileSync(lockPath, '1234');
    const stale = new Date(Date.now() - AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS - 1000);
    utimesSync(lockPath, stale, stale);
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => '/sbin/launchd',
    })).toEqual({
      action: 'takeover',
      reason: 'foreign pid 1234 with stale lock',
    });
  });

  test('keeps a FRESH lock when process identity cannot be inspected', () => {
    writeFileSync(lockPath, '1234');
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => null,
    })).toEqual({
      action: 'exit',
      holderPid: 1234,
      holderState: 'alive-unknown',
    });
  });

  test('takes over a STALE lock when process identity cannot be inspected (#4300)', () => {
    // Recycled PID after reboot on a host where the command probe fails:
    // pre-fix this exited forever (bricked daemon). alive-unknown now shares
    // the alive-foreign age gate.
    writeFileSync(lockPath, '1234');
    const stale = new Date(Date.now() - AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS - 1000);
    utimesSync(lockPath, stale, stale);
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => null,
    })).toEqual({
      action: 'takeover',
      reason: 'unidentifiable pid 1234 with stale lock',
    });
  });

  test('takes over malformed and empty locks', () => {
    writeFileSync(lockPath, 'not-a-pid');
    expect(decideLockAcquisition(lockPath, process.pid).action).toBe('takeover');
    writeFileSync(lockPath, '');
    expect(decideLockAcquisition(lockPath, process.pid).action).toBe('takeover');
  });
});

describe('readProcessCommand', () => {
  test('prefers /proc/<pid>/cmdline when readable (#4300)', () => {
    const seen: string[] = [];
    const cmd = readProcessCommand(1234, {
      readCmdlineFile: (path) => {
        seen.push(path);
        return Buffer.from('gbrain\0autopilot\0--repo\0repo\0');
      },
    });
    expect(seen).toEqual(['/proc/1234/cmdline']);
    expect(cmd).toBe('gbrain autopilot --repo repo');
  });

  test('falls back to ps when the cmdline probe throws', () => {
    // The current process always exists; ps must resolve it on macOS/Linux.
    const cmd = readProcessCommand(process.pid, {
      readCmdlineFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(cmd).not.toBeNull();
    expect((cmd ?? '').length).toBeGreaterThan(0);
  });

  test('falls back to ps when the cmdline file is empty (zombie)', () => {
    const cmd = readProcessCommand(process.pid, {
      readCmdlineFile: () => Buffer.from(''),
    });
    expect(cmd).not.toBeNull();
  });

  test('returns null for invalid pids without probing', () => {
    expect(readProcessCommand(0)).toBeNull();
    expect(readProcessCommand(-5)).toBeNull();
    expect(readProcessCommand(Number.NaN)).toBeNull();
  });

  test('uses Get-CimInstance on win32 and never touches /proc or ps (#4563)', () => {
    const calls: Array<[string, string[]]> = [];
    const cmd = readProcessCommand(1234, {
      platform: 'win32',
      readCmdlineFile: () => {
        throw new Error('should not read /proc on win32');
      },
      execFile: (file, args) => {
        calls.push([file, args]);
        return 'C:\\Users\\u\\.bun\\bin\\gbrain.exe autopilot --repo C:\\brain\r\n';
      },
    });
    expect(cmd).toBe('C:\\Users\\u\\.bun\\bin\\gbrain.exe autopilot --repo C:\\brain');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('powershell.exe');
    expect(calls[0][1].join(' ')).toContain('Get-CimInstance Win32_Process');
    expect(calls[0][1].join(' ')).toContain('ProcessId=1234');
    expect(looksLikeGbrainAutopilotCommand(cmd!)).toBe(true);
  });

  test('win32: returns null when powershell fails or the process is gone (#4563)', () => {
    expect(readProcessCommand(1234, {
      platform: 'win32',
      execFile: () => {
        throw new Error('no powershell');
      },
    })).toBeNull();
    // Empty CIM output = process exited between kill-0 and the CIM query.
    expect(readProcessCommand(1234, {
      platform: 'win32',
      readCmdlineFile: () => {
        throw new Error('should not read /proc on win32');
      },
      execFile: () => '',
    })).toBeNull();
  });
});

describe('readProcessArgv', () => {
  test('preserves Linux /proc argv boundaries instead of joining them into a spoofable string', () => {
    expect(readProcessArgv(1234, {
      platform: 'linux',
      readCmdlineFile: () => Buffer.from('/usr/bin/bun\0/opt/gbrain/src/cli.ts\0autopilot\0'),
    })).toEqual(['/usr/bin/bun', '/opt/gbrain/src/cli.ts', 'autopilot']);
    expect(readProcessArgv(1234, {
      platform: 'linux',
      readCmdlineFile: () => Buffer.from('/usr/bin/bun /opt/gbrain/src/cli.ts autopilot\0'),
    })).toEqual(['/usr/bin/bun /opt/gbrain/src/cli.ts autopilot']);
  });

  test('fails closed where the OS probe cannot preserve argv boundaries', () => {
    expect(readProcessArgv(1234, { platform: 'win32' })).toBeNull();
  });

  test('parses exact Darwin KERN_PROCARGS2 argv boundaries', () => {
    const raw = Buffer.concat([
      Buffer.from([3, 0, 0, 0]),
      Buffer.from('/opt/homebrew/bin/bun\0\0'),
      Buffer.from('/opt/homebrew/bin/bun\0/opt/gbrain/src/cli.ts\0autopilot\0'),
    ]);
    expect(parseDarwinProcessArgs(raw)).toEqual([
      '/opt/homebrew/bin/bun', '/opt/gbrain/src/cli.ts', 'autopilot',
    ]);
  });
});

describe('looksLikeGbrainAutopilotCommand', () => {
  test('matches packaged and source-tree autopilot invocations', () => {
    expect(looksLikeGbrainAutopilotCommand('gbrain autopilot --repo repo')).toBe(true);
    expect(looksLikeGbrainAutopilotCommand('./gbrain/src/cli.ts autopilot')).toBe(true);
    expect(looksLikeGbrainAutopilotCommand('bun src/cli.ts autopilot --repo repo')).toBe(true);
  });

  test('matches a Windows command line with the executable quoted under a path with spaces', () => {
    expect(looksLikeGbrainAutopilotCommand('"C:\\Program Files\\gbrain\\gbrain.exe" autopilot --repo "C:\\my brain"')).toBe(true);
  });

  test('rejects unrelated live processes', () => {
    expect(looksLikeGbrainAutopilotCommand('/sbin/launchd')).toBe(false);
    expect(looksLikeGbrainAutopilotCommand('/usr/bin/python worker.py')).toBe(false);
    expect(looksLikeGbrainAutopilotCommand('gbrain status autopilot')).toBe(false);
    expect(looksLikeGbrainAutopilotCommand('bun src/cli.ts status autopilot')).toBe(false);
  });
});

describe('verifyAutopilotRuntimeOwner', () => {
  const entrypoint = '/opt/gbrain-release/src/cli.ts';
  const launcher = '/opt/homebrew/bin/bun';

  test('accepts only the exact release entrypoint followed by the autopilot subcommand', () => {
    expect(argvMatchesAutopilotEntrypoint([launcher, entrypoint, 'autopilot', '--repo', '/brain'], entrypoint, launcher)).toBe(true);
    expect(argvMatchesAutopilotEntrypoint([`${launcher} ${entrypoint} autopilot`], entrypoint, launcher)).toBe(false);
    expect(argvMatchesAutopilotEntrypoint(['/opt/gbrain', 'autopilot'], '/$bunfs/root/gbrain', '/opt/gbrain')).toBe(true);
    expect(argvMatchesAutopilotEntrypoint([launcher, 'autopilot'], '/$bunfs/root/gbrain', launcher)).toBe(false);
    expect(argvMatchesAutopilotEntrypoint(
      ['bun', '/home/me/.bun/bin/gbrain', 'autopilot', '--repo', '/brain'],
      entrypoint,
      launcher,
      (path) => path === '/home/me/.bun/bin/gbrain' ? entrypoint : null,
    )).toBe(true);
    expect(argvMatchesAutopilotEntrypoint(
      [launcher, '/home/me/.bun/bin/gbrain', 'autopilot'],
      entrypoint,
      launcher,
      (path) => path === '/home/me/.bun/bin/gbrain' ? entrypoint : null,
    )).toBe(true);
    expect(argvMatchesAutopilotEntrypoint(
      ['bun', '/home/me/.bun/bin/gbrain', 'autopilot'],
      entrypoint,
      launcher,
      (path) => path === '/home/me/.bun/bin/gbrain' ? '/tmp/not-cli.ts' : null,
    )).toBe(false);
    expect(argvMatchesAutopilotEntrypoint(
      ['bun', '/home/me/.bun/bin/gbrain', 'autopilot'],
      entrypoint,
      launcher,
      () => null,
    )).toBe(false);
    expect(argvMatchesAutopilotEntrypoint(
      ['bun', 'gbrain', 'autopilot'],
      entrypoint,
      launcher,
      () => entrypoint,
    )).toBe(false);
    expect(argvMatchesAutopilotEntrypoint(
      ['python', '/home/me/.bun/bin/gbrain', 'autopilot'],
      entrypoint,
      launcher,
      (path) => path === '/home/me/.bun/bin/gbrain' ? entrypoint : null,
    )).toBe(false);
    expect(commandMatchesAutopilotEntrypoint(
      `${launcher} ${entrypoint} autopilot --repo /brain`,
      entrypoint,
      launcher,
    )).toBe(true);
    expect(commandMatchesAutopilotEntrypoint(
      `"${launcher}"   "${entrypoint}"\tautopilot --repo /brain`,
      entrypoint,
      launcher,
    )).toBe(true);
    expect(commandMatchesAutopilotEntrypoint(
      `bun /tmp/src/cli.ts autopilot --repo /brain`,
      entrypoint,
      launcher,
    )).toBe(false);
    expect(commandMatchesAutopilotEntrypoint(
      `${launcher} "${entrypoint} autopilot --repo /brain`,
      entrypoint,
      launcher,
    )).toBe(false);
    expect(commandMatchesAutopilotEntrypoint(
      `${launcher} "${entrypoint}"autopilot --repo /brain`,
      entrypoint,
      launcher,
    )).toBe(false);
    expect(commandMatchesAutopilotEntrypoint(
      `bun /OPT/GBRAIN-RELEASE/SRC/CLI.ts autopilot --repo /brain`,
      entrypoint,
      launcher,
    )).toBe(false);
    expect(commandMatchesAutopilotEntrypoint(
      `/tmp/gbrain autopilot --repo /brain`,
      entrypoint,
      launcher,
    )).toBe(false);
    expect(commandMatchesAutopilotEntrypoint(
      `bun ${entrypoint} status autopilot`,
      entrypoint,
      launcher,
    )).toBe(false);
    expect(commandMatchesAutopilotEntrypoint(
      `evil-wrapper ${entrypoint} autopilot --repo /brain`,
      entrypoint,
      launcher,
    )).toBe(false);
    expect(commandMatchesAutopilotEntrypoint(
      `sleep 600 ${entrypoint} autopilot`,
      entrypoint,
      launcher,
    )).toBe(false);
    expect(commandMatchesAutopilotEntrypoint(
      `/tmp/bun ${entrypoint} autopilot`,
      entrypoint,
      launcher,
    )).toBe(false);
  });

  test('fails closed for a dead pid, unreadable command, or relative expected path', () => {
    expect(verifyAutopilotRuntimeOwner(4321, entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessArgv: () => [launcher, entrypoint, 'autopilot'],
      readProcessExecutable: () => launcher,
    })).toBe(true);
    expect(verifyAutopilotRuntimeOwner(4321, entrypoint, launcher, {
      isPidAlive: () => false,
      readProcessArgv: () => [launcher, entrypoint, 'autopilot'],
      readProcessExecutable: () => launcher,
    })).toBe(false);
    expect(verifyAutopilotRuntimeOwner(4321, entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessArgv: () => null,
      readProcessExecutable: () => launcher,
    })).toBe(false);
    expect(verifyAutopilotRuntimeOwner(4321, 'src/cli.ts', launcher, {
      isPidAlive: () => true,
      readProcessArgv: () => ['bun', 'src/cli.ts', 'autopilot'],
      readProcessExecutable: () => launcher,
    })).toBe(false);
    expect(verifyAutopilotRuntimeOwner(4321, entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessArgv: () => [launcher, entrypoint, 'autopilot'],
      readProcessExecutable: () => '/bin/cat',
    })).toBe(false);
    expect(verifyAutopilotRuntimeOwner(4321, entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessArgv: () => ['bun', '/home/me/.bun/bin/gbrain', 'autopilot'],
      readProcessExecutable: () => launcher,
      resolveCanonicalPath: (path) => path === '/home/me/.bun/bin/gbrain' ? entrypoint : null,
    })).toBe(true);
    expect(verifyAutopilotRuntimeOwner(4321, entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessArgv: () => ['bun', '/home/me/.bun/bin/gbrain', 'autopilot'],
      readProcessExecutable: () => '/bin/cat',
      resolveCanonicalPath: (path) => path === '/home/me/.bun/bin/gbrain' ? entrypoint : null,
    })).toBe(false);
  });

  test('service-managed parent and live child are independently verified', () => {
    expect(verifyServiceManagedAutopilotRuntimeOwner(4321, 4321, entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessArgv: () => [launcher, entrypoint, 'autopilot'],
      readProcessExecutable: () => launcher,
    })).toBe(true);
    expect(verifyServiceManagedAutopilotRuntimeOwner(4321, 9999, entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessArgv: () => [launcher, entrypoint, 'autopilot'],
      readProcessExecutable: () => launcher,
    })).toBe(false);
    expect(verifyServiceManagedAutopilotRuntimeOwner(4321, 4321, entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessArgv: () => [launcher, '/tmp/not-cli.ts', 'autopilot'],
      readProcessExecutable: () => launcher,
    })).toBe(false);
    expect(verifyAutopilotManagedWorker(8765, 4321, [8765], entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessParentPid: () => 4321,
      readProcessArgv: () => [launcher, entrypoint, 'jobs', 'work'],
      readProcessExecutable: () => launcher,
    })).toBe(true);
    expect(verifyAutopilotManagedWorker(8765, 4321, [8765], entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessParentPid: () => 9999,
    })).toBe(false);
    expect(verifyAutopilotManagedWorker(8765, 4321, [8765], '/$bunfs/root/gbrain', '/opt/gbrain', {
      isPidAlive: () => true,
      readProcessParentPid: () => 4321,
      readProcessArgv: () => ['/opt/gbrain', 'jobs', 'work'],
      readProcessExecutable: () => '/opt/gbrain',
    })).toBe(true);
    expect(verifyAutopilotManagedWorker(8765, 4321, [], entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessParentPid: () => 4321,
      readProcessArgv: () => [launcher, entrypoint, 'jobs', 'work'],
      readProcessExecutable: () => launcher,
    })).toBe(false);
    expect(verifyAutopilotManagedWorker(8765, 4321, [9000], entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessParentPid: (pid) => pid === 8765 ? 4321 : 8765,
      readProcessArgv: (pid) => pid === 9000 ? [launcher, entrypoint, 'jobs', 'work'] : ['/usr/bin/tini'],
      readProcessExecutable: () => launcher,
    })).toBe(true);
    expect(verifyAutopilotManagedWorker(8765, 4321, [8765], entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessParentPid: () => 4321,
      readProcessArgv: () => [launcher, entrypoint, 'jobs', 'work'],
      readProcessExecutable: () => '/bin/cat',
    })).toBe(false);
    expect(verifyAutopilotManagedWorker(8765, 4321, [8765], entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessParentPid: () => 4321,
      readProcessArgv: () => ['bun', '/home/me/.bun/bin/gbrain', 'jobs', 'work'],
      readProcessExecutable: () => launcher,
      resolveCanonicalPath: (path) => path === '/home/me/.bun/bin/gbrain' ? entrypoint : null,
    })).toBe(true);
    expect(verifyAutopilotManagedWorker(8765, 4321, [8765], entrypoint, launcher, {
      isPidAlive: () => true,
      readProcessParentPid: () => 4321,
      readProcessArgv: () => ['bun', '/home/me/.bun/bin/gbrain', 'jobs', 'work'],
      readProcessExecutable: () => '/bin/cat',
      resolveCanonicalPath: (path) => path === '/home/me/.bun/bin/gbrain' ? entrypoint : null,
    })).toBe(false);
    expect(verifyAutopilotManagedWorker(null, 4321, [], entrypoint, launcher)).toBe(false);
  });
});

describe('Bun global-install shim argv', () => {
  test('accepts a PATH shim whose realpath is the release entrypoint', () => {
    const shimHome = mkdtempSync(join(tmpdir(), 'gbrain-bun-shim-'));
    try {
      const entry = join(shimHome, 'cli.ts');
      const shim = join(shimHome, 'gbrain');
      writeFileSync(entry, '#!/usr/bin/env bun\n');
      symlinkSync(entry, shim);
      const canonicalEntry = realpathSync(entry);
      const bunLauncher = '/home/me/.bun/bin/bun';
      expect(argvMatchesAutopilotEntrypoint(['bun', shim, 'autopilot'], canonicalEntry, bunLauncher)).toBe(true);
      expect(argvMatchesAutopilotEntrypoint([bunLauncher, shim, 'autopilot'], canonicalEntry, bunLauncher)).toBe(true);
      expect(verifyAutopilotRuntimeOwner(4321, canonicalEntry, bunLauncher, {
        isPidAlive: () => true,
        readProcessArgv: () => ['bun', shim, 'autopilot'],
        readProcessExecutable: () => bunLauncher,
      })).toBe(true);
      expect(verifyAutopilotManagedWorker(8765, 4321, [8765], canonicalEntry, bunLauncher, {
        isPidAlive: () => true,
        readProcessParentPid: () => 4321,
        readProcessArgv: () => ['bun', shim, 'jobs', 'work'],
        readProcessExecutable: () => bunLauncher,
      })).toBe(true);
    } finally {
      rmSync(shimHome, { recursive: true, force: true });
    }
  });

  test('rejects a PATH shim whose realpath is a different file', () => {
    const shimHome = mkdtempSync(join(tmpdir(), 'gbrain-bun-shim-other-'));
    try {
      const entry = join(shimHome, 'cli.ts');
      const other = join(shimHome, 'other.ts');
      const shim = join(shimHome, 'gbrain');
      writeFileSync(entry, '#!/usr/bin/env bun\n');
      writeFileSync(other, '#!/usr/bin/env bun\n');
      symlinkSync(other, shim);
      const canonicalEntry = realpathSync(entry);
      const bunLauncher = '/home/me/.bun/bin/bun';
      expect(argvMatchesAutopilotEntrypoint(['bun', shim, 'autopilot'], canonicalEntry, bunLauncher)).toBe(false);
      expect(verifyAutopilotRuntimeOwner(4321, canonicalEntry, bunLauncher, {
        isPidAlive: () => true,
        readProcessArgv: () => ['bun', shim, 'autopilot'],
        readProcessExecutable: () => bunLauncher,
      })).toBe(false);
      expect(verifyAutopilotManagedWorker(8765, 4321, [8765], canonicalEntry, bunLauncher, {
        isPidAlive: () => true,
        readProcessParentPid: () => 4321,
        readProcessArgv: () => ['bun', shim, 'jobs', 'work'],
        readProcessExecutable: () => bunLauncher,
      })).toBe(false);
    } finally {
      rmSync(shimHome, { recursive: true, force: true });
    }
  });
});

describe('readProcessExecutable', () => {
  test('reads the current executable from OS metadata', () => {
    expect(readProcessExecutable(process.pid)).toBe(process.execPath);
  });

  test('returns null for invalid pids', () => {
    expect(readProcessExecutable(0)).toBeNull();
    expect(readProcessExecutable(-1)).toBeNull();
  });
});
