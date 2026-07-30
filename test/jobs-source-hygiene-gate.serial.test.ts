/**
 * Execution-time source-hygiene gate for queued spend-capable handlers.
 *
 * A job can be admitted while the brain is healthy, wait in Minions, and be
 * claimed only after another populated source loses its checkout. The worker
 * must re-read hygiene at handler entry so stale queue admission cannot spend.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  QUEUED_NO_PROVIDER_HANDLER_INVENTORY,
  QUEUED_PROVIDER_HANDLER_INVENTORY,
  integrityJobRequiresProviderGate,
  registerBuiltinHandlers,
} from '../src/commands/jobs.ts';
import { makeContextualReindexHandler } from '../src/core/minions/handlers/contextual-reindex-per-chunk.ts';
import { inspectSourceHygiene } from '../src/core/source-hygiene.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

async function captureHandlers(): Promise<Map<string, (job: any) => Promise<any>>> {
  const handlers = new Map<string, (job: any) => Promise<any>>();
  const fakeWorker = {
    register(name: string, handler: (job: any) => Promise<any>) {
      handlers.set(name, handler);
    },
  };
  await registerBuiltinHandlers(fakeWorker as never, engine, { quiet: true });
  return handlers;
}

describe('queued spend handlers — execution-time source hygiene', () => {
  test('jobs admitted while healthy fail closed after a neighboring source becomes recovery-required', async () => {
    expect(QUEUED_PROVIDER_HANDLER_INVENTORY).toEqual([
      'sync',
      'embed',
      'extract-conversation-facts',
      'enrich',
      'import',
      'contextual_reindex_per_chunk',
      'autopilot-cycle',
      'autopilot-global-maintenance',
      'subagent',
      'ingest_capture',
      'reindex',
      'synthesize',
      'patterns',
      'consolidate',
      'extract_facts',
      'extract-atoms-drain',
      'embed-backfill',
      'extract-takes-from-pages',
      'embed-catch-up',
      'skillopt',
      'integrity-auto',
      'integrity',
    ]);
    expect(integrityJobRequiresProviderGate({ mode: 'auto' })).toBe(true);
    expect(integrityJobRequiresProviderGate({ mode: 'check' })).toBe(false);
    expect(integrityJobRequiresProviderGate({})).toBe(false);

    const queue = new MinionQueue(engine);
    const before = await inspectSourceHygiene(engine, { inspectFilesystem: true });
    expect(before.sources.some((source) => source.classification === 'recovery_required')).toBe(false);
    const handlers = await captureHandlers();
    expect([...handlers.keys()].sort()).toEqual([
      ...QUEUED_PROVIDER_HANDLER_INVENTORY,
      ...QUEUED_NO_PROVIDER_HANDLER_INVENTORY,
    ].sort());
    const healthyEmbedResult = await handlers.get('embed-backfill')!({
      data: { sourceId: 'default' },
      signal: undefined,
      updateProgress: async () => {},
    });
    expect(healthyEmbedResult.status).toBe('success');

    const queued = [
      await queue.add('synthesize', {}, {}, { allowProtectedSubmit: true }),
      await queue.add('patterns', {}, {}, { allowProtectedSubmit: true }),
      await queue.add('consolidate', {}, {}, { allowProtectedSubmit: true }),
      await queue.add('embed-backfill', { sourceId: 'default' }),
    ];

    // Transition after queue admission: the neighboring source is populated,
    // but its configured checkout no longer exists.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('broken-neighbor', 'broken-neighbor',
               '/definitely/missing/gbrain-source-hygiene-queued-spend', '{}'::jsonb)`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES ('broken-neighbor', 'notes/recovery-proof', 'note',
               'Recovery proof', '# Recovery proof')`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES ('default', 'notes/recovery-proof', 'note',
               'Default recovery proof', '# Default recovery proof')`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES ('default', 'concepts/consent-race', 'concept',
               'Consent race', $1)`,
      ['Provider-eligible claim body long enough for the takes classifier. '.repeat(8)],
    );

    const after = await inspectSourceHygiene(engine, { inspectFilesystem: true });
    expect(after.sources.find((source) => source.source_id === 'broken-neighbor')?.classification)
      .toBe('recovery_required');

    let providerEgressCalls = 0;
    configureGateway({
      chat_model: 'anthropic:claude-haiku-4-5-20251001',
      env: { ANTHROPIC_API_KEY: 'test-key' },
    });
    __setChatTransportForTests(async () => {
      providerEgressCalls++;
      throw new Error('PROVIDER_EGRESS_SENTINEL');
    });
    __setEmbedTransportForTests((async () => {
      providerEgressCalls++;
      throw new Error('PROVIDER_EGRESS_SENTINEL');
    }) as never);
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('FETCH_EGRESS_SENTINEL');
    }) as unknown as typeof fetch;

    try {
      // Regression: the old wrapper read consent once to decide whether to
      // gate, then the handler read it again. A false -> true transition
      // bypassed hygiene and reached chat while recovery was already required.
      // The provider-capable handler now gates before reading consent at all.
      const originalGetConfig = engine.getConfig.bind(engine);
      let consentReads = 0;
      engine.getConfig = async (key: string) => {
        if (key === 'takes.bootstrap_enabled') {
          consentReads++;
          return consentReads === 1 ? 'false' : 'true';
        }
        return await originalGetConfig(key);
      };
      try {
        const consentRaceResult = await handlers.get('extract-takes-from-pages')!({
          data: { sourceId: 'default' },
          signal: undefined,
          updateProgress: async () => {},
        });
        expect(consentRaceResult).toMatchObject({
          status: 'skipped',
          reason: 'source_hygiene_blocked',
          source_id: 'default',
        });
        expect(consentReads).toBe(0);
        expect(providerEgressCalls).toBe(0);
      } finally {
        engine.getConfig = originalGetConfig;
      }

      const contextualHandler = handlers.get('contextual_reindex_per_chunk')!;
      const exactSourceGate = await contextualHandler({
        data: {
          page_slug: 'notes/recovery-proof',
          expected_source_id: 'broken-neighbor',
        },
        signal: undefined,
        updateProgress: async () => {},
      });
      expect(exactSourceGate).toMatchObject({
        status: 'skipped',
        reason: 'source_hygiene_blocked',
        source_id: 'broken-neighbor',
      });
      await expect(contextualHandler({
        data: { page_slug: 'notes/recovery-proof' },
        signal: undefined,
        updateProgress: async () => {},
      })).rejects.toThrow(/ambiguous.*expected_source_id/i);

      const downstreamHandler = makeContextualReindexHandler({ engine });
      const exactDownstreamResult = await downstreamHandler({
        id: 701,
        data: {
          page_slug: 'notes/recovery-proof',
          expected_source_id: 'broken-neighbor',
        },
        signal: undefined,
        updateProgress: async () => {},
      } as never);
      expect(exactDownstreamResult).toEqual({
        ok: true,
        mode_applied: 'skipped',
        chunks_embedded: 0,
      });
      await expect(downstreamHandler({
        id: 702,
        data: { page_slug: 'notes/recovery-proof' },
        signal: undefined,
        updateProgress: async () => {},
      } as never)).rejects.toThrow(/ambiguous.*expected_source_id/i);

      for (const job of queued) {
        const handler = handlers.get(job.name);
        expect(handler).toBeTruthy();
        const result = await handler!({
          data: job.data,
          signal: undefined,
          updateProgress: async () => {},
        });
        expect(result).toMatchObject({
          status: 'skipped',
          reason: 'source_hygiene_blocked',
          source_id: 'default',
          block_reason: 'brain_recovery_required',
          recovery_source_ids: ['broken-neighbor'],
        });
      }

      await engine.setConfig('takes.bootstrap_enabled', 'true');
      const providerModeData: Record<string, Record<string, unknown>> = {
        sync: { noEmbed: false, noPull: true, sourceId: 'default' },
        embed: { stale: true, sourceId: 'default' },
        'extract-conversation-facts': { sourceId: 'default' },
        enrich: { sourceId: 'default' },
        import: { dir: '/tmp/provider-egress-sentinel', sourceId: 'default' },
        contextual_reindex_per_chunk: {
          page_slug: 'notes/recovery-proof',
          expected_source_id: 'broken-neighbor',
        },
        'autopilot-cycle': {},
        'autopilot-global-maintenance': {},
        subagent: { source_id: 'default', prompt: 'provider egress sentinel' },
        ingest_capture: { noEmbed: false },
        reindex: {},
        synthesize: {},
        patterns: {},
        consolidate: {},
        extract_facts: {},
        'extract-atoms-drain': { sourceId: 'default' },
        'embed-backfill': { sourceId: 'default' },
        'extract-takes-from-pages': { sourceId: 'default' },
        'embed-catch-up': { sourceId: 'default' },
        skillopt: {
          skills_dir: '/tmp/provider-egress-sentinel',
          skill_name: 'sentinel',
          benchmark_path: '/tmp/provider-egress-sentinel.ndjson',
        },
        'integrity-auto': {},
        integrity: { mode: 'auto' },
      };

      expect([...handlers.keys()]).toEqual(expect.arrayContaining([
        ...QUEUED_PROVIDER_HANDLER_INVENTORY,
      ]));
      for (const name of QUEUED_PROVIDER_HANDLER_INVENTORY) {
        const result = await handlers.get(name)!({
          data: providerModeData[name],
          signal: undefined,
          updateProgress: async () => {},
        });
        const gateResult = name === 'autopilot-cycle' || name === 'autopilot-global-maintenance'
          ? result.report
          : result;
        expect(gateResult.reason).toBe('source_hygiene_blocked');
        expect(gateResult.recovery_source_ids ?? gateResult.source_ids)
          .toEqual(['broken-neighbor']);
        expect(providerEgressCalls).toBe(0);
        expect(fetchCalls).toBe(0);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
