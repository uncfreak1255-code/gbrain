import { afterEach, beforeEach, expect, test } from 'bun:test';
import { configureGateway, resetGateway, expand, withBudgetTracker } from '../../../src/core/ai/gateway.ts';
import { BudgetTracker } from '../../../src/core/budget/budget-tracker.ts';

const originalFetch = globalThis.fetch;
let calls = 0;
let responseUsage: Record<string, number> | undefined;
beforeEach(() => {
  calls = 0;
  responseUsage = { input_tokens: 100, output_tokens: 50, total_tokens: 150 };
  configureGateway({ expansion_model: 'openai:gpt-4o-mini', env: { OPENAI_API_KEY: 'test-only' } });
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ id: 'example', object: 'response', created_at: 1,
      model: 'gpt-4o-mini', output: [{ type: 'message', id: 'message-example', status: 'completed',
        role: 'assistant', content: [{ type: 'output_text', text: '{"queries":["alternate"]}', annotations: [] }] }],
      usage: responseUsage }),
    { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; resetGateway(); });
const tracker = (maxCostUsd: number) => new BudgetTracker({ label: 'expansion', maxCostUsd, auditPath: '/dev/null' });

test('zero active budget stops expansion before HTTP', async () => {
  expect(await withBudgetTracker(tracker(0), () => expand('original'))).toEqual(['original']);
  expect(calls).toBe(0);
});
test('expansion records cost in the active budget', async () => {
  const budget = tracker(1);
  expect(await withBudgetTracker(budget, () => expand('original'))).toEqual(['original', 'alternate']);
  expect(calls).toBe(1);
  expect(budget.totalSpent).toBeGreaterThan(0);
});
test('failed expansion records a ceiling and never retries HTTP', async () => {
  globalThis.fetch = (async () => { calls++; throw new Error('example timeout'); }) as unknown as typeof fetch;
  const budget = tracker(1);
  expect(await withBudgetTracker(budget, () => expand('original'))).toEqual(['original']);
  expect(calls).toBe(1);
  expect(budget.totalSpent).toBeGreaterThan(0);
});

test.each([undefined, { input_tokens: -100, output_tokens: -50, total_tokens: -150 }])(
  'missing or invalid usage retains a positive ceiling', async usage => {
    responseUsage = usage;
    const budget = tracker(1);
    await withBudgetTracker(budget, () => expand('original'));
    expect(calls).toBe(1);
    expect(budget.totalSpent).toBeGreaterThan(0);
  });
