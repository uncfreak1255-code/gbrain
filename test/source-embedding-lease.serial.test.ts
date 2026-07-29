import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { hostname } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { softDeleteSource } from '../src/core/destructive-guard.ts';
import {
  __setSourceEmbeddingLeaseTimingsForTests,
  beginSourceArchiveDrain,
  SourceEmbeddingLeaseLostError,
  withActiveSourceProviderLease,
} from '../src/core/source-embedding-lease.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`test timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('source embedding provider leases', () => {
  let db: PGLiteEngine;

  beforeAll(async () => {
    db = new PGLiteEngine();
    await db.connect({});
    await db.initSchema();
  });

  beforeEach(async () => {
    await resetPgliteState(db);
    __setSourceEmbeddingLeaseTimingsForTests({
      heartbeatMs: 10,
      archivePollMs: 5,
      archiveWaitMs: 120,
      dbOperationMs: 60,
    });
  });

  afterEach(() => {
    __setSourceEmbeddingLeaseTimingsForTests();
  });

  afterAll(async () => {
    await db.disconnect();
  });

  async function addSource(id: string): Promise<void> {
    await db.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`,
      [id],
    );
  }

  test('same-source provider submissions overlap and clean up exact tokens', async () => {
    await addSource('overlap-source');
    const bothStarted = deferred();
    const release = deferred();
    let active = 0;
    let maxActive = 0;
    const submit = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (active === 2) bothStarted.resolve();
      await release.promise;
      active--;
      return 'ok';
    };

    const first = withActiveSourceProviderLease(db, 'overlap-source', submit);
    const second = withActiveSourceProviderLease(db, 'overlap-source', submit);
    await within(bothStarted.promise);
    const live = await db.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM source_embedding_leases
        WHERE source_id = 'overlap-source'`,
    );
    expect(live).toEqual([{ count: 2 }]);
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok']);
    expect(maxActive).toBe(2);
    const remaining = await db.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM source_embedding_leases
        WHERE source_id = 'overlap-source'`,
    );
    expect(remaining[0]?.count).toBe(0);
  });

  test('archive aborts and waits for an abort-ignoring provider, then discards output', async () => {
    await addSource('drain-source');
    const started = deferred();
    const release = deferred();
    const aborted = deferred();
    const provider = withActiveSourceProviderLease(db, 'drain-source', async (signal) => {
      signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      started.resolve();
      await release.promise;
      return 'must-not-escape';
    });
    await within(started.promise);

    let archiveSettled = false;
    const archive = softDeleteSource(db, 'drain-source').finally(() => {
      archiveSettled = true;
    });
    await within(aborted.promise);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(archiveSettled).toBe(false);
    const draining = await db.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
      leases: number;
    }>(
      `SELECT source.archived, source.embedding_drain_token,
              count(lease.lease_token)::int AS leases
         FROM sources source
         LEFT JOIN source_embedding_leases lease ON lease.source_id = source.id
        WHERE source.id = 'drain-source'
        GROUP BY source.id`,
    );
    expect(draining[0]?.archived).toBe(false);
    expect(draining[0]?.embedding_drain_token).not.toBeNull();
    expect(draining[0]?.leases).toBe(1);

    release.resolve();
    await expect(provider).rejects.toBeInstanceOf(SourceEmbeddingLeaseLostError);
    await expect(archive).resolves.not.toBeNull();
  });

  test('an unrelated source archive does not wait on another source token', async () => {
    await addSource('archive-a');
    await addSource('provider-b');
    const started = deferred();
    const release = deferred();
    const provider = withActiveSourceProviderLease(db, 'provider-b', async () => {
      started.resolve();
      await release.promise;
      return 'b-output';
    });
    await within(started.promise);

    await expect(within(softDeleteSource(db, 'archive-a'), 500)).resolves.not.toBeNull();
    const bState = await db.executeRaw<{ archived: boolean; draining: boolean }>(
      `SELECT archived, embedding_drain_token IS NOT NULL AS draining
         FROM sources WHERE id = 'provider-b'`,
    );
    expect(bState).toEqual([{ archived: false, draining: false }]);
    release.resolve();
    await expect(provider).resolves.toBe('b-output');
  });

  test('a missing exact token aborts the provider and rejects its output', async () => {
    await addSource('lost-source');
    const started = deferred();
    const provider = withActiveSourceProviderLease(db, 'lost-source', async (signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return 'lost-output';
    });
    await within(started.promise);
    await db.executeRaw(`DELETE FROM source_embedding_leases WHERE source_id = 'lost-source'`);
    await expect(within(provider)).rejects.toBeInstanceOf(SourceEmbeddingLeaseLostError);
  });

  test('raw archive cannot bypass a live provider token', async () => {
    await addSource('raw-bypass');
    const started = deferred();
    const release = deferred();
    const provider = withActiveSourceProviderLease(db, 'raw-bypass', async () => {
      started.resolve();
      await release.promise;
      return 'ignored';
    });
    await within(started.promise);
    const drain = await beginSourceArchiveDrain(db, 'raw-bypass');
    expect(drain).not.toBeNull();
    await expect(db.executeRaw(
      `UPDATE sources
          SET archived = true, embedding_drain_token = NULL
        WHERE id = 'raw-bypass'`,
    )).rejects.toThrow('embedding provider leases remain');
    release.resolve();
    await expect(provider).rejects.toBeInstanceOf(SourceEmbeddingLeaseLostError);
    await expect(softDeleteSource(db, 'raw-bypass')).resolves.not.toBeNull();
  });

  test('archive reclaims only a same-host lease whose owner PID is provably dead', async () => {
    await addSource('dead-owner');
    const drain = await beginSourceArchiveDrain(db, 'dead-owner');
    expect(drain).not.toBeNull();
    await db.executeRaw(
      `INSERT INTO source_embedding_leases
         (lease_token, source_id, source_epoch, owner_host, owner_pid, owner_instance)
       VALUES ('dead-owner-token', 'dead-owner', $1, $2, 2147483647, 'dead-instance')`,
      [drain!.epoch, hostname()],
    );

    await expect(within(softDeleteSource(db, 'dead-owner'), 500)).resolves.not.toBeNull();
    const leases = await db.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count FROM source_embedding_leases
        WHERE source_id = 'dead-owner'`,
    );
    expect(leases[0]?.count).toBe(0);
  });

  test('archive refuses to prune live or remote owners and leaves the drain visible', async () => {
    for (const [sourceId, ownerHost, ownerPid] of [
      ['live-owner', hostname(), process.pid],
      ['remote-owner', 'remote-host.invalid', 2147483647],
    ] as const) {
      await addSource(sourceId);
      const drain = await beginSourceArchiveDrain(db, sourceId);
      await db.executeRaw(
        `INSERT INTO source_embedding_leases
           (lease_token, source_id, source_epoch, owner_host, owner_pid, owner_instance)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [`${sourceId}-token`, sourceId, drain!.epoch, ownerHost, ownerPid, `${sourceId}-instance`],
      );
      await expect(softDeleteSource(db, sourceId)).rejects.toThrow('require operator review');
      const state = await db.executeRaw<{ archived: boolean; draining: boolean; leases: number }>(
        `SELECT source.archived, source.embedding_drain_token IS NOT NULL AS draining,
                count(lease.lease_token)::int AS leases
           FROM sources source
           LEFT JOIN source_embedding_leases lease ON lease.source_id = source.id
          WHERE source.id = $1
          GROUP BY source.id`,
        [sourceId],
      );
      expect(state).toEqual([{ archived: false, draining: true, leases: 1 }]);
    }
  });
});

describe('source embedding lease DB-operation bounds', () => {
  afterEach(() => {
    __setSourceEmbeddingLeaseTimingsForTests();
  });

  function fakeLeaseEngine(opts: {
    hangHeartbeat?: boolean;
    hangCompletion?: boolean;
    onCompletionAttempt?: () => void;
  }): BrainEngine {
    let token = '';
    const engine = {
      kind: 'pglite' as const,
      transaction: async <T>(run: (tx: BrainEngine) => Promise<T>) => run(engine as BrainEngine),
      executeRaw: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('SELECT id, archived') && sql.includes('FROM public.sources')) {
          return [{
            id: 'bounded-source',
            archived: false,
            embedding_drain_token: null,
            embedding_drain_epoch: 0,
          }] as T[];
        }
        if (sql.includes('INSERT INTO public.source_embedding_leases')) {
          token = String(params[0]);
          return [];
        }
        if (sql.includes('UPDATE public.source_embedding_leases')) {
          if (opts.hangHeartbeat) return await new Promise<T[]>(() => {});
          return [{ lease_token: token }] as T[];
        }
        if (sql.includes('SELECT archived') && sql.includes('FROM public.sources')) {
          return [{
            archived: false,
            embedding_drain_token: null,
            embedding_drain_epoch: 0,
          }] as T[];
        }
        if (sql.includes('DELETE FROM public.source_embedding_leases')) {
          opts.onCompletionAttempt?.();
          if (opts.hangCompletion) return await new Promise<T[]>(() => {});
          return [{ lease_token: token }] as T[];
        }
        return [];
      },
    };
    return engine as unknown as BrainEngine;
  }

  test('heartbeat timeout aborts/discards and still attempts bounded exact completion', async () => {
    __setSourceEmbeddingLeaseTimingsForTests({ heartbeatMs: 5, dbOperationMs: 10 });
    let completionAttempted = false;
    const engine = fakeLeaseEngine({
      hangHeartbeat: true,
      onCompletionAttempt: () => { completionAttempted = true; },
    });

    const result = withActiveSourceProviderLease(engine, 'bounded-source', async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return 'discard-me';
    });

    await expect(within(result)).rejects.toBeInstanceOf(SourceEmbeddingLeaseLostError);
    expect(completionAttempted).toBe(true);
  });

  test('completion timeout rejects output and leaves cleanup to owner-death recovery', async () => {
    __setSourceEmbeddingLeaseTimingsForTests({ heartbeatMs: 1_000, dbOperationMs: 10 });
    let completionAttempted = false;
    const engine = fakeLeaseEngine({
      hangCompletion: true,
      onCompletionAttempt: () => { completionAttempted = true; },
    });

    const result = withActiveSourceProviderLease(
      engine,
      'bounded-source',
      async () => 'discard-me',
    );

    await expect(within(result)).rejects.toBeInstanceOf(SourceEmbeddingLeaseLostError);
    expect(completionAttempted).toBe(true);
  });
});
