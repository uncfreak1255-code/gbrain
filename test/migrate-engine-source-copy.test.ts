import { afterAll, beforeAll, describe, test, expect } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { copySourceRowsForMigration } from '../src/commands/migrate-engine.ts';

let source: PGLiteEngine;
let target: PGLiteEngine;
let spySource: PGLiteEngine;
let spyTargetReal: PGLiteEngine;

beforeAll(async () => {
  source = new PGLiteEngine();
  target = new PGLiteEngine();
  spySource = new PGLiteEngine();
  spyTargetReal = new PGLiteEngine();
  await source.connect({});
  await source.initSchema();
  await target.connect({});
  await target.initSchema();
  await spySource.connect({});
  await spySource.initSchema();
  await spyTargetReal.connect({});
  await spyTargetReal.initSchema();
});

afterAll(async () => {
  await source.disconnect();
  await target.disconnect();
  await spySource.disconnect();
  await spyTargetReal.disconnect();
});

describe('migrate-engine source row copy', () => {
  test('copies non-default sources before page import so FK-backed page writes succeed', async () => {
    await source.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
         VALUES ('wiki', 'Wiki', '/tmp/wiki', '{"federated": true}'::jsonb)`,
    );
    await source.putPage(
      'people/alice',
      { type: 'person', title: 'Alice', compiled_truth: 'Alice source page', timeline: '' },
      { sourceId: 'wiki' },
    );

    await expect(
      target.putPage(
        'people/alice',
        { type: 'person', title: 'Alice', compiled_truth: 'Alice target page', timeline: '' },
        { sourceId: 'wiki' },
      ),
    ).rejects.toThrow();

    const copied = await copySourceRowsForMigration(source, target);
    expect(copied).toBe(2);

    const sourceRows = await target.executeRaw<{ id: string; name: string; local_path: string | null }>(
      `SELECT id, name, local_path FROM sources ORDER BY id`,
    );
    expect(sourceRows.map((r) => r.id).sort()).toEqual(['default', 'wiki']);

    const wiki = sourceRows.find((r) => r.id === 'wiki');
    expect(wiki?.name).toBe('Wiki');
    expect(wiki?.local_path).toBe('/tmp/wiki');

    const page = await target.putPage(
      'people/alice',
      { type: 'person', title: 'Alice', compiled_truth: 'Alice target page', timeline: '' },
      { sourceId: 'wiki' },
    );
    expect(page.source_id).toBe('wiki');
  }, 60_000);

  // Driver-faithful regression for the JSONB double-encode bug.
  //
  // The bug: copySourceRowsForMigration bound `JSON.stringify(config)` (a
  // string) to the `$N::jsonb` cast in the INSERT. On a Postgres target,
  // postgres.js double-encodes that string, storing a JSONB STRING literal
  // instead of an OBJECT, so every `config->>'key'` returns NULL. PGLite
  // silently normalizes the string back to an object, so a pure-PGLite
  // round-trip CANNOT detect it (verified empirically: binding the stringified
  // value yields jsonb_typeof='object' identical to binding the raw object).
  //
  // The correctness boundary is therefore the VALUE BOUND to the jsonb
  // position, not what PGLite reads back. This test spies on the target
  // engine's executeRaw and asserts the config value reaching the
  // `$N::jsonb` cast is a raw JS object — the form that round-trips correctly
  // on real Postgres — never a pre-stringified JSON string. It fails red
  // against the JSON.stringify(...) code and passes green once the raw object
  // is bound (directly or via executeRawJsonb). The Postgres-target
  // environment-faithful assertion lives in test/e2e/migrate-source-jsonb.test.ts.
  test('binds source config as a raw object, not a double-encoded JSON string', async () => {
    await spySource.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
         VALUES ('blog', 'Blog', '/tmp/blog', '{"federated": true, "k": "v"}'::jsonb)`,
    );

    const boundConfigsByPos: unknown[] = [];

    const spyTarget: BrainEngine = new Proxy(spyTargetReal, {
      get(realTarget, prop, receiver) {
        if (prop === 'executeRaw') {
          return async (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) => {
            // Capture the value bound to the jsonb config position on the
            // sources INSERT/UPSERT. The SQL declares `$6::jsonb` for config.
            if (/INSERT INTO sources/i.test(sql) && Array.isArray(params)) {
              boundConfigsByPos.push(params[5]);
            }
            return (realTarget as PGLiteEngine).executeRaw(sql, params, opts);
          };
        }
        return Reflect.get(realTarget, prop, receiver);
      },
    }) as unknown as BrainEngine;

    await copySourceRowsForMigration(spySource, spyTarget);

    // Select the blog source's bound config by its unique `k` key — present
    // whether the value reached us as a raw object (correct) or a
    // pre-stringified JSON string (the bug).
    const blogConfig = boundConfigsByPos.find((c) => {
      if (c && typeof c === 'object') return 'k' in (c as Record<string, unknown>);
      return typeof c === 'string' && c.includes('"k"');
    });

    // The value bound to `$N::jsonb` must be a raw object so postgres.js
    // encodes it with the jsonb type oid (no double-encode). A string here
    // is the bug: postgres.js stringifies it again into a JSONB STRING.
    expect(typeof blogConfig).toBe('object');
    expect(typeof blogConfig).not.toBe('string');
    expect((blogConfig as Record<string, unknown>).federated).toBe(true);
    expect((blogConfig as Record<string, unknown>).k).toBe('v');
  }, 60_000);
});
