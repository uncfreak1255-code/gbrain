import { expect, spyOn, test } from 'bun:test';

import { runPages } from '../src/commands/pages.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  isSourceLifecyclePurgeConflict,
  PURGE_LIFECYCLE_FALLBACK_ATTEMPTS,
  purgeDeletedPagesSafely,
} from '../src/core/purge-deleted-pages.ts';

function buildEngine(calls: Array<{ hours: number; dryRun: boolean | undefined }>): BrainEngine {
  return {
    purgeDeletedPages: async (hours: number, opts?: { dryRun?: boolean }) => {
      calls.push({ hours, dryRun: opts?.dryRun });
      return {
        slugs: ['projects/healthy-tombstone'],
        count: 1,
        candidates: [{
          slug: 'projects/healthy-tombstone',
          source_id: 'healthy-source',
          deleted_at: new Date('2026-07-20T12:00:00.000Z'),
        }],
      };
    },
  } as unknown as BrainEngine;
}

test('purge-deleted JSON dry-run delegates to the current candidate query without deleting', async () => {
  const calls: Array<{ hours: number; dryRun: boolean | undefined }> = [];
  const engine = buildEngine(calls);
  const lines: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation((line?: unknown) => {
    lines.push(String(line));
  });

  try {
    await runPages(engine, ['purge-deleted', '--older-than', '3d', '--dry-run', '--json']);
  } finally {
    logSpy.mockRestore();
  }

  expect(calls).toEqual([{ hours: 72, dryRun: true }]);
  expect(JSON.parse(lines.join('\n'))).toEqual({
    dry_run: true,
    candidate_scope: 'current_aged_candidates_excluding_draining_owners',
    dry_run_candidate_limit: 10000,
    candidate_result_truncated: false,
    live_sweep_candidate_limit: 1000,
    lifecycle_fallback_attempt_limit: 64,
    lifecycle_protected_cascades_may_be_skipped: true,
    older_than_hours: 72,
    count: 1,
    slugs: ['projects/healthy-tombstone'],
  });
});

test('purge-deleted human dry-run preserves deletion timestamps', async () => {
  const calls: Array<{ hours: number; dryRun: boolean | undefined }> = [];
  const engine = buildEngine(calls);
  const lines: string[] = [];
  const logSpy = spyOn(console, 'log').mockImplementation((line?: unknown) => {
    lines.push(String(line));
  });

  try {
    await runPages(engine, ['purge-deleted', '--older-than', '72h', '--dry-run']);
  } finally {
    logSpy.mockRestore();
  }

  expect(calls).toEqual([{ hours: 72, dryRun: true }]);
  expect(lines).toEqual([
    '(dry-run) Found 1 current aged candidate(s) with non-draining owners, soft-deleted more than 72h ago.',
    'Live cleanup runs in sweeps of at most 1000; lifecycle-protected cascades may be retained.',
    '  projects/healthy-tombstone  deleted_at=2026-07-20T12:00:00.000Z',
  ]);
});

test('purge conflict classifier accepts only anchored lifecycle guard errors', () => {
  for (const message of [
    'Cannot delete from links: page source source-b is draining',
    'Cannot delete from code_edges_chunk: source source-b is draining',
    'Cannot write files: source source-b is archived or draining',
    'Cannot write links: page source source-b is archived or draining',
  ]) {
    expect(isSourceLifecyclePurgeConflict({ code: '23503', message })).toBe(true);
  }
  expect(isSourceLifecyclePurgeConflict({
    code: '23503',
    message: 'insert or update on table violates foreign key constraint',
  })).toBe(false);
  expect(isSourceLifecyclePurgeConflict({
    code: '99999',
    message: 'Cannot delete from links: page source source-b is draining',
  })).toBe(false);
});

