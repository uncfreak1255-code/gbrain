import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { assembleContextPack, assembleTurnContext } from '../src/core/context/turn-context.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import type { FactKind, FactVisibility } from '../src/core/engine.ts';

let engine: PGLiteEngine;
const preference = 'Make the technical recommendation instead of returning a menu.';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'Other')");
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  __resetHotMemoryCacheForTests();
  await engine.executeRaw('DELETE FROM facts');
});

async function seed(text: string, opts: {
  kind?: FactKind; visibility?: FactVisibility; source?: string;
  session?: string; old?: boolean; expired?: boolean;
} = {}) {
  const row = await engine.insertFact({
    fact: text, kind: opts.kind ?? 'event', visibility: opts.visibility ?? 'world',
    entity_slug: 'people/alice-example', source: 'synthetic regression',
    source_session: opts.session ?? null,
  }, { source_id: opts.source ?? 'default' });
  if (opts.old) await engine.executeRaw(
    "UPDATE facts SET created_at = now() - interval '3 days', valid_from = now() - interval '3 days' WHERE id = $1", [row.id],
  );
  if (opts.expired) await engine.executeRaw(
    "UPDATE facts SET valid_until = now() - interval '1 second' WHERE id = $1", [row.id],
  );
  return row;
}

describe('durable preference delivery', () => {
  test('cold pack carries an older preference despite newer events, with privacy and expiry intact', async () => {
    await seed(preference, { kind: 'preference', old: true });
    await seed('OLD EVENT', { old: true });
    await seed('PRIVATE PREFERENCE', { kind: 'preference', visibility: 'private' });
    await seed('EXPIRED PREFERENCE', { kind: 'preference', expired: true });
    await seed('OTHER SOURCE PREFERENCE', { kind: 'preference', source: 'other' });
    for (let i = 0; i < 20; i++) await seed(`Recent event ${i}`);
    const result = await assembleContextPack(engine, { sourceId: 'default', sessionId: 'fresh-session' });
    expect(result.text).toContain(preference);
    expect(result.text).toContain('Recent event');
    for (const hidden of ['OLD EVENT', 'PRIVATE PREFERENCE', 'EXPIRED PREFERENCE', 'OTHER SOURCE PREFERENCE']) {
      expect(result.text).not.toContain(hidden);
    }
    expect(result.factsCount).toBe(10);
  });

  test('a session with its own facts also receives the standing preference', async () => {
    await seed(preference, { kind: 'preference', old: true });
    await seed('Current session work', { session: 'current' });
    await seed('Other session work', { session: 'other' });
    const result = await assembleContextPack(engine, { sourceId: 'default', sessionId: 'current' });
    expect(result.text).toContain(preference);
    expect(result.text).toContain('Current session work');
    expect(result.text).not.toContain('Other session work');
  });

  test('startup pack carries older preferences through a preference import burst and deduplicates the digest', async () => {
    await seed(preference, { kind: 'preference', old: true });
    for (let i = 0; i < 30; i++) await seed(`Preference ${i}`, { kind: 'preference' });
    for (let i = 0; i < 10; i++) await seed(`Recent event ${i}`);
    await seed('Recent preference', { kind: 'preference' });
    const result = await assembleContextPack(engine, { sourceId: 'default' });
    expect(result.factsCount).toBe(37);
    expect(result.text).toContain(preference);
    expect(result.text.match(/Recent preference/g)).toHaveLength(1);
    expect(result.text.match(/Preference \d/g)).toHaveLength(30);
    expect(result.text).toContain('Recent event');
  });

  test('ordinary per-turn byte pressure retains the short standing preference', async () => {
    await seed(preference, { kind: 'preference', old: true });
    for (let i = 0; i < 12; i++) await seed(`Recent event ${i}: ${'detail '.repeat(200)}`);
    const result = await assembleTurnContext(engine, { sourceId: 'default', window: [], maxBytes: 2000 });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(2000);
    expect(result.text).toContain(preference);
    expect(result.text).toContain('Recent event');
  });

  test('startup text is capped while a standing preference survives large recent events', async () => {
    await seed(preference, { kind: 'preference', old: true });
    for (let i = 0; i < 12; i++) await seed(`Recent event ${i}: ${'detail '.repeat(3000)}`);
    const result = await assembleContextPack(engine, { sourceId: 'default' });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(32768);
    expect(result.text).toContain(preference);
    expect(result.text).toContain('Recent event');
    expect(result.degradedReason).toBe('budget_trimmed');
    expect(result.factsCount).toBe(result.facts?.length ?? 0);
  });

  test('oversized preference collections and explicit tiny budgets obey the startup cap', async () => {
    for (let i = 0; i < 100; i++) await seed(`Preference ${i}: ${'detail '.repeat(100)}`, { kind: 'preference' });
    const result = await assembleContextPack(engine, { sourceId: 'default' });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(32768);
    expect(result.degradedReason).toBe('budget_trimmed');
    expect(result.factsCount).toBeGreaterThan(0);
    expect(result.factsCount).toBeLessThan(100);
    const tiny = await assembleContextPack(engine, { sourceId: 'default', maxBytes: 1 });
    expect(tiny.text).toBe('');
    expect(tiny.factsCount).toBe(0);
  });
});
