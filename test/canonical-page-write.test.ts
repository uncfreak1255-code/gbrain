import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeCanonicalPage,
  withSourceWriteLease,
  inspectExpectedManagedState,
  assertLegacyPathMutationAllowed,
  writeSourceQualifiedCanonicalPage,
  writeCanonicalPathMutation,
  assertUnmanagedPathMutation,
  assertManagedPagesMutationAllowed,
  assertManagedSlugMutationAllowed,
  type CanonicalWriterMode,
  type SourceQualifiedCanonicalTarget,
  type SourceWriteLease,
} from '../src/core/canonical-page-write.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { learningLoopProtectedStateHash, renderLearningLoopFence, type LearningLoopKnowledge } from '../src/core/learning-loop-knowledge.ts';
import { parseFactsFence, renderFactsTable } from '../src/core/facts-fence.ts';

const managedFact = { rowNum: 1, claim: 'Managed', kind: 'preference' as const, confidence: 1, visibility: 'private' as const, notability: 'high' as const, active: true };
const facts = renderFactsTable([managedFact]);
const knowledge = (generation = 1): LearningLoopKnowledge => {
  const value: LearningLoopKnowledge = {
    brain_id: 'b', source_id: 's', canonical_slug: 'x',
    managed_rows: { generation: { claim: 'Managed', row_num: 1, active: true, generation } }, blocked_identities: [], correction_lineages: {},
    reversal_attempts: {}, immutable_commit_markers: [], pending_delivery: null,
  };
  return { ...value, protected_state_hash: learningLoopProtectedStateHash(value, parseFactsFence(facts).facts) };
};
const managedPage = (generation = 1) => `# X\n\n${facts}\n\n${renderLearningLoopFence(knowledge(generation))}\n`;

async function inRoot<T>(fn: (ctx: { base: string; root: string; target: SourceQualifiedCanonicalTarget; path: string; locks: string }) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), 'canonical-write-'));
  const root = join(base, 'root');
  mkdirSync(root);
  const target = { configured_root: root, canonical_slug: 'x', brain_id: 'b', source_id: 's' };
  try { return await fn({ base, root, target, path: join(root, 'x.md'), locks: join(base, 'locks') }); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

const sourceLock = async () => async () => {};

function boundaryEngine(roots: Array<{ id: string; local_path: string | null }>, managedBody = ''): BrainEngine {
  return {
    kind: 'pglite',
    db: { query: async (sql: string) => ({ rows: sql.includes('RETURNING id') ? [{ id: 'lock' }] : [] }) },
    executeRaw: async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id, local_path FROM sources')) return roots;
      if (sql.includes('SELECT DISTINCT source_id FROM pages')) {
        return managedBody ? [{ source_id: roots[0]?.id ?? 's' }] : [];
      }
      if (sql.includes('SELECT compiled_truth, timeline FROM pages')) {
        const sourceId = typeof params?.[1] === 'string' ? params[1] : undefined;
        if (sourceId && roots.length > 0 && !roots.some(root => root.id === sourceId)) return [];
        return managedBody ? [{ compiled_truth: managedBody, timeline: null }] : [];
      }
      return [];
    },
    getConfig: async () => null,
    learningLoopLedgerConfig: () => ({ engine: 'pglite', database_url: 'test-boundary' }),
  } as unknown as BrainEngine;
}

