import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { FixtureProcesses } from './helpers/fixture-processes.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function ready(path: string): Promise<number> {
  for (let i = 0; i < 100; i++) { if (existsSync(path)) return Number(readFileSync(path, 'utf8')); await sleep(20); }
  throw new Error('Owned child did not become ready');
}
function sleeper(path: string, ignoreTerm = false): string[] {
  return ['-e', `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`, path];
}

describe('fixture subprocess ownership', () => {
  for (const outcome of ['success', 'failure', 'cancellation']) {
    test(`${outcome} reaps its own worker before deleting the fixture`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'fixture-workers-'));
      const scope = new FixtureProcesses(root, 10_000);
      let pid = 0;
      try {
        const child = scope.spawn(process.execPath, sleeper(join(root, 'ready')), { stdio: 'ignore' });
        pid = await ready(join(root, 'ready'));
        try {
          if (outcome === 'cancellation') {
            const closed = new Promise(resolve => child.once('close', resolve));
            expect(child.kill('SIGINT')).toBe(true);
            await closed;
            expect(alive(pid)).toBe(false);
          }
          if (outcome === 'failure') throw new Error(outcome);
        } catch (e: any) { expect(e.message).toBe(outcome); }
        finally { await scope.cleanup(); }
        expect(alive(pid)).toBe(false);
        rmSync(root, { recursive: true });
        expect(existsSync(root)).toBe(false);
        expect(() => scope.spawn(process.execPath, ['-e', ''])).toThrow('closing');
      } finally {
        await scope.cleanup();
        // Only delete once ownership cleanup succeeded; never leave a running worker with a deleted cwd.
        rmSync(root, { recursive: true, force: true });
      }
    }, 10_000);
  }

  test('KILL escalates a TERM-resistant worker and preserves an unrelated process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fixture-workers-'));
    const scope = new FixtureProcesses(root, 10_000);
    const unrelated = spawn(process.execPath, sleeper(join(root, 'sentinel')), { stdio: 'ignore' });
    const sentinelClosed = new Promise(resolve => unrelated.once('close', resolve));
    try {
      await ready(join(root, 'sentinel'));
      scope.spawn(process.execPath, sleeper(join(root, 'ready'), true), { stdio: 'ignore' });
      const pid = await ready(join(root, 'ready'));
      await scope.cleanup();
      expect(alive(pid)).toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
    } finally {
      let drained = false;
      try { await scope.cleanup(); drained = true; }
      finally { unrelated.kill('SIGTERM'); await sentinelClosed; }
      if (drained) rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test('a disowned hook invocation is registered and drained without a parent handle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fixture-workers-'));
    const scope = new FixtureProcesses(root, 10_000);
    const worker = join(root, 'worker.js');
    writeFileSync(worker, "require('fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)");
    const shim = join(root, 'gbrain');
    scope.writeShim(shim, process.execPath, [worker, join(root, 'ready')]);
    try {
      const hook = spawn('bash', ['-c', '"$1" </dev/null >/dev/null 2>&1 & disown', 'hook', shim], { cwd: root, stdio: 'ignore' });
      await new Promise(resolve => hook.once('close', resolve));
      const pid = await ready(join(root, 'ready'));
      await scope.cleanup();
      expect(alive(pid)).toBe(false);
    } finally {
      await scope.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test('an invocation after scope closure cannot launch a worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fixture-workers-'));
    const scope = new FixtureProcesses(root);
    const shim = join(root, 'gbrain');
    scope.writeShim(shim, process.execPath, sleeper(join(root, 'should-not-exist')));
    try {
      await scope.cleanup();
      const child = spawn(shim, [], { stdio: 'ignore' });
      const code = await new Promise(resolve => child.once('close', resolve));
      expect(code).toBe(125);
      expect(existsSync(join(root, 'should-not-exist'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test('cleanup immediately after spawn prevents launch or drains it before deletion', async () => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const root = mkdtempSync(join(tmpdir(), 'fixture-launch-race-'));
    const scope = new FixtureProcesses(root, 2_000);
    const marker = join(root, 'ready');
    scope.spawn(process.execPath, sleeper(marker), { stdio: 'ignore' });
    try {
      await scope.cleanup();
      if (existsSync(marker)) expect(alive(Number(readFileSync(marker, 'utf8')))).toBe(false);
    } finally { await scope.cleanup(); rmSync(root, { recursive: true, force: true }); }
  }
}, 15_000);

test('failed cleanup stays failed on repeat and retains its fixture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-failed-cleanup-'));
  const scope = new FixtureProcesses(root);
  // Synthetic failed lease; no subprocess is launched by this regression.
  writeFileSync(join(scope.directory, 'failed.json'), JSON.stringify({ failure: 'owned worker not reaped' }));
  const first = scope.cleanup();
  expect(scope.cleanup()).toBe(first);
  await expect(first).rejects.toThrow('owned worker not reaped');
  await expect(scope.cleanup()).rejects.toThrow('owned worker not reaped');
  expect(existsSync(root)).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test('the group leader reaps its CLI and waits for a detached hook descendant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-descendants-'));
  const scope = new FixtureProcesses(root, 10_000);
  const marker = join(root, 'grandchild');
  const args = sleeper(marker, true);
  const launcher = `require('child_process').spawn(process.execPath,${JSON.stringify(args)},{stdio:'ignore'});setTimeout(()=>process.exit(0),200);`;
  try {
    scope.spawn(process.execPath, ['-e', launcher], { stdio: 'ignore' });
    const pid = await ready(marker);
    await scope.cleanup();
    expect(alive(pid)).toBe(false);
  } finally { await scope.cleanup(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test('supervisor disconnection still drains its worker and retains the incomplete fixture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-disconnect-'));
  const scope = new FixtureProcesses(root, 10_000);
  const child = scope.spawn(process.execPath, sleeper(join(root, 'ready'), true), { stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  const pid = await ready(join(root, 'ready'));
  child.kill('SIGKILL'); // exact test-owned supervisor; exercises disconnected IPC
  await closed;
  const deadline = Date.now() + 5_000;
  while (alive(pid) && Date.now() < deadline) await sleep(25);
  expect(alive(pid)).toBe(false);
  await expect(scope.cleanup()).rejects.toThrow('retain fixture root');
  expect(existsSync(root)).toBe(true);
  // Supervisor is reaped and its only worker is gone; deliberate failed lease
  // retained above is now safe to remove by this regression's owner.
  rmSync(root, { recursive: true, force: true });
}, 20_000);
