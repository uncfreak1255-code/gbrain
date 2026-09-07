import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

const AUTOPILOT = readFileSync('src/commands/autopilot.ts', 'utf8');

describe('autopilot paid-spend scope', () => {
  test('creates one gateway scope for each daemon tick', () => {
    const loop = AUTOPILOT.indexOf('while (!stopping)');
    const scope = AUTOPILOT.indexOf('await withGatewaySpendScope(engine, async () => {');
    const queueSubmit = AUTOPILOT.indexOf('queue.add(');
    const wait = AUTOPILOT.indexOf('// Wait for next cycle');

    expect(loop).toBeGreaterThan(-1);
    expect(scope).toBeGreaterThan(loop);
    expect(queueSubmit).toBeGreaterThan(scope);
    expect(wait).toBeGreaterThan(queueSubmit);
    expect(AUTOPILOT.slice(scope, wait)).toContain('});');
  });
});