describe('canonical page write boundary', () => {
  for (const mode of ['ordinary_content', 'non_lineage_fact', 'checkout_rebuild'] as const satisfies readonly CanonicalWriterMode[]) {
    test(`${mode} preserves both protected fences byte-identically`, async () => inRoot(async ({ target, path, locks }) => {
      writeFileSync(path, managedPage());
      const out = await withSourceWriteLease(target, lease => writeCanonicalPage(target, '# Changed\n', { mode, lockRoot: locks, sourceLease: lease }), { sourceLock });
      expect(out).toStartWith('# Changed');
      expect(out).toContain(facts);
      expect(out).toContain(renderLearningLoopFence(knowledge()));
      expect(readFileSync(path, 'utf8')).toBe(out);
    }));
  }

  test('learning_transition remains closed until the lineage reducer owns permit creation', async () => inRoot(async ({ target, path, locks }) => {
    const next = knowledge(2);
    writeFileSync(path, managedPage(1));
    const replacement = `# Changed\n\n${facts}\n\n${renderLearningLoopFence(next)}\n`;
    await withSourceWriteLease(target, async lease => {
      await expect(writeCanonicalPage(target, replacement, { mode: 'learning_transition', lockRoot: locks, sourceLease: lease })).rejects.toThrow('transition permit required');
    }, { sourceLock });
    expect(readFileSync(path, 'utf8')).toBe(managedPage(1));
  }));

  test('non_lineage_fact rejects dropping a managed fact row', async () => inRoot(async ({ target, path, locks }) => {
    writeFileSync(path, managedPage());
    const dropped = `# X\n\n${renderFactsTable([{ ...managedFact, rowNum: 2, claim: 'Other' }])}\n`;
    await withSourceWriteLease(target, async lease => {
      await expect(writeCanonicalPage(target, dropped, {
        mode: 'non_lineage_fact', lockRoot: locks, sourceLease: lease, expectedManaged: 'expected',
      })).rejects.toThrow('managed fact row is absent');
    }, { sourceLock });
    expect(readFileSync(path, 'utf8')).toBe(managedPage());
  }));

  test('non_lineage_fact appends a facts fence without restoring the previous table', async () => inRoot(async ({ target, path, locks }) => {
    const first = `# X\n\n${facts}\n`;
    writeFileSync(path, first);
    const appendedFact = { ...managedFact, rowNum: 2, claim: 'Also this' };
    const nextFacts = renderFactsTable([managedFact, appendedFact]);
    const next = `# X\n\n${nextFacts}\n`;
    const out = await withSourceWriteLease(target, lease => writeCanonicalPage(target, next, {
      mode: 'non_lineage_fact', lockRoot: locks, sourceLease: lease, expectedManaged: false,
    }), { sourceLock });
    expect(out).toContain('Also this');
    expect(out).toContain('Managed');
    expect(readFileSync(path, 'utf8')).toBe(out);
  }));

  test('generic modes cannot introduce Learning Loop metadata', async () => inRoot(async ({ target, path, locks }) => {
    writeFileSync(path, '# Unmanaged\n');
    await withSourceWriteLease(target, async lease => {
      for (const mode of ['ordinary_content', 'non_lineage_fact', 'checkout_rebuild', 'learning_transition'] as const) {
        await expect(writeCanonicalPage(target, managedPage(), { mode, lockRoot: locks, sourceLease: lease })).rejects.toThrow('metadata creation requires');
      }
    }, { sourceLock });
    expect(readFileSync(path, 'utf8')).toBe('# Unmanaged\n');
  }));

  test('managed metadata identity must match the source-qualified target', async () => inRoot(async ({ target, path, locks }) => {
    writeFileSync(path, managedPage().replace('"source_id":"s"', '"source_id":"other"'));
    await withSourceWriteLease(target, async lease => {
      await expect(writeCanonicalPage(target, '# Changed\n', {
        mode: 'ordinary_content', lockRoot: locks, sourceLease: lease,
      })).rejects.toThrow('metadata target mismatch');
    }, { sourceLock });
  }));

  test('rejects changed, malformed, and duplicate protected fences', async () => inRoot(async ({ target, path, locks }) => {
    writeFileSync(path, managedPage());
    await withSourceWriteLease(target, async lease => {
      await expect(writeCanonicalPage(target, managedPage().replace('Managed', 'Changed'), { mode: 'ordinary_content', lockRoot: locks, sourceLease: lease })).rejects.toThrow('protected fence changed');
      await expect(writeCanonicalPage(target, `${managedPage()}\n${facts}\n`, { mode: 'ordinary_content', lockRoot: locks, sourceLease: lease })).rejects.toThrow('malformed or duplicate');
      await expect(writeCanonicalPage(target, managedPage().replace('<!-- gbrain:learning-loop:v1:end -->', ''), { mode: 'ordinary_content', lockRoot: locks, sourceLease: lease })).rejects.toThrow('malformed or duplicate');
    }, { sourceLock });
    expect(readFileSync(path, 'utf8')).toBe(managedPage());
  }));

  test('requires a live exact source lease and rejects forged, expired, and wrong-source leases', async () => inRoot(async ({ target, path, locks }) => {
    writeFileSync(path, '# X\n');
    let expired: SourceWriteLease | undefined;
    await withSourceWriteLease(target, async lease => {
      expired = lease;
      const forged = { ...lease } as SourceWriteLease;
      await expect(writeCanonicalPage(target, '# forged\n', { mode: 'ordinary_content', lockRoot: locks, sourceLease: forged })).rejects.toThrow('invalid or stale');
      await expect(writeCanonicalPage({ ...target, source_id: 'other' }, '# wrong\n', { mode: 'ordinary_content', lockRoot: locks, sourceLease: lease })).rejects.toThrow('invalid or stale');
    }, { sourceLock });
    await expect(writeCanonicalPage(target, '# expired\n', { mode: 'ordinary_content', lockRoot: locks, sourceLease: expired! })).rejects.toThrow('invalid or stale');
    expect(readFileSync(path, 'utf8')).toBe('# X\n');
  }));

  test('requires the source boundary callback', async () => inRoot(async ({ target }) => {
    await expect(withSourceWriteLease(target, async () => undefined, undefined as never)).rejects.toThrow();
  }));

  test('rejects configured-root inode replacement immediately before rename and cleans the temp file', async () => inRoot(async ({ base, root, target, path, locks }) => {
    writeFileSync(path, '# Original\n');
    const moved = join(base, 'moved-root');
    await expect(withSourceWriteLease(target, lease => writeCanonicalPage(target, '# Changed\n', {
      mode: 'ordinary_content', lockRoot: locks, sourceLease: lease,
      beforeRename: () => { renameSync(root, moved); mkdirSync(root); },
    }), { sourceLock })).rejects.toThrow('invalid or stale');
    expect(readFileSync(join(moved, 'x.md'), 'utf8')).toBe('# Original\n');
    expect(readdirSync(moved).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(join(root, 'x.md'))).toBe(false);
  }));

  test('expected-managed preflight fails closed when the fence is deleted at the barrier', async () => inRoot(async ({ target, path, locks }) => {
    writeFileSync(path, managedPage());
    await withSourceWriteLease(target, async lease => {
      const preflight = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      expect(preflight.managed).toBe(true);
      await expect(writeCanonicalPage(target, '# Changed\n', {
        mode: 'ordinary_content', lockRoot: locks, sourceLease: lease,
        expectedManaged: preflight.managed,
        beforeRename: () => writeFileSync(path, '# unmanaged replacement\n'),
      })).rejects.toThrow('expected managed state is absent');
    }, { sourceLock });
    expect(readFileSync(path, 'utf8')).toBe('# unmanaged replacement\n');
  }));

  test('binds protected state to managed rows and rejects a valid-looking tamper', async () => inRoot(async ({ target, path, locks }) => {
    const blocked = 'a'.repeat(64);
    const fact = { rowNum: 1, claim: 'Managed', kind: 'preference' as const, confidence: 1, visibility: 'private' as const, notability: 'high' as const, active: true };
    const state: LearningLoopKnowledge = {
      brain_id: target.brain_id, source_id: target.source_id, canonical_slug: target.canonical_slug,
      managed_rows: { [blocked]: { claim: 'Managed', row_num: 1, active: true } }, blocked_identities: [blocked],
      correction_lineages: {}, reversal_attempts: {}, immutable_commit_markers: [], pending_delivery: null,
    };
    const factsFence = renderFactsTable([fact]);
    const protected_state_hash = learningLoopProtectedStateHash(state, parseFactsFence(factsFence).facts);
    const page = `# X\n\n${factsFence}\n\n${renderLearningLoopFence({ ...state, protected_state_hash })}\n`;
    writeFileSync(path, page);
    await withSourceWriteLease(target, async lease => {
      expect(inspectExpectedManagedState(target, lease, { expected: 'expected' }).managed).toBe(true);
      const ordinary = await writeCanonicalPage(target, page.replace('# X', '# Changed'), { mode: 'ordinary_content', lockRoot: locks, sourceLease: lease, expectedManaged: 'expected' });
      expect(inspectExpectedManagedState(target, lease, { expected: 'expected' }).canonical).toBe(ordinary);
      writeFileSync(path, ordinary.replace('Managed', 'Changed'));
      expect(() => inspectExpectedManagedState(target, lease, { expected: 'expected' })).toThrow('protected state hash mismatch');
    }, { sourceLock });
  }));

  test('rejects traversal before consulting a lease', async () => inRoot(async ({ root, locks }) => {
    await expect(writeCanonicalPage({ configured_root: root, canonical_slug: '../escape', brain_id: 'b', source_id: 's' }, 'x', {
      mode: 'ordinary_content', lockRoot: locks, sourceLease: undefined as never,
    })).rejects.toThrow('invalid canonical target');
  }));
});

