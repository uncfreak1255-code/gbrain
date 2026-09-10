import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { AIGatewayConfig, Recipe } from '../ai/types.ts';
import { canonicalLookup, type ModelPricing } from '../model-pricing.ts';
import { sqlQueryForEngine } from '../sql-query.ts';
import { BudgetExceededError } from '../spend-log.ts';

/** Durable limits for the supported paid text gateway surface. */
export interface PaidBudgetPolicy {
  max_usd_per_run: number;
  max_usd_per_day: number;
}

/** Local inference that may skip paid reservation after a loopback check. */
export const LOCAL_PAID_PROVIDERS = ['ollama', 'llama-server', 'lmstudio'] as const;
const LOCAL_PAID_ENV: Record<(typeof LOCAL_PAID_PROVIDERS)[number], string> = {
  ollama: 'OLLAMA_BASE_URL',
  'llama-server': 'LLAMA_SERVER_BASE_URL',
  lmstudio: 'LMSTUDIO_BASE_URL',
};
const LOCAL_PAID_DEFAULTS: Record<(typeof LOCAL_PAID_PROVIDERS)[number], string> = {
  ollama: 'http://localhost:11434/v1',
  'llama-server': 'http://localhost:8080/v1',
  lmstudio: 'http://localhost:1234/v1',
};
const CLI_OWNED_SCOPE_EXEMPT = new Set(['serve', 'autopilot']);

interface GatewayScope { engine: BrainEngine; runId: string }
const scopes = new AsyncLocalStorage<GatewayScope>();
const GATEWAY_CLIENT_ID = 'gbrain:gateway-budget';

export function withGatewaySpendScope<T>(
  engine: BrainEngine,
  fn: () => Promise<T>,
  runId?: string,
): Promise<T> {
  if (runId === undefined && scopes.getStore()?.engine === engine) return fn();
  return scopes.run({ engine, runId: runId ?? randomUUID() }, fn);
}

/** CLI-only commands that own their own durable run identity. */
export function cliCommandOwnsGatewaySpendScope(command: string): boolean {
  return !CLI_OWNED_SCOPE_EXEMPT.has(command);
}

/** Wrap a CLI command unless it owns per-tick / process-lifetime scope. */
export function withCliGatewaySpendScope<T>(
  engine: BrainEngine,
  command: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!cliCommandOwnsGatewaySpendScope(command)) return fn();
  return withGatewaySpendScope(engine, fn);
}

export function currentGatewaySpendRunId(engine: BrainEngine): string | undefined {
  const scope = scopes.getStore();
  return scope?.engine === engine ? scope.runId : undefined;
}

export const SPEND_RUN_DATA_KEY = '__gateway_spend_run';

/** Resolve the durable run id from a queue job and its parent chain. */
export async function gatewayJobRunId(
  engine: BrainEngine,
  job: { id: number; data?: Record<string, unknown>; parent_job_id?: number | null },
): Promise<string> {
  const seen = new Set<number>();
  let current = job;
  for (let depth = 0; depth < 64; depth++) {
    if (seen.has(current.id)) throw new Error('Cyclic gateway budget job ancestry');
    seen.add(current.id);
    const stamped = current.data?.[SPEND_RUN_DATA_KEY];
    if (typeof stamped === 'string' && stamped.length > 0) return stamped;
    if (!current.parent_job_id) return `job:${current.id}`;
    const [parent] = await engine.executeRaw<{
      id: number; data: Record<string, unknown>; parent_job_id: number | null;
    }>('SELECT id, data, parent_job_id FROM minion_jobs WHERE id = $1', [current.parent_job_id]);
    if (!parent) throw new Error('Missing gateway budget job parent');
    current = parent;
  }
  throw new Error('Gateway budget job ancestry exceeds limit');
}

