/**
 * v0.31 E2E — MCP _meta.brain_hot_memory injection on real Postgres,
 * via dispatchToolCall (the same path stdio + HTTP transports use).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { assembleContextPack } from '../../src/core/context/turn-context.ts';
import {
  getBrainHotMemoryMeta,
  __resetHotMemoryCacheForTests,
} from '../../src/core/facts/meta-hook.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => {
  if (!RUN) return;
  const engine = await setupDB();
  await engine.insertFact(
    { fact: 'world fact', kind: 'fact', entity_slug: 'meta-pg', visibility: 'world', source: 'test' },
    { source_id: 'default' },
  );
  await engine.insertFact(
    { fact: 'private fact', kind: 'fact', entity_slug: 'meta-pg', visibility: 'private', source: 'test' },
    { source_id: 'default' },
  );
});

afterAll(async () => { if (RUN) await teardownDB(); });

beforeEach(() => { if (RUN) __resetHotMemoryCacheForTests(); });

d('_meta injection on Postgres', () => {
  test('cold sessions receive older active preferences without private or expired rows', async () => {
    const engine = getEngine();
    const sourceId = 'durable-preference-test';
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ($1, 'Durable preference test') ON CONFLICT DO NOTHING", [sourceId]);
    const pref = await engine.insertFact({ fact: 'Make a concrete recommendation.', kind: 'preference', visibility: 'world', source: 'synthetic regression' }, { source_id: sourceId });
    await engine.executeRaw("UPDATE facts SET created_at = now() - interval '3 days' WHERE id = $1", [pref.id]);
    for (let i = 0; i < 20; i++) {
      await engine.insertFact({ fact: `Recent event ${i}`, kind: 'event', visibility: 'world', source: 'test' }, { source_id: sourceId });
      await engine.insertFact({ fact: `Private preference ${i}`, kind: 'preference', visibility: 'private', source: 'test' }, { source_id: sourceId });
    }
    const expired = await engine.insertFact({ fact: 'Expired preference', kind: 'preference', visibility: 'world', source: 'test' }, { source_id: sourceId });
    await engine.executeRaw('UPDATE facts SET expired_at = now() WHERE id = $1', [expired.id]);
    const r = await dispatchToolCall(engine, 'get_stats', {}, {
      remote: true, sourceId, sessionId: 'fresh-session', metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBeFalsy();
    const facts = (r._meta?.brain_hot_memory as { facts: { id: number; fact: string }[] }).facts;
    expect(facts).toHaveLength(10);
    expect(facts.some(f => f.id === pref.id)).toBe(true);
    expect(facts.some(f => /Private|Expired/.test(f.fact))).toBe(false);
    expect(facts.some(f => f.fact.startsWith('Recent event'))).toBe(true);
    for (let i = 0; i < 30; i++) {
      await engine.insertFact({ fact: `Imported preference ${i}`, kind: 'preference', visibility: 'world', source: 'test' }, { source_id: sourceId });
    }
    const pack = await assembleContextPack(engine, { sourceId, sessionId: 'another-cold-session' });
    expect(pack.facts?.some(f => f.id === pref.id)).toBe(true);
    expect(pack.text).toContain('Make a concrete recommendation.');
    expect(pack.text).not.toMatch(/Private preference|Expired preference/);
  });

  test('successful op gets _meta.brain_hot_memory', async () => {
    const r = await dispatchToolCall(getEngine(), 'get_stats', {}, {
      remote: false, sourceId: 'default', metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBeFalsy();
    expect(r._meta?.brain_hot_memory).toBeDefined();
  });

  test('remote=true filters to world facts only', async () => {
    const r = await dispatchToolCall(getEngine(), 'get_stats', {}, {
      remote: true, sourceId: 'default', metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBeFalsy();
    const bhm = r._meta?.brain_hot_memory as { facts: { fact: string }[] } | undefined;
    expect(bhm?.facts.find(f => f.fact === 'private fact')).toBeUndefined();
    expect(bhm?.facts.find(f => f.fact === 'world fact')).toBeDefined();
  });

  test('failing meta hook degrades to no-_meta, op still succeeds', async () => {
    const failHook = async (): Promise<Record<string, unknown> | undefined> => {
      throw new Error('boom');
    };
    const r = await dispatchToolCall(getEngine(), 'get_stats', {}, {
      remote: true, sourceId: 'default', metaHook: failHook,
    });
    expect(r.isError).toBeFalsy();
    expect(r._meta).toBeUndefined();
  });

  test('recall op itself does NOT get _meta injection (anti-loop)', async () => {
    const r = await dispatchToolCall(getEngine(), 'recall', { entity: 'meta-pg' }, {
      remote: false, sourceId: 'default', metaHook: getBrainHotMemoryMeta,
    });
    expect(r.isError).toBeFalsy();
    expect(r._meta?.brain_hot_memory).toBeUndefined();
  });
});
