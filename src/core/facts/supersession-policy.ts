import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';

export type CorrectionMode = 'semantic' | 'explicit';

/** Read the source-wide semantic retirement policy; absent configuration preserves legacy behavior. */
export async function sourceCorrectionMode(engine: BrainEngine, sourceId: string): Promise<CorrectionMode> {
  const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [sourceId]);
  if (!row) throw opError('invalid_params', `Unknown memory source "${sourceId}".`, 'Pass a registered source id; list them with gbrain sources list.');
  let config = row.config;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch {
      throw opError('storage_error', `Source "${sourceId}" has an unreadable correction policy configuration.`, 'Repair the source config JSON, then set the mode with gbrain sources set-correction-mode.');
    }
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw opError('storage_error', `Source "${sourceId}" has an unreadable correction policy configuration.`, 'Repair the source config JSON, then set the mode with gbrain sources set-correction-mode.');
  }
  const mode = (config as Record<string, unknown>).correction_mode;
  if (mode === undefined) return 'semantic';
  if (mode === 'semantic' || mode === 'explicit') return mode;
  throw opError('storage_error', `Source "${sourceId}" has invalid correction_mode; expected semantic or explicit.`, 'Set it to semantic or explicit with gbrain sources set-correction-mode.');
}
