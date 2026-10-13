import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';

export type CorrectionMode = 'semantic' | 'explicit';

/** Read the source-wide semantic retirement policy; absent configuration preserves legacy behavior. */
export async function sourceCorrectionMode(engine: BrainEngine, sourceId: string): Promise<CorrectionMode> {
  const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [sourceId]);
  if (!row) throw new OperationError('invalid_params', `Unknown memory source "${sourceId}".`);
  let config = row.config;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch {
      throw new OperationError('storage_error', `Source "${sourceId}" has an unreadable correction policy configuration.`);
    }
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new OperationError('storage_error', `Source "${sourceId}" has an unreadable correction policy configuration.`);
  }
  const mode = (config as Record<string, unknown>).correction_mode;
  if (mode === undefined) return 'semantic';
  if (mode === 'semantic' || mode === 'explicit') return mode;
  throw new OperationError('storage_error', `Source "${sourceId}" has invalid correction_mode; expected semantic or explicit.`);
}
