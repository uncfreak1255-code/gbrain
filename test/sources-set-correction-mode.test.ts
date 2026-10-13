import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';
import { sourceCorrectionMode } from '../src/core/facts/supersession-policy.ts';

describe('source correction mode', () => {
  let engine: PGLiteEngine;
  let origExit: typeof process.exit;
  let exitCode: number | null;
  beforeAll(async () => { origExit = process.exit; engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
  afterAll(async () => { await engine.disconnect(); process.exit = origExit; });
  afterEach(() => { process.exit = origExit; });
  beforeEach(async () => {
    await resetPgliteState(engine); exitCode = null;
    (process as unknown as { exit: (n: number) => never }).exit = ((n: number) => {
      exitCode = n; throw new Error(`__test_exit_${n}__`);
    }) as never;
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('policy-test','Policy test','{"retained":"yes"}'::jsonb)`);
  });

  test('owner setter atomically writes and reads the policy without replacing adjacent source config', async () => {
    expect(await sourceCorrectionMode(engine, 'policy-test')).toBe('semantic');
    await runSources(engine, ['set-correction-mode', 'policy-test', 'explicit']);
    expect(await sourceCorrectionMode(engine, 'policy-test')).toBe('explicit');
    const [row] = await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', ['policy-test']);
    expect(row.config).toMatchObject({ correction_mode: 'explicit', retained: 'yes' });
    await runSources(engine, ['set-correction-mode', 'policy-test', 'semantic']);
    expect(await sourceCorrectionMode(engine, 'policy-test')).toBe('semantic');
  });

  test('rejects an unknown policy value instead of silently selecting semantic retirement', async () => {
    await engine.updateSourceConfig('policy-test', { correction_mode: 'maybe' });
    await expect(sourceCorrectionMode(engine, 'policy-test')).rejects.toThrow(/invalid correction_mode/);
  });

  test('rejects unreadable persisted JSON config instead of silently selecting semantic retirement', async () => {
    await engine.executeRaw(`UPDATE sources SET config=to_jsonb('not-json'::text) WHERE id='policy-test'`);
    await expect(sourceCorrectionMode(engine, 'policy-test')).rejects.toThrow(/unreadable correction policy configuration/);
  });

  test('rejects invalid owner input and a missing source without mutating config', async () => {
    try { await runSources(engine, ['set-correction-mode', 'policy-test', 'maybe']); } catch { /* expected process.exit */ }
    expect(exitCode).toBe(2);
    exitCode = null;
    try { await runSources(engine, ['set-correction-mode', 'missing-source', 'explicit']); } catch { /* expected process.exit */ }
    expect(Number(exitCode)).toBe(4);
    const [row] = await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', ['policy-test']);
    expect(row.config).toEqual({ retained: 'yes' });
  });
});
