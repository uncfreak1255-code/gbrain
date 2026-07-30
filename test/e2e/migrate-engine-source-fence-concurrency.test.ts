import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  finalizeTargetSourceRowsForMigrationCutover,
  withMigrationSourceWriteFence,
  withTargetMigrationSessionLock,
} from '../../src/commands/migrate-engine.ts';
import type { FinalSourceMigrationState } from '../../src/commands/migrate-engine.ts';
import { softDeleteSourceGuarded } from '../../src/core/destructive-guard.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import {
  beginSourceArchiveDrain,
  cancelSourceArchiveDrain,
} from '../../src/core/source-embedding-lease.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

if (!hasDatabase()) {
  console.log('Skipping migrate-engine source-fence concurrency E2E (DATABASE_URL not set)');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describeE2E('migrate-engine source-fence concurrency', () => {
  let migration: PostgresEngine;
  let ordinaryWorker: PostgresEngine;

  beforeAll(async () => {
    migration = await setupDB();
    ordinaryWorker = new PostgresEngine();
    await ordinaryWorker.connect({ database_url: process.env.DATABASE_URL! });
  }, 30_000);

  afterAll(async () => {
    await ordinaryWorker.disconnect();
    await teardownDB();
  });

  test('ordinary child delete waits and rejects without deadlocking the migration writer', async () => {
    const sourceId = 'migration-child-delete-race';
    const slug = 'projects/migration-child-delete-race';
    const sourceOpts = { sourceId };
    await migration.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    await migration.putPage(slug, {
      type: 'project',
      title: 'Migration child delete race',
      compiled_truth: 'The migration owns this target snapshot.',
      timeline: '',
    }, sourceOpts);
    await migration.upsertChunks(slug, [{
      chunk_index: 0,
      chunk_text: 'before migration write',
      chunk_source: 'compiled_truth',
      model: 'test-model',
      token_count: 3,
    }], sourceOpts);
    const drain = await beginSourceArchiveDrain(migration, sourceId, 'migration');
    expect(drain?.purpose).toBe('migration');

    const migrationHasLifecycleLock = deferred();
    const allowMigrationWrite = deferred();
    let migrationSettled = false;
    let ordinarySettled = false;
    const migrationRun = withMigrationSourceWriteFence(migration, sourceId, async (tx) => {
      migrationHasLifecycleLock.resolve();
      await allowMigrationWrite.promise;
      await tx.upsertChunks(slug, [{
        chunk_index: 0,
        chunk_text: 'migration write committed',
        chunk_source: 'compiled_truth',
        model: 'test-model',
        token_count: 3,
      }], sourceOpts);
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { migrationSettled = true; });

    await within(migrationHasLifecycleLock.promise, 5_000, 'migration lifecycle lock');
    const ordinaryRun = ordinaryWorker.executeRaw(
      `DELETE FROM content_chunks
        WHERE page_id = (
          SELECT id FROM pages WHERE source_id = $1 AND slug = $2
        )
          AND chunk_index = 0`,
      [sourceId, slug],
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { ordinarySettled = true; });

    await wait(150);
    expect(migrationSettled).toBe(false);
    expect(ordinarySettled).toBe(false);
    allowMigrationWrite.resolve();

    const [migrationOutcome, ordinaryOutcome] = await within(
      Promise.all([migrationRun, ordinaryRun]),
      10_000,
      'migration/delete race',
    );
    expect(migrationOutcome).toEqual({ ok: true });
    expect(ordinaryOutcome.ok).toBe(false);
    const ordinaryError = String(
      ordinaryOutcome.ok ? '' : ordinaryOutcome.error,
    );
    expect(ordinaryError).toContain(`source ${sourceId} is draining`);
    expect(ordinaryError).not.toContain('deadlock detected');

    expect(await migration.executeRaw(
      `SELECT chunk_text
         FROM content_chunks
        WHERE page_id = (
          SELECT id FROM pages WHERE source_id = $1 AND slug = $2
        )
          AND chunk_index = 0`,
      [sourceId, slug],
    )).toEqual([{ chunk_text: 'migration write committed' }]);
    expect(await cancelSourceArchiveDrain(migration, drain!)).toBe(true);
  }, 30_000);

  test('bulk purge skips draining sources while cleaning healthy sources', async () => {
    const drainingSourceId = 'postgres-purge-draining-source';
    const healthySourceId = 'postgres-purge-healthy-source';
    const drainingSlug = 'projects/postgres-purge-draining-source';
    const healthySlug = 'projects/postgres-purge-healthy-source';
    for (const sourceId of [drainingSourceId, healthySourceId]) {
      await migration.executeRaw(
        `INSERT INTO sources (id, name, config)
         VALUES ($1, $1, jsonb_build_object())`,
        [sourceId],
      );
      await migration.putPage(`projects/${sourceId}`, {
        type: 'project',
        title: sourceId,
        compiled_truth: `${sourceId} keeps its lifecycle boundary during purge.`,
        timeline: '',
      }, { sourceId });
    }
    await migration.executeRaw(
      `UPDATE pages
          SET deleted_at = now() - INTERVAL '73 hours'
        WHERE source_id = ANY($1::text[])`,
      [[drainingSourceId, healthySourceId]],
    );

    const drain = await beginSourceArchiveDrain(migration, drainingSourceId, 'migration');
    expect(drain?.purpose).toBe('migration');

    const preview = await ordinaryWorker.purgeDeletedPages(72, { dryRun: true });
    expect(preview).toMatchObject({
      slugs: [healthySlug],
      count: 1,
    });
    expect(preview.candidates?.[0]).toMatchObject({
      slug: healthySlug,
      source_id: healthySourceId,
    });
    expect(preview.candidates?.[0]?.deleted_at).toBeInstanceOf(Date);
    expect(await migration.executeRaw(
      `SELECT count(*)::int AS count
         FROM pages
        WHERE source_id = ANY($1::text[])`,
      [[drainingSourceId, healthySourceId]],
    )).toEqual([{ count: 2 }]);

    expect(await ordinaryWorker.purgeDeletedPages(72)).toEqual({
      slugs: [healthySlug],
      count: 1,
    });
    expect(await migration.executeRaw(
      `SELECT source_id, slug
         FROM pages
        WHERE source_id = ANY($1::text[])
        ORDER BY source_id, slug`,
      [[drainingSourceId, healthySourceId]],
    )).toEqual([{ source_id: drainingSourceId, slug: drainingSlug }]);

    expect(await cancelSourceArchiveDrain(migration, drain!)).toBe(true);
    await migration.executeRaw(
      `DELETE FROM sources WHERE id = ANY($1::text[])`,
      [[drainingSourceId, healthySourceId]],
    );
  }, 30_000);

  test('bulk purge savepoints isolate every lifecycle-protected descendant cascade', async () => {
    const candidateSourceId = 'postgres-purge-cascade-candidates';
    const drainingSourceId = 'postgres-purge-cascade-draining';
    const archivedSourceId = 'postgres-purge-cascade-archived';
    const candidateSlugs = [
      'projects/postgres-purge-cascade-edge-chunk-from',
      'projects/postgres-purge-cascade-edge-chunk-to',
      'projects/postgres-purge-cascade-edge-symbol',
      'projects/postgres-purge-cascade-file-archived',
      'projects/postgres-purge-cascade-file-draining',
      'projects/postgres-purge-cascade-healthy',
      'projects/postgres-purge-cascade-link',
      'projects/postgres-purge-cascade-link-origin',
      'projects/postgres-purge-cascade-synthesis-page',
      'projects/postgres-purge-cascade-synthesis-take',
    ];
    const eligibleSlugs = [
      'projects/postgres-purge-cascade-healthy',
      'projects/postgres-purge-cascade-synthesis-page',
    ];
    const blockedSlugs = candidateSlugs.filter((slug) => !eligibleSlugs.includes(slug));
    const drainingTargetSlug = 'projects/postgres-purge-cascade-draining-target';
    const archivedTargetSlug = 'projects/postgres-purge-cascade-archived-target';
    const originHostSlug = 'projects/postgres-purge-cascade-origin-host';
    for (const sourceId of [candidateSourceId, drainingSourceId, archivedSourceId]) {
      await migration.executeRaw(
        `INSERT INTO sources (id, name, config)
         VALUES ($1, $1, jsonb_build_object())`,
        [sourceId],
      );
    }
    for (const slug of candidateSlugs) {
      await migration.putPage(slug, {
        type: 'project',
        title: slug,
        compiled_truth: `${slug} exercises guarded cascade isolation.`,
        timeline: '',
      }, { sourceId: candidateSourceId });
    }
    await migration.putPage(drainingTargetSlug, {
      type: 'project',
      title: drainingTargetSlug,
      compiled_truth: 'A draining source can own a cross-page descendant.',
      timeline: '',
    }, { sourceId: drainingSourceId });
    await migration.putPage(archivedTargetSlug, {
      type: 'project',
      title: archivedTargetSlug,
      compiled_truth: 'An archived source can own a cross-page descendant.',
      timeline: '',
    }, { sourceId: archivedSourceId });
    await migration.putPage(originHostSlug, {
      type: 'project',
      title: originHostSlug,
      compiled_truth: 'Active host for an origin_page_id SET NULL cascade.',
      timeline: '',
    }, { sourceId: candidateSourceId });
    await migration.executeRaw(
      `UPDATE pages
          SET deleted_at = now() - INTERVAL '73 hours'
        WHERE source_id = $1 AND slug = ANY($2::text[])`,
      [candidateSourceId, candidateSlugs],
    );
    const pageRows = await migration.executeRaw<{ id: number; slug: string }>(
      `SELECT id, slug
         FROM pages
        WHERE source_id = ANY($1::text[])`,
      [[candidateSourceId, drainingSourceId, archivedSourceId]],
    );
    const pageId = new Map(pageRows.map((row) => [row.slug, row.id]));

    await migration.executeRaw(
      `INSERT INTO files (
         source_id, page_id, filename, storage_path, content_hash
       ) VALUES ($1, $2, 'draining.txt', 'postgres-purge/draining.txt', 'postgres-purge-draining-file')`,
      [drainingSourceId, pageId.get('projects/postgres-purge-cascade-file-draining')!],
    );
    await migration.executeRaw(
      `INSERT INTO files (
         source_id, page_id, filename, storage_path, content_hash
       ) VALUES ($1, $2, 'archived.txt', 'postgres-purge/archived.txt', 'postgres-purge-archived-file')`,
      [archivedSourceId, pageId.get('projects/postgres-purge-cascade-file-archived')!],
    );
    await migration.executeRaw(
      `INSERT INTO links (
         from_page_id, to_page_id, link_type, context, link_source
       ) VALUES ($1, $2, 'related', '', 'manual')`,
      [
        pageId.get('projects/postgres-purge-cascade-link')!,
        pageId.get(drainingTargetSlug)!,
      ],
    );
    await migration.executeRaw(
      `INSERT INTO links (
         from_page_id, to_page_id, link_type, context, link_source, origin_page_id
       ) VALUES ($1, $2, 'related', '', 'frontmatter', $3)`,
      [
        pageId.get(originHostSlug)!,
        pageId.get(archivedTargetSlug)!,
        pageId.get('projects/postgres-purge-cascade-link-origin')!,
      ],
    );
    for (const slug of [
      'projects/postgres-purge-cascade-edge-chunk-from',
      'projects/postgres-purge-cascade-edge-chunk-to',
      'projects/postgres-purge-cascade-edge-symbol',
    ]) {
      await migration.upsertChunks(slug, [{
        chunk_index: 0,
        chunk_text: `${slug} guarded edge`,
        chunk_source: 'compiled_truth',
        model: 'test-model',
      }], { sourceId: candidateSourceId });
    }
    await migration.upsertChunks(drainingTargetSlug, [{
      chunk_index: 0,
      chunk_text: 'draining target guarded edge',
      chunk_source: 'compiled_truth',
      model: 'test-model',
    }], { sourceId: drainingSourceId });
    const chunkRows = await migration.executeRaw<{ id: number; slug: string }>(
      `SELECT chunk.id, page.slug
         FROM content_chunks chunk
         JOIN pages page ON page.id = chunk.page_id
        WHERE page.slug = ANY($1::text[])`,
      [[
        'projects/postgres-purge-cascade-edge-chunk-from',
        'projects/postgres-purge-cascade-edge-chunk-to',
        'projects/postgres-purge-cascade-edge-symbol',
        drainingTargetSlug,
      ]],
    );
    const chunkId = new Map(chunkRows.map((row) => [row.slug, row.id]));
    await migration.executeRaw(
      `INSERT INTO code_edges_chunk (
         from_chunk_id, to_chunk_id, from_symbol_qualified,
         to_symbol_qualified, edge_type, source_id
       ) VALUES ($1, $2, 'draining.symbol', 'candidate.symbol', 'calls', $3)`,
      [
        chunkId.get(drainingTargetSlug)!,
        chunkId.get('projects/postgres-purge-cascade-edge-chunk-to')!,
        drainingSourceId,
      ],
    );
    await migration.executeRaw(
      `INSERT INTO code_edges_chunk (
         from_chunk_id, to_chunk_id, from_symbol_qualified,
         to_symbol_qualified, edge_type, source_id
       ) VALUES ($1, $2, 'candidate.symbol', 'draining.symbol', 'calls', $3)`,
      [
        chunkId.get('projects/postgres-purge-cascade-edge-chunk-from')!,
        chunkId.get(drainingTargetSlug)!,
        drainingSourceId,
      ],
    );
    await migration.executeRaw(
      `INSERT INTO code_edges_symbol (
         from_chunk_id, from_symbol_qualified, to_symbol_qualified,
         edge_type, source_id
       ) VALUES ($1, 'candidate.symbol', 'missing.symbol', 'calls', $2)`,
      [chunkId.get('projects/postgres-purge-cascade-edge-symbol')!, drainingSourceId],
    );
    await migration.executeRaw(
      `INSERT INTO takes (
         page_id, row_num, claim, kind, holder, weight
       ) VALUES ($1, 1, 'Guarded synthesis evidence', 'fact', 'world', 0.5)`,
      [pageId.get('projects/postgres-purge-cascade-synthesis-take')!],
    );
    await migration.executeRaw(
      `INSERT INTO takes (
         page_id, row_num, claim, kind, holder, weight
       ) VALUES ($1, 1, 'Draining synthesis evidence', 'fact', 'world', 0.5)`,
      [pageId.get(drainingTargetSlug)!],
    );
    await migration.executeRaw(
      `INSERT INTO synthesis_evidence (
         synthesis_page_id, take_page_id, take_row_num, citation_index
       ) VALUES ($1, $2, 1, 1)`,
      [
        pageId.get(drainingTargetSlug)!,
        pageId.get('projects/postgres-purge-cascade-synthesis-take')!,
      ],
    );
    await migration.executeRaw(
      `INSERT INTO synthesis_evidence (
         synthesis_page_id, take_page_id, take_row_num, citation_index
       ) VALUES ($1, $2, 1, 1)`,
      [
        pageId.get('projects/postgres-purge-cascade-synthesis-page')!,
        pageId.get(drainingTargetSlug)!,
      ],
    );

    expect((await softDeleteSourceGuarded(migration, archivedSourceId)).reason).toBe('archived');

    const drain = await beginSourceArchiveDrain(migration, drainingSourceId, 'migration');
    expect(drain?.purpose).toBe('migration');

    const preview = await ordinaryWorker.purgeDeletedPages(72, { dryRun: true });
    expect(preview.count).toBe(candidateSlugs.length);
    expect(preview.slugs).toEqual(candidateSlugs);
    expect(await migration.executeRaw(
      `SELECT count(*)::int AS count FROM pages
        WHERE source_id = ANY($1::text[])`,
      [[candidateSourceId, drainingSourceId, archivedSourceId]],
    )).toEqual([{ count: candidateSlugs.length + 3 }]);

    expect(await ordinaryWorker.purgeDeletedPages(72)).toEqual({
      slugs: eligibleSlugs,
      count: eligibleSlugs.length,
    });
    expect((await migration.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NOT NULL
        ORDER BY slug`,
      [candidateSourceId],
    )).map((row) => row.slug)).toEqual(blockedSlugs);
    expect(await ordinaryWorker.purgeDeletedPages(72)).toEqual({ slugs: [], count: 0 });

    expect(await cancelSourceArchiveDrain(migration, drain!)).toBe(true);
    expect((await ordinaryWorker.purgeDeletedPages(72)).count).toBe(blockedSlugs.length - 2);
    await migration.executeRaw(
      `UPDATE sources
          SET archived = false, archived_at = NULL, archive_expires_at = NULL
        WHERE id = $1`,
      [archivedSourceId],
    );
    expect((await ordinaryWorker.purgeDeletedPages(72)).count).toBe(2);
    await migration.executeRaw(
      `DELETE FROM sources WHERE id = ANY($1::text[])`,
      [[candidateSourceId, drainingSourceId, archivedSourceId]],
    );
  }, 30_000);

  test('generic foreign-key failures abort the whole bulk purge transaction', async () => {
    const sourceId = 'postgres-purge-generic-fk';
    const slugs = [
      'projects/postgres-purge-generic-fk-blocked',
      'projects/postgres-purge-generic-fk-healthy',
    ];
    await migration.executeRaw('DROP TABLE IF EXISTS purge_generic_fk_guard');
    await migration.executeRaw(
      `CREATE TABLE purge_generic_fk_guard (
         page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE RESTRICT
       )`,
    );
    await migration.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    for (const slug of slugs) {
      await migration.putPage(slug, {
        type: 'project',
        title: slug,
        compiled_truth: `${slug} proves generic FK rollback.`,
        timeline: '',
      }, { sourceId });
    }
    await migration.executeRaw(
      `UPDATE pages
          SET deleted_at = now() - INTERVAL '73 hours'
        WHERE source_id = $1`,
      [sourceId],
    );
    await migration.executeRaw(
      `INSERT INTO purge_generic_fk_guard (page_id)
       SELECT id FROM pages WHERE source_id = $1 AND slug = $2`,
      [sourceId, slugs[0]],
    );

    await expect(ordinaryWorker.purgeDeletedPages(72)).rejects.toMatchObject({
      code: '23503',
    });
    expect((await migration.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 ORDER BY slug`,
      [sourceId],
    )).map((row) => row.slug)).toEqual(slugs);

    await migration.executeRaw('DELETE FROM purge_generic_fk_guard');
    expect(await ordinaryWorker.purgeDeletedPages(72)).toEqual({
      slugs,
      count: slugs.length,
    });
    await migration.executeRaw('DROP TABLE purge_generic_fk_guard');
    await migration.executeRaw('DELETE FROM sources WHERE id = $1', [sourceId]);
  }, 30_000);

  test('archived cleanup cannot observe the final lifecycle before cutover commits', async () => {
    const priorSourceId = 'migration-child-delete-race';
    await migration.executeRaw('DELETE FROM pages WHERE source_id = $1', [priorSourceId]);
    await migration.executeRaw('DELETE FROM sources WHERE id = $1', [priorSourceId]);

    const sourceId = 'migration-archived-cutover-race';
    const slug = 'projects/migration-archived-cutover-race';
    const archivedAt = '2026-07-01T12:00:00.000Z';
    const archiveExpiresAt = '2026-08-01T12:00:00.000Z';
    await migration.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    await migration.putPage(slug, {
      type: 'project',
      title: 'Archived cutover race',
      compiled_truth: 'Cleanup must wait until target cutover commits.',
      timeline: '',
    }, { sourceId });

    const defaultDrain = await beginSourceArchiveDrain(migration, 'default', 'migration');
    const archivedDrain = await beginSourceArchiveDrain(migration, sourceId, 'migration');
    expect(defaultDrain?.purpose).toBe('migration');
    expect(archivedDrain?.purpose).toBe('migration');

    const sourceRows: FinalSourceMigrationState[] = [
      {
        id: 'default',
        archived: false,
        archived_at: null,
        archive_expires_at: null,
        embedding_drain_token: null,
      },
      {
        id: sourceId,
        archived: true,
        archived_at: archivedAt,
        archive_expires_at: archiveExpiresAt,
        embedding_drain_token: null,
      },
    ];
    const cutoverHasLifecycleLock = deferred();
    const allowCutoverCommit = deferred();
    let cutoverSettled = false;
    let ordinarySettled = false;

    const cutoverRun = finalizeTargetSourceRowsForMigrationCutover(
      migration,
      sourceRows,
      async () => {
        cutoverHasLifecycleLock.resolve();
        await allowCutoverCommit.promise;
      },
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { cutoverSettled = true; });

    await within(cutoverHasLifecycleLock.promise, 5_000, 'cutover lifecycle lock');
    expect(await ordinaryWorker.executeRaw<{
      archived: boolean;
      embedding_drain_token: string | null;
    }>(
      `SELECT archived, embedding_drain_token
         FROM sources
        WHERE id = $1`,
      [sourceId],
    )).toEqual([{
      archived: false,
      embedding_drain_token: archivedDrain!.token,
    }]);

    const ordinaryRun = ordinaryWorker.executeRaw(
      'DELETE FROM pages WHERE source_id = $1',
      [sourceId],
    ).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ).finally(() => { ordinarySettled = true; });

    await wait(150);
    expect(cutoverSettled).toBe(false);
    expect(ordinarySettled).toBe(false);
    allowCutoverCommit.resolve();

    const [cutoverOutcome, ordinaryOutcome] = await within(
      Promise.all([cutoverRun, ordinaryRun]),
      10_000,
      'archived cutover/delete race',
    );
    expect(cutoverOutcome).toEqual({ ok: true });
    expect(ordinaryOutcome).toEqual({ ok: true });
    expect(await migration.executeRaw(
      `SELECT archived, archived_at, archive_expires_at, embedding_drain_token
         FROM sources
        WHERE id = $1`,
      [sourceId],
    )).toEqual([{
      archived: true,
      archived_at: new Date(archivedAt),
      archive_expires_at: new Date(archiveExpiresAt),
      embedding_drain_token: null,
    }]);
    expect(await migration.executeRaw(
      'SELECT COUNT(*)::int AS count FROM pages WHERE source_id = $1',
      [sourceId],
    )).toEqual([{ count: 0 }]);
  }, 30_000);

  test('source deletion rejects a migration drain but permits archived cleanup', async () => {
    const sourceId = 'migration-source-delete-fence';
    await migration.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    await migration.putPage('projects/migration-source-delete-fence', {
      type: 'project',
      title: 'Source delete fence',
      compiled_truth: 'The source registry row owns the whole cascade.',
      timeline: '',
    }, { sourceId });
    const drain = await beginSourceArchiveDrain(migration, sourceId, 'migration');
    expect(drain?.purpose).toBe('migration');

    await expect(ordinaryWorker.executeRaw(
      'DELETE FROM sources WHERE id = $1',
      [sourceId],
    )).rejects.toThrow(`Cannot delete source ${sourceId} while it is draining`);
    expect(await migration.executeRaw(
      'SELECT COUNT(*)::int AS count FROM pages WHERE source_id = $1',
      [sourceId],
    )).toEqual([{ count: 1 }]);

    expect(await cancelSourceArchiveDrain(migration, drain!)).toBe(true);
    expect((await softDeleteSourceGuarded(migration, sourceId)).reason).toBe('archived');
    expect(await migration.executeRaw(
      `SELECT archived, embedding_drain_token
         FROM sources
        WHERE id = $1`,
      [sourceId],
    )).toEqual([{ archived: true, embedding_drain_token: null }]);

    await ordinaryWorker.executeRaw('DELETE FROM sources WHERE id = $1', [sourceId]);
    expect(await migration.executeRaw(
      'SELECT COUNT(*)::int AS count FROM pages WHERE source_id = $1',
      [sourceId],
    )).toEqual([{ count: 0 }]);
  }, 30_000);

  test('nullable page references do not suppress ordinary PostgreSQL deletes', async () => {
    const sourceId = 'migration-nullable-page-delete';
    await migration.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ($1, $1, jsonb_build_object())`,
      [sourceId],
    );
    const inserted = await migration.executeRaw<{ id: number }>(
      `INSERT INTO files (
         source_id, page_id, filename, storage_path, content_hash
       ) VALUES ($1, NULL, 'orphan.txt', 'nullable/orphan.txt', 'nullable-hash')
       RETURNING id`,
      [sourceId],
    );

    await ordinaryWorker.executeRaw('DELETE FROM files WHERE id = $1', [inserted[0]!.id]);

    expect(await migration.executeRaw(
      'SELECT COUNT(*)::int AS count FROM files WHERE id = $1',
      [inserted[0]!.id],
    )).toEqual([{ count: 0 }]);
  }, 30_000);

  test('only one live migrate-engine command can own a target database', async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const firstRun = withTargetMigrationSessionLock(migration, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      return 'first-complete';
    });

    await within(firstEntered.promise, 5_000, 'first target migration lock');
    let secondRan = false;
    await expect(withTargetMigrationSessionLock(ordinaryWorker, async () => {
      secondRan = true;
    })).rejects.toThrow('Another migrate-engine command is already writing this target');
    expect(secondRan).toBe(false);

    releaseFirst.resolve();
    await expect(within(firstRun, 5_000, 'first target migration release'))
      .resolves.toBe('first-complete');
    await expect(withTargetMigrationSessionLock(ordinaryWorker, async () => 'next-run'))
      .resolves.toBe('next-run');
  }, 30_000);

  test('dedicated session lock does not consume a poolSize=1 work connection', async () => {
    const singleConnectionWorker = new PostgresEngine();
    await singleConnectionWorker.connect({
      database_url: process.env.DATABASE_URL!,
      poolSize: 1,
    });
    try {
      await expect(within(withTargetMigrationSessionLock(
        singleConnectionWorker,
        async () => {
          await singleConnectionWorker.initSchema();
          return singleConnectionWorker.executeRaw<{ value: number }>(
            'SELECT 1::int AS value',
          );
        },
      ), 15_000, 'poolSize=1 migration session lock')).resolves.toEqual([{ value: 1 }]);
    } finally {
      await singleConnectionWorker.disconnect();
    }
  }, 30_000);
});
