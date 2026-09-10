import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chat, configureGateway, resetGateway, withBudgetTracker } from '../../../src/core/ai/gateway.ts';
import { BudgetTracker } from '../../../src/core/budget/budget-tracker.ts';

const originalFetch = globalThis.fetch;
let directory: string | undefined;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetGateway();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

for (const model of ['anthropic/claude-sonnet-4-6', 'anthropic:claude-haiku-4-5']) {
  test.each([false, true])(`chat keeps the reserved budget identity for ${model} (failure=%s)`, async failure => {
    directory = mkdtempSync(join(tmpdir(), 'gbrain-model-identity-'));
    const auditPath = join(directory, 'budget.jsonl');
    const tracker = new BudgetTracker({ label: 'identity', maxCostUsd: 0.15, auditPath,
      pricingOverrides: { [model]: { input: 100, output: 100 } } });
    configureGateway({ chat_model: model, env: { ANTHROPIC_API_KEY: 'test-only' } });
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify(failure
      ? { type: 'error', error: { type: 'invalid_request_error', message: 'fixture rejection' } }
      : { id: 'msg_example', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 10 } }),
    { status: failure ? 400 : 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const result = withBudgetTracker(tracker, () => chat({ messages: [{ role: 'user', content: 'example' }], maxTokens: 64 }));
    if (failure) await expect(result).rejects.toThrow('fixture rejection');
    else expect((await result).text).toBe('ok');
    const rows = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const reserved = rows.filter(row => row.event === 'reserve');
    const recorded = rows.filter(row => row.event === 'record');
    expect(reserved).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].model).toBe(reserved[0].model);
    expect(recorded[0].model).toBe(model);
    if (!failure) {
      expect(tracker.totalSpent).toBeCloseTo(0.101, 8);
      await expect(withBudgetTracker(tracker, () => chat({ messages: [{ role: 'user', content: 'example' }], maxTokens: 500 })))
        .rejects.toThrow();
      expect(calls).toBe(1);
    }
  });
}
