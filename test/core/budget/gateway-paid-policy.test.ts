import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { chat, configureGateway, resetGateway, embed } from '../../../src/core/ai/gateway.ts';
import { withGatewaySpendScope } from '../../../src/core/budget/gateway-spend.ts';
import { paidTextFetch } from '../../../src/core/budget/gateway-spend.ts';
import { zai } from '../../../src/core/ai/recipes/zai.ts';
import { reserveGatewaySpend } from '../../../src/core/minions/budget-meter.ts';

let engine: PGLiteEngine;
let calls = 0;
const originalFetch = globalThis.fetch;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
beforeEach(async () => {
  await engine.executeRaw("DELETE FROM mcp_spend_log WHERE client_id = 'gbrain:gateway-budget'");
  await engine.setConfig('pricing.overrides', JSON.stringify({ 'zai:glm-5.2': { input: 1, output: 1 } }));
  calls = 0;
  configureGateway({ chat_model: 'zai:glm-5.2', env: { ZAI_API_KEY: 'test-only' },
    paid_budget: { max_usd_per_run: 0.007, max_usd_per_day: 0.012 } });
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ id: 'test', model: 'glm-5.2', choices: [
      { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
    ], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; resetGateway(); });
afterAll(async () => { await engine?.disconnect(); });
const call = () => chat({ messages: [{ role: 'user', content: 'test' }], maxTokens: 64 });

test('unscoped paid requests stop before HTTP', async () => {
  await expect(call()).rejects.toThrow('run scope');
  expect(calls).toBe(0);
});
test('nested work and restarted runs share durable reservations', async () => {
  await withGatewaySpendScope(engine, async () => {
    await call();
    await expect(withGatewaySpendScope(engine, call)).rejects.toThrow('cap');
  }, 'test-run');
  await expect(withGatewaySpendScope(engine, call, 'test-run')).rejects.toThrow('cap');
  expect(calls).toBe(1);
});
test('different runs share the daily cap', async () => {
  await withGatewaySpendScope(engine, call);
  await withGatewaySpendScope(engine, call);
  await expect(withGatewaySpendScope(engine, call)).rejects.toThrow('cap');
  expect(calls).toBe(2);
});
test('timeout retains reservation and SDK does not retry', async () => {
  globalThis.fetch = (async () => { calls++; throw new Error('fixture timeout'); }) as unknown as typeof fetch;
  await withGatewaySpendScope(engine, async () => {
    await expect(call()).rejects.toThrow('fixture timeout');
    await expect(call()).rejects.toThrow('cap');
  });
  expect(calls).toBe(1);
});
test('ledger write failure prevents dispatch', async () => {
  const broken = Object.create(engine) as PGLiteEngine;
  broken.transaction = async () => { throw new Error('ledger unavailable'); };
  await expect(withGatewaySpendScope(broken, call)).rejects.toThrow('ledger unavailable');
  expect(calls).toBe(0);
});
test('malformed operator prices refuse instead of using shipped rates', async () => {
  await engine.setConfig('pricing.overrides', '{"zai:glm-5.2":{"input":-1,"output":1}}');
  await expect(withGatewaySpendScope(engine, call)).rejects.toThrow('pricing.overrides');
  expect(calls).toBe(0);
});
test('paid embeddings refuse under the text-only policy', async () => {
  await expect(withGatewaySpendScope(engine, () => embed(['test'], { embeddingModel: 'openai:text-embedding-3-small' })))
    .rejects.toThrow('local embeddings only');
  expect(calls).toBe(0);
});

test.each([null, {}, { max_usd_per_run: NaN, max_usd_per_day: 1 }, { max_usd_per_run: 1, max_usd_per_day: -1 }])(
  'malformed policy refuses configuration', policy => {
    expect(() => configureGateway({ env: {}, paid_budget: policy as any })).toThrow('paid_budget');
    expect(calls).toBe(0);
  });

test.each([
  { model: 'other-model' }, { max_tokens: 0 }, { max_tokens: null }, { max_tokens: 1.5 },
  { n: 2 }, { max_completion_tokens: 200 }, { modalities: ['audio'] },
  { tools: [{ type: 'web_search' }] },
  { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image' } }] }] },
])('invalid wire request refuses before reservation and HTTP', async override => {
  const transport = paidTextFetch(zai, 'glm-5.2', { env: {}, paid_budget: { max_usd_per_run: 1, max_usd_per_day: 1 } })!;
  await expect(withGatewaySpendScope(engine, () => transport('https://example.invalid/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'test' }], max_tokens: 64, ...override }),
  }))).rejects.toThrow('paid_budget');
  expect(calls).toBe(0);
  const [row] = await engine.executeRaw<{ count: number }>("SELECT count(*)::int AS count FROM mcp_spend_log WHERE client_id='gbrain:gateway-budget'");
  expect(row.count).toBe(0);
});

test('microdollar rounding cannot silently erase repeated small holds', async () => {
  const reserve = () => reserveGatewaySpend(engine, { runId: 'rounding', estimatedUsd: 0.0000001,
    runCapUsd: 0.000001, dayCapUsd: 0.000001, model: 'test:model' });
  await reserve();
  await expect(reserve()).rejects.toThrow('cap');
});

test('HTTP redirect does not repeat the paid request', async () => {
  globalThis.fetch = originalFetch;
  let first = 0, redirected = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    if (new URL(req.url).pathname === '/rebill') { redirected++; return new Response('unexpected'); }
    first++; return new Response(null, { status: 307, headers: { location: '/rebill' } });
  } });
  configureGateway({ chat_model: 'zai:glm-5.2', env: { ZAI_API_KEY: 'test-only' },
    base_urls: { zai: `http://127.0.0.1:${server.port}` }, paid_budget: { max_usd_per_run: 0.007, max_usd_per_day: 0.012 } });
  try {
    await withGatewaySpendScope(engine, async () => {
      await expect(call()).rejects.toThrow();
      await expect(call()).rejects.toThrow('cap');
    });
    expect(first).toBe(1); expect(redirected).toBe(0);
  } finally { await server.stop(true); }
});

test('missing success usage retains the admitted ceiling', async () => {
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ id: 'test', model: 'glm-5.2', choices: [
      { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
    ] }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  await withGatewaySpendScope(engine, async () => {
    await call(); await expect(call()).rejects.toThrow('cap');
  });
  expect(calls).toBe(1);
});
