/** Own fixture subprocesses, including disowned Git hooks. Test-only, POSIX. */
import { spawn, spawnSync, execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const helper = import.meta.path;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const DRAIN_MS = 4_000;
type Lease = { done?: boolean; failure?: string };
function publish(file: string, lease: Lease): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(lease), { flag: 'wx' });
  renameSync(temporary, file);
}
function groupMembers(group: number): number[] {
  // The observer needs its own group, or every snapshot includes the `ps`
  // subprocess itself and falsely reports a surviving fixture descendant.
  const snapshot = spawnSync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8', detached: true });
  if (snapshot.error) throw snapshot.error;
  if (snapshot.status !== 0) throw new Error('Cannot inspect owned fixture process group');
  return snapshot.stdout
    .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => pgid === group && pid !== group).map(([pid]) => pid);
}
function signalMembers(signal: NodeJS.Signals): void {
  // The dedicated leader owns this POSIX session and stays alive while
  // draining. Other sessions cannot join its group. Recheck membership for
  // each PID; never act on persisted or vanished group identities.
  for (const pid of groupMembers(process.pid)) {
    let pgid: string;
    try { pgid = execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { continue; } // The member exited between enumeration and recheck.
    if (Number(pgid) !== process.pid) continue;
    // POSIX has no portable atomic PID-and-membership signal operation.
    // This immediate check limits the standard PID-reuse race; the leader
    // prevents group reuse throughout the bounded drain.
    try { process.kill(pid, signal); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
  }
}
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Owned fixture worker did not reap; retain its root')), ms);
  })]); } finally { clearTimeout(timer!); }
}


/** IPC may close between its connected check and send. Keep draining even
 * when the peer disappeared; a failed notification must never abort cleanup. */
function send(peer: Pick<ChildProcess, 'connected' | 'send'> | NodeJS.Process, message: any): boolean {
  if (!peer.connected || !peer.send) return false;
  try {
    // Process and ChildProcess expose different overload declarations for
    // their shared two-argument message/callback IPC form.
    const notify = peer.send as (value: any, callback: (error: Error | null) => void) => boolean;
    notify.call(peer, message, () => {});
    return true;
  }
  catch { return false; }
}

export class FixtureProcesses {
  readonly directory: string;
  private closing = false;
  private cleanupPromise?: Promise<void>;
  private children: Array<Promise<void>> = [];
  constructor(root: string, readonly timeoutMs = 150_000) {
    this.directory = join(root, '.owned-processes');
    mkdirSync(this.directory, { recursive: true });
  }
  spawn(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
    if (this.closing) throw new Error('Fixture process scope is closing');
    const child = spawn(process.execPath, [helper, this.directory, String(this.timeoutMs), command, ...args], options);
    // 'close' follows spawn errors as well and includes stdio drainage.
    this.children.push(new Promise(resolve => child.once('close', () => resolve())));
    return child;
  }
  writeShim(path: string, command: string, args: string[]): void {
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    writeFileSync(path, `#!/usr/bin/env bash\nexec ${[process.execPath, helper, this.directory, String(this.timeoutMs), command, ...args].map(quote).join(' ')} "$@"\n`, { mode: 0o755 });
  }
  private leases(): Lease[] {
    return readdirSync(this.directory).filter(x => x.endsWith('.json')).map(x => JSON.parse(readFileSync(join(this.directory, x), 'utf8')));
  }
  cleanup(): Promise<void> {
    return this.cleanupPromise ??= this.drain();
  }
  private async drain(): Promise<void> {
    this.closing = true;
    writeFileSync(join(this.directory, 'closing'), 'closed\n');
    // Supervisors poll this marker; cleanup never sends signals to recorded
    // PIDs, which may belong to unrelated processes after supervisor exit.
    const deadline = Date.now() + DRAIN_MS * 2 + 2_000;
    for (;;) {
      const leases = this.leases();
      const failed = leases.find(x => x.failure);
      if (failed) throw new Error(failed.failure);
      if (leases.every(x => x.done)) break;
      if (Date.now() >= deadline) throw new Error('Owned fixture supervisor did not drain; retain fixture root');
      await sleep(25);
    }
    await bounded(Promise.all(this.children), Math.max(1, deadline - Date.now()));
    if (this.leases().some(x => !x.done)) throw new Error('Late fixture supervisor did not drain');
  }
}

/** Dedicated group leader: it does not exit when the CLI exits. This preserves
 * group identity through TERM, KILL, and member reaping. */
