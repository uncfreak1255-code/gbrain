/**
 * Per-page, cross-process lock for canonical Markdown mutation.
 *
 * Each source-qualified page identity maps to one persistent SQLite file under
 * `~/.gbrain/page-locks`. `BEGIN EXCLUSIVE` is the lock: acquisition is atomic,
 * process death releases it, and no stale pathname must be unlinked. The random
 * token owns only this in-memory handle, so an old handle cannot release a new
 * holder's transaction.
 */

import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { gbrainPath } from './config.ts';

export interface PageLockHandle {
  release: () => Promise<void>;
  refresh: () => Promise<void>;
  slug: string;
}

export interface AcquirePageLockOpts {
  timeoutMs?: number;
  pollMs?: number;
  lockRoot?: string;
  brainId?: string;
  sourceId?: string;
}

export function pageLockIdentity(brainId: string, sourceId: string, slug: string): string {
  return createHash('sha256').update(`${brainId}\0${sourceId}\0${slug}`, 'utf8').digest('hex');
}

function lockPathFor(slug: string, opts: AcquirePageLockOpts): string {
  const identity = pageLockIdentity(opts.brainId ?? 'default', opts.sourceId ?? 'default', slug);
  return join(opts.lockRoot ?? gbrainPath('page-locks'), `${identity}.lock.sqlite`);
}

function sqliteBusy(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code ?? '');
  return code.startsWith('SQLITE_BUSY') || /database is locked/i.test(String((error as Error).message ?? ''));
}

function tryAcquireOnce(slug: string, lockPath: string): PageLockHandle | null {
  mkdirSync(dirname(lockPath), { recursive: true });
  let database: Database | undefined;
  try {
    database = new Database(lockPath, { create: true, strict: true });
    chmodSync(lockPath, 0o600);
    database.run('PRAGMA busy_timeout = 0');
    database.run('BEGIN EXCLUSIVE');
  } catch (error) {
    try { database?.close(); } catch { /* preserve acquisition error */ }
    if (sqliteBusy(error)) return null;
    throw error;
  }

  const token = randomUUID();
  let activeToken: string | null = token;
  return {
    slug,
    refresh: async () => {
      if (activeToken !== token) return;
      database!.query('SELECT 1').get();
    },
    release: async () => {
      if (activeToken !== token) return;
      activeToken = null;
      let releaseError: unknown;
      try { database!.run('ROLLBACK'); } catch (error) { releaseError = error; }
      try { database!.close(); } catch (error) {
        releaseError = releaseError === undefined
          ? error
          : new AggregateError([releaseError, error], 'Page lock rollback and close both failed');
      }
      if (releaseError !== undefined) throw releaseError;
    },
  };
}

export async function acquirePageLock(slug: string, opts: AcquirePageLockOpts = {}): Promise<PageLockHandle | null> {
  const lockPath = lockPathFor(slug, opts);
  const deadline = Date.now() + (opts.timeoutMs ?? 0);
  const pollMs = opts.pollMs ?? 200;
  let attempt = tryAcquireOnce(slug, lockPath);
  if (attempt) return attempt;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    attempt = tryAcquireOnce(slug, lockPath);
    if (attempt) return attempt;
  }
  return null;
}

export async function withPageLock<T>(slug: string, fn: () => Promise<T>, opts: AcquirePageLockOpts = {}): Promise<T> {
  const handle = await acquirePageLock(slug, { timeoutMs: 30_000, ...opts });
  if (!handle) throw new Error(`acquirePageLock: could not acquire lock for slug "${slug}" within ${opts.timeoutMs ?? 30_000}ms`);
  try { return await fn(); }
  finally { await handle.release(); }
}
