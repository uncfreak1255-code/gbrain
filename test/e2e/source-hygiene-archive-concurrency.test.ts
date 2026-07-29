/**
 * Real-Postgres proof for the source archive/write lock protocol.
 *
 * PGLite proves trigger behavior, but it cannot prove two independent
 * transactions block in the required order. These cases pin both directions:
 * an existing writer makes archive wait and then veto; an archive already in
 * progress makes a later writer wait and then reject the archived source.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { archiveHygieneCandidate } from '../../src/commands/sources.ts';
import { softDeleteSource } from '../../src/core/destructive-guard.ts';
import { MIGRATIONS } from '../../src/core/migrate.ts';
import { withActiveEmbeddingSource } from '../../src/commands/embed.ts';
import {
  beginSourceArchiveDrain,
  SourceEmbeddingLeaseLostError,
} from '../../src/core/source-embedding-lease.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

if (!hasDatabase()) {
  console.log('Skipping source-hygiene archive concurrency E2E (DATABASE_URL not set)');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describeE2E('source hygiene archive/write concurrency', () => {
  beforeAll(async () => {
    await setupDB();
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('guard ignores a caller-controlled temporary sources table', async () => {
    const sourceId = 'archive-search-path-shadow-e2e';
    const jobName = 'source-hygiene-search-path-shadow-e2e';
    const writer = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM public.minion_jobs WHERE name = $1`, [jobName]);
      await writer.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO public.sources (id, name, config, archived)
         VALUES ($1, $1, '{}'::jsonb, true)`,
        [sourceId],
      );
      const error = await writer.withReservedConnection(async (conn) => {
        try {
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.sources`);
          await conn.executeRaw(
            `CREATE TEMP TABLE sources (id text PRIMARY KEY, archived boolean NOT NULL)`,
          );
          await conn.executeRaw(
            `INSERT INTO pg_temp.sources (id, archived) VALUES ($1, false)`,
            [sourceId],
          );
          await conn.executeRaw(`SET search_path = pg_temp, public`);

          try {
            await conn.executeRaw(
              `INSERT INTO public.minion_jobs (name, data)
               VALUES ($1, jsonb_build_object('sourceId', $2::text))`,
              [jobName, sourceId],
            );
          } catch (caught) {
            return caught;
          }
          return undefined;
        } finally {
          await conn.executeRaw(`DROP TABLE IF EXISTS pg_temp.sources`).catch(() => {});
          await conn.executeRaw(`RESET search_path`).catch(() => {});
        }
      });
      expect(error).toBeDefined();
      expect(String(error)).toContain('is archived');
    } finally {
      await writer.executeRaw(`DELETE FROM public.minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
      await writer.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]).catch(() => {});
      await writer.disconnect();
    }
  }, 30_000);

  test('provider lease blocks archive until egress settles and discards drained output', async () => {
    const sourceId = 'embedding-egress-lock-e2e';
    const embedder = new PostgresEngine();
    const archiver = new PostgresEngine();
    await embedder.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });
    const providerStarted = deferred();
    const releaseProvider = deferred();
    let submission: Promise<string> | null = null;
    let archive: ReturnType<typeof softDeleteSource> | null = null;

    try {
      await embedder.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]);
      await embedder.executeRaw(
        `INSERT INTO public.sources (id, name, config, archived)
         VALUES ($1, $1, '{}'::jsonb, false)`,
        [sourceId],
      );

      submission = withActiveEmbeddingSource(embedder, sourceId, async () => {
        providerStarted.resolve();
        await releaseProvider.promise;
        return 'submitted';
      });
      await providerStarted.promise;

      let archiveSettled = false;
      archive = softDeleteSource(archiver, sourceId)
        .finally(() => { archiveSettled = true; });
      await wait(100);
      expect(archiveSettled).toBe(false);

      releaseProvider.resolve();
      await expect(submission!).rejects.toBeInstanceOf(SourceEmbeddingLeaseLostError);
      expect(await archive).toMatchObject({ id: sourceId });
      const state = await archiver.executeRaw<{ archived: boolean }>(
        `SELECT archived FROM public.sources WHERE id = $1`,
        [sourceId],
      );
      expect(state).toEqual([{ archived: true }]);
    } finally {
      releaseProvider.resolve();
      await submission?.catch(() => {});
      await archive?.catch(() => {});
      await archiver.executeRaw(`DELETE FROM public.sources WHERE id = $1`, [sourceId]).catch(() => {});
      await embedder.disconnect();
      await archiver.disconnect();
    }
  }, 30_000);

  test('archived rows cannot escape through direct or page-owned source references', async () => {
    const sourceId = 'archived-rehome-e2e';
    const pageSlug = 'archive/rehome-e2e';
    const jobName = 'archive-rehome-e2e';
    const writer = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });

    const expectArchivedError = async (sql: string) => {
      let error: unknown;
      try {
        await writer.executeRaw(sql);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(String(error)).toContain('is archived');
    };

    try {
      await writer.executeRaw(
        `INSERT INTO sources (id, name, config, archived)
         VALUES ($1, $1, '{}'::jsonb, false)`,
        [sourceId],
      );
      await writer.executeRaw(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
         VALUES ($1, $2, 'note', 'Archive rehome', 'archive rehome')`,
        [sourceId, pageSlug],
      );
      await writer.executeRaw(
        `INSERT INTO content_chunks (page_id, chunk_index, chunk_text)
         SELECT id, 0, 'archive rehome chunk'
           FROM pages
          WHERE source_id = $1 AND slug = $2`,
        [sourceId, pageSlug],
      );
      await writer.executeRaw(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
         VALUES
           ('default', 'archive/rehome-e2e-from', 'note', 'From', 'from'),
           ('default', 'archive/rehome-e2e-to', 'note', 'To', 'to')`,
      );
      await writer.executeRaw(
        `INSERT INTO files
           (source_id, page_slug, page_id, filename, storage_path, content_hash)
         SELECT 'default', $2, id,
                'archive-rehome-e2e.txt', 'archive-rehome-e2e.txt', 'archive-rehome-e2e-hash'
           FROM pages
          WHERE source_id = $1 AND slug = $2`,
        [sourceId, pageSlug],
      );
      await writer.executeRaw(
        `INSERT INTO links
           (from_page_id, to_page_id, origin_page_id, link_type, link_source)
         SELECT from_page.id, to_page.id, origin_page.id, 'related', 'frontmatter'
           FROM pages from_page
           JOIN pages to_page
             ON to_page.source_id = 'default' AND to_page.slug = 'archive/rehome-e2e-to'
           JOIN pages origin_page
             ON origin_page.source_id = $1 AND origin_page.slug = $2
          WHERE from_page.source_id = 'default'
            AND from_page.slug = 'archive/rehome-e2e-from'`,
        [sourceId, pageSlug],
      );
      await writer.executeRaw(
        `INSERT INTO eval_candidates
           (tool_name, query, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
         VALUES ('query', 'archive rehome', ARRAY[$1], false, false, 1, false)`,
        [sourceId],
      );
      await writer.executeRaw(
        `INSERT INTO minion_jobs (name, data)
         VALUES ($1, jsonb_build_object('sourceId', $2::text))`,
        [jobName, sourceId],
      );
      expect(await softDeleteSource(writer, sourceId)).toMatchObject({ id: sourceId });

      await expectArchivedError(
        `UPDATE pages SET source_id = 'default'
          WHERE source_id = '${sourceId}' AND slug = '${pageSlug}'`,
      );
      await expectArchivedError(
        `UPDATE content_chunks SET chunk_text = 'blocked archived chunk mutation'
          WHERE page_id = (
            SELECT id FROM pages
             WHERE source_id = '${sourceId}' AND slug = '${pageSlug}'
          )`,
      );
      await expectArchivedError(
        `UPDATE eval_candidates SET source_ids = ARRAY['default']
          WHERE query = 'archive rehome'`,
      );
      await expectArchivedError(
        `UPDATE minion_jobs SET data = '{"sourceId":"default"}'::jsonb
          WHERE name = '${jobName}'`,
      );

      await writer.executeRaw(
        `UPDATE minion_jobs SET status = 'failed' WHERE name = $1`,
        [jobName],
      );
      await writer.executeRaw(
        `DELETE FROM pages WHERE source_id = $1 AND slug = $2`,
        [sourceId, pageSlug],
      );
      const nullableRefs = await writer.executeRaw<{
        file_page_id: number | null;
        link_origin_page_id: number | null;
      }>(
        `SELECT
           (SELECT page_id FROM files
             WHERE storage_path = 'archive-rehome-e2e.txt') AS file_page_id,
           (SELECT link.origin_page_id
              FROM links link
              JOIN pages from_page ON from_page.id = link.from_page_id
             WHERE from_page.source_id = 'default'
               AND from_page.slug = 'archive/rehome-e2e-from'
               AND link.link_source = 'frontmatter'
               AND link.link_type = 'related') AS link_origin_page_id`,
      );
      expect(nullableRefs).toEqual([{
        file_page_id: null,
        link_origin_page_id: null,
      }]);
    } finally {
      await writer.executeRaw(
        `UPDATE sources SET archived = false, archived_at = NULL WHERE id = $1`,
        [sourceId],
      ).catch(() => {});
      await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
      await writer.executeRaw(`DELETE FROM eval_candidates WHERE query = 'archive rehome'`).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM files WHERE storage_path = 'archive-rehome-e2e.txt'`,
      ).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM links link
          USING pages from_page
          WHERE link.from_page_id = from_page.id
            AND from_page.source_id = 'default'
            AND from_page.slug = 'archive/rehome-e2e-from'
            AND link.link_source = 'frontmatter'
            AND link.link_type = 'related'`,
      ).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM pages WHERE source_id = $1 AND slug = $2`,
        [sourceId, pageSlug],
      ).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM pages
          WHERE source_id = 'default'
            AND slug IN ('archive/rehome-e2e-from', 'archive/rehome-e2e-to')`,
      ).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await writer.disconnect();
    }
  }, 30_000);

  test('intermediate guards allow missing legacy sources but reject archived sources', async () => {
    const referenceGuard = MIGRATIONS.find((entry) => entry.version === 124);
    const jobGuard = MIGRATIONS.find((entry) => entry.version === 126);
    const continuationGuard = MIGRATIONS.find((entry) => entry.version === 127);
    const ownedRowGuard = MIGRATIONS.find((entry) => entry.version === 128);
    const compatibilityGuard = MIGRATIONS.find((entry) => entry.version === 129);
    const finalGuard = MIGRATIONS.find((entry) => entry.version === 130);
    const indirectGuard = MIGRATIONS.find((entry) => entry.version === 132);
    expect(referenceGuard?.sql).toBeDefined();
    expect(jobGuard?.sql).toBeDefined();
    expect(continuationGuard?.sql).toBeDefined();
    expect(ownedRowGuard?.sql).toBeDefined();
    expect(compatibilityGuard?.sql).toBeDefined();
    expect(finalGuard?.sql).toBeDefined();
    expect(indirectGuard?.sql).toBeDefined();

    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    const proveMissingWriterBlocksArchive = async (sourceId: string, jobName: string) => {
      const writerReady = deferred();
      const releaseWriter = deferred();
      let writerTx: Promise<void> | null = null;
      let archiveAttempt: ReturnType<typeof archiveHygieneCandidate> | null = null;

      try {
        writerTx = writer.transaction(async (tx) => {
          await tx.executeRaw(
            `INSERT INTO minion_jobs (name, status, data)
             VALUES ($1, 'waiting', jsonb_build_object('sourceId', $2::text))`,
            [jobName, sourceId],
          );
          writerReady.resolve();
          await releaseWriter.promise;
        });
        await writerReady.promise;

        await archiver.executeRaw(
          `INSERT INTO sources (id, name, local_path, config)
           VALUES ($1, $1, $2, '{}'::jsonb)`,
          [sourceId, `/tmp/gbrain-${sourceId}-missing`],
        );
        let archiveSettled = false;
        archiveAttempt = archiveHygieneCandidate(archiver, sourceId)
          .finally(() => { archiveSettled = true; });
        await wait(100);
        expect(archiveSettled).toBe(false);

        releaseWriter.resolve();
        await writerTx;
        const archive = await archiveAttempt;
        expect(archive.result).toBeNull();
        expect(archive.reason).toContain('nonterminal_source_work');
      } finally {
        releaseWriter.resolve();
        await writerTx?.catch(() => {});
        await archiveAttempt?.catch(() => {});
        await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
        await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      }
    };

    try {
      await writer.runMigration(124, referenceGuard!.sql!);
      await writer.executeRaw(
        `INSERT INTO sources (id, name, archived)
         VALUES ('v124-archived-e2e', 'v124-archived-e2e', true)`,
      );
      await writer.executeRaw(
        `INSERT INTO eval_candidates
           (tool_name, query, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
         VALUES ('query', 'v124 missing source e2e', ARRAY['v124-missing-e2e'], false, false, 1, false)`,
      );
      await writer.executeRaw(
        `INSERT INTO config (key, value) VALUES ('sources.default', 'v124-missing-e2e')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      await writer.runMigration(124, `
            DO $assert$
            BEGIN
              BEGIN
                INSERT INTO eval_candidates
                  (tool_name, query, source_ids, vector_enabled, expansion_applied, latency_ms, remote)
                VALUES ('query', 'v124 archived source e2e', ARRAY['v124-archived-e2e'], false, false, 1, false);
                RAISE EXCEPTION 'v124 accepted an archived source reference';
              EXCEPTION WHEN foreign_key_violation THEN
                IF SQLERRM NOT LIKE '%is archived%' THEN RAISE; END IF;
              END;

              BEGIN
                INSERT INTO config (key, value) VALUES ('sources.default', 'v124-archived-e2e')
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
                RAISE EXCEPTION 'v124 accepted an archived default source';
              EXCEPTION WHEN foreign_key_violation THEN
                IF SQLERRM NOT LIKE '%is archived%' THEN RAISE; END IF;
              END;
            END;
            $assert$;
      `);

      await writer.runMigration(126, jobGuard!.sql!);
      await writer.executeRaw(
        `INSERT INTO minion_jobs (name, data)
         VALUES ('v126-missing-source-e2e', '{"sourceId":"v126-missing-e2e"}'::jsonb)`,
      );
      await writer.runMigration(126, `
            DO $assert$
            BEGIN
              BEGIN
                INSERT INTO minion_jobs (name, data)
                VALUES ('v126-archived-source-e2e', '{"sourceId":"v124-archived-e2e"}'::jsonb);
                RAISE EXCEPTION 'v126 accepted an archived source reference';
              EXCEPTION WHEN foreign_key_violation THEN
                IF SQLERRM NOT LIKE '%is archived%' THEN RAISE; END IF;
              END;
            END;
            $assert$;
      `);

      await proveMissingWriterBlocksArchive(
        'v126-lock-missing-e2e',
        'v126-lock-missing-source-e2e',
      );

      await writer.runMigration(129, compatibilityGuard!.sql!);
      await writer.runMigration(129, `
            DO $assert$
            BEGIN
              BEGIN
                INSERT INTO minion_jobs (name, data)
                VALUES ('v129-archived-source-e2e', '{"sourceId":"v124-archived-e2e"}'::jsonb);
                RAISE EXCEPTION 'v129 accepted an archived source reference';
              EXCEPTION WHEN foreign_key_violation THEN
                IF SQLERRM NOT LIKE '%is archived%' THEN RAISE; END IF;
              END;
            END;
            $assert$;
      `);
      await proveMissingWriterBlocksArchive(
        'v129-lock-missing-e2e',
        'v129-lock-missing-source-e2e',
      );
    } finally {
      await writer.runMigration(127, continuationGuard!.sql!);
      await writer.runMigration(128, ownedRowGuard!.sql!);
      await writer.runMigration(130, finalGuard!.sql!);
      await writer.runMigration(132, indirectGuard!.sql!);
      await writer.executeRaw(
        `DELETE FROM minion_jobs
          WHERE name IN ('v126-missing-source-e2e', 'v126-lock-missing-source-e2e',
                         'v129-lock-missing-source-e2e')`,
      ).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM eval_candidates
          WHERE query IN ('v124 missing source e2e', 'v124 archived source e2e')`,
      ).catch(() => {});
      await writer.executeRaw(
        `DELETE FROM sources
          WHERE id IN ('v124-archived-e2e', 'v126-lock-missing-e2e', 'v129-lock-missing-e2e')`,
      ).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);

  test('writer already holding a source share lock commits before archive rereads and vetoes', async () => {
    const sourceId = 'archive-writer-first-e2e';
    const sourcePath = `/tmp/gbrain-${sourceId}-missing`;
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, sourcePath],
      );

      const writerReady = deferred();
      const releaseWriter = deferred();
      const writerTx = writer.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO minion_jobs (name, status, data)
           VALUES ('source-hygiene-e2e', 'waiting', jsonb_build_object('sourceId', $1::text))`,
          [sourceId],
        );
        writerReady.resolve();
        await releaseWriter.promise;
      });
      await writerReady.promise;

      let archiveSettled = false;
      const archiveAttempt = archiveHygieneCandidate(archiver, sourceId)
        .finally(() => { archiveSettled = true; });
      await wait(100);
      expect(archiveSettled).toBe(false);

      releaseWriter.resolve();
      await writerTx;
      const result = await archiveAttempt;
      expect(result.result).toBeNull();
      expect(result.reason).toContain('nonterminal_source_work');

      const rows = await writer.executeRaw<{ archived: boolean }>(
        `SELECT archived FROM sources WHERE id = $1`,
        [sourceId],
      );
      expect(rows[0]?.archived).toBe(false);
    } finally {
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);

  test('writer for a missing source blocks later registration plus archive until its reference is visible', async () => {
    const sourceId = 'archive-missing-writer-first-e2e';
    const jobName = 'source-hygiene-missing-source-e2e';
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    const writerReady = deferred();
    const releaseWriter = deferred();
    let writerTx: Promise<void> | null = null;
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]);
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);

      writerTx = writer.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO minion_jobs (name, status, data)
           VALUES ($1, 'waiting', jsonb_build_object('sourceId', $2::text))`,
          [jobName, sourceId],
        );
        writerReady.resolve();
        await releaseWriter.promise;
      });
      await writerReady.promise;

      await archiver.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, `/tmp/gbrain-${sourceId}-missing`],
      );

      let archiveSettled = false;
      const archiveAttempt = archiveHygieneCandidate(archiver, sourceId)
        .finally(() => { archiveSettled = true; });
      await wait(100);
      expect(archiveSettled).toBe(false);

      releaseWriter.resolve();
      await writerTx;
      const result = await archiveAttempt;
      expect(result.result).toBeNull();
      expect(result.reason).toContain('nonterminal_source_work');

      const rows = await writer.executeRaw<{ archived: boolean }>(
        `SELECT archived FROM sources WHERE id = $1`,
        [sourceId],
      );
      expect(rows[0]?.archived).toBe(false);
    } finally {
      releaseWriter.resolve();
      await writerTx?.catch(() => {});
      await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);

  test('writer for a missing source commits before explicit soft archive', async () => {
    const sourceId = 'archive-missing-writer-explicit-e2e';
    const jobName = 'source-hygiene-missing-source-explicit-e2e';
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    const writerReady = deferred();
    const releaseWriter = deferred();
    let writerTx: Promise<void> | null = null;
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]);
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);

      writerTx = writer.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO minion_jobs (name, status, data)
           VALUES ($1, 'waiting', jsonb_build_object('sourceId', $2::text))`,
          [jobName, sourceId],
        );
        writerReady.resolve();
        await releaseWriter.promise;
      });
      await writerReady.promise;

      await archiver.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, `/tmp/gbrain-${sourceId}-missing`],
      );

      let archiveSettled = false;
      const archiveAttempt = softDeleteSource(archiver, sourceId)
        .finally(() => { archiveSettled = true; });
      await wait(100);
      expect(archiveSettled).toBe(false);

      releaseWriter.resolve();
      await writerTx;
      const result = await archiveAttempt;
      expect(result?.id).toBe(sourceId);

      const rows = await writer.executeRaw<{ archived: boolean }>(
        `SELECT archived FROM sources WHERE id = $1`,
        [sourceId],
      );
      expect(rows[0]?.archived).toBe(true);
    } finally {
      releaseWriter.resolve();
      await writerTx?.catch(() => {});
      await writer.executeRaw(`DELETE FROM minion_jobs WHERE name = $1`, [jobName]).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);

  test('archive holding lifecycle and update locks makes a later path-routed sync job reject', async () => {
    const sourceId = 'archive-archiver-first-e2e';
    const sourcePath = `/tmp/gbrain-${sourceId}-missing`;
    const writer = postgres(process.env.DATABASE_URL!, { max: 1 });
    const archiver = postgres(process.env.DATABASE_URL!, { max: 1 });
    const drainEngine = new PostgresEngine();
    await drainEngine.connect({ database_url: process.env.DATABASE_URL! });
    const releaseArchive = deferred();
    let archiveTx: Promise<void> | null = null;

    try {
      await writer.unsafe(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await writer.unsafe(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, sourcePath],
      );
      const drain = await beginSourceArchiveDrain(drainEngine, sourceId);
      expect(drain).not.toBeNull();

      const archiveReady = deferred();
      archiveTx = archiver.begin(async (tx) => {
        await tx.unsafe(
          `SELECT pg_advisory_xact_lock(hashtextextended('gbrain:source-lifecycle', 0))`,
        );
        await tx.unsafe(
          `SELECT id FROM sources WHERE id = $1 AND archived = false FOR UPDATE`,
          [sourceId],
        );
        await tx.unsafe(
          `UPDATE sources
              SET archived = true, archived_at = now(),
                  archive_expires_at = now() + interval '72 hours',
                  embedding_drain_token = NULL
            WHERE id = $1
              AND embedding_drain_token = $2
              AND embedding_drain_epoch = $3`,
          [sourceId, drain!.token, drain!.epoch],
        );
        archiveReady.resolve();
        await releaseArchive.promise;
      });
      await archiveReady.promise;

      let writerSettled = false;
      const writerAttempt = writer.unsafe(
        `INSERT INTO minion_jobs (name, data)
         VALUES ('sync', jsonb_build_object('repoPath', $1::text))`,
        [sourcePath],
      ).finally(() => { writerSettled = true; });
      await wait(100);
      expect(writerSettled).toBe(false);

      releaseArchive.resolve();
      await archiveTx;
      let writerError: unknown;
      try {
        await writerAttempt;
      } catch (caught) {
        writerError = caught;
      }
      expect(writerError).toBeDefined();
      expect(String(writerError)).toContain('is archived');
      expect(writerSettled).toBe(true);
    } finally {
      releaseArchive.resolve();
      await archiveTx?.catch(() => {});
      await writer.unsafe(
        `DELETE FROM minion_jobs WHERE name = 'sync' AND data->>'repoPath' = $1`,
        [sourcePath],
      ).catch(() => {});
      await writer.unsafe(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([
        writer.end({ timeout: 2 }).catch(() => {}),
        archiver.end({ timeout: 2 }).catch(() => {}),
        drainEngine.disconnect().catch(() => {}),
      ]);
    }
  }, 30_000);

  test('live sync-lock acquisition commits before archive rereads and vetoes', async () => {
    const sourceId = 'archive-sync-lock-first-e2e';
    const lockId = `gbrain-sync:${sourceId}`;
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]);
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, `/tmp/gbrain-${sourceId}-missing`],
      );

      const lockReady = deferred();
      const releaseLockWriter = deferred();
      const lockTx = writer.transaction(async (tx) => {
        await tx.executeRaw(
          `INSERT INTO gbrain_cycle_locks
             (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
           VALUES ($1, 2001, 'fixture', now() + interval '5 minutes', now())`,
          [lockId],
        );
        lockReady.resolve();
        await releaseLockWriter.promise;
      });
      await lockReady.promise;

      let archiveSettled = false;
      const archiveAttempt = archiveHygieneCandidate(archiver, sourceId)
        .finally(() => { archiveSettled = true; });
      await wait(100);
      expect(archiveSettled).toBe(false);

      releaseLockWriter.resolve();
      await lockTx;
      const result = await archiveAttempt;
      expect(result.result).toBeNull();
      expect(result.reason).toContain('live_sync_lock');
    } finally {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);

  test('archive holding the update lock makes a later sync-lock refresh reject', async () => {
    const sourceId = 'archive-sync-refresh-later-e2e';
    const lockId = `gbrain-sync:${sourceId}`;
    const writer = new PostgresEngine();
    const archiver = new PostgresEngine();
    await writer.connect({ database_url: process.env.DATABASE_URL! });
    await archiver.connect({ database_url: process.env.DATABASE_URL! });

    try {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]);
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
      await writer.executeRaw(
        `INSERT INTO sources (id, name, local_path, config)
         VALUES ($1, $1, $2, '{}'::jsonb)`,
        [sourceId, `/tmp/gbrain-${sourceId}-missing`],
      );
      await writer.executeRaw(
        `INSERT INTO gbrain_cycle_locks
           (id, holder_pid, holder_host, ttl_expires_at, last_refreshed_at)
         VALUES ($1, 2002, 'fixture', now() - interval '5 minutes', now() - interval '5 minutes')`,
        [lockId],
      );
      const drain = await beginSourceArchiveDrain(archiver, sourceId);
      expect(drain).not.toBeNull();

      const archiveReady = deferred();
      const releaseArchive = deferred();
      const archiveTx = archiver.transaction(async (tx) => {
        await tx.executeRaw(
          `SELECT pg_advisory_xact_lock(
             hashtextextended('gbrain:source-lifecycle', 0)
           )`,
        );
        await tx.executeRaw(
          `SELECT id FROM sources WHERE id = $1 AND archived = false FOR UPDATE`,
          [sourceId],
        );
        await tx.executeRaw(
          `UPDATE sources
              SET archived = true, archived_at = now(),
                  archive_expires_at = now() + interval '72 hours',
                  embedding_drain_token = NULL
            WHERE id = $1
              AND embedding_drain_token = $2
              AND embedding_drain_epoch = $3`,
          [sourceId, drain!.token, drain!.epoch],
        );
        archiveReady.resolve();
        await releaseArchive.promise;
      });
      await archiveReady.promise;

      let refreshSettled = false;
      const refreshAttempt = writer.executeRaw(
        `UPDATE gbrain_cycle_locks
            SET ttl_expires_at = now() + interval '5 minutes', last_refreshed_at = now()
          WHERE id = $1`,
        [lockId],
      ).finally(() => { refreshSettled = true; });
      await wait(100);
      expect(refreshSettled).toBe(false);

      releaseArchive.resolve();
      await archiveTx;
      let refreshError: unknown;
      try {
        await refreshAttempt;
      } catch (caught) {
        refreshError = caught;
      }
      expect(refreshError).toBeDefined();
      expect(String(refreshError)).toContain('is archived');
    } finally {
      await writer.executeRaw(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]).catch(() => {});
      await writer.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]).catch(() => {});
      await Promise.all([writer.disconnect(), archiver.disconnect()]);
    }
  }, 30_000);
});
