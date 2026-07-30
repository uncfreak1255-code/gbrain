import { afterAll, beforeAll, describe, test, expect } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { softDeleteSourceGuarded } from '../src/core/destructive-guard.ts';
import {
  beginSourceArchiveDrain,
  cancelSourceArchiveDrain,
} from '../src/core/source-embedding-lease.ts';
import {
  copySourceRowsForMigration,
  finalizeArchivedSourceRowsForMigration,
  assertTargetSourceIdsCompatibleForMigration,
  assertTargetSourceLifecycleCompatibleForMigration,
  assertTargetSourceLifecycleParityForMigration,
} from '../src/commands/migrate-engine.ts';

let source: PGLiteEngine;
let target: PGLiteEngine;
let spySource: PGLiteEngine;
let spyTargetReal: PGLiteEngine;
let edgeSource: PGLiteEngine;
let edgeTarget: PGLiteEngine;

beforeAll(async () => {
  source = new PGLiteEngine();
  target = new PGLiteEngine();
  spySource = new PGLiteEngine();
  spyTargetReal = new PGLiteEngine();
  edgeSource = new PGLiteEngine();
  edgeTarget = new PGLiteEngine();
  await source.connect({});
  await source.initSchema();
  await target.connect({});
  await target.initSchema();
  await spySource.connect({});
  await spySource.initSchema();
  await spyTargetReal.connect({});
  await spyTargetReal.initSchema();
  await edgeSource.connect({});
  await edgeSource.initSchema();
  await edgeTarget.connect({});
  await edgeTarget.initSchema();
}, 30_000);

afterAll(async () => {
  await source.disconnect();
  await target.disconnect();
  await spySource.disconnect();
  await spyTargetReal.disconnect();
  await edgeSource.disconnect();
  await edgeTarget.disconnect();
});

