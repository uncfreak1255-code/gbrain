import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

describe('cli operation dispatch', () => {
  test('runs both read and write operation handlers inside the paid-spend scope', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');

    expect(cli).toContain(
      "withGatewaySpendScope(engine, () => op.handler(ctx, params)),\n          wallclockMs",
    );
    expect(cli).toContain(
      "rawResult = await withGatewaySpendScope(engine, () => op.handler(ctx, params));",
    );
  });

  test('runs Dream with an engine inside the paid-spend scope', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');

    expect(cli).toContain(
      'await withGatewaySpendScope(eng, () => runDream(eng, args, dreamAbortController.signal));',
    );
  });
});
