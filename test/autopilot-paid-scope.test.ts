import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  currentGatewaySpendRunId,
  SPEND_RUN_DATA_KEY,
  withGatewaySpendScope,
} from '../src/core/budget/gateway-spend.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine?.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('autopilot paid-spend scope', () => {
  test('creates one gateway scope around each daemon tick submit', () => {
    const autopilot = readFileSync('src/commands/autopilot.ts', 'utf8');
    const loop = autopilot.indexOf('while (!stopping)');
    const scope = autopilot.indexOf('await withGatewaySpendScope(engine, async () => {');
    expect(loop).toBeGreaterThan(-1);
    expect(scope).toBeGreaterThan(loop);
  });

  test('successive ticks mint distinct run ids and stamp queued descendants', async () => {
    let firstRun: string | undefined;
    let secondRun: string | undefined;
    const first = await withGatewaySpendScope(engine, async () => {
      firstRun = currentGatewaySpendRunId(engine);
      return queue.add('embed-backfill', { sourceId: 'default' });
    });
    const second = await withGatewaySpendScope(engine, async () => {
      secondRun = currentGatewaySpendRunId(engine);
      return queue.add('embed-backfill', { sourceId: 'default' });
    });

    expect(firstRun).toBeDefined();
    expect(secondRun).toBeDefined();
    expect(firstRun).not.toBe(secondRun);
    expect(first.data?.[SPEND_RUN_DATA_KEY]).toBe(firstRun);
    expect(second.data?.[SPEND_RUN_DATA_KEY]).toBe(secondRun);
  });

  test('queue.add outside a tick does not inherit a prior run id', async () => {
    await withGatewaySpendScope(engine, async () => {
      expect(currentGatewaySpendRunId(engine)).toBeDefined();
    }, 'tick-one');
    const orphan = await queue.add('embed-backfill', { sourceId: 'default' });
    expect(orphan.data?.[SPEND_RUN_DATA_KEY]).toBeUndefined();
  });
});