async function leadGroup(): Promise<void> {
  const [directory, command, ...args] = process.argv.slice(3);
  let child: ChildProcess | undefined;
  let closed: Promise<void> = Promise.resolve();
  let code = 125;
  let launched = false;
  let stop: Promise<void> | undefined;
  const hold = setInterval(() => {}, 1_000);
  const drain = () => stop ??= (async () => {
    signalMembers('SIGTERM');
    await sleep(500);
    signalMembers('SIGKILL');
    await bounded(closed, DRAIN_MS);
    const deadline = Date.now() + DRAIN_MS;
    while (groupMembers(process.pid).length) {
      if (Date.now() >= deadline) throw new Error('Owned fixture descendants did not disappear; retain root');
      await sleep(25);
    }
    send(process, { drained: true, code });
    clearInterval(hold);
    if (process.connected) process.disconnect?.();
  })().catch((error: any) => {
    send(process, { failure: error.message });
    clearInterval(hold);
    process.exitCode = 1;
    if (process.connected) process.disconnect?.();
  });
  process.on('SIGTERM', () => { void drain(); });
  process.on('SIGINT', () => { void drain(); });
  process.on('message', message => {
    if (message === 'drain') { void drain(); return; }
    if (message !== 'launch' || launched || stop) return;
    launched = true;
    if (!existsSync(directory) || existsSync(join(directory, 'closing'))) {
      send(process, { code }); return;
    }
    child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.once('error', () => {});
    closed = new Promise(resolve => child!.once('close', (exit, sig) => {
      code = exit ?? (sig ? 128 : 1);
      send(process, { code });
      resolve();
    }));
  });
  process.once('disconnect', () => { void drain(); });
  send(process, 'ready');
}

async function supervise(): Promise<void> {
  const [directory, timeout, command, ...args] = process.argv.slice(2);
  if (!directory || !command || !existsSync(directory)) { process.exitCode = 125; return; }
  let stopping = false;
  const terminate = () => { stopping = true; };
  // Install before ownership publication or any subprocess launch.
  process.on('SIGTERM', terminate);
  process.on('SIGINT', terminate);
  const file = join(directory, `${randomUUID()}.json`);
  const lease: Lease = {};
  const poll = setInterval(() => { if (existsSync(join(directory, 'closing'))) terminate(); }, 25);
  const timer = setTimeout(terminate, Number(timeout));
  let leader: ChildProcess | undefined;
  try {
    publish(file, lease);
    if (stopping || existsSync(join(directory, 'closing'))) { lease.done = true; process.exitCode = 125; return; }
    leader = spawn(process.execPath, [helper, '--group-leader', directory, command, ...args], {
      detached: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: process.env,
    });
    const owned = leader;
    let finished: number | undefined;
    let exited = false;
    let spawnError: Error | undefined;
    const closed = new Promise<void>(resolve => owned.once('close', () => resolve()));
    owned.once('error', error => { spawnError = error; });
    owned.once('exit', () => { exited = true; });
    owned.on('message', (message: any) => {
      if (message === 'ready') {
        if (stopping || existsSync(join(directory, 'closing'))) terminate();
        else if (!send(owned, 'launch')) terminate();
      } else if (typeof message?.code === 'number') finished = message.code;
    });
    while (!stopping && finished === undefined && !exited && !spawnError) await sleep(10);
    if (spawnError) throw spawnError;
    if (exited) throw new Error('Owned group leader exited before draining; retain fixture');
    let drained = false;
    let failure: string | undefined;
    owned.on('message', (message: any) => {
      if (message?.drained) { drained = true; finished = message.code; }
      if (message?.failure) failure = message.failure;
    });
    send(owned, 'drain');
    await bounded(closed, DRAIN_MS * 2 + 1_000);
    if (!drained || failure) throw new Error(failure ?? 'Owned leader exited without drainage receipt');
    process.exitCode = finished ?? 128;
    lease.done = true;
  } catch (error: any) {
    lease.failure = error.message;
    process.exitCode = 1;
    // Closing IPC invokes the leader's bounded fail-safe if still alive.
    if (leader?.connected) leader.disconnect();
  } finally {
    publish(file, lease);
    clearInterval(poll);
    clearTimeout(timer);
    process.off('SIGTERM', terminate);
    process.off('SIGINT', terminate);
  }
}

if (import.meta.main) {
  if (process.argv[2] === '--group-leader') await leadGroup();
  else await supervise();
}
