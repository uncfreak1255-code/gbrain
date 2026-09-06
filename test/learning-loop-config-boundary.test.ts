import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isProtectedOwnerControlKey } from '../src/commands/config.ts';
import {
  assertLearningLoopConfigMutationPermit,
  consumeLearningLoopConfigMutationPermit,
  createLearningLoopConfigMutationPermit,
  createLearningLoopLifecycleHolder,
  type BrainEngine,
} from '../src/core/engine.ts';

const root = resolve(import.meta.dir, '..');
const inventory = JSON.parse(readFileSync(resolve(import.meta.dir, 'fixtures/learning-loop-config-sql-inventory.json'), 'utf8')) as {
  schema_version: number;
  reserved_keys: string[];
  sites: Array<{ file: string; symbol: string; operation: string; namespace: string }>;
};

describe('Learning Loop config boundary inventory', () => {
  test('reserves both lifecycle keys and classifies every raw config mutation', () => {
    expect(inventory.schema_version).toBe(1);
    expect(inventory.reserved_keys).toEqual(['learning_loop.mode', 'learning_loop.mode_transition_intent_v1']);
    expect(inventory.sites.length).toBeGreaterThan(0);
    for (const site of inventory.sites) {
      expect(site.file.startsWith('src/')).toBe(true);
      expect(site.symbol.length).toBeGreaterThan(0);
      expect(['config_write', 'config_delete']).toContain(site.operation);
      expect(site.namespace).not.toContain('learning_loop');
    }
  });

  test('CLI owner guard covers exact keys but not unrelated config', () => {
    for (const key of inventory.reserved_keys) expect(isProtectedOwnerControlKey(key)).toBe(true);
    expect(isProtectedOwnerControlKey('learning_loop.corpus.codex.root')).toBe(false);
    expect(isProtectedOwnerControlKey('search.mode')).toBe(false);
  });

  test('raw inventory source paths exist and classify every listed symbol', () => {
    for (const file of new Set(inventory.sites.map(site => site.file))) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source.length).toBeGreaterThan(0);
      for (const site of inventory.sites.filter(entry => entry.file === file)) {
        const symbol = site.symbol.includes('.') ? site.symbol.slice(site.symbol.lastIndexOf('.') + 1) : site.symbol;
        expect(source.includes(symbol)).toBe(true);
        expect(site.namespace).not.toContain('learning_loop');
      }
    }
  });

  test('permits accept only the exact owner-created key, engine, operation, and old value', () => {
    const engine = {} as BrainEngine;
    const otherEngine = {} as BrainEngine;
    const holder = createLearningLoopLifecycleHolder();
    const permit = createLearningLoopConfigMutationPermit({
      key: 'learning_loop.mode', operation: 'set', engine, lifecycleHolder: holder, expectedOldValue: 'canary',
    });
    expect(() => assertLearningLoopConfigMutationPermit(permit, 'learning_loop.mode', 'set', engine)).not.toThrow();
    expect(() => assertLearningLoopConfigMutationPermit({ ...permit }, 'learning_loop.mode', 'set', engine)).toThrow();
    expect(() => assertLearningLoopConfigMutationPermit(permit, 'learning_loop.mode_transition_intent_v1', 'set', engine)).toThrow();
    expect(() => assertLearningLoopConfigMutationPermit(permit, 'learning_loop.mode', 'unset', engine)).toThrow();
    expect(() => assertLearningLoopConfigMutationPermit(permit, 'learning_loop.mode', 'set', otherEngine)).toThrow();
    expect(() => createLearningLoopConfigMutationPermit({
      key: 'learning_loop.mode', operation: 'set', engine, lifecycleHolder: {}, expectedOldValue: 'canary',
    })).toThrow();
    consumeLearningLoopConfigMutationPermit(permit);
    expect(() => assertLearningLoopConfigMutationPermit(permit, 'learning_loop.mode', 'set', engine)).toThrow();
  });

  test('generic CLI set/unset/prefix paths identify both reserved keys before mutation', () => {
    // test-reads-source-ok: pins each generic CLI mutation lane alongside runtime permit rejection tests.
    const cli = readFileSync(resolve(root, 'src/commands/config.ts'), 'utf8');
    expect(cli).toContain('isProtectedOwnerControlKey(key)');
    expect(cli).toContain('keys.find(isProtectedOwnerControlKey)');
    for (const key of inventory.reserved_keys) expect(cli).toContain(key);
  });
});
