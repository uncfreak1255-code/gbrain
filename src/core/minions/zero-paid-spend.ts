import { withAIInvocationPolicy, type AIInvocation } from '../ai/invocation-guard.ts';
import { UnrecoverableError } from './types.ts';

const LOCAL_PROVIDERS: Readonly<Record<AIInvocation['kind'], ReadonlySet<string>>> = {
  chat: new Set(['ollama', 'llama-server']),
  embedding: new Set(['ollama', 'llama-server', 'lmstudio']),
  rerank: new Set(['llama-server-reranker']),
  // No multimodal recipe is currently proven local-only. Fail closed until a
  // concrete local transport is added and covered by this policy's tests.
  multimodal: new Set(),
};

export class QueueZeroPaidSpendError extends UnrecoverableError {
  constructor(call: AIInvocation) {
    super(
      `queue_zero_paid_spend: refused ${call.kind} provider route ${call.model} ` +
      `for ${call.operation}; no provider call was made`,
    );
    this.name = 'QueueZeroPaidSpendError';
  }
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

export function isExplicitlyLocalInvocation(call: AIInvocation): boolean {
  const provider = providerOf(call.model);
  if (!LOCAL_PROVIDERS[call.kind].has(provider) || !isLoopbackEndpoint(call.endpoint)) return false;
  // Ollama cloud models are reached through the local daemon but can still
  // bill remotely. The documented model tag is therefore never local-only.
  return provider !== 'ollama' || !/(?:^|[:-])cloud(?:$|:)/i.test(call.model);
}

/**
 * Queue-wide hard boundary for continuous workers. Unknown and proxy routes
 * fail closed: only provider ids whose transport is explicitly local may run.
 */
export function withQueueZeroPaidSpend<T>(
  run: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  if (env.GBRAIN_QUEUE_ZERO_PAID_SPEND !== '1') return run();
  return withAIInvocationPolicy(async (call) => {
    if (!isExplicitlyLocalInvocation(call)) throw new QueueZeroPaidSpendError(call);
  }, run);
}
