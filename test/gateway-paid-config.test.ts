import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runConfig } from '../src/commands/config.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const noEngine = null as unknown as BrainEngine;

describe('paid gateway policy configuration', () => {
  test('stores and unsets paid_budget in the file plane', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-paid-config-'));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await runConfig(noEngine, ['set', 'paid_budget', '{"max_usd_per_run":0.25,"max_usd_per_day":2}']);
      const path = join(home, '.gbrain', 'config.json');
      expect(JSON.parse(readFileSync(path, 'utf8')).paid_budget).toEqual({ max_usd_per_run: 0.25, max_usd_per_day: 2 });
      await runConfig(noEngine, ['unset', 'paid_budget']);
      expect(JSON.parse(readFileSync(path, 'utf8')).paid_budget).toBeUndefined();
    });
  });

  test('reads paid_budget from the file plane', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-paid-config-get-'));
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(' '));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await runConfig(noEngine, ['set', 'paid_budget', '{"max_usd_per_run":0.25,"max_usd_per_day":2}']);
        await runConfig(noEngine, ['get', 'paid_budget']);
      });
      expect(output.at(-1)).toBe('{"max_usd_per_run":0.25,"max_usd_per_day":2}');
    } finally {
      console.log = originalLog;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects invalid policy before writing a config file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-paid-config-invalid-'));
    const originalExit = process.exit;
    (process as { exit: unknown }).exit = (() => { throw new Error('__exit__'); }) as unknown as typeof process.exit;
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await expect(runConfig(noEngine, ['set', 'paid_budget', '{"max_usd_per_run":-1,"max_usd_per_day":2}']))
          .rejects.toThrow('__exit__');
      });
      expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
    } finally {
      process.exit = originalExit;
    }
  });

  test('registers paid_budget as a known key', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('paid_budget');
  });
});