describe('source-qualified and standalone path lanes', () => {
  test('standalone lane rejects registered, overlapping, symlink-ambiguous, and unreadable roots', async () => {
    const base = mkdtempSync(join(tmpdir(), 'canonical-lanes-'));
    try {
      const root = join(base, 'root');
      const nested = join(root, 'nested');
      const outside = join(base, 'outside');
      mkdirSync(nested, { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(nested, 'x.md'), '# X\n');
      const engine = boundaryEngine([{ id: 'a', local_path: root }]);
      await expect(assertLegacyPathMutationAllowed({ engine, sourceId: '', slug: '' }, join(nested, 'x.md')))
        .rejects.toThrow('explicit unambiguous source identity');
      await expect(assertLegacyPathMutationAllowed({ engine, sourceId: '', slug: '' }, join(outside, 'x.md')))
        .resolves.toBeUndefined();

      const overlap = boundaryEngine([{ id: 'a', local_path: root }, { id: 'b', local_path: nested }]);
      await expect(assertLegacyPathMutationAllowed({ engine: overlap, sourceId: 'a', slug: 'nested/x' }, join(nested, 'x.md')))
        .rejects.toThrow('unambiguous source identity');

      const link = join(base, 'root-link');
      symlinkSync(root, link);
      await expect(assertLegacyPathMutationAllowed({ engine, sourceId: '', slug: '' }, join(link, 'nested/x.md')))
        .rejects.toThrow(/symlink-ambiguous|registered canonical path/);

      const unreadable = boundaryEngine([{ id: 'missing', local_path: join(base, 'missing') }]);
      await expect(assertLegacyPathMutationAllowed({ engine: unreadable, sourceId: '', slug: '' }, join(outside, 'x.md')))
        .rejects.toThrow('root is unreadable');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('source-qualified lane writes only the exact selected source and rejects missing expected-managed state', async () => {
    const base = mkdtempSync(join(tmpdir(), 'canonical-qualified-'));
    try {
      const a = join(base, 'a');
      const b = join(base, 'b');
      mkdirSync(a); mkdirSync(b);
      const roots = [{ id: 'a', local_path: a }, { id: 'b', local_path: b }];
      const engine = boundaryEngine(roots);
      const escaped = join(base, 'escaped');
      await expect(writeSourceQualifiedCanonicalPage({ engine, sourceId: 'a', slug: '../../escaped/new' }, '# no\n'))
        .rejects.toThrow('invalid canonical target');
      expect(existsSync(escaped)).toBe(false);
      await writeSourceQualifiedCanonicalPage({ engine, sourceId: 'a', slug: 'same' }, '# A\n');
      expect(readFileSync(join(a, 'same.md'), 'utf8')).toBe('# A\n');
      expect(existsSync(join(b, 'same.md'))).toBe(false);

      const expected = boundaryEngine(roots, renderLearningLoopFence({ ...knowledge(), source_id: 'a', canonical_slug: 'missing' }));
      await expect(writeSourceQualifiedCanonicalPage({ engine: expected, sourceId: 'a', slug: 'missing' }, '# no\n'))
        .rejects.toThrow('canonical page is missing');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('source-qualified lane keeps explicit not-managed expectation so planted managed state fails closed', async () => {
    const base = mkdtempSync(join(tmpdir(), 'canonical-not-managed-'));
    try {
      const a = join(base, 'a');
      mkdirSync(a);
      const plantedKnowledge: LearningLoopKnowledge = { ...knowledge(), source_id: 'a', canonical_slug: 'planted' };
      const plantedPage = `# Planted\n\n${facts}\n\n${renderLearningLoopFence({
        ...plantedKnowledge,
        protected_state_hash: learningLoopProtectedStateHash(plantedKnowledge, parseFactsFence(facts).facts),
      })}\n`;
      const planted = join(a, 'planted.md');
      writeFileSync(planted, plantedPage);
      const engine = boundaryEngine([{ id: 'a', local_path: a }]);
      await expect(writeSourceQualifiedCanonicalPage(
        { engine, sourceId: 'a', slug: 'planted', brainId: 'b' },
        '# no\n',
      )).rejects.toThrow('unexpected managed state');
      expect(readFileSync(planted, 'utf8')).toBe(plantedPage);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('unique registered source writes without an explicit source id', async () => {
    const base = mkdtempSync(join(tmpdir(), 'canonical-unique-source-'));
    try {
      const root = join(base, 'root');
      mkdirSync(root);
      const page = join(root, 'note.md');
      writeFileSync(page, '# Old\n');
      const engine = boundaryEngine([{ id: 'host', local_path: root }]);
      await writeCanonicalPathMutation(engine, page, '# New\n');
      expect(readFileSync(page, 'utf8')).toBe('# New\n');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  test('unscoped slug assert rejects a managed page on a non-default source', async () => inRoot(async ({ root, path }) => {
    writeFileSync(path, managedPage());
    const engine = boundaryEngine([{ id: 's', local_path: root }], managedPage());
    await expect(assertManagedSlugMutationAllowed(engine, 'x', undefined, 'destructive_admin', 'active'))
      .rejects.toThrow('managed canonical page mutation rejected');
  }));

  test('batched managed-page assert rejects one managed slug in a delete batch', async () => inRoot(async ({ root, path }) => {
    writeFileSync(path, managedPage());
    const engine = {
      kind: 'pglite',
      executeRaw: async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT id, local_path FROM sources')) return [{ id: 's', local_path: root }];
        if (sql.includes('SELECT slug, compiled_truth, timeline FROM pages')) {
          const slugs = Array.isArray(params?.[1]) ? params[1] as string[] : [];
          return slugs.includes('x') ? [{ slug: 'x', compiled_truth: managedPage(), timeline: null }] : [];
        }
        return [];
      },
      getConfig: async () => null,
      learningLoopLedgerConfig: () => ({ engine: 'pglite', database_url: 'test-batch-assert' }),
    } as unknown as BrainEngine;
    await expect(assertManagedPagesMutationAllowed(engine, ['other', 'x', 'also'], 's', 'destructive_admin'))
      .rejects.toThrow('managed canonical page mutation rejected');
  }));

  test('assertUnmanagedPathMutation rejects current or proposed managed content before any caller write', async () => inRoot(async ({ path }) => {
    writeFileSync(path, managedPage());
    expect(() => assertUnmanagedPathMutation(path)).toThrow('path-only writer cannot mutate managed');
    expect(readFileSync(path, 'utf8')).toBe(managedPage());

    writeFileSync(path, '# Unmanaged\n');
    expect(() => assertUnmanagedPathMutation(path, managedPage())).toThrow('path-only writer cannot mutate managed');
    expect(readFileSync(path, 'utf8')).toBe('# Unmanaged\n');

    expect(() => assertUnmanagedPathMutation(path, '# still unmanaged\n')).not.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('# Unmanaged\n');
  }));
});
