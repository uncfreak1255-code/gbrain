import { describe, expect, test } from 'bun:test';
import { readMaintenanceHealth } from '../src/core/maintenance-health.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('readMaintenanceHealth timeout contract', () => {
  test('aborts the engine query and reports the section timeout', async () => {
    let signal: AbortSignal | undefined;
    let timedOut = false;
    const engine = {
      executeRaw: async (_sql: string, _params?: unknown[], opts?: { signal?: AbortSignal }) => {
        signal = opts?.signal;
        return new Promise<never>(() => { /* settled by the timeout race */ });
      },
    } as unknown as BrainEngine;

    const health = await readMaintenanceHealth(engine, 10, () => { timedOut = true; });

    expect(health.state).toBe('unknown');
    expect(signal?.aborted).toBe(true);
    expect(timedOut).toBe(true);
  });
});
