import { afterEach, expect, test } from 'bun:test';
import { expand, configureGateway, resetGateway, withBudgetTracker, __setGenerateTextTransportForTests } from '../../../src/core/ai/gateway.ts';
import { BudgetTracker } from '../../../src/core/budget/budget-tracker.ts';

afterEach(() => { __setGenerateTextTransportForTests(null); resetGateway(); });

test('expansion refuses a zero cap before any SDK call', async () => {
  configureGateway({ expansion_model: 'deepseek:deepseek-v4-flash', env: { DEEPSEEK_API_KEY: 'test-only' } });
  let calls = 0;
  __setGenerateTextTransportForTests((async () => {
    calls++;
    return { text: '{"queries":["alternate"]}', usage: { inputTokens: 10, outputTokens: 10 } };
  }) as any);
  const tracker = new BudgetTracker({ maxCostUsd: 0, label: 'expansion-admission', auditPath: '/dev/null' });
  await withBudgetTracker(tracker, () => expand('test query'));
  expect(calls).toBe(0);
});

test('expansion bounds output and disables SDK retries', async () => {
  configureGateway({ expansion_model: 'deepseek:deepseek-v4-flash', env: { DEEPSEEK_API_KEY: 'test-only' } });
  let request: any;
  __setGenerateTextTransportForTests((async (opts: any) => {
    request = opts;
    return { text: '{"queries":["alternate"]}', usage: { inputTokens: 10, outputTokens: 10 } };
  }) as any);
  await expand('test query');
  expect(request.maxOutputTokens).toBe(512);
  expect(request.maxRetries).toBe(0);
});