describe('migrate-engine source row copy', () => {
  test('rejects target-only sources before force can mutate target pages', () => {
    expect(() => assertTargetSourceIdsCompatibleForMigration(
      [{ id: 'default' }],
      [{ id: 'default' }, { id: 'target-extra' }],
    )).toThrow('--force overwrites pages but does not delete source registrations');
  });

  test('rejects same-ID manual drains but permits migration-owned archive recovery', () => {
    const archivedSource = {
      id: 'shared',
      archived: true,
      embedding_drain_token: null,
    };
    expect(() => assertTargetSourceLifecycleCompatibleForMigration(
      [archivedSource],
      [{ id: 'shared', archived: false, embedding_drain_token: 'manual:target' }],
    )).toThrow('incompatible manual archive drain');
    expect(() => assertTargetSourceLifecycleCompatibleForMigration(
      [archivedSource],
      [{ id: 'shared', archived: false, embedding_drain_token: 'hygiene-candidate:target' }],
    )).toThrow('incompatible hygiene_candidate archive drain');
    expect(() => assertTargetSourceLifecycleCompatibleForMigration(
      [archivedSource],
      [{ id: 'shared', archived: false, embedding_drain_token: 'migration:target' }],
    )).not.toThrow();
    expect(() => assertTargetSourceLifecycleCompatibleForMigration(
      [archivedSource],
      [{ id: 'shared', archived: false, embedding_drain_token: 'migration:target' }],
      { allowMigrationDrain: false },
    )).toThrow('rerun migration without --force');
  });

  test('rejects target-only source lifecycle residue before config switch', () => {
    const activeDefault = {
      id: 'default',
      archived: false,
      archived_at: null,
      archive_expires_at: null,
      embedding_drain_token: null,
    };
    expect(() => assertTargetSourceLifecycleParityForMigration(
      [activeDefault],
      [
        activeDefault,
        {
          id: 'target-extra',
          archived: false,
          archived_at: null,
          archive_expires_at: null,
          embedding_drain_token: 'manual:target-only',
        },
      ],
    )).toThrow('Migration target has unexpected source "target-extra"');
  });

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

  test('binds source config as a raw object, not a double-encoded JSON string', async () => {
    await spySource.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
         VALUES ('blog', 'Blog', '/tmp/blog', '{"federated": true, "k": "v"}'::jsonb)`,
    );

    const boundConfigsByPos: unknown[] = [];

    const spyTarget = new Proxy(spyTargetReal, {
      get(realTarget, prop, receiver) {
        if (prop === 'executeRaw') {
          return async (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) => {
            if (/INSERT INTO sources/i.test(sql) && Array.isArray(params)) {
              const jsonbMatch = sql.match(/\$(\d+)::jsonb/);
              if (jsonbMatch) {
                boundConfigsByPos.push(params[Number(jsonbMatch[1]) - 1]);
              }
            }
            return realTarget.executeRaw(sql, params, opts);
          };
        }
        return Reflect.get(realTarget, prop, receiver);
      },
    }) as unknown as BrainEngine;

    await copySourceRowsForMigration(spySource, spyTarget);

    const blogConfig = boundConfigsByPos.find((candidate) => {
      if (candidate && typeof candidate === 'object') {
        return 'k' in (candidate as Record<string, unknown>);
      }
      return typeof candidate === 'string' && candidate.includes('"k"');
    });

    expect(typeof blogConfig).toBe('object');
    expect(typeof blogConfig).not.toBe('string');
    expect((blogConfig as Record<string, unknown>).federated).toBe(true);
    expect((blogConfig as Record<string, unknown>).k).toBe('v');
  }, 60_000);

  test('stages archived sources until the migration-supported dependent rows are copied', async () => {
    const sourceId = 'legacy-archived';
    const slug = 'projects/archived-migration';
    const sourceOpts = { sourceId };
    await source.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, 'Legacy Archived', '/tmp/legacy-archived', '{"federated": false}'::jsonb)`,
      [sourceId],
    );
    await source.putPage(slug, {
      type: 'project',
      title: 'Archived Migration',
      compiled_truth: 'Archived source data must survive engine migration.',
      timeline: '',
    }, sourceOpts);
    await source.upsertChunks(slug, [{
      chunk_index: 0,
      chunk_text: 'Archived source chunk',
      chunk_source: 'compiled_truth',
      model: 'test-model',
      token_count: 4,
    }], sourceOpts);
    await source.addTag(slug, 'migration-fixture', sourceOpts);
    await source.addTimelineEntry(slug, {
      date: '2026-07-01',
      source: 'test',
      summary: 'Archived before migration',
      detail: 'The migration-supported dependent rows must still copy.',
    }, sourceOpts);
    await source.putRawData(slug, 'migration-fixture', { preserved: true }, sourceOpts);
    await source.addLink(
      slug,
      slug,
      'self-link',
      'related',
      undefined,
      undefined,
      undefined,
      { fromSourceId: sourceId, toSourceId: sourceId },
    );
    const archive = await softDeleteSourceGuarded(source, sourceId);
    expect(archive.reason).toBe('archived');
    const sourceArchiveState = await source.executeRaw<{
      archived_at: Date | string | null;
      archive_expires_at: Date | string | null;
    }>(
      `SELECT archived_at, archive_expires_at FROM sources WHERE id = $1`,
      [sourceId],
    );

    await copySourceRowsForMigration(source, target, { stageArchivedAsActive: true });
    expect(await target.executeRaw(
      `SELECT archived, archived_at, archive_expires_at FROM sources WHERE id = $1`,
      [sourceId],
    )).toEqual([{
      archived: false,
      archived_at: null,
      archive_expires_at: null,
    }]);

    const page = (await source.listPages({ sourceId, limit: 10 }))
      .find((candidate) => candidate.slug === slug);
    expect(page).toBeDefined();
    await target.putPage(slug, {
      type: page!.type,
      title: page!.title,
      compiled_truth: page!.compiled_truth,
      timeline: page!.timeline,
      frontmatter: page!.frontmatter,
      content_hash: page!.content_hash,
    }, sourceOpts);
    const chunks = await source.getChunksWithEmbeddings(slug, sourceOpts);
    await target.upsertChunks(slug, chunks.map((chunk) => ({
      chunk_index: chunk.chunk_index,
      chunk_text: chunk.chunk_text,
      chunk_source: chunk.chunk_source,
      embedding: chunk.embedding || undefined,
      model: chunk.model,
      token_count: chunk.token_count || undefined,
    })), sourceOpts);
    for (const tag of await source.getTags(slug, sourceOpts)) {
      await target.addTag(slug, tag, sourceOpts);
    }
    for (const entry of await source.getTimeline(slug, sourceOpts)) {
      await target.addTimelineEntry(slug, {
        date: entry.date,
        source: entry.source,
        summary: entry.summary,
        detail: entry.detail,
      }, sourceOpts);
    }
    for (const raw of await source.getRawData(slug, undefined, sourceOpts)) {
      await target.putRawData(slug, raw.source, raw.data, sourceOpts);
    }
    for (const link of await source.getLinks(slug, sourceOpts)) {
      await target.addLink(
        link.from_slug,
        link.to_slug,
        link.context,
        link.link_type,
        undefined,
        undefined,
        undefined,
        { fromSourceId: sourceId, toSourceId: sourceId },
      );
    }

    expect(await finalizeArchivedSourceRowsForMigration(source, target)).toBe(1);
    const finalSource = await target.executeRaw<{
      archived: boolean;
      archived_at: Date | string | null;
      archive_expires_at: Date | string | null;
    }>(
      `SELECT archived, archived_at, archive_expires_at FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(finalSource[0]?.archived).toBe(true);
    expect(new Date(finalSource[0]!.archived_at!).toISOString()).toBe(
      new Date(sourceArchiveState[0]!.archived_at!).toISOString(),
    );
    expect(new Date(finalSource[0]!.archive_expires_at!).toISOString()).toBe(
      new Date(sourceArchiveState[0]!.archive_expires_at!).toISOString(),
    );

    const graphCounts = await target.executeRaw<{
      chunks: number | string;
      tags: number | string;
      timeline: number | string;
      raw: number | string;
      links: number | string;
    }>(
      `SELECT
         (SELECT count(*) FROM content_chunks c WHERE c.page_id = p.id)::int AS chunks,
         (SELECT count(*) FROM tags t WHERE t.page_id = p.id)::int AS tags,
         (SELECT count(*) FROM timeline_entries t WHERE t.page_id = p.id)::int AS timeline,
         (SELECT count(*) FROM raw_data r WHERE r.page_id = p.id)::int AS raw,
         (SELECT count(*) FROM links l WHERE l.from_page_id = p.id)::int AS links
       FROM pages p
       WHERE p.source_id = $1 AND p.slug = $2`,
      [sourceId, slug],
    );
    expect(graphCounts.map((row) => ({
      chunks: Number(row.chunks),
      tags: Number(row.tags),
      timeline: Number(row.timeline),
      raw: Number(row.raw),
      links: Number(row.links),
    }))).toEqual([{ chunks: 1, tags: 1, timeline: 1, raw: 1, links: 1 }]);

    // A crash after archive finalization but before the file-plane config
    // switch leaves a resumable manifest pointing at an already-archived
    // target. Re-stage it, then simulate a second crash after the migration
    // drain commits but before the archive UPDATE. The next staging pass must
    // complete only that migration-owned drain and leave the source writable
    // for the remaining migrated rows.
    await copySourceRowsForMigration(source, target, { stageArchivedAsActive: true });
    const interruptedDrain = await beginSourceArchiveDrain(target, sourceId, 'migration');
    expect(interruptedDrain?.purpose).toBe('migration');
    await copySourceRowsForMigration(source, target, { stageArchivedAsActive: true });
    expect(await target.executeRaw(
      `SELECT archived, archived_at, archive_expires_at, embedding_drain_token
         FROM sources WHERE id = $1`,
      [sourceId],
    )).toEqual([{
      archived: false,
      archived_at: null,
      archive_expires_at: null,
      embedding_drain_token: null,
    }]);
    expect(await finalizeArchivedSourceRowsForMigration(source, target)).toBe(1);

    const resumedSource = await target.executeRaw<{
      archived: boolean;
      archived_at: Date | string | null;
      archive_expires_at: Date | string | null;
    }>(
      `SELECT archived, archived_at, archive_expires_at FROM sources WHERE id = $1`,
      [sourceId],
    );
    expect(resumedSource[0]?.archived).toBe(true);
    expect(new Date(resumedSource[0]!.archived_at!).toISOString()).toBe(
      new Date(sourceArchiveState[0]!.archived_at!).toISOString(),
    );
    expect(new Date(resumedSource[0]!.archive_expires_at!).toISOString()).toBe(
      new Date(sourceArchiveState[0]!.archive_expires_at!).toISOString(),
    );
  }, 60_000);

  test('fails before target writes when the source has an active archive drain', async () => {
    const sourceId = 'source-draining-during-migration';
    await source.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, 'Source Draining', '/tmp/source-draining', '{}'::jsonb)`,
      [sourceId],
    );
    const drain = await beginSourceArchiveDrain(source, sourceId);
    expect(drain?.purpose).toBe('manual');

    await expect(
      copySourceRowsForMigration(source, target, { stageArchivedAsActive: true }),
    ).rejects.toThrow(`Cannot migrate while source "${sourceId}" has an active archive drain`);
    expect(await target.executeRaw(
      `SELECT id FROM sources WHERE id = $1`,
      [sourceId],
    )).toEqual([]);
  }, 60_000);

  test('does not adopt a target drain owned by a manual archive', async () => {
    const sourceId = 'manual-target-drain';
    await edgeSource.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, 'Manual Target Drain', '{}'::jsonb)`,
      [sourceId],
    );
    expect((await softDeleteSourceGuarded(edgeSource, sourceId)).reason).toBe('archived');
    await copySourceRowsForMigration(edgeSource, edgeTarget, {
      stageArchivedAsActive: true,
    });
    const manualDrain = await beginSourceArchiveDrain(edgeTarget, sourceId, 'manual');
    expect(manualDrain?.purpose).toBe('manual');

    await expect(
      copySourceRowsForMigration(edgeSource, edgeTarget, {
        stageArchivedAsActive: true,
      }),
    ).rejects.toThrow('target has a non-migration archive drain');
    expect((await edgeTarget.executeRaw<{ embedding_drain_token: string | null }>(
      `SELECT embedding_drain_token FROM sources WHERE id = $1`,
      [sourceId],
    ))[0]?.embedding_drain_token).toBe(manualDrain!.token);
    await cancelSourceArchiveDrain(edgeTarget, manualDrain!);
  }, 60_000);

  test('does not cancel a replacement migration drain before source staging', async () => {
    const sourceId = 'replacement-target-drain';
    await edgeSource.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, 'Replacement Target Drain', '{}'::jsonb)`,
      [sourceId],
    );
    expect((await softDeleteSourceGuarded(edgeSource, sourceId)).reason).toBe('archived');
    await copySourceRowsForMigration(edgeSource, edgeTarget, {
      stageArchivedAsActive: true,
    });
    const observed = await beginSourceArchiveDrain(edgeTarget, sourceId, 'migration');
    expect(observed?.purpose).toBe('migration');
    const replacements: NonNullable<Awaited<ReturnType<typeof beginSourceArchiveDrain>>>[] = [];
    let replaced = false;
    const replacingTarget = new Proxy(edgeTarget, {
      get(realTarget, prop, receiver) {
        if (prop === 'executeRaw') {
          return async <T>(sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) => {
            const rows = await realTarget.executeRaw<T>(sql, params, opts);
            if (
              !replaced
              && params?.[0] === sourceId
              && /SELECT id, archived, archived_at, archive_expires_at, embedding_drain_token/i.test(sql)
              && /embedding_drain_epoch/i.test(sql)
            ) {
              replaced = true;
              expect(await cancelSourceArchiveDrain(realTarget, observed!)).toBe(true);
              const replacement = await beginSourceArchiveDrain(realTarget, sourceId, 'migration');
              if (replacement) replacements.push(replacement);
            }
            return rows;
          };
        }
        return Reflect.get(realTarget, prop, receiver);
      },
    }) as unknown as BrainEngine;

    await expect(copySourceRowsForMigration(edgeSource, replacingTarget, {
      stageArchivedAsActive: true,
    })).rejects.toThrow('ownership changed');
    expect(replaced).toBe(true);
    expect(replacements[0]?.purpose).toBe('migration');
    expect((await edgeTarget.executeRaw<{ embedding_drain_token: string | null }>(
      `SELECT embedding_drain_token FROM sources WHERE id = $1`,
      [sourceId],
    ))[0]?.embedding_drain_token).toBe(replacements[0]!.token);
    expect(await cancelSourceArchiveDrain(edgeTarget, replacements[0]!)).toBe(true);
  }, 60_000);

  test('rejects an invalid archived default source', async () => {
    await edgeSource.executeRaw(`DELETE FROM sources WHERE id = 'default'`);
    await edgeSource.executeRaw(
      `INSERT INTO sources (id, name, config, archived, archived_at, archive_expires_at)
       VALUES ('default', 'Default', '{}'::jsonb, TRUE, now(), now() + interval '24 hours')`,
    );

    await expect(
      copySourceRowsForMigration(edgeSource, edgeTarget, {
        stageArchivedAsActive: true,
      }),
    ).rejects.toThrow('Cannot migrate an invalid archived "default" source');
    await expect(
      finalizeArchivedSourceRowsForMigration(edgeSource, edgeTarget),
    ).rejects.toThrow('Cannot finalize an invalid archived "default" source migration');
  }, 60_000);
});
