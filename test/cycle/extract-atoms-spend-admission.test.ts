import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let calls = 0;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  calls = 0;
  await engine.setConfig('models.dream.extract_atoms', 'groq:unpriced-model');
  await engine.setConfig('cycle.extract_atoms.budget_usd', '0.30');
  configureGateway({ chat_model: 'groq:unpriced-model', env: { GROQ_API_KEY: 'test-only' } });
  __setChatTransportForTests(async () => {
    calls++;
    return { text: '[]', blocks: [{ type: 'text', text: '[]' }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'groq:unpriced-model', providerId: 'groq' };
  });
});
afterEach(() => { __setChatTransportForTests(null); resetGateway(); });
const run = () => runPhaseExtractAtoms(engine, { sourceId: 'default',
  _transcripts: [{ filePath: '/tmp/spend-fixture.txt', content: 'Example operator confirmed the repair is still unverified.', contentHash: 'a'.repeat(64) }], _pages: [] });

test('unknown paid model does not drop the phase cap', async () => {
  await run();
  expect(calls).toBe(0);
});
test('invalid explicit phase cap refuses before inference', async () => {
  await engine.setConfig('cycle.extract_atoms.budget_usd', 'invalid');
  await expect(run()).rejects.toThrow('configuration unavailable');
  expect(calls).toBe(0);
});
