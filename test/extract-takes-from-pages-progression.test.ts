import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';

let engine: PGLiteEngine;

function setClassifierResponse(text: string): void {
  __setChatTransportForTests(async () => ({
    text,
    blocks: [{ type: 'text' as const, text }],
    stopReason: 'end' as const,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5-20251001',
    providerId: 'anthropic',
  }));
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  configureGateway({
    chat_model: 'anthropic:claude-haiku-4-5-20251001',
    env: { ANTHROPIC_API_KEY: 'test-key' },
  });
  setClassifierResponse('[{"claim":"a stubbed claim","kind":"take","weight":0.7}]');

  const body = 'An opinion-bearing body long enough to clear the 200-char eligibility floor. '.repeat(5);
  await engine.putPage('concepts/progression-a', {
    type: 'concept', title: 'A', compiled_truth: body, frontmatter: {},
  });
  await engine.putPage('concepts/progression-b', {
    type: 'concept', title: 'B', compiled_truth: body, frontmatter: {},
  });
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

describe('extractTakesFromPages — bootstrap progression', () => {
  test('first run covers the eligible pages', async () => {
    const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(result.pages_scanned).toBe(2);
    expect(result.claims_extracted).toBe(2);
  });

  test('second run skips covered pages', async () => {
    const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(result.pages_scanned).toBe(0);
    expect(result.claims_extracted).toBe(0);
  });

  test('a page added after the first run is picked up', async () => {
    const body = 'Another opinion-bearing body long enough to clear the eligibility floor. '.repeat(5);
    await engine.putPage('concepts/progression-c', {
      type: 'concept', title: 'C', compiled_truth: body, frontmatter: {},
    });
    const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(result.pages_scanned).toBe(1);
  });

  test('a valid no-claim page is marked complete and content changes retry it', async () => {
    const body = 'Narrative-only material with no gradeable claims, long enough for classification. '.repeat(5);
    await engine.putPage('concepts/progression-no-claims', {
      type: 'concept', title: 'No claims', compiled_truth: body, frontmatter: {},
    });
    setClassifierResponse('[]');

    const first = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(first.pages_scanned).toBe(1);
    expect(first.claims_extracted).toBe(0);

    const second = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(second.pages_scanned).toBe(0);

    await engine.putPage('concepts/progression-no-claims', {
      type: 'concept', title: 'No claims', compiled_truth: `${body} Changed.`, frontmatter: {},
    });
    const afterChange = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(afterChange.pages_scanned).toBe(1);
    const afterRemark = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(afterRemark.pages_scanned).toBe(0);
  });

  test('a malformed non-empty claim array stays eligible for retry', async () => {
    const body = 'Another classification candidate long enough to clear the eligibility floor. '.repeat(5);
    await engine.putPage('concepts/progression-malformed', {
      type: 'concept', title: 'Malformed result', compiled_truth: body, frontmatter: {},
    });
    setClassifierResponse('[{"claim":"real claim","kind":"opinion","weight":0.5}]');

    const malformed = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(malformed.pages_scanned).toBe(1);
    expect(malformed.claims_extracted).toBe(0);
    const row = await engine.getPage('concepts/progression-malformed');
    const marker = await engine.executeRaw<{ takes_extracted_content_hash: string | null }>(
      `SELECT takes_extracted_content_hash FROM pages WHERE id = $1`,
      [row!.id],
    );
    expect(marker[0].takes_extracted_content_hash).toBeNull();

    setClassifierResponse('[]');
    const retry = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(retry.pages_scanned).toBe(1);
    const covered = await extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 50 });
    expect(covered.pages_scanned).toBe(0);
  });

  test('includeCovered restores refresh semantics', async () => {
    const result = await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      maxPages: 50,
      includeCovered: true,
    });
    expect(result.pages_scanned).toBe(5);
  });
});
