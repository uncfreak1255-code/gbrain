/**
 * Sweep spend guard — PRODUCTION lane. The chat-transport seam that most
 * sweep tests use bypasses the SDK usage normalization; these tests stub the
 * SDK result instead (`__setGenerateTextTransportForTests`) so the gateway's
 * real usage → budget path is what runs. Fake keys, no network.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMaintenanceSweep, readSweepSpendLedger, CORPUS_INGESTED_SUFFIX, utcDay } from '../src/core/sweep.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import {
  configureGateway,
  resetGateway,
  __setGenerateTextTransportForTests,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};

let engine: PGLiteEngine;
let corpusDir: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  resetGateway();
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    env: { ANTHROPIC_API_KEY: 'sk-ant-spend-guard-fake-no-network' },
  } as never);
  __setChatTransportForTests(null);
}, 120_000);

afterAll(async () => {
  __setGenerateTextTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-spend-prod-'));
  tmpDirs.push(corpusDir);
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  await engine.setConfig('facts.sweep_max_usd', '0.006'); // fits ONE projected call at 1/1 pricing (~$0.0049)
  await engine.setConfig('facts.sweep_max_usd_per_day', '5');
  await engine.unsetConfig('facts.sweep_spend_ledger');
  await engine.unsetConfig('facts.extraction_model');
  await engine.setConfig('pricing.overrides', JSON.stringify({
    'anthropic:claude-sonnet-4-6': { input: 1, output: 1 },
    'anthropic:claude-haiku-4-5': { input: 1, output: 1 },
    'anthropic:claude-haiku-4-5-20251001': { input: 1, output: 1 },
  }));
});

afterEach(() => {
  __setGenerateTextTransportForTests(null);
});

function seed(n: number): void {
  for (let i = 0; i < n; i++) {
    writeFileSync(join(corpusDir, `t-${i}.txt`), `Transcript ${i}: the follow-up owner is the ops lead.\n`);
  }
}

/** Stub the SDK generateText result; `usage` is the surface under test. */
function stubSdk(usage: unknown): () => number {
  let n = 0;
  __setGenerateTextTransportForTests((async () => {
    n += 1;
    const text = JSON.stringify({ facts: [] });
    return { text, content: [{ type: 'text', text }], finishReason: 'stop', usage };
  }) as never);
  return () => n;
}

const sweep = () => runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED, budgetMs: 60_000, batchLimit: 20 });

describe('sweep spend guard — production usage path', () => {
  test('input reported but output missing is charged the output projection, so the cap still trips', async () => {
    seed(5);
    const calls = stubSdk({ inputTokens: 812, outputTokens: 0 });
    const r = await sweep();
    expect(calls()).toBe(1);
    expect(r.corpusIngested).toBe(1);
    expect(r.spentUsd).toBeGreaterThan(0.004);
    expect(r.skipped).toContainEqual({ reason: 'cost_cap_exhausted:corpus', count: 4 });
    expect(r.skipped).toContainEqual({ reason: 'cost_unmetered_calls:corpus', count: 1 });
    expect(await readSweepSpendLedger(engine)).toEqual({ day: utcDay(), usd: r.spentUsd });
  });

  test('no usage at all is charged the full projection', async () => {
    seed(5);
    const calls = stubSdk(undefined);
    const r = await sweep();
    expect(calls()).toBe(1);
    expect(r.spentUsd).toBeGreaterThan(0.004);
    expect(r.skipped).toContainEqual({ reason: 'cost_unmetered_calls:corpus', count: 1 });
  });

  test('a pricing override keyed by a model alias is applied at record time, not just at reserve', async () => {
    // The alias resolves to the dated id inside the gateway; the override is
    // keyed by the alias, the way the reserve_no_pricing hint tells operators.
    await engine.setConfig('facts.extraction_model', 'anthropic:claude-haiku-4-5');
    await engine.setConfig('facts.sweep_max_usd', '0.5');
    await engine.setConfig('pricing.overrides', JSON.stringify({
      'anthropic:claude-haiku-4-5': { input: 100, output: 100 },
    }));
    seed(3);
    const calls = stubSdk({ inputTokens: 1, outputTokens: 4000 });
    const r = await sweep();
    expect(calls()).toBe(1);
    // (1 + 4000) tokens at $100/M = $0.4001 — the operator's rate, not the shipped $1/$5 table.
    expect(r.spentUsd).toBeCloseTo(0.4001, 6);
    expect(r.skipped).toContainEqual({ reason: 'cost_cap_exhausted:corpus', count: 2 });
    expect(await readSweepSpendLedger(engine)).toEqual({ day: utcDay(), usd: 0.4001 });
  });

  test('a thrown provider error carrying zero usage is charged the projection, not $0', async () => {
    seed(5);
    let n = 0;
    __setGenerateTextTransportForTests((async () => {
      n += 1;
      const e = new Error('provider 500 with zero usage') as Error & { usage?: unknown };
      e.usage = { input_tokens: 0, output_tokens: 0 };
      throw e;
    }) as never);
    const r = await sweep();
    expect(n).toBe(1);
    expect(r.corpusIngested).toBe(0);
    expect(r.spentUsd).toBeGreaterThan(0.004);
    expect(r.skipped).toContainEqual({ reason: 'cost_cap_exhausted:corpus', count: 4 });
    expect(existsSync(join(corpusDir, 't-0.txt' + CORPUS_INGESTED_SUFFIX))).toBe(false);
  });
});
