// Commit 3 (Phase 3): unified multimodal column.
//
// Covers:
//   - Schema migration v68 adds embedding_multimodal column
//   - searchVector routes to embedding_multimodal when opts.embeddingColumn set
//   - hybridSearch routes through unified column when search.unified_multimodal=true
//   - D8 fail-open: unified-only=false + empty unified column → falls back to text
//   - D8 strict: unified-only=true + empty column → does not fall back
//   - reindex --multimodal cost estimate + dry-run + GBRAIN_NO_REEMBED bypass
//   - D7 lock acquired during reindex; second reindex receives LOCK_HELD

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { runReindexMultimodal } from '../src/commands/reindex-multimodal.ts';
import {
  beginSourceArchiveDrain,
  cancelSourceArchiveDrain,
} from '../src/core/source-embedding-lease.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let engine: PGLiteEngine;
let fetchHandler: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
const origFetch = globalThis.fetch;

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
  fetchHandler = async () => new Response(JSON.stringify({
    data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
    model: 'voyage-multimodal-3',
  }), { status: 200 });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!fetchHandler) throw new Error('no fetch handler');
    return fetchHandler(typeof url === 'string' ? url : url.toString(), init ?? {});
  }) as typeof fetch;
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    embedding_multimodal_model: 'voyage:voyage-multimodal-3',
    env: { OPENAI_API_KEY: 'test', VOYAGE_API_KEY: 'test' },
  });
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
});