export function validatePaidBudget(policy: unknown): asserts policy is PaidBudgetPolicy | undefined {
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Invalid paid_budget');
  }
  for (const key of ['max_usd_per_run', 'max_usd_per_day'] as const) {
    const value = (policy as PaidBudgetPolicy)[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid paid_budget.${key}`);
    }
  }
}

function isLocalPaidProvider(provider: string): provider is (typeof LOCAL_PAID_PROVIDERS)[number] {
  return (LOCAL_PAID_PROVIDERS as readonly string[]).includes(provider);
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** Resolve the URL paid mode will actually dial for a local provider. */
export function resolveLocalPaidBaseUrl(cfg: AIGatewayConfig, provider: string): string | undefined {
  if (!isLocalPaidProvider(provider)) return undefined;
  const configured = cfg.base_urls?.[provider];
  if (configured) return configured;
  const fromEnv = cfg.env?.[LOCAL_PAID_ENV[provider]];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return LOCAL_PAID_DEFAULTS[provider];
}

/** Paid mode permits only loopback local inference for embeddings and chat. */
export function assertLocalPaidPolicy(cfg: AIGatewayConfig, model: string, kind: string): void {
  if (!cfg.paid_budget) return;
  const provider = model.split(':', 1)[0] ?? '';
  if (!isLocalPaidProvider(provider)) {
    throw new Error(`paid_budget: local ${kind} only`);
  }
  const url = resolveLocalPaidBaseUrl(cfg, provider);
  if (!url) throw new Error('paid_budget: local inference requires a loopback endpoint');
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error('paid_budget: local inference requires a loopback endpoint');
  }
  if (!isLoopbackHostname(hostname)) {
    throw new Error('paid_budget: local inference requires a loopback endpoint');
  }
}

export function parsePricingOverrides(raw: unknown): Record<string, ModelPricing> | undefined {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error('Invalid pricing.overrides'); }
  }
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pricing.overrides');
  const out: Record<string, ModelPricing> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Invalid pricing.overrides: every declared rate must be valid');
    }
    const input = (item as { input?: unknown }).input;
    const output = (item as { output?: unknown }).output;
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 ||
        typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
      throw new Error('Invalid pricing.overrides: every declared rate must be valid');
    }
    out[key.trim().toLowerCase()] = { input, output };
  }
  return out;
}

async function pricingFor(engine: BrainEngine, model: string): Promise<ModelPricing | null> {
  const raw = await engine.getConfig('pricing.overrides');
  const overrides = parsePricingOverrides(raw);
  return overrides?.[model.trim().toLowerCase()] ?? canonicalLookup(model) ?? null;
}

/**
 * Validate, reserve, and dispatch one OpenAI-compatible text request. The
 * reservation is a non-expiring write-ahead hold: failed or unknown provider
 * outcomes keep their admitted ceiling so retries cannot bypass the cap.
 */
export function paidTextFetch(
  recipe: Recipe,
  modelId: string,
  cfg: AIGatewayConfig,
  custom?: typeof fetch,
): typeof fetch | undefined {
  if (!cfg.paid_budget) return custom;
  const paidBudget = cfg.paid_budget;
  if (isLocalPaidProvider(recipe.id)) {
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
    let body: Record<string, any>;
    try { body = JSON.parse(init.body); } catch { throw new Error('paid_budget: expected serialized text request'); }
    const allowed = new Set([
      'model', 'messages', 'max_tokens', 'max_completion_tokens', 'n', 'temperature', 'top_p', 'stop',
      'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'response_format',
      'seed', 'user', 'presence_penalty', 'frequency_penalty',
      'logprobs', 'top_logprobs',
    ]);
    if (Object.keys(body).some(key => !allowed.has(key)) ||
        (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((t: any) => t.type !== 'function')))) {
      throw new Error('paid_budget: unsupported wire options or hosted tools');
    }
    const output = body.max_tokens ?? body.max_completion_tokens;
    if (body.model !== modelId || !Number.isSafeInteger(output) || output <= 0 ||
        (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) ||
        (body.n !== undefined && body.n !== 1)) {
      throw new Error('paid_budget: invalid wire model or output bound');
    }
    if (!Array.isArray(body.messages) || body.messages.some((m: any) =>
      m.content != null && typeof m.content !== 'string' &&
      (!Array.isArray(m.content) || m.content.some((part: any) => part.type !== 'text' || typeof part.text !== 'string')))) {
      throw new Error('paid_budget: text messages only');
    }
    const rates = await pricingFor(scope.engine, `${recipe.id}:${modelId}`);
    if (!rates || rates.input <= 0 || rates.output <= 0) {
      throw new Error('paid_budget: missing positive model prices');
    }
    const inputTokens = Buffer.byteLength(init.body, 'utf8') + 4096;
    const estimatedUsd = (inputTokens * Math.max(rates.input, rates.cache_read_input ?? 0) + output * rates.output) / 1_000_000;
    await reserveGatewaySpend(scope.engine, {
      runId: scope.runId,
      estimatedUsd,
      runCapUsd: paidBudget.max_usd_per_run,
      dayCapUsd: paidBudget.max_usd_per_day,
      model: `${recipe.id}:${modelId}`,
    });
    return fetch(input, { ...init, redirect: 'error' });
  }) as typeof fetch;
}

function lockKey(value: string): bigint {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return BigInt(hash >>> 0);
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a finite non-negative number`);
}

