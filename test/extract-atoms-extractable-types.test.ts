import { describe, expect, test } from 'bun:test';
import { unionExtractableTypes } from '../src/core/cycle/extract-atoms.ts';

const LEGACY = ['meeting', 'source', 'article', 'video', 'book', 'original'];

describe('unionExtractableTypes', () => {
  test('always retains the legacy extraction floor', () => {
    const result = unionExtractableTypes([]);
    for (const type of LEGACY) expect(result).toContain(type);
  });

  test('adds pack-declared extractable types', () => {
    const result = unionExtractableTypes(['note', 'writing']);
    expect(result).toContain('note');
    expect(result).toContain('writing');
  });

  test('excludes synthesis outputs even when the pack marks them extractable', () => {
    const result = unionExtractableTypes(['note', 'concept', 'atom']);
    expect(result).toContain('note');
    expect(result).not.toContain('concept');
    expect(result).not.toContain('atom');
  });

  test('deduplicates types already present in the legacy floor', () => {
    const result = unionExtractableTypes(['meeting', 'source']);
    expect(result.filter((type) => type === 'meeting')).toHaveLength(1);
  });
});