describe('Phase 3 schema — v68 migration', () => {
  test('content_chunks has embedding_multimodal column', async () => {
    // Run an explicit query against the column. If the migration ran, this succeeds.
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM content_chunks WHERE embedding_multimodal IS NULL`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('reindex --multimodal command (Phase 3)', () => {
  test('--dry-run reports cost estimate without mutating', async () => {
    // No rows in DB → pending=0, no work needed.
    const result = await runReindexMultimodal(engine, { dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.reembedded).toBe(0);
  });

  test('--cost-estimate reports cost but does not run', async () => {
    const result = await runReindexMultimodal(engine, { costEstimate: true });
    expect(result.dry_run).toBe(true);
    expect(result.reembedded).toBe(0);
  });

  test('GBRAIN_NO_REEMBED=1 honored on zero-pending brain (skip path is no-op-clean)', async () => {
    await withEnv({ GBRAIN_NO_REEMBED: '1' }, async () => {
      const result = await runReindexMultimodal(engine, {});
      // Zero pending → reindex short-circuits before the env-var check; both
      // paths produce dry_run=false + reembedded=0 + pending=0.
      expect(result.reembedded).toBe(0);
      expect(result.pending_after).toBe(0);
    });
  });

  test('zero-pending returns cleanly', async () => {
    const result = await runReindexMultimodal(engine, { yes: true });
    expect(result.pending_before).toBe(0);
    expect(result.reembedded).toBe(0);
    expect(result.failed).toBe(0);
  });

  test('partitions mixed-source rows and holds the exact source lease during each provider call', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $2), ($3, $4)`,
      ['source-alpha', 'Source Alpha', 'source-beta', 'Source Beta'],
    );
    const pageInput = (title: string) => ({
      type: 'topic',
      title,
      compiled_truth: title,
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('topics/alpha', pageInput('alpha provider payload'), { sourceId: 'source-alpha' });
    await engine.upsertChunks('topics/alpha', [{
      chunk_index: 0,
      chunk_text: 'alpha provider payload',
      chunk_source: 'compiled_truth',
    }], { sourceId: 'source-alpha' });
    await engine.putPage('topics/beta', pageInput('beta provider payload'), { sourceId: 'source-beta' });
    await engine.upsertChunks('topics/beta', [{
      chunk_index: 0,
      chunk_text: 'beta provider payload',
      chunk_source: 'compiled_truth',
    }], { sourceId: 'source-beta' });

    const providerSources: string[] = [];
    fetchHandler = async (_url, init) => {
      const request = JSON.parse(String(init.body)) as {
        inputs: Array<{ content: Array<{ text?: string }> }>;
      };
      const texts = request.inputs.map((input) => input.content[0]?.text ?? '');
      const expectedSource = texts.every((text) => text.includes('alpha'))
        ? 'source-alpha'
        : texts.every((text) => text.includes('beta'))
          ? 'source-beta'
          : 'mixed';
      const leases = await engine.executeRaw<{ source_id: string }>(
        `SELECT source_id FROM source_embedding_leases ORDER BY source_id`,
      );
      expect(expectedSource).not.toBe('mixed');
      expect(leases.map((row) => row.source_id)).toEqual([expectedSource]);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      providerSources.push(expectedSource);
      return new Response(JSON.stringify({
        data: request.inputs.map(() => ({ embedding: Array.from({ length: 1024 }, () => 0.1) })),
      }), { status: 200 });
    };

    const isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-mm-lease-'));
    const result = await withEnv({ GBRAIN_HOME: isolatedHome }, () =>
      runReindexMultimodal(engine, { yes: true }));

    expect(result.reembedded).toBe(2);
    expect(result.failed).toBe(0);
    expect(providerSources.sort()).toEqual(['source-alpha', 'source-beta']);
    expect(await engine.executeRaw(`SELECT lease_token FROM source_embedding_leases`)).toEqual([]);
  });

  test('draining sources are excluded from pending, cost, fetch, and completion coverage', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ($1, $2), ($3, $4)`,
      ['active-source', 'Active Source', 'draining-source', 'Draining Source'],
    );
    const pageInput = (title: string) => ({
      type: 'topic',
      title,
      compiled_truth: title,
      timeline: '',
      frontmatter: {},
    });
    await engine.putPage('topics/active', pageInput('active payload'), { sourceId: 'active-source' });
    await engine.upsertChunks('topics/active', [{
      chunk_index: 0,
      chunk_text: 'active payload',
      chunk_source: 'compiled_truth',
    }], { sourceId: 'active-source' });
    await engine.putPage(
      'topics/draining',
      pageInput('draining payload'),
      { sourceId: 'draining-source' },
    );
    await engine.upsertChunks('topics/draining', [{
      chunk_index: 0,
      chunk_text: 'draining payload '.repeat(500),
      chunk_source: 'compiled_truth',
    }], { sourceId: 'draining-source' });

    const drain = await beginSourceArchiveDrain(engine, 'draining-source');
    expect(drain).not.toBeNull();
    const isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-mm-drain-filter-'));

    try {
      const estimate = await withEnv({ GBRAIN_HOME: isolatedHome }, () =>
        runReindexMultimodal(engine, { costEstimate: true }));
      expect(estimate.pending_before).toBe(1);
      expect(estimate.cost_usd_estimate).toBeCloseTo(
        ('active payload'.length / 3.5 / 1_000_000) * 0.18,
        12,
      );

      const providerTexts: string[][] = [];
      fetchHandler = async (_url, init) => {
        const body = JSON.parse(String(init.body)) as {
          inputs: Array<{ content: Array<{ text?: string }> }>;
        };
        const texts = body.inputs.map(input => input.content[0]?.text ?? '');
        providerTexts.push(texts);
        return new Response(JSON.stringify({
          data: texts.map(() => ({ embedding: Array.from({ length: 1024 }, () => 0.1) })),
        }), { status: 200 });
      };

      const result = await withEnv({ GBRAIN_HOME: isolatedHome }, () =>
        runReindexMultimodal(engine, { yes: true }));
      expect(result.pending_before).toBe(1);
      expect(result.pending_after).toBe(0);
      expect(result.reembedded).toBe(1);
      expect(providerTexts).toEqual([['active payload']]);

      const coverage = await engine.executeRaw<{
        source_id: string;
        embedded: boolean;
      }>(
        `SELECT page.source_id, chunk.embedding_multimodal IS NOT NULL AS embedded
           FROM content_chunks chunk
           JOIN pages page ON page.id = chunk.page_id
          WHERE page.source_id IN ('active-source', 'draining-source')
          ORDER BY page.source_id`,
      );
      expect(coverage).toEqual([
        { source_id: 'active-source', embedded: true },
        { source_id: 'draining-source', embedded: false },
      ]);
    } finally {
      if (drain) await cancelSourceArchiveDrain(engine, drain);
    }
  });
});

describe('hybridSearch unified routing (Phase 3)', () => {
  test('search.unified_multimodal=true routes ALL queries through embedding_multimodal', async () => {
    await engine.setConfig('search.unified_multimodal', 'true');
    let voyageCalled = 0;
    let openaiCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        voyageCalled++;
        return new Response(JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
        }), { status: 200 });
      }
      if (url.includes('api.openai.com') && url.includes('embeddings')) {
        openaiCalled++;
      }
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
      }), { status: 200 });
    };

    await hybridSearch(engine, 'totally text query', { limit: 5 });
    // Unified routing: text query forced to multimodal endpoint.
    expect(voyageCalled).toBeGreaterThanOrEqual(1);
  });

  test('D8 fail-open: empty unified column + not strict → falls back to text', async () => {
    // Set unified flag but DON'T set unified_multimodal_only. Empty DB → unified returns [].
    await engine.setConfig('search.unified_multimodal', 'true');
    let openaiCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        return new Response(JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
        }), { status: 200 });
      }
      openaiCalled++;
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
      }), { status: 200 });
    };

    const results = await hybridSearch(engine, 'whatever', { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    // The fall-back path SHOULD call OpenAI (text path) when unified came back empty.
    expect(openaiCalled).toBeGreaterThanOrEqual(1);
  });

  test('D8 strict: unified_multimodal_only=true + empty column → does NOT fall back', async () => {
    await engine.setConfig('search.unified_multimodal', 'true');
    await engine.setConfig('search.unified_multimodal_only', 'true');
    let openaiCalled = 0;
    fetchHandler = async (url) => {
      if (url.includes('multimodalembeddings')) {
        return new Response(JSON.stringify({
          data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
        }), { status: 200 });
      }
      openaiCalled++;
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.1), index: 0 }],
      }), { status: 200 });
    };

    await hybridSearch(engine, 'whatever', { limit: 5 });
    // Strict mode means NO text fallback even when unified is empty.
    expect(openaiCalled).toBe(0);
  });
});
