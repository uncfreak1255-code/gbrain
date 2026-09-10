import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  cliCommandOwnsGatewaySpendScope,
  currentGatewaySpendRunId,
  withCliGatewaySpendScope,
  withGatewaySpendScope,
} from '../src/core/budget/gateway-spend.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine?.disconnect();
});

describe('cli operation dispatch', () => {
  test('wires the shared CLI spend-scope helper', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toContain('withCliGatewaySpendScope(engine, command, dispatch)');
    expect(cli).toContain('withGatewaySpendScope(engine, () => op.handler(ctx, params))');
    expect(cli).toContain('withGatewaySpendScope(eng, () => runDream(eng, args, dreamAbortController.signal))');
    expect(cli).toContain('withGatewaySpendScope(eng, () => runRemediate(eng, args))');
  });

  test('owns a durable run for ordinary commands and leaves serve/autopilot unscoped', async () => {
    expect(cliCommandOwnsGatewaySpendScope('query')).toBe(true);
    expect(cliCommandOwnsGatewaySpendScope('serve')).toBe(false);
    expect(cliCommandOwnsGatewaySpendScope('autopilot')).toBe(false);

    await withCliGatewaySpendScope(engine, 'query', async () => {
      expect(currentGatewaySpendRunId(engine)).toBeDefined();
    });
    await withCliGatewaySpendScope(engine, 'serve', async () => {
      expect(currentGatewaySpendRunId(engine)).toBeUndefined();
    });
    await withCliGatewaySpendScope(engine, 'autopilot', async () => {
      expect(currentGatewaySpendRunId(engine)).toBeUndefined();
    });
  });

  test('nested CLI work reuses the same durable run id', async () => {
    await withGatewaySpendScope(engine, async () => {
      const runId = currentGatewaySpendRunId(engine);
      expect(runId).toBeDefined();
      await withCliGatewaySpendScope(engine, 'query', async () => {
        expect(currentGatewaySpendRunId(engine)).toBe(runId);
      });
    }, 'cli-nested-run');
  });
});
