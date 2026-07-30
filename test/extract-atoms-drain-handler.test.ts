/**
 * #1685 GAP D — extract-atoms-drain Minion handler: registration + protected
 * gate. Canonical PGLite block (CLAUDE.md R3+R4).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const JOBS_SOURCE = readFileSync(join(import.meta.dir, '../src/commands/jobs.ts'), 'utf8');

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('extract-atoms-drain handler', () => {
  test('registerBuiltinHandlers registers the handler', async () => {
    const worker = new MinionWorker(engine);
    await registerBuiltinHandlers(worker, engine);
    expect(worker.registeredNames).toContain('extract-atoms-drain');
  });

  test('queue.add rejects an untrusted submission (PROTECTED, CODEX #1)', async () => {
    await expect(queue.add('extract-atoms-drain', { sourceId: 'default' })).rejects.toThrow(
      /protected job name/i,
    );
  });

  test('queue.add accepts a trusted submission (allowProtectedSubmit)', async () => {
    const job = await queue.add(
      'extract-atoms-drain',
      { sourceId: 'default', window: 120 },
      { queue: 'default' },
      { allowProtectedSubmit: true },
    );
    expect(job.id).toBeGreaterThan(0);
    expect(job.name).toBe('extract-atoms-drain');
  });

  test('handler rechecks source hygiene immediately before the spend-capable drain', () => {
    const sharedGate = JOBS_SOURCE.slice(
      JOBS_SOURCE.indexOf('async function executionTimeSpendBlock('),
      JOBS_SOURCE.indexOf('async function resolveContextualReindexSourceId('),
    );
    expect(sharedGate).toContain('inspectSourceHygiene(engine');
    expect(sharedGate).toContain('gateProtectedSourceWork(packet, sourceId)');
    expect(sharedGate).toContain("reason: 'source_hygiene_blocked'");

    const handler = JOBS_SOURCE.slice(JOBS_SOURCE.indexOf("registerProviderHandler('extract-atoms-drain'"));
    const nextHandler = handler.indexOf("registerProviderHandler(\n    'embed-backfill'");
    const body = handler.slice(0, nextHandler);
    expect(body).toContain("job.data.sourceId : undefined");
    expect(body).toContain('runExtractAtomsDrainForSource(engine, {\n        sourceId,');
    expect(body).not.toContain('source_hygiene_source_id_missing');
    expect(body).toContain("phase: 'extract_atoms'");
    expect(body).toContain(": 'default'");
  });
});
