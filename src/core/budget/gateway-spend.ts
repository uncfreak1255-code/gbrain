import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { AIGatewayConfig, Recipe } from '../ai/types.ts';
import { loadPricingOverridesStrict, resolveBudgetPricing } from './budget-tracker.ts';
import { reserveGatewaySpend } from '../minions/budget-meter.ts';

export interface PaidBudgetPolicy { max_usd_per_run: number; max_usd_per_day: number }
const scopes = new AsyncLocalStorage<{ engine: BrainEngine; runId: string }>();

export function withGatewaySpendScope<T>(engine: BrainEngine, fn: () => Promise<T>, runId?: string): Promise<T> {
  if (runId === undefined && scopes.getStore()?.engine === engine) return fn();
  return scopes.run({ engine, runId: runId ?? randomUUID() }, fn);
}
export function currentGatewaySpendRunId(engine: BrainEngine): string | undefined {
  const scope = scopes.getStore();
  return scope?.engine === engine ? scope.runId : undefined;
}

export const SPEND_RUN_DATA_KEY = '__gateway_spend_run';
/** Queue-owned identity survives retries and descendants across processes. */
export async function gatewayJobRunId(engine: BrainEngine, job: { id: number; data?: Record<string, unknown>; parent_job_id?: number | null }): Promise<string> {
  const seen = new Set<number>();
  let current = job;
  for (let depth = 0; depth < 64; depth++) {
    if (seen.has(current.id)) throw new Error('Cyclic gateway budget job ancestry');
    seen.add(current.id);
    const stamped = current.data?.[SPEND_RUN_DATA_KEY];
    if (typeof stamped === 'string' && stamped.length > 0) return stamped;
    if (!current.parent_job_id) return `job:${current.id}`;
    const [parent] = await engine.executeRaw<{ id: number; data: Record<string, unknown>; parent_job_id: number | null }>(
      'SELECT id, data, parent_job_id FROM minion_jobs WHERE id = $1', [current.parent_job_id]);
    if (!parent) throw new Error('Missing gateway budget job parent');
    current = parent;
  }
  throw new Error('Gateway budget job ancestry exceeds limit');
}
export function validatePaidBudget(policy: unknown): asserts policy is PaidBudgetPolicy | undefined {
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Invalid paid_budget');
  for (const key of ['max_usd_per_run', 'max_usd_per_day'] as const) {
    const n = (policy as PaidBudgetPolicy)[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`Invalid paid_budget.${key}`);
  }
}

export function assertLocalPaidPolicy(cfg: AIGatewayConfig, model: string, kind: string): void {
  if (!cfg.paid_budget) return;
  const provider = model.split(':')[0];
  if (!['ollama', 'llama-server', 'lmstudio'].includes(provider)) throw new Error(`paid_budget: local ${kind} only`);
  const url = cfg.base_urls?.[provider];
  if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('paid_budget: local inference requires a loopback endpoint');
  }
}

/** Only plain OpenAI-compatible text requests have a proved token bound here. */
export function paidTextFetch(recipe: Recipe, modelId: string, cfg: AIGatewayConfig, custom?: typeof fetch): typeof fetch | undefined {
  if (!cfg.paid_budget) return custom;
  if (['ollama', 'llama-server'].includes(recipe.id)) {
    assertLocalPaidPolicy(cfg, `${recipe.id}:${modelId}`, 'chat');
    return custom;
  }
  if (recipe.implementation !== 'openai-compatible' || custom) {
    throw new Error('paid_budget: unsupported paid transport');
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const scope = scopes.getStore();
    if (!scope) throw new Error('paid_budget: paid HTTP requires a durable run scope');
    if (typeof init?.body !== 'string') throw new Error('paid_budget: expected serialized text request');
    const body = JSON.parse(init.body);
    const allowed = new Set(['model', 'messages', 'max_tokens', 'max_completion_tokens', 'n', 'temperature', 'top_p', 'stop',
      'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'thinking',
      'reasoning_effort', 'seed', 'user', 'presence_penalty', 'frequency_penalty', 'logprobs', 'top_logprobs']);
    if (Object.keys(body).some(key => !allowed.has(key)) ||
        (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((t: any) => t.type !== 'function')))) {
      throw new Error('paid_budget: unsupported wire options or hosted tools');
    }
    const output = body.max_tokens ?? body.max_completion_tokens;
    if (body.model !== modelId || !Number.isSafeInteger(output) || output <= 0 ||
        (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) ||
        (body.n !== undefined && body.n !== 1)) throw new Error('paid_budget: invalid wire model or output bound');
    if (!Array.isArray(body.messages) || body.messages.some((m: any) =>
      m.content != null && typeof m.content !== 'string' &&
      (!Array.isArray(m.content) || m.content.some((part: any) => part.type !== 'text' || typeof part.text !== 'string')))) {
      throw new Error('paid_budget: text messages only');
    }
    // Byte count bounds text BPE input plus a framing allowance. Include
    // serialized tools, prior reasoning, schemas and provider options.
    const inputTokens = Buffer.byteLength(init.body, 'utf8') + 4096;
    const model = `${recipe.id}:${modelId}`;
    const rates = resolveBudgetPricing(model, 'chat', await loadPricingOverridesStrict(scope.engine));
    if (!rates || rates.input <= 0 || rates.output <= 0) throw new Error('paid_budget: missing positive model prices');
    const inputRate = Math.max(rates.input, rates.cache_read ?? 0, rates.cache_write ?? 0);
    await reserveGatewaySpend(scope.engine, {
      runId: scope.runId, model, estimatedUsd: (inputTokens * inputRate + output * rates.output) / 1_000_000,
      runCapUsd: cfg.paid_budget!.max_usd_per_run, dayCapUsd: cfg.paid_budget!.max_usd_per_day,
    });
    // A 307/308 can repeat the paid body. Never let fetch follow it under
    // one reservation; all failures retain the admitted ceiling.
    return fetch(input, { ...init, redirect: 'error' });
  }) as typeof fetch;
}
