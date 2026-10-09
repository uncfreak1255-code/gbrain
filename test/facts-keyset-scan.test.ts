/**
 * Protects complete, read-only creation-time backlog scans at real storage and
 * operation boundaries. A newest-100 slice, offset cursor, event-time cutoff,
 * unstabilized upper bound, or post-limit visibility filter fails these cases.
 * Existing recall tests cover relevance/list windows, never complete keyset
 * traversal. Uses only production BrainEngine and recall surfaces, no seams.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const SINCE = '2026-01-01T00:00:00.000Z';

for (const backend of testBackends()) {
  describe(`${backend}: fact keyset scan`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      ({ engine, close } = await isolatedSharedSkillsEngine(backend === 'postgres' ? requirePostgresTestDatabase() : undefined));
      await engine.executeRaw(`INSERT INTO sources(id,name) VALUES ('scan-many','many'),('scan-hundred','hundred'),
        ('scan-boundary','boundary'),('scan-empty','empty'),('scan-archive','archive')`);
      await engine.executeRaw("UPDATE sources SET archived=true WHERE id='scan-archive'");
      for (const [source, count] of [['scan-many', 350], ['scan-hundred', 100]] as const) {
        await engine.executeRaw(`INSERT INTO facts (source_id, fact, source, visibility, created_at, valid_from)
          SELECT $1, 'Saved claim ' || i::text, 'synthetic', 'world', '2026-06-10T12:00:00Z', '2020-01-01T00:00:00Z'
          FROM generate_series(1,$2::integer) AS i`, [source, count]);
      }
      await engine.executeRaw(`INSERT INTO facts(source_id,fact,source,visibility,created_at,valid_from)
        VALUES ('scan-boundary','same claim','synthetic','world',$1::timestamptz,'2020-01-01'),
          ('scan-boundary','same claim','synthetic','world',$1::timestamptz,'2020-01-01'),
          ('scan-boundary','too early','synthetic','world',$1::timestamptz - interval '1 millisecond','2026-06-10'),
          ('scan-boundary','private claim','synthetic','private',$1::timestamptz,'2020-01-01'),
          ('scan-boundary','audit checkpoint','cli:extract-conversation-facts:terminal:v2','world',$1::timestamptz,'2020-01-01')`, [SINCE]);
      await engine.executeRaw(`INSERT INTO facts(source_id,fact,source,visibility,created_at,valid_from,expired_at)
        VALUES ('scan-boundary','expired claim','synthetic','world',$1::timestamptz,'2020-01-01','2026-02-01')`, [SINCE]);
    });
    afterAll(async () => { await close?.(); });

    async function scan(sourceId: string, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
      const result = await dispatchToolCall(engine, 'recall', { scan: true, since: SINCE, source_id: sourceId, ...extra },
        { remote: false, sourceId, ...options } as never);
      const body = JSON.parse(result.content[0].text);
      expect(result.isError).toBeFalsy();
      return body;
    }

    test('exactly 100 eligible facts is a complete page, and an empty source is complete', async () => {
      const page = await scan('scan-hundred', { limit: 100 });
      expect(page.facts).toHaveLength(100);
      expect(page.scan).toMatchObject({ version: 1, source_id: 'scan-hundred', since: SINCE, after_id: 0, has_more: false });
      expect(page.scan.next_after_id).toBe(page.facts.at(-1).id);
      expect(page.scan.through_id).toBe(page.scan.next_after_id);
      const empty = await scan('scan-empty');
      expect(empty.facts).toEqual([]);
      expect(empty.scan).toMatchObject({ through_id: 0, next_after_id: 0, has_more: false });
    });

    test('prolonged backlog, same timestamp ties, interrupted retries, and new writes preserve complete ID order', async () => {
      const first = await scan('scan-many', { include_expired: true, limit: 100 });
      expect(first.facts).toHaveLength(100);
      expect(first.scan.has_more).toBe(true);
      const through = first.scan.through_id;
      const newFact = await engine.insertFact({ fact: 'Inserted after scan snapshot', source: 'synthetic', visibility: 'world' }, { source_id: 'scan-many' });
      const params = { include_expired: true, limit: 100, after_id: first.scan.next_after_id, through_id: through };
      const interrupted = await scan('scan-many', params);
      const resumed = await scan('scan-many', params);
      expect(resumed).toEqual(interrupted);
      const all = [...first.facts, ...resumed.facts];
      let page = resumed;
      while (page.scan.has_more) {
        page = await scan('scan-many', { include_expired: true, limit: 100, after_id: page.scan.next_after_id, through_id: through });
        expect(page.scan.through_id).toBe(through);
        all.push(...page.facts);
      }
      const ids = all.map(row => row.id);
      expect(ids).toHaveLength(350);
      expect(new Set(ids).size).toBe(350);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      expect(ids).not.toContain(newFact.id);
      expect(all.every(row => row.created_at === '2026-06-10T12:00:00.000Z' && row.valid_from === '2020-01-01T00:00:00.000Z')).toBe(true);
      const afterSnapshot = await scan('scan-many', { after_id: through, through_id: newFact.id });
      expect(afterSnapshot.facts.map((row: any) => row.id)).toEqual([newFact.id]);
      const stored = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::integer AS count FROM facts WHERE source_id='scan-many'");
      expect(stored[0].count).toBe(351);
    });

    test('creation cutoff is inclusive, duplicate text keeps distinct IDs, expiry opt-in and remote privacy filter before page limit', async () => {
      const publicPage = await scan('scan-boundary', { include_expired: true }, { remote: true, auth: { allowedSources: ['scan-boundary'] } });
      expect(publicPage.facts.map((row: any) => row.fact)).toEqual(['same claim', 'same claim', 'expired claim']);
      expect(new Set(publicPage.facts.map((row: any) => row.id)).size).toBe(3);
      expect(publicPage.scan.through_id).toBe(publicPage.facts.at(-1).id);
      const active = await scan('scan-boundary', { limit: 2 }, { remote: true, auth: { allowedSources: ['scan-boundary'] } });
      expect(active.facts.map((row: any) => row.fact)).toEqual(['same claim', 'same claim']);
      expect(active.scan.has_more).toBe(false);
      const local = await scan('scan-boundary', { include_expired: true });
      expect(local.facts.map((row: any) => row.fact)).toEqual(['same claim', 'same claim', 'private claim', 'expired claim']);
    });

    test('contract-wide metadata and dry-run fields preserve the same read-only scan', async () => {
      const plain = await scan('scan-hundred', { include_expired: true });
      for (const transport of [{ _meta: { session_id: 'example-session' } }, { dry_run: false }, { dry_run: true },
        { _meta: { session_id: 'example-session' }, dry_run: false }]) {
        const decorated = await scan('scan-hundred', { include_expired: true, ...transport });
        expect(decorated).toEqual(plain);
      }
    });

    test('invalid cursors, incompatible options and ambiguous or unauthorized sources fail closed', async () => {
      for (const bad of [
        { after_id: 1 }, { after_id: -1 }, { after_id: 0.5 }, { after_id: 5, through_id: 4 },
        { through_id: 2147483648 }, { through_id: -1 }, { limit: 101 }, { limit: 0 }, { limit: 1.5 },
        { since: '7 days ago' }, { since: 'bad' }, { query: 'claim' }, { budget_tokens: 1 }, { entity: 'example' },
      ]) {
        const result = await dispatchToolCall(engine, 'recall', { scan: true, source_id: 'scan-many', since: SINCE, ...bad }, { remote: false, sourceId: 'scan-many' });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).error).toBe('invalid_params');
      }
      for (const [source_id, expected] of [['scan-hundred', 'permission_denied'], ['missing-example', 'permission_denied'], ['__all__', 'invalid_params']]) {
        const result = await dispatchToolCall(engine, 'recall', { scan: true, since: SINCE, source_id },
          { remote: true, sourceId: 'scan-many', auth: { allowedSources: ['scan-many'] } } as never);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).error).toBe(expected);
      }
      for (const source_id of ['scan-archive', 'missing-example']) {
        const result = await dispatchToolCall(engine, 'recall', { scan: true, since: SINCE, source_id }, { remote: false, sourceId: 'scan-many' });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).error).toBe('unknown_source');
      }
      const ambiguous = await dispatchToolCall(engine, 'recall', { scan: true, since: SINCE },
        { remote: true, sourceId: 'scan-many', auth: { allowedSources: ['scan-many', 'scan-hundred'] } } as never);
      expect(ambiguous.isError).toBe(true);
      expect(JSON.parse(ambiguous.content[0].text).error).toBe('invalid_params');
      const noScan = await dispatchToolCall(engine, 'recall', { after_id: 1 }, { remote: false, sourceId: 'scan-many' });
      expect(noScan.isError).toBe(true);
    });

    test('a late committed lower ID is recovered by a fresh full scan, never treated as a commit watermark', async () => {
      await engine.executeRaw("INSERT INTO sources(id,name) VALUES('scan-late','late')");
      await engine.executeRaw(`INSERT INTO facts(id,source_id,fact,source,visibility,created_at,valid_from)
        VALUES (10000,'scan-late','First committed claim','synthetic','world',$1::timestamptz,'2020-01-01'),
          (10200,'scan-late','Later committed claim','synthetic','world',$1::timestamptz,'2020-01-01')`, [SINCE]);
      const first = await scan('scan-late', { limit: 1, include_expired: true });
      expect(first.facts.map((row: any) => row.id)).toEqual([10000]);
      // Models a sequence ID allocated by an earlier transaction that commits
      // only after the initial page; IDs are allocation order, not commit order.
      await engine.executeRaw(`INSERT INTO facts(id,source_id,fact,source,visibility,created_at,valid_from)
        VALUES(9999,'scan-late','Late lower-ID claim','synthetic','world',$1::timestamptz,'2020-01-01')`, [SINCE]);
      const tail = await scan('scan-late', { after_id: first.scan.next_after_id, through_id: first.scan.through_id, include_expired: true });
      expect(tail.facts.map((row: any) => row.id)).toEqual([10200]);
      const fullReplay = await scan('scan-late', { include_expired: true });
      expect(fullReplay.facts.map((row: any) => row.id)).toEqual([9999, 10000, 10200]);
    });

    test('engine validation refuses malformed cursors or empty visibility instead of widening', async () => {
      for (const options of [{ afterId: 1 }, { afterId: -1 }, { throughId: 0, afterId: 1 }, { limit: 101 }, { visibility: [] }]) {
        await expect(engine.scanFacts('scan-many', new Date(SINCE), options as never)).rejects.toThrow('Invalid fact scan');
      }
    });
  });
}
