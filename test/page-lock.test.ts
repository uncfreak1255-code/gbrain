import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { acquirePageLock, pageLockIdentity, withPageLock } from '../src/core/page-lock.ts';

let tmp: string;

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'page-lock-test-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function lockFile(brainId: string, sourceId: string, slug: string): string {
  return join(tmp, `${pageLockIdentity(brainId, sourceId, slug)}.lock.sqlite`);
}

describe('acquirePageLock', () => {
  test('acquires atomically and leaves a persistent kernel-lock database', async () => {
    const lock = await acquirePageLock('people/alice', { lockRoot: tmp });
    expect(lock).not.toBeNull();
    expect(lock!.slug).toBe('people/alice');
    expect(existsSync(lockFile('default', 'default', 'people/alice'))).toBe(true);
    await lock!.release();
    expect(existsSync(lockFile('default', 'default', 'people/alice'))).toBe(true);
  });

  test('returns null while the same identity is held and reacquires after release', async () => {
    const first = await acquirePageLock('companies/acme', { lockRoot: tmp });
    expect(first).not.toBeNull();
    expect(await acquirePageLock('companies/acme', { lockRoot: tmp })).toBeNull();
    await first!.release();
    const second = await acquirePageLock('companies/acme', { lockRoot: tmp });
    expect(second).not.toBeNull();
    await second!.release();
  });

  test('release is idempotent and an old handle cannot release a new holder', async () => {
    const first = await acquirePageLock('test/release', { lockRoot: tmp });
    await first!.release();
    const second = await acquirePageLock('test/release', { lockRoot: tmp });
    expect(second).not.toBeNull();
    await first!.release();
    expect(await acquirePageLock('test/release', { lockRoot: tmp })).toBeNull();
    await second!.release();
  });

  test('refresh retains ownership without changing pathname state', async () => {
    const lock = await acquirePageLock('test/refresh', { lockRoot: tmp });
    await lock!.refresh();
    expect(await acquirePageLock('test/refresh', { lockRoot: tmp })).toBeNull();
    await lock!.release();
  });

  test('same slug in different brains and sources has independent ownership', async () => {
    const one = await acquirePageLock('same', { lockRoot: tmp, brainId: 'brain', sourceId: 'one' });
    const two = await acquirePageLock('same', { lockRoot: tmp, brainId: 'brain', sourceId: 'two' });
    const three = await acquirePageLock('same', { lockRoot: tmp, brainId: 'other', sourceId: 'one' });
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(three).not.toBeNull();
    await one!.release();
    await two!.release();
    await three!.release();
  });

  test('contends across two OS processes and recovers after process death', async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, '../src/core/page-lock.ts')).href;
    const child = Bun.spawn([process.execPath, '-e', `
      const { acquirePageLock } = await import(${JSON.stringify(moduleUrl)});
      const lock = await acquirePageLock('cross-process', { lockRoot: ${JSON.stringify(tmp)}, brainId: 'brain', sourceId: 'source' });
      if (!lock) process.exit(2);
      console.log('READY');
      await new Promise(resolve => setTimeout(resolve, 30_000));
    `], { stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain('READY');
    expect(await acquirePageLock('cross-process', { lockRoot: tmp, brainId: 'brain', sourceId: 'source' })).toBeNull();
    child.kill('SIGKILL');
    await child.exited;
    const recovered = await acquirePageLock('cross-process', { lockRoot: tmp, brainId: 'brain', sourceId: 'source', timeoutMs: 1_000, pollMs: 20 });
    expect(recovered).not.toBeNull();
    await recovered!.release();
  });
});

describe('withPageLock', () => {
  test('runs the callback and releases on success', async () => {
    let ran = false;
    await withPageLock('synthesis/test', async () => { ran = true; }, { lockRoot: tmp, timeoutMs: 500 });
    expect(ran).toBe(true);
    const next = await acquirePageLock('synthesis/test', { lockRoot: tmp });
    expect(next).not.toBeNull();
    await next!.release();
  });

  test('releases even when the callback throws', async () => {
    await expect(withPageLock('synthesis/throws', async () => { throw new Error('boom'); }, { lockRoot: tmp, timeoutMs: 500 })).rejects.toThrow('boom');
    const next = await acquirePageLock('synthesis/throws', { lockRoot: tmp });
    expect(next).not.toBeNull();
    await next!.release();
  });

  test('throws when timeout elapses with a holder', async () => {
    const first = await acquirePageLock('held/page', { lockRoot: tmp });
    await expect(withPageLock('held/page', async () => 'unreachable', { lockRoot: tmp, timeoutMs: 100, pollMs: 10 })).rejects.toThrow();
    await first!.release();
  });

  test('re-enters the same qualified lock in one async call chain', async () => {
    const opts = { lockRoot: tmp, brainId: 'brain', sourceId: 'source', timeoutMs: 50, pollMs: 10 };
    const order: string[] = [];
    await withPageLock('nested/page', async () => {
      order.push('outer');
      const nestedHandle = await acquirePageLock('nested/page', opts);
      expect(nestedHandle).not.toBeNull();
      await nestedHandle!.release();
      await withPageLock('nested/page', async () => {
        order.push('inner');
      }, opts);
    }, opts);
    expect(order).toEqual(['outer', 'inner']);
  });

  test('an inherited async context reacquires after the outer lock is released', async () => {
    const opts = { lockRoot: tmp, brainId: 'brain', sourceId: 'source' };
    let continueChild!: () => void;
    const gate = new Promise<void>(resolve => { continueChild = resolve; });
    let child!: Promise<Awaited<ReturnType<typeof acquirePageLock>>>;
    await withPageLock('delayed/page', async () => {
      child = (async () => {
        await gate;
        return acquirePageLock('delayed/page', opts);
      })();
    }, opts);

    continueChild();
    const reacquired = await child;
    expect(reacquired).not.toBeNull();
    expect(await acquirePageLock('delayed/page', opts)).toBeNull();
    await reacquired!.release();
  });

  test('a nested callback keeps the physical lock until the nested holder finishes', async () => {
    const opts = { lockRoot: tmp, brainId: 'brain', sourceId: 'source' };
    let continueChild!: () => void;
    const gate = new Promise<void>(resolve => { continueChild = resolve; });
    let childEntered = false;
    let child!: Promise<void>;

    await withPageLock('nested-delayed/page', async () => {
      child = withPageLock('nested-delayed/page', async () => {
        await gate;
        childEntered = true;
      }, opts);
      await Bun.sleep(0);
    }, opts);

    expect(childEntered).toBe(false);
    expect(await acquirePageLock('nested-delayed/page', opts)).toBeNull();
    continueChild();
    await child;
    const next = await acquirePageLock('nested-delayed/page', opts);
    expect(next).not.toBeNull();
    await next!.release();
  });
});

test('source-qualified identities produce safe filenames', () => {
  const filename = lockFile('brain', 'source', 'people/alíce-éxample/sub').split(sep).pop()!;
  expect(filename).toMatch(/^[0-9a-f]{64}\.lock\.sqlite$/);
});
