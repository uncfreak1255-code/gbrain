import { invokeAI, sdkInvocationUsage, hasAIInvocationGuard, hasAIInvocationPolicy, type AIInvocation } from './invocation-guard.ts';
import { resolveChatContextTokens } from './model-resolver.ts';
import { queueZeroPaidSpendEnabled } from './zero-paid-spend-policy.ts';

export function chatInvocation(operation: string, model: string, maxOutputTokens: number): AIInvocation {
  let maxInputTokens: number | undefined;
  try { maxInputTokens = resolveChatContextTokens(model); } catch { /* finite admission refuses an unknown maximum */ }
  return { operation, kind: 'chat', model, maxInputTokens, maxOutputTokens };
}

/** Each SDK attempt has its own durable hold; local calls keep SDK retries. */
export function createGuardedGeneration(defaultMaxOutputTokens: () => number) {
  return async function guardedGeneration<T>(model: string, transport: (opts: any) => Promise<T>, opts: any, endpoint?: string): Promise<T> {
    // Skip invokeAI only when nothing would run there: no spend guard, no
    // policy ALS, and the process-wide queue boundary is off. The skip exists
    // so unguarded calls keep SDK retries. It must not also skip
    // assertZeroPaidSpendAdmission — inline-drain / dream oneshot have no ALS
    // and still reach gateway.chat() through this function.
    if (!hasAIInvocationGuard() && !hasAIInvocationPolicy() && !queueZeroPaidSpendEnabled()) return transport(opts);
    const maxOutputTokens = opts.maxOutputTokens ?? defaultMaxOutputTokens();
    return invokeAI({ ...chatInvocation('gateway.generate', model, maxOutputTokens),
      endpoint,
      cacheWriteTtl: opts.providerOptions?.anthropic?.cacheControl?.ttl ?? '5m' },
      () => transport({ ...opts, maxOutputTokens, maxRetries: 0 }), sdkInvocationUsage);
  };
}
