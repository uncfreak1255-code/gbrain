import type { AIInvocation } from './invocation-guard.ts';
import { UnrecoverableError } from '../minions/types.ts';

/**
 * The zero-paid-spend boundary, evaluated inside `invokeAI` itself.
 *
 * Why it lives here and not in a wrapper each executor installs: the first
 * design wrapped `withQueueZeroPaidSpend` around the two job executors we knew
 * about (`minions/worker.ts`, `minions/run-child.ts`). A third executor,
 * `core/cycle/inline-drain.ts`, claims and runs the same `minion_jobs` rows —
 * reachable from autopilot's inline-cycle fallback and from `gbrain dream` —
 * and it was never wrapped, so a queued subagent job reached
 * `anthropic:claude-sonnet-4-6` and billed while the boundary was "on".
 *
 * That is fail-open by omission: an opt-in wrapper means every executor added
 * later silently escapes, and nothing detects it. Reading the boundary at the
 * single point every provider call must pass through makes it a property of
 * the invocation path instead of each caller's discipline. There is no way to
 * add a new executor that forgets it.
 */

const ENV = 'GBRAIN_QUEUE_ZERO_PAID_SPEND';

const LOCAL_PROVIDERS: Readonly<Record<AIInvocation['kind'], ReadonlySet<string>>> = {
  chat: new Set(['ollama', 'llama-server']),
  embedding: new Set(['ollama', 'llama-server', 'lmstudio']),
  rerank: new Set(['llama-server-reranker']),
  // No multimodal recipe is currently proven local-only. Fail closed until a
  // concrete local transport is added and covered by this policy's tests.
  multimodal: new Set(),
};

const EXPLICITLY_OFF = new Set(['', '0', 'false', 'no', 'off']);

/**
 * Is the boundary on?
 *
 * Unset means off. Anything SET that is not an explicit off value means ON,
 * including values this code does not recognize. That asymmetry is the whole
 * point: `GBRAIN_ALLOW_SHELL_JOBS` grants a permission, so a typo there fails
 * closed by leaving it off — but this variable withholds one, so treating a
 * typo as "off" would fail open, toward money. An operator who writes
 * `=true` into `~/.gbrain/env` (which the daemon wrapper sources with
 * `set -a`) gets the protection they plainly asked for.
 */
export function queueZeroPaidSpendEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ENV];
  if (raw === undefined) return false;
  return !EXPLICITLY_OFF.has(raw.trim().toLowerCase());
}

/** True when the variable is set to something neither clearly on nor clearly off. */
export function queueZeroPaidSpendValueIsAmbiguous(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ENV];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return !EXPLICITLY_OFF.has(value) && !['1', 'true', 'yes', 'on'].includes(value);
}

function providerOf(model: string): string {
  const colon = model.indexOf(':');
  const slash = model.indexOf('/');
  const cut = colon < 0 ? slash : slash < 0 ? colon : Math.min(colon, slash);
  return (cut < 0 ? '' : model.slice(0, cut)).trim().toLowerCase();
}

function isLoopbackEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    const { hostname, protocol } = new URL(endpoint);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * "Explicitly local" means a known-local provider id at a loopback endpoint.
 *
 * Deliberate residual, stated plainly rather than overclaimed: a loopback
 * endpoint can itself be a relay. Registering a paid API under the `ollama`
 * id at `http://127.0.0.1:4000` (the LiteLLM shape) is admitted here, and no
 * check on this side of the socket can see past the proxy. That is an
 * operator-config decision — the model label is built from the configured
 * recipe id, not from job data, so it is not reachable from queued input.
 */
export function isExplicitlyLocalInvocation(call: AIInvocation): boolean {
  const provider = providerOf(call.model);
  if (!LOCAL_PROVIDERS[call.kind]?.has(provider) || !isLoopbackEndpoint(call.endpoint)) return false;
  // Ollama cloud models are reached through the local daemon but can still
  // bill remotely. Any `cloud` segment disqualifies — `:cloud`, `-cloud`,
  // `_cloud` and `-cloud-preview` all bill.
  return provider !== 'ollama' || !/(?:^|[:_-])cloud(?:$|[:_-])/i.test(call.model);
}

export class QueueZeroPaidSpendError extends UnrecoverableError {
  constructor(call: AIInvocation) {
    super(
      `queue_zero_paid_spend: refused ${call.kind} provider route ${call.model} ` +
      `for ${call.operation}; no provider call was made`,
    );
    this.name = 'QueueZeroPaidSpendError';
  }
}

/**
 * Throws unless the route is explicitly local. Called by `invokeAI` before any
 * policy, guard, or transport runs.
 */
export function assertZeroPaidSpendAdmission(
  call: AIInvocation,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!queueZeroPaidSpendEnabled(env)) return;
  if (!isExplicitlyLocalInvocation(call)) throw new QueueZeroPaidSpendError(call);
}
