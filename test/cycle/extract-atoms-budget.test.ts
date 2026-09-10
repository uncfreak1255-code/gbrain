import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, withBudgetTracker } from '../../src/core/ai/gateway.ts';
import { BudgetTracker } from '../../src/core/budget/budget-tracker.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../helpers/with-env.ts';

let engine: PGLiteEngine;
let calls = 0;
let auditDir: string;
beforeAll(async () => { auditDir = mkdtempSync(join(tmpdir(), 'extract-budget-')); engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); rmSync(auditDir, { recursive: true, force: true }); });
beforeEach(async () => {
  calls = 0;
  await engine.unsetConfig('cycle.extract_atoms.budget_usd');
  await engine.unsetConfig('pricing.overrides');
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: {} });
  __setChatTransportForTests(async () => {
    calls++;
    return { text: '[]', blocks: [], stopReason: 'end',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' };
  });
});
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });
const run = (target = engine) => withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => runPhaseExtractAtoms(target, { sourceId: 'default', dryRun: true,
  _transcripts: [{ filePath: '/tmp/budget-example.txt', content: 'Example source text.', contentHash: 'a'.repeat(64) }], _pages: [] }));

test('zero configured phase cap prevents transport', async () => {
  await engine.setConfig('cycle.extract_atoms.budget_usd', '0');
  const result = await run();
  expect(calls).toBe(0);
  expect(result.details?.budget_usd).toBe(0);
});
test.each(['invalid', '', '-1', 'Infinity'])('invalid phase cap refuses: %s', async value => {
  await engine.setConfig('cycle.extract_atoms.budget_usd', value);
  await expect(run()).rejects.toThrow('budget');
  expect(calls).toBe(0);
});
test('unreadable phase cap refuses before transport', async () => {
  const broken = Object.create(engine) as PGLiteEngine;
  broken.getConfig = async key => {
    if (key === 'cycle.extract_atoms.budget_usd') throw new Error('budget config unavailable');
    return engine.getConfig(key);
  };
  await expect(run(broken)).rejects.toThrow('budget');
  expect(calls).toBe(0);
});
test('unpriced model retains the phase cap', async () => {
  configureGateway({ chat_model: 'example:unpriced-model', env: {} });
  const result = await run();
  expect(calls).toBe(0);
  expect(result.status).toBe('warn');
});
test('phase cap is checked against projected cost before transport', async () => {
  await engine.setConfig('cycle.extract_atoms.budget_usd', '0.0001');
  await run();
  expect(calls).toBe(0);
});
test('declared prices take precedence over built-in prices', async () => {
  await engine.setConfig('pricing.overrides', JSON.stringify({ 'anthropic:claude-sonnet-4-6': { input: 1000, output: 1000 } }));
  await run();
  expect(calls).toBe(0);
});
test('invalid declared prices refuse instead of falling back', async () => {
  await engine.setConfig('pricing.overrides', '{"anthropic:claude-sonnet-4-6":{"input":-1,"output":1}}');
  await expect(run()).rejects.toThrow('pricing.overrides');
  expect(calls).toBe(0);
});
test('phase accounting uses the model price and preserves the outer budget', async () => {
  const outer = new BudgetTracker({ label: 'outer', maxCostUsd: 1, auditPath: '/dev/null' });
  const result = await withBudgetTracker(outer, () => run());
  expect(calls).toBe(1);
  expect(result.details?.estimated_spend_usd).toBeCloseTo(outer.totalSpent, 8);
  expect(outer.totalSpent).toBeGreaterThan(0);
  const stopped = new BudgetTracker({ label: 'outer', maxCostUsd: 0, auditPath: '/dev/null' });
  await withBudgetTracker(stopped, () => run());
  expect(calls).toBe(1);
});
