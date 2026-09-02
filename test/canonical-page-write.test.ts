import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeCanonicalPage,
  withSourceWriteLease,
  inspectExpectedManagedState,
  type CanonicalWriterMode,
  type SourceQualifiedCanonicalTarget,
  type SourceWriteLease,
} from '../src/core/canonical-page-write.ts';
import { renderLearningLoopFence, type LearningLoopKnowledge } from '../src/core/learning-loop-knowledge.ts';

const facts = '<!--- gbrain:facts:begin -->\n| Fact | Value |\n|---|---|\n| Managed | yes |\n<!--- gbrain:facts:end -->';
const knowledge = (generation = 1): LearningLoopKnowledge => ({
  brain_id: 'b', source_id: 's', canonical_slug: 'x',
  managed_rows: { generation }, blocked_identities: [], correction_lineages: {},
  reversal_attempts: {}, immutable_commit_markers: [], pending_delivery: null,
});
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
      await expect(writeCanonicalPage(target, managedPage().replace('Managed | yes', 'Managed | no'), { mode: 'ordinary_content', lockRoot: locks, sourceLease: lease })).rejects.toThrow('protected fence changed');
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

  test('rejects traversal before consulting a lease', async () => inRoot(async ({ root, locks }) => {
    await expect(writeCanonicalPage({ configured_root: root, canonical_slug: '../escape', brain_id: 'b', source_id: 's' }, 'x', {
      mode: 'ordinary_content', lockRoot: locks, sourceLease: undefined as never,
    })).rejects.toThrow('invalid canonical target');
  }));
});
