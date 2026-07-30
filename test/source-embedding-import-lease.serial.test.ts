import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  embed,
  resetGateway,
  withBudgetTracker,
} from '../src/core/ai/gateway.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import {
  beginSourceArchiveDrain,
  cancelSourceArchiveDrain,
  withActiveSourceProviderLease,
  type SourceArchiveDrain,
} from '../src/core/source-embedding-lease.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $2)`,
    ['docs-source', 'Docs Source'],
  );
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'test' },
  });
});

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('source-owned markdown import embedding lease', () => {
  test('the exact source token exists and its signal reaches the real embed transport', async () => {
    const leasedSources: string[][] = [];
    let sawAbortSignal = false;
    __setEmbedTransportForTests(async ({ values, abortSignal }: {
      values: string[];
      abortSignal?: AbortSignal;
    }) => {
      const leases = await engine.executeRaw<{ source_id: string }>(
        `SELECT source_id FROM source_embedding_leases ORDER BY source_id`,
      );
      leasedSources.push(leases.map((row) => row.source_id));
      sawAbortSignal = abortSignal instanceof AbortSignal;
      return {
        embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.01)),
        usage: { tokens: values.length },
      } as never;
    });

    const result = await importFromContent(
      engine,
      'topics/lease-covered-import',
      '# Lease covered import\n\nThis source document must be fenced before provider egress.',
      { sourceId: 'docs-source' },
    );

    expect(result.status).toBe('imported');
    expect(leasedSources).toEqual([['docs-source']]);
    expect(sawAbortSignal).toBe(true);
    expect(await engine.executeRaw(`SELECT lease_token FROM source_embedding_leases`)).toEqual([]);
  });

  test('a draining source is rejected before the embed transport is called', async () => {
    let providerCalls = 0;
    __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
      providerCalls++;
      return {
        embeddings: values.map(() => Array.from({ length: 1536 }, () => 0.01)),
        usage: { tokens: values.length },
      } as never;
    });
    const drain = await beginSourceArchiveDrain(engine, 'docs-source');
    expect(drain).not.toBeNull();

    await expect(importFromContent(
      engine,
      'topics/draining-import',
      '# Draining import\n\nThis must never reach the embedding provider.',
      { sourceId: 'docs-source' },
    )).rejects.toThrow(/archived, draining, or unavailable/);
    expect(providerCalls).toBe(0);

    if (drain) await cancelSourceArchiveDrain(engine, drain);
  });

  test('a lease rejection before provider egress records no fictitious spend', async () => {
    let providerCalls = 0;
    __setEmbedTransportForTests(async () => {
      providerCalls++;
      throw new Error('transport must not run');
    });
    const auditDir = mkdtempSync(join(tmpdir(), 'gbrain-zero-egress-budget-'));
    const tracker = new BudgetTracker({
      maxCostUsd: 1,
      label: 'zero-egress-lease-rejection',
      auditPath: join(auditDir, 'budget.jsonl'),
    });

    try {
      await expect(withBudgetTracker(tracker, () => embed(['must stay local'], {
        withProviderSubmission: async () => {
          throw new Error('lease rejected before provider submission');
        },
      }))).rejects.toThrow('lease rejected before provider submission');
      expect(providerCalls).toBe(0);
      expect(tracker.totalSpent).toBe(0);
      expect(tracker.snapshot().callsRecorded).toBe(0);
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }
  });

  test('a drain that wins after a token-limit failure prevents recursive provider retries', async () => {
    let providerCalls = 0;
    let drain: SourceArchiveDrain | null = null;
    __setEmbedTransportForTests(async () => {
      providerCalls++;
      drain = await beginSourceArchiveDrain(engine, 'docs-source');
      throw new Error(
        "Request failed. The max allowed tokens per submitted batch is 120000.",
      );
    });

    try {
      await expect(embed(['first document', 'second document'], {
        withProviderSubmission: (_texts, submit) =>
          withActiveSourceProviderLease(
            engine,
            'docs-source',
            leaseSignal => submit(leaseSignal),
          ),
      })).rejects.toThrow(/provider output was discarded/);

      expect(providerCalls).toBe(1);
      expect(drain).not.toBeNull();
      expect(await engine.executeRaw(`SELECT lease_token FROM source_embedding_leases`)).toEqual([]);
    } finally {
      if (drain) await cancelSourceArchiveDrain(engine, drain);
    }
  });

  test('a drain committed between recipe pre-splits blocks the next transport call', async () => {
    configureGateway({
      embedding_model: 'voyage:voyage-3-large',
      embedding_dimensions: 1024,
      env: { VOYAGE_API_KEY: 'test' },
    });
    const transportBatchSizes: number[] = [];
    const fencedBatchSizes: number[] = [];
    let drain: SourceArchiveDrain | null = null;
    const auditDir = mkdtempSync(join(tmpdir(), 'gbrain-partial-egress-budget-'));
    const auditPath = join(auditDir, 'budget.jsonl');
    const tracker = new BudgetTracker({
      maxCostUsd: 1,
      label: 'partial-egress-lease-rejection',
      auditPath,
    });
    __setEmbedTransportForTests(async ({ values }: { values: string[] }) => {
      transportBatchSizes.push(values.length);
      return {
        embeddings: values.map(() => Array.from({ length: 1024 }, () => 0.01)),
        usage: { tokens: values.length },
      } as never;
    });

    try {
      await expect(withBudgetTracker(tracker, () => embed(
        Array.from({ length: 9 }, (_, i) => `${i}${'x'.repeat(7_999)}`),
        {
          withProviderSubmission: async (texts, submit) => {
            fencedBatchSizes.push(texts.length);
            const result = await withActiveSourceProviderLease(
              engine,
              'docs-source',
              leaseSignal => submit(leaseSignal),
            );
            if (fencedBatchSizes.length === 1) {
              // The first provider call and its exact-token completion have
              // both settled. Commit the drain before embed() advances to the
              // recipe's second pre-split batch.
              drain = await beginSourceArchiveDrain(engine, 'docs-source');
            }
            return result;
          },
        },
      ))).rejects.toThrow(/archived, draining, or unavailable/);

      expect(fencedBatchSizes).toEqual([7, 2]);
      expect(transportBatchSizes).toEqual([7]);
      expect(drain).not.toBeNull();
      expect(await engine.executeRaw(`SELECT lease_token FROM source_embedding_leases`)).toEqual([]);
      expect(tracker.snapshot().callsRecorded).toBe(1);
      const receipts = readFileSync(auditPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const record = receipts.find((row) => row.event === 'record');
      expect(Number(record?.input_tokens)).toBe(56_000);
    } finally {
      if (drain) await cancelSourceArchiveDrain(engine, drain);
      rmSync(auditDir, { recursive: true, force: true });
    }
  });
});
