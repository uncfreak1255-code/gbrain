/**
 * Tests for `gbrain sync trigger` CLI (v0.40 D18).
 *
 * Validates the push-trigger entry point:
 *   - Help text renders
 *   - --source <id> required (exits 2)
 *   - --priority invalid (exits 2)
 *   - Non-existent source errors before submit (exits 1)
 *   - Successful submit prints job_id=N on stdout
 *   - Default priority is high (-10)
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSyncTrigger } from '../src/commands/sync.ts';
import { runSources } from '../src/commands/sources.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { beginSourceArchiveDrain } from '../src/core/source-embedding-lease.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw(
    `UPDATE sources
        SET archived = false,
            archived_at = NULL,
            archive_expires_at = NULL,
            embedding_drain_token = NULL
      WHERE id = 'default'`,
  );
});

/** Capture process.exit and stdout/stderr writes for one runSyncTrigger call. */
async function capture(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  const exitError = new Error('__exit__');
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw exitError;
  }) as never;
  console.log = (...a: unknown[]) => { stdout += a.map(String).join(' ') + '\n'; };
  console.error = (...a: unknown[]) => { stderr += a.map(String).join(' ') + '\n'; };
  try {
    await runSyncTrigger(engine, args);
  } catch (e) {
    if (e !== exitError) throw e;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { stdout, stderr, exitCode };
}

async function captureSources(args: string[]): Promise<{
  stderr: string;
  exitCode: number | null;
}> {
  const origExit = process.exit;
  const origErr = console.error;
  let stderr = '';
  let exitCode: number | null = null;
  const exitError = new Error('__sources_exit__');
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw exitError;
  }) as never;
  console.error = (...a: unknown[]) => { stderr += a.map(String).join(' ') + '\n'; };
  try {
    await runSources(engine, args);
  } catch (e) {
    if (e !== exitError) throw e;
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
  return { stderr, exitCode };
}

describe('runSyncTrigger', () => {
  test('--help prints usage and returns', async () => {
    const { stdout, exitCode } = await capture(['--help']);
    expect(exitCode).toBeNull();
    expect(stdout).toContain('gbrain sync trigger');
    expect(stdout).toContain('--source');
    expect(stdout).toContain('--priority');
  });

  test('missing --source exits 2 with hint', async () => {
    const { stderr, exitCode } = await capture([]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('--source <id> is required');
  });

  test('invalid --priority exits 2', async () => {
    const { stderr, exitCode } = await capture(['--source', 'default', '--priority', 'urgent']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('Invalid --priority value');
  });

  test('non-existent source exits 1', async () => {
    const { stderr, exitCode } = await capture(['--source', 'does-not-exist']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not found');
  });

  test('interrupted source drain exits 1 with exact archive-resume guidance', async () => {
    await engine.executeRaw(
      `UPDATE sources
          SET embedding_drain_token = 'hygiene-candidate:interrupted-drain',
              embedding_drain_epoch = embedding_drain_epoch + 1
        WHERE id = 'default'`,
    );
    await engine.executeRaw(
      `INSERT INTO source_embedding_leases
         (lease_token, source_id, source_epoch, owner_host, owner_pid, owner_instance)
       SELECT 'fenced-default-lease', id, embedding_drain_epoch - 1,
              'test-host', 1, 'test-instance'
         FROM sources WHERE id = 'default'`,
    );

    const { stderr, exitCode } = await capture(['--source', 'default']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('interrupted archive drain');
    expect(stderr).toContain('gbrain sources archive default --if-hygiene-candidate');

    const jobs = await new MinionQueue(engine).getJobs({ name: 'sync', limit: 5 });
    expect(jobs).toEqual([]);

    await runSources(engine, ['archive', 'default', '--if-hygiene-candidate']);
    const recovered = await engine.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
    }>(
      `SELECT archived, embedding_drain_token FROM sources WHERE id = 'default'`,
    );
    expect(recovered).toEqual([{ archived: false, embedding_drain_token: null }]);
    const leases = await engine.executeRaw<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM source_embedding_leases WHERE source_id = 'default'`,
    );
    expect(leases).toEqual([{ count: 0 }]);

    const resumed = await capture(['--source', 'default']);
    expect(resumed.exitCode).toBeNull();
  });

  test('manual default drain recovery omits the hygiene guard and keeps default active', async () => {
    await engine.executeRaw(
      `UPDATE sources SET embedding_drain_token = 'manual:interrupted-drain'
        WHERE id = 'default'`,
    );
    await runSources(engine, ['archive', 'default']);
    const rows = await engine.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
    }>(
      `SELECT archived, embedding_drain_token FROM sources WHERE id = 'default'`,
    );
    expect(rows).toEqual([{ archived: false, embedding_drain_token: null }]);
  });

  test('plain non-default archive refuses a migration drain with migration guidance', async () => {
    const sourceId = 'migration-stuck';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, 'Migration Stuck', '{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET archived = FALSE, embedding_drain_token = NULL`,
      [sourceId],
    );
    const drain = await beginSourceArchiveDrain(engine, sourceId, 'migration');
    expect(drain?.purpose).toBe('migration');

    const result = await captureSources(['archive', sourceId]);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('interrupted engine-migration drain');
    expect(result.stderr).toContain('rerun the engine migration');
    expect((await engine.executeRaw<{ embedding_drain_token: string | null }>(
      `SELECT embedding_drain_token FROM sources WHERE id = $1`,
      [sourceId],
    ))[0]?.embedding_drain_token).toBe(drain!.token);
  });

  test('valid trigger submits sync job + prints job_id=N to stdout', async () => {
    const { stdout, exitCode } = await capture(['--source', 'default']);
    expect(exitCode).toBeNull();
    expect(stdout).toMatch(/^job_id=\d+$/m);

    // Verify a sync job exists with auto_embed_backfill + priority -10
    const queue = new MinionQueue(engine);
    const jobs = await queue.getJobs({ name: 'sync', limit: 5 });
    expect(jobs.length).toBe(1);
    const job = jobs[0];
    expect(job.priority).toBe(-10);
    expect((job.data as { sourceId: string }).sourceId).toBe('default');
    expect((job.data as { auto_embed_backfill: boolean }).auto_embed_backfill).toBe(true);
  });

  test('--priority normal maps to 0', async () => {
    const { exitCode } = await capture(['--source', 'default', '--priority', 'normal']);
    expect(exitCode).toBeNull();
    const queue = new MinionQueue(engine);
    const jobs = await queue.getJobs({ name: 'sync', limit: 5 });
    expect(jobs[0].priority).toBe(0);
  });

  test('--priority low maps to 5', async () => {
    const { exitCode } = await capture(['--source', 'default', '--priority', 'low']);
    expect(exitCode).toBeNull();
    const queue = new MinionQueue(engine);
    const jobs = await queue.getJobs({ name: 'sync', limit: 5 });
    expect(jobs[0].priority).toBe(5);
  });
});