test('non-lifecycle 23503 rolls back prior split progress and aborts the purge', async () => {
  const genericFkError = Object.assign(
    new Error('insert or update on table violates foreign key constraint'),
    { code: '23503' },
  );
  const lifecycleError = Object.assign(
    new Error('Cannot write files: source draining-source is archived or draining'),
    { code: '23503' },
  );
  const commands: string[] = [];
  const stagedDeletes = new Set<number>();
  const transactionEngine = {
    savepoint: async <T>(name: string, fn: (engine: BrainEngine) => Promise<T>) => {
      commands.push(`SAVEPOINT ${name}`);
      const snapshot = new Set(stagedDeletes);
      try {
        return await fn(transactionEngine as unknown as BrainEngine);
      } catch (error) {
        stagedDeletes.clear();
        for (const id of snapshot) stagedDeletes.add(id);
        commands.push(`ROLLBACK ${name}`);
        throw error;
      }
    },
    executeRaw: async (sql: string, params?: unknown[]) => {
      const normalized = sql.trim().split(/\s+/).join(' ');
      commands.push(normalized.split(' ').slice(0, 3).join(' '));
      if (sql.includes('SELECT candidate.id')) {
        return [1, 2, 3].map((id) => ({
          id,
          slug: `projects/purge-${id}`,
          source_id: 'default',
          deleted_at: new Date('2026-07-20T12:00:00.000Z'),
        }));
      }
      if (sql.includes('DELETE FROM pages')) {
        const ids = params?.[0] as number[];
        if (ids.includes(2)) throw lifecycleError;
        if (ids.includes(3)) throw genericFkError;
        for (const id of ids) stagedDeletes.add(id);
        return ids.map((id) => ({ id }));
      }
      return [];
    },
  } as unknown as BrainEngine;
  const engine = {
    transaction: async <T>(fn: (tx: BrainEngine) => Promise<T>) => {
      const before = new Set(stagedDeletes);
      try {
        return await fn(transactionEngine);
      } catch (error) {
        stagedDeletes.clear();
        for (const id of before) stagedDeletes.add(id);
        throw error;
      }
    },
  } as unknown as BrainEngine;

  await expect(purgeDeletedPagesSafely(engine, 72)).rejects.toBe(genericFkError);
  expect(stagedDeletes.size).toBe(0);
  expect(commands.filter((command) => command.startsWith('SAVEPOINT')).length).toBeGreaterThan(3);
  expect(commands.some((command) => command.startsWith('ROLLBACK'))).toBe(true);
});

test('unexpected lifecycle fallback has a hard attempt ceiling', async () => {
  const lifecycleError = Object.assign(
    new Error('Cannot delete from future_guarded_table: source future-source is draining'),
    { code: '23503' },
  );
  const candidateCount = 10_000;
  let attempts = 0;
  const transactionEngine = {
    savepoint: async <T>(_name: string, fn: (engine: BrainEngine) => Promise<T>) => {
      attempts += 1;
      return fn(transactionEngine as unknown as BrainEngine);
    },
    executeRaw: async (sql: string) => {
      if (sql.includes('SELECT candidate.id')) {
        return Array.from({ length: candidateCount }, (_, index) => ({
          id: index + 1,
          slug: `projects/purge-${String(index + 1).padStart(5, '0')}`,
          source_id: 'default',
          deleted_at: new Date('2026-07-20T12:00:00.000Z'),
        }));
      }
      if (sql.includes('DELETE FROM pages')) throw lifecycleError;
      return [];
    },
  } as unknown as BrainEngine;
  const engine = {
    transaction: async <T>(fn: (tx: BrainEngine) => Promise<T>) => fn(transactionEngine),
  } as unknown as BrainEngine;

  expect(await purgeDeletedPagesSafely(engine, 72)).toEqual({ slugs: [], count: 0 });
  expect(attempts).toBe(PURGE_LIFECYCLE_FALLBACK_ATTEMPTS);
});

test('dry-run candidate preview preserves the historical 10,000-row read ceiling', async () => {
  const rowCount = 10_001;
  const engine = {
    executeRaw: async () => Array.from({ length: rowCount }, (_, index) => ({
      id: index + 1,
      slug: `projects/preview-${String(index + 1).padStart(5, '0')}`,
      source_id: 'default',
      deleted_at: new Date('2026-07-20T12:00:00.000Z'),
    })),
  } as unknown as BrainEngine;

  const result = await purgeDeletedPagesSafely(engine, 72, { dryRun: true });
  expect(result.count).toBe(10_000);
  expect(result.slugs).toHaveLength(10_000);
  expect(result.candidates).toHaveLength(10_000);
  expect(result.truncated).toBe(true);
  expect(result.candidate_limit).toBe(10_000);
});
