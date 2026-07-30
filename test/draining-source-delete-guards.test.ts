import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  withMigrationSourceWriteFence,
  withMigrationSourceWriteFences,
} from '../src/commands/migrate-engine.ts';
import { softDeleteSourceGuarded } from '../src/core/destructive-guard.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  beginSourceArchiveDrain,
  cancelSourceArchiveDrain,
} from '../src/core/source-embedding-lease.ts';

describe('draining-source delete guards', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 30_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  test('blocks ordinary parent and child deletes but permits the exact migration transaction', async () => {
    const sourceId = 'delete-fence';
    const slug = 'projects/delete-fence';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    await engine.putPage(slug, {
      type: 'project',
      title: 'Delete fence',
      compiled_truth: 'Migration fencing must cover deletes.',
      timeline: '',
    }, { sourceId });
    await engine.upsertChunks(slug, [{
      chunk_index: 0,
      chunk_text: 'fenced child row',
      chunk_source: 'compiled_truth',
      model: 'test-model',
    }], { sourceId });

    const drain = await beginSourceArchiveDrain(engine, sourceId, 'migration');
    expect(drain?.purpose).toBe('migration');

    await expect(engine.executeRaw(
      `DELETE FROM content_chunks
        WHERE page_id IN (SELECT id FROM pages WHERE source_id = $1)`,
      [sourceId],
    )).rejects.toThrow('page source delete-fence is draining');
    await expect(engine.executeRaw(
      `DELETE FROM pages WHERE source_id = $1`,
      [sourceId],
    )).rejects.toThrow('source delete-fence is draining');
    expect(await engine.executeRaw(
      `SELECT count(*)::int AS count
         FROM content_chunks c
         JOIN pages p ON p.id = c.page_id
        WHERE p.source_id = $1`,
      [sourceId],
    )).toEqual([{ count: 1 }]);
    expect(await engine.executeRaw(
      `SELECT count(*)::int AS count FROM pages WHERE source_id = $1`,
      [sourceId],
    )).toEqual([{ count: 1 }]);

    await withMigrationSourceWriteFence(engine, sourceId, async (tx) => {
      await tx.executeRaw(`DELETE FROM pages WHERE source_id = $1`, [sourceId]);
    });

    expect(await engine.executeRaw(
      `SELECT count(*)::int AS count FROM pages WHERE source_id = $1`,
      [sourceId],
    )).toEqual([{ count: 0 }]);
    expect((await engine.executeRaw<{
      embedding_drain_token: string | null;
      embedding_drain_epoch: number | string;
    }>(
      `SELECT embedding_drain_token, embedding_drain_epoch
         FROM sources
        WHERE id = $1`,
      [sourceId],
    ))[0]).toEqual({
      embedding_drain_token: drain!.token,
      embedding_drain_epoch: drain!.epoch,
    });
  }, 30_000);

  test('allows cleanup after an archive drain is exact-cleared and the source is archived', async () => {
    const sourceId = 'archived-cleanup';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    await engine.putPage('projects/archived-cleanup', {
      type: 'project',
      title: 'Archived cleanup',
      compiled_truth: 'Cleanup is legal after the drain is cleared.',
      timeline: '',
    }, { sourceId });

    const drain = await beginSourceArchiveDrain(engine, sourceId, 'migration');
    expect(drain).not.toBeNull();
    expect(await cancelSourceArchiveDrain(engine, drain!)).toBe(true);
    expect((await softDeleteSourceGuarded(engine, sourceId)).reason).toBe('archived');

    await engine.executeRaw(`DELETE FROM pages WHERE source_id = $1`, [sourceId]);
    expect(await engine.executeRaw(
      `SELECT count(*)::int AS count FROM pages WHERE source_id = $1`,
      [sourceId],
    )).toEqual([{ count: 0 }]);
  }, 30_000);

  test('bulk purge skips draining sources while cleaning healthy sources', async () => {
    const drainingSourceId = 'purge-draining-source';
    const healthySourceId = 'purge-healthy-source';
    const drainingSlug = 'projects/purge-draining-source';
    const healthySlug = 'projects/purge-healthy-source';
    for (const sourceId of [drainingSourceId, healthySourceId]) {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config)
         VALUES ($1, $1, jsonb_build_object())`,
        [sourceId],
      );
      await engine.putPage(`projects/${sourceId}`, {
        type: 'project',
        title: sourceId,
        compiled_truth: `${sourceId} keeps its lifecycle boundary during purge.`,
        timeline: '',
      }, { sourceId });
    }
    await engine.executeRaw(
      `UPDATE pages
          SET deleted_at = now() - INTERVAL '73 hours'
        WHERE source_id = ANY($1::text[])`,
      [[drainingSourceId, healthySourceId]],
    );

    const drain = await beginSourceArchiveDrain(engine, drainingSourceId, 'migration');
    expect(drain?.purpose).toBe('migration');

    const preview = await engine.purgeDeletedPages(72, { dryRun: true });
    expect(preview).toMatchObject({
      slugs: [healthySlug],
      count: 1,
    });
    expect(preview.candidates?.[0]).toMatchObject({
      slug: healthySlug,
      source_id: healthySourceId,
    });
    expect(preview.candidates?.[0]?.deleted_at).toBeInstanceOf(Date);
    expect(await engine.executeRaw(
      `SELECT count(*)::int AS count
         FROM pages
        WHERE source_id = ANY($1::text[])`,
      [[drainingSourceId, healthySourceId]],
    )).toEqual([{ count: 2 }]);

    expect(await engine.purgeDeletedPages(72)).toEqual({
      slugs: [healthySlug],
      count: 1,
    });
    expect(await engine.executeRaw(
      `SELECT source_id, slug
         FROM pages
        WHERE source_id = ANY($1::text[])
        ORDER BY source_id, slug`,
      [[drainingSourceId, healthySourceId]],
    )).toEqual([{ source_id: drainingSourceId, slug: drainingSlug }]);

    expect(await cancelSourceArchiveDrain(engine, drain!)).toBe(true);
    await engine.executeRaw(
      `DELETE FROM sources WHERE id = ANY($1::text[])`,
      [[drainingSourceId, healthySourceId]],
    );
  }, 30_000);

  test('bulk purge isolates every lifecycle-protected descendant cascade', async () => {
    const candidateSourceId = 'purge-cascade-candidates';
    const drainingSourceId = 'purge-cascade-draining';
    const archivedSourceId = 'purge-cascade-archived';
    const candidateSlugs = [
      'projects/purge-cascade-edge-chunk-from',
      'projects/purge-cascade-edge-chunk-to',
      'projects/purge-cascade-edge-symbol',
      'projects/purge-cascade-file-archived',
      'projects/purge-cascade-file-draining',
      'projects/purge-cascade-healthy',
      'projects/purge-cascade-link',
      'projects/purge-cascade-link-origin',
      'projects/purge-cascade-synthesis-page',
      'projects/purge-cascade-synthesis-take',
    ];
    const eligibleSlugs = [
      'projects/purge-cascade-healthy',
      'projects/purge-cascade-synthesis-page',
    ];
    const blockedSlugs = candidateSlugs.filter((slug) => !eligibleSlugs.includes(slug));
    const drainingTargetSlug = 'projects/purge-cascade-draining-target';
    const archivedTargetSlug = 'projects/purge-cascade-archived-target';
    const originHostSlug = 'projects/purge-cascade-origin-host';
    for (const sourceId of [candidateSourceId, drainingSourceId, archivedSourceId]) {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config)
         VALUES ($1, $1, jsonb_build_object())`,
        [sourceId],
      );
    }
    for (const slug of candidateSlugs) {
      await engine.putPage(slug, {
        type: 'project',
        title: slug,
        compiled_truth: `${slug} exercises guarded cascade isolation.`,
        timeline: '',
      }, { sourceId: candidateSourceId });
    }
    await engine.putPage(drainingTargetSlug, {
      type: 'project',
      title: drainingTargetSlug,
      compiled_truth: 'A draining source can own a cross-page descendant.',
      timeline: '',
    }, { sourceId: drainingSourceId });
    await engine.putPage(archivedTargetSlug, {
      type: 'project',
      title: archivedTargetSlug,
      compiled_truth: 'An archived source can own a cross-page descendant.',
      timeline: '',
    }, { sourceId: archivedSourceId });
    await engine.putPage(originHostSlug, {
      type: 'project',
      title: originHostSlug,
      compiled_truth: 'Active host for an origin_page_id SET NULL cascade.',
      timeline: '',
    }, { sourceId: candidateSourceId });
    await engine.executeRaw(
      `UPDATE pages
          SET deleted_at = now() - INTERVAL '73 hours'
        WHERE source_id = $1 AND slug = ANY($2::text[])`,
      [candidateSourceId, candidateSlugs],
    );
    const pageRows = await engine.executeRaw<{ id: number; slug: string }>(
      `SELECT id, slug
         FROM pages
        WHERE source_id = ANY($1::text[])`,
      [[candidateSourceId, drainingSourceId, archivedSourceId]],
    );
    const pageId = new Map(pageRows.map((row) => [row.slug, row.id]));

    await engine.executeRaw(
      `INSERT INTO files (
         source_id, page_id, filename, storage_path, content_hash
       ) VALUES ($1, $2, 'draining.txt', 'purge/draining.txt', 'purge-draining-file')`,
      [drainingSourceId, pageId.get('projects/purge-cascade-file-draining')!],
    );
    await engine.executeRaw(
      `INSERT INTO files (
         source_id, page_id, filename, storage_path, content_hash
       ) VALUES ($1, $2, 'archived.txt', 'purge/archived.txt', 'purge-archived-file')`,
      [archivedSourceId, pageId.get('projects/purge-cascade-file-archived')!],
    );
    await engine.executeRaw(
      `INSERT INTO links (
         from_page_id, to_page_id, link_type, context, link_source
       ) VALUES ($1, $2, 'related', '', 'manual')`,
      [
        pageId.get('projects/purge-cascade-link')!,
        pageId.get(drainingTargetSlug)!,
      ],
    );
    await engine.executeRaw(
      `INSERT INTO links (
         from_page_id, to_page_id, link_type, context, link_source, origin_page_id
       ) VALUES ($1, $2, 'related', '', 'frontmatter', $3)`,
      [
        pageId.get(originHostSlug)!,
        pageId.get(archivedTargetSlug)!,
        pageId.get('projects/purge-cascade-link-origin')!,
      ],
    );
    for (const slug of [
      'projects/purge-cascade-edge-chunk-from',
      'projects/purge-cascade-edge-chunk-to',
      'projects/purge-cascade-edge-symbol',
    ]) {
      await engine.upsertChunks(slug, [{
        chunk_index: 0,
        chunk_text: `${slug} guarded edge`,
        chunk_source: 'compiled_truth',
        model: 'test-model',
      }], { sourceId: candidateSourceId });
    }
    await engine.upsertChunks(drainingTargetSlug, [{
      chunk_index: 0,
      chunk_text: 'draining target guarded edge',
      chunk_source: 'compiled_truth',
      model: 'test-model',
    }], { sourceId: drainingSourceId });
    const chunkRows = await engine.executeRaw<{ id: number; slug: string }>(
      `SELECT chunk.id, page.slug
         FROM content_chunks chunk
         JOIN pages page ON page.id = chunk.page_id
        WHERE page.slug = ANY($1::text[])`,
      [[
        'projects/purge-cascade-edge-chunk-from',
        'projects/purge-cascade-edge-chunk-to',
        'projects/purge-cascade-edge-symbol',
        drainingTargetSlug,
      ]],
    );
    const chunkId = new Map(chunkRows.map((row) => [row.slug, row.id]));
    await engine.executeRaw(
      `INSERT INTO code_edges_chunk (
         from_chunk_id, to_chunk_id, from_symbol_qualified,
         to_symbol_qualified, edge_type, source_id
       ) VALUES ($1, $2, 'draining.symbol', 'candidate.symbol', 'calls', $3)`,
      [
        chunkId.get(drainingTargetSlug)!,
        chunkId.get('projects/purge-cascade-edge-chunk-to')!,
        drainingSourceId,
      ],
    );
    await engine.executeRaw(
      `INSERT INTO code_edges_chunk (
         from_chunk_id, to_chunk_id, from_symbol_qualified,
         to_symbol_qualified, edge_type, source_id
       ) VALUES ($1, $2, 'candidate.symbol', 'draining.symbol', 'calls', $3)`,
      [
        chunkId.get('projects/purge-cascade-edge-chunk-from')!,
        chunkId.get(drainingTargetSlug)!,
        drainingSourceId,
      ],
    );
    await engine.executeRaw(
      `INSERT INTO code_edges_symbol (
         from_chunk_id, from_symbol_qualified, to_symbol_qualified,
         edge_type, source_id
       ) VALUES ($1, 'candidate.symbol', 'missing.symbol', 'calls', $2)`,
      [chunkId.get('projects/purge-cascade-edge-symbol')!, drainingSourceId],
    );
    await engine.executeRaw(
      `INSERT INTO takes (
         page_id, row_num, claim, kind, holder, weight
       ) VALUES ($1, 1, 'Guarded synthesis evidence', 'fact', 'world', 0.5)`,
      [pageId.get('projects/purge-cascade-synthesis-take')!],
    );
    await engine.executeRaw(
      `INSERT INTO takes (
         page_id, row_num, claim, kind, holder, weight
       ) VALUES ($1, 1, 'Draining synthesis evidence', 'fact', 'world', 0.5)`,
      [pageId.get(drainingTargetSlug)!],
    );
    await engine.executeRaw(
      `INSERT INTO synthesis_evidence (
         synthesis_page_id, take_page_id, take_row_num, citation_index
       ) VALUES ($1, $2, 1, 1)`,
      [
        pageId.get(drainingTargetSlug)!,
        pageId.get('projects/purge-cascade-synthesis-take')!,
      ],
    );
    await engine.executeRaw(
      `INSERT INTO synthesis_evidence (
         synthesis_page_id, take_page_id, take_row_num, citation_index
       ) VALUES ($1, $2, 1, 1)`,
      [
        pageId.get('projects/purge-cascade-synthesis-page')!,
        pageId.get(drainingTargetSlug)!,
      ],
    );

    expect((await softDeleteSourceGuarded(engine, archivedSourceId)).reason).toBe('archived');

    const drain = await beginSourceArchiveDrain(engine, drainingSourceId, 'migration');
    expect(drain?.purpose).toBe('migration');

    const preview = await engine.purgeDeletedPages(72, { dryRun: true });
    expect(preview.count).toBe(candidateSlugs.length);
    expect(preview.slugs).toEqual(candidateSlugs);
    expect(await engine.executeRaw(
      `SELECT count(*)::int AS count FROM pages
        WHERE source_id = ANY($1::text[])`,
      [[candidateSourceId, drainingSourceId, archivedSourceId]],
    )).toEqual([{ count: candidateSlugs.length + 3 }]);

    expect(await engine.purgeDeletedPages(72)).toEqual({
      slugs: eligibleSlugs,
      count: eligibleSlugs.length,
    });
    expect((await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NOT NULL
        ORDER BY slug`,
      [candidateSourceId],
    )).map((row) => row.slug)).toEqual(blockedSlugs);
    expect(await engine.purgeDeletedPages(72)).toEqual({ slugs: [], count: 0 });

    expect(await cancelSourceArchiveDrain(engine, drain!)).toBe(true);
    expect((await engine.purgeDeletedPages(72)).count).toBe(blockedSlugs.length - 2);
    await engine.executeRaw(
      `UPDATE sources
          SET archived = false, archived_at = NULL, archive_expires_at = NULL
        WHERE id = $1`,
      [archivedSourceId],
    );
    expect((await engine.purgeDeletedPages(72)).count).toBe(2);
    await engine.executeRaw(
      `DELETE FROM sources WHERE id = ANY($1::text[])`,
      [[candidateSourceId, drainingSourceId, archivedSourceId]],
    );
  }, 30_000);

  test('allows deleting active-source rows whose optional page reference is null', async () => {
    const sourceId = 'nullable-page-delete';
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    const inserted = await engine.executeRaw<{ id: number }>(
      `INSERT INTO files (
         source_id, page_id, filename, storage_path, content_hash
       ) VALUES ($1, NULL, 'orphan.txt', 'nullable/orphan.txt', 'nullable-hash')
       RETURNING id`,
      [sourceId],
    );

    await engine.executeRaw(`DELETE FROM files WHERE id = $1`, [inserted[0]!.id]);

    expect(await engine.executeRaw(
      `SELECT count(*)::int AS count FROM files WHERE id = $1`,
      [inserted[0]!.id],
    )).toEqual([{ count: 0 }]);
  }, 30_000);

  test('force-style deletion preserves pages owned by sources outside the exact fence set', async () => {
    const migratedSourceId = 'force-migrated-source';
    const targetOnlySourceId = 'force-target-only-source';
    for (const sourceId of [migratedSourceId, targetOnlySourceId]) {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config)
         VALUES ($1, $1, jsonb_build_object())`,
        [sourceId],
      );
      await engine.putPage(`projects/${sourceId}`, {
        type: 'project',
        title: sourceId,
        compiled_truth: `${sourceId} must keep the correct ownership boundary.`,
        timeline: '',
      }, { sourceId });
    }
    expect((await beginSourceArchiveDrain(engine, migratedSourceId, 'migration'))?.purpose)
      .toBe('migration');

    await withMigrationSourceWriteFences(engine, [migratedSourceId], async (tx) => {
      await tx.executeRaw(
        `DELETE FROM pages WHERE source_id = ANY($1::text[])`,
        [[migratedSourceId]],
      );
    });

    expect(await engine.executeRaw(
      `SELECT source_id FROM pages
        WHERE source_id = ANY($1::text[])
        ORDER BY source_id`,
      [[migratedSourceId, targetOnlySourceId]],
    )).toEqual([{ source_id: targetOnlySourceId }]);
  }, 30_000);
});
