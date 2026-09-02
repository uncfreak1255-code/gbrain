import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
import {
  inspectExpectedManagedState,
  withSourceWriteLease,
  type PageDbMutationPermit,
  type SourceQualifiedCanonicalTarget,
  type SourceWriteLease,
} from '../src/core/canonical-page-write.ts';
import { renderLearningLoopFence, type LearningLoopKnowledge } from '../src/core/learning-loop-knowledge.ts';

const slug = 'topics/managed-import';
let engine: PGLiteEngine;
let root: string;
let target: SourceQualifiedCanonicalTarget;
let content: string;

function knowledge(): LearningLoopKnowledge {
  return {
    brain_id: 'host', source_id: 'default', canonical_slug: slug,
    managed_rows: {}, blocked_identities: [], correction_lineages: {},
    reversal_attempts: {}, immutable_commit_markers: [], pending_delivery: null,
  };
}

async function pageSnapshot(): Promise<string> {
  const rows = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]);
  return JSON.stringify(rows, (_key, value) => value instanceof Date ? value.toISOString() : value);
}

const noOpSourceLock = async () => async () => {};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ type: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); }, 60_000);
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

beforeEach(async () => {
  await engine.executeRaw('UPDATE sources SET local_path = NULL WHERE id = $1', ['default']);
  await engine.executeRaw('DELETE FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]);
  await engine.putPage(slug, { type: 'concept', title: 'Before', compiled_truth: 'Before' }, { sourceId: 'default' });
  root = mkdtempSync(join(tmpdir(), 'managed-import-'));
  mkdirSync(join(root, 'topics'));
  target = { brain_id: 'host', source_id: 'default', canonical_slug: slug, configured_root: root };
  content = `---\ntype: concept\ntitle: Managed Import\nslug: ${slug}\n---\n\n# Managed Import\n\nCanonical body.\n\n${renderLearningLoopFence(knowledge())}\n`;
  writeFileSync(join(root, `${slug}.md`), content);
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [root, 'default']);
});

describe('managed canonical import permits', () => {
  test('imports only exact canonical readback under a live lease', async () => {
    await withSourceWriteLease(target, async lease => {
      const inspected = inspectExpectedManagedState(target, lease, { expected: 'expected' });
      const result = await importFromContent(engine, slug, content, {
        sourceId: 'default', noEmbed: true,
        canonicalPermit: inspected.permit, canonicalReadback: inspected.canonical,
      });
      expect(result.status).toBe('imported');
    }, { sourceLock: noOpSourceLock });
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.title).toBe('Managed Import');
  });

  test('file import acquires the source boundary and reconciles exact managed bytes', async () => {
    const result = await importFromFile(
      engine,
      join(root, `${slug}.md`),
      `${slug}.md`,
      { sourceId: 'default', noEmbed: true, inferFrontmatter: false },
    );
    expect(result.status).toBe('imported');
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.title).toBe('Managed Import');
  });

  test('changed submitted bytes reject before the page row changes', async () => {
    const before = await pageSnapshot();
    await withSourceWriteLease(target, async lease => {
      const inspected = inspectExpectedManagedState(target, lease, { expected: true });
      await expect(importFromContent(engine, slug, `${content}\nchanged`, {
        sourceId: 'default', noEmbed: true,
        canonicalPermit: inspected.permit, canonicalReadback: inspected.canonical,
      })).rejects.toThrow('not exact canonical readback');
    }, { sourceLock: noOpSourceLock });
    expect(await pageSnapshot()).toBe(before);
  });

  test('forged, wrong-target, expired, and hash-drift permits reject without row mutation', async () => {
    const before = await pageSnapshot();
    let expired: PageDbMutationPermit | undefined;
    await withSourceWriteLease(target, async lease => {
      const inspected = inspectExpectedManagedState(target, lease, { expected: true });
      expired = inspected.permit;
      const forged = { ...inspected.permit } as PageDbMutationPermit;
      await expect(engine.putPage(slug, { type: 'concept', title: 'Forged', compiled_truth: 'Forged' }, {
        sourceId: 'default', canonicalPermit: forged,
      })).rejects.toThrow('invalid page DB mutation permit');

      const wrongTarget = { ...target, canonical_slug: 'topics/other' };
      const wrongPermit = inspectExpectedManagedState(target, lease, { expected: true }).permit;
      await expect(engine.putPage(wrongTarget.canonical_slug, { type: 'concept', title: 'Wrong', compiled_truth: 'Wrong' }, {
        sourceId: 'default', canonicalPermit: wrongPermit,
      })).rejects.toThrow();

      writeFileSync(join(root, `${slug}.md`), `${content}\nexternal drift`);
      await expect(engine.putPage(slug, { type: 'concept', title: 'Drift', compiled_truth: 'Drift' }, {
        sourceId: 'default', canonicalPermit: inspected.permit,
      })).rejects.toThrow('canonical permit hash mismatch');
    }, { sourceLock: noOpSourceLock });

    writeFileSync(join(root, `${slug}.md`), content);
    await expect(engine.putPage(slug, { type: 'concept', title: 'Expired', compiled_truth: 'Expired' }, {
      sourceId: 'default', canonicalPermit: expired,
    })).rejects.toThrow('stale page DB mutation permit');
    expect(await pageSnapshot()).toBe(before);
  });

  test('wrong-brain permit rejects against canonical metadata identity', async () => {
    const before = await pageSnapshot();
    const wrongBrain: SourceQualifiedCanonicalTarget = { ...target, brain_id: 'other' };
    await withSourceWriteLease(wrongBrain, async (lease: SourceWriteLease) => {
      expect(() => inspectExpectedManagedState(wrongBrain, lease, { expected: true })).toThrow('metadata target mismatch');
    }, { sourceLock: noOpSourceLock });
    expect(await pageSnapshot()).toBe(before);
  });

  test('a managed row hint prevents deleted-fence downgrade at the engine sink', async () => {
    await withSourceWriteLease(target, async lease => {
      const inspected = inspectExpectedManagedState(target, lease, { expected: true });
      await importFromContent(engine, slug, inspected.canonical, {
        sourceId: 'default', noEmbed: true,
        canonicalPermit: inspected.permit, canonicalReadback: inspected.canonical,
      });
    }, { sourceLock: noOpSourceLock });
    const before = await pageSnapshot();
    writeFileSync(join(root, `${slug}.md`), '# Fence removed\n');

    await expect(engine.putPage(slug, {
      type: 'concept', title: 'Bypass', compiled_truth: 'Bypass',
    }, { sourceId: 'default' })).rejects.toThrow('expected managed state is absent');
    expect(await pageSnapshot()).toBe(before);
  });

  test('file import cannot downgrade a managed row after the canonical fence is removed', async () => {
    await importFromFile(engine, join(root, `${slug}.md`), `${slug}.md`, {
      sourceId: 'default', noEmbed: true, inferFrontmatter: false,
    });
    const before = await pageSnapshot();
    writeFileSync(join(root, `${slug}.md`), `---\ntitle: Downgrade\nslug: ${slug}\n---\n\nNo fence.\n`);

    await expect(importFromFile(engine, join(root, `${slug}.md`), `${slug}.md`, {
      sourceId: 'default', noEmbed: true, inferFrontmatter: false,
    })).rejects.toThrow('expected managed state is absent');
    expect(await pageSnapshot()).toBe(before);
  });
});
