import { expect, test } from 'bun:test';
import { BudgetTracker } from '../../../src/core/budget/budget-tracker.ts';

test.each([NaN, Infinity, -Infinity, -1])('invalid budget bounds refuse: %s', value => {
  for (const key of ['maxCostUsd', 'maxRuntimeMs'] as const) {
    expect(() => new BudgetTracker({ label: 'bounds', auditPath: '/dev/null', [key]: value })).toThrow(TypeError);
  }
});

test.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('invalid token bounds refuse: %s', value => {
  const tracker = new BudgetTracker({ label: 'bounds', maxCostUsd: 1, auditPath: '/dev/null' });
  for (const key of ['estimatedInputTokens', 'maxOutputTokens'] as const) {
    expect(() => tracker.reserve({ modelId: 'claude-haiku-4-5-20251001', kind: 'chat',
      estimatedInputTokens: 0, maxOutputTokens: 0, [key]: value })).toThrow(TypeError);
  }
});

test('zero cap and zero token bounds remain valid', () => {
  const tracker = new BudgetTracker({ label: 'bounds', maxCostUsd: 0, auditPath: '/dev/null' });
  expect(() => tracker.reserve({ modelId: 'claude-haiku-4-5-20251001', kind: 'chat',
    estimatedInputTokens: 0, maxOutputTokens: 0 })).not.toThrow();
});

test.each([NaN, Infinity, -1, 0.5])('invalid recorded usage never changes spend: %s', value => {
  const tracker = new BudgetTracker({ label: 'bounds', maxCostUsd: 1, auditPath: '/dev/null' });
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) {
    expect(() => tracker.record({ modelId: 'claude-haiku-4-5-20251001', inputTokens: 0, [key]: value })).toThrow(TypeError);
    expect(tracker.totalSpent).toBe(0);
  }
});
