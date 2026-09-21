import { withAIInvocationPolicy, type AIInvocation } from '../ai/invocation-guard.ts';
import {
  assertZeroPaidSpendAdmission,
  isExplicitlyLocalInvocation,
  queueZeroPaidSpendEnabled,
  queueZeroPaidSpendValueIsAmbiguous,
  QueueZeroPaidSpendError,
} from '../ai/zero-paid-spend-policy.ts';

// Re-exported so existing minions-side importers keep one import path while
// the single definition lives at the chokepoint (ai/zero-paid-spend-policy.ts).
export {
  isExplicitlyLocalInvocation,
  queueZeroPaidSpendEnabled,
  queueZeroPaidSpendValueIsAmbiguous,
  QueueZeroPaidSpendError,
};

export const QUEUE_ZERO_PAID_SPEND_FLAG = '--zero-paid-spend';
export const QUEUE_ZERO_PAID_SPEND_ENV = 'GBRAIN_QUEUE_ZERO_PAID_SPEND';

export class ZeroPaidSpendFlagError extends Error {}

const TRUTHY = new Set(['', '1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

/**
 * Resolve an EXPLICIT spend choice from argv, or undefined when argv is
 * silent. Returns a tri-state on purpose: "not mentioned" must not read as
 * "turn it off", or a durable opt-in would be erased by every bare invocation.
 *
 * Why this is not `args.includes('--zero-paid-spend')`: the CLI validator
 * (src/cli.ts findUnknownFlag) legalizes an `=value` suffix and `--no-`
 * negations for any known flag, so `--zero-paid-spend=1` reaches dispatch.
 * An `includes()` reader silently misses it and the worker starts UNGUARDED
 * while the operator watches a clean startup — the exact false-safety-signal
 * this boundary exists to eliminate. `--allow-shell-jobs` shares the idiom
 * but not the failure direction: missing it there fails closed, missing it
 * here fails open, toward money.
 *
 * An unrecognized value is refused loudly rather than guessed.
 */
export function resolveZeroPaidSpendChoice(args: readonly string[]): boolean | undefined {
  let choice: boolean | undefined;
  for (const arg of args) {
    const match = /^--(no-)?zero-paid-spend(?:=(.*))?$/i.exec(arg);
    if (!match) continue;
    const [, negated, rawValue] = match;
    const value = (rawValue ?? '').trim().toLowerCase();
    let enabled: boolean;
    if (TRUTHY.has(value)) enabled = true;
    else if (FALSY.has(value)) enabled = false;
    else {
      throw new ZeroPaidSpendFlagError(
        `${QUEUE_ZERO_PAID_SPEND_FLAG}: unrecognized value '${rawValue}'. ` +
        `Use ${QUEUE_ZERO_PAID_SPEND_FLAG}, ${QUEUE_ZERO_PAID_SPEND_FLAG}=true, ` +
        `or --no-${QUEUE_ZERO_PAID_SPEND_FLAG.slice(2)} — refusing to guess whether ` +
        'paid spend is allowed.',
      );
    }
    choice = negated ? !enabled : enabled;
  }
  return choice;
}

/**
 * Re-assert the operator's opt-in after a command's preflight and report the
 * resulting state. Mirrors the --allow-shell-jobs handshake: the opt-in
 * travels as a flag as well as env so a worker spawned by the supervisor, or
 * an isolated child, keeps the boundary its parent was started with.
 *
 * Every command that ends up executing queued work calls this. A flag the CLI
 * accepts and the worker ignores is a false safety signal, not a safeguard.
 */
export function applyQueueZeroPaidSpendFlag(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const choice = resolveZeroPaidSpendChoice(args);
  if (choice === true) env[QUEUE_ZERO_PAID_SPEND_ENV] = '1';
  else if (choice === false) delete env[QUEUE_ZERO_PAID_SPEND_ENV];
  return queueZeroPaidSpendEnabled(env);
}

/**
 * Defence in depth only — enforcement itself lives in `invokeAI` (see
 * ai/zero-paid-spend-policy.ts), so a job is covered whether or not its
 * executor calls this. Retained because it also refuses in-process callers
 * that reach a policy without going through the guard, and because an
 * explicit wrap at a known executor documents the intent at that site.
 */
export function withQueueZeroPaidSpend<T>(
  run: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  if (!queueZeroPaidSpendEnabled(env)) return run();
  return withAIInvocationPolicy((call: AIInvocation) => {
    assertZeroPaidSpendAdmission(call, env);
  }, run);
}