/** Atomic cap admission under the existing per-client advisory lock. */
export async function reserveGatewaySpend(
  engine: BrainEngine,
  opts: { runId: string; estimatedUsd: number; runCapUsd: number; dayCapUsd: number; model: string },
): Promise<void> {
  if (!opts.runId.trim() || !opts.model.trim()) throw new TypeError('gateway reservation identity must be non-empty');
  assertFinite('estimatedUsd', opts.estimatedUsd);
  assertFinite('runCapUsd', opts.runCapUsd);
  assertFinite('dayCapUsd', opts.dayCapUsd);
  const cents = Math.ceil(opts.estimatedUsd * 1_000_000) / 10_000;
  if (!Number.isFinite(cents) || cents >= 100_000_000) throw new Error('Invalid gateway reservation');
  await engine.transaction(async tx => {
    const sql = sqlQueryForEngine(tx);
    // Same lock on both engines. PGLite (WASM Postgres 17) supports
    // pg_advisory_xact_lock; skipping it here let concurrent MCP/toolLoop
    // admissions double-read the SUM and both insert.
    await sql`SELECT pg_advisory_xact_lock(${lockKey(GATEWAY_CLIENT_ID)})`;
    const [row] = await sql`
      SELECT
        COALESCE(SUM(spend_cents) FILTER (WHERE token_name = ${opts.runId}), 0)::text AS run_cents,
        COALESCE(SUM(spend_cents) FILTER (WHERE created_at >=
          (date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')), 0)::text AS day_cents
      FROM mcp_spend_log WHERE client_id = ${GATEWAY_CLIENT_ID} AND operation = 'gateway_reservation'
    `;
    const run = Number(row?.run_cents ?? 0);
    const day = Number(row?.day_cents ?? 0);
    if (!Number.isFinite(run) || !Number.isFinite(day)) throw new Error('Unreadable gateway spend ledger');
    const holdMicros = Math.round(cents * 10_000);
    const runMicros = Math.round(run * 10_000);
    const dayMicros = Math.round(day * 10_000);
    const runCapMicros = Math.floor(opts.runCapUsd * 1_000_000);
    const dayCapMicros = Math.floor(opts.dayCapUsd * 1_000_000);
    if (![holdMicros, runMicros, dayMicros, runCapMicros, dayCapMicros].every(Number.isSafeInteger)) {
      throw new Error('Gateway spend amount exceeds safe precision');
    }
    if (runMicros + holdMicros > runCapMicros || dayMicros + holdMicros > dayCapMicros) {
      throw new BudgetExceededError(
        'Gateway paid budget cap exceeded',
        Math.max(run, day),
        Math.min(opts.runCapUsd, opts.dayCapUsd) * 100,
      );
    }
    await sql`
      INSERT INTO mcp_spend_log (client_id, token_name, operation, spend_cents, provider, model, created_at)
      VALUES (${GATEWAY_CLIENT_ID}, ${opts.runId}, 'gateway_reservation', ${cents}, ${opts.model.split(':')[0]}, ${opts.model}, clock_timestamp())
    `;
  });
}
