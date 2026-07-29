import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import {
  beginSourceArchiveDrain,
  cancelSourceArchiveDrain,
} from '../../src/core/source-embedding-lease.ts';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => { if (RUN) await setupDB(); });
afterAll(async () => { if (RUN) await teardownDB(); });

const fence = (claim: string) => `# Example

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | test |  |
<!--- gbrain:facts:end -->
`;

d('extract_facts atomic page reconciliation (Postgres)', () => {
  test('archive drain rejection preserves the previously committed page facts', async () => {
    const engine = getEngine();
    await engine.putPage('people/example', {
      title: 'Example',
      type: 'person',
      compiled_truth: fence('old fact'),
      frontmatter: {},
      timeline: '',
    });
    await runExtractFacts(engine, { slugs: ['people/example'] });
    await engine.putPage('people/example', {
      title: 'Example',
      type: 'person',
      compiled_truth: fence('replacement fact'),
      frontmatter: {},
      timeline: '',
    });

    const drain = await beginSourceArchiveDrain(engine, 'default');
    expect(drain).not.toBeNull();
    try {
      await expect(
        runExtractFacts(engine, { slugs: ['people/example'] }),
      ).rejects.toThrow(/archived or draining/);
    } finally {
      if (drain) await cancelSourceArchiveDrain(engine, drain);
    }

    const rows = await engine.executeRaw<{ fact: string }>(
      `SELECT fact FROM facts
        WHERE source_id = 'default'
          AND source_markdown_slug = 'people/example'`,
    );
    expect(rows).toEqual([{ fact: 'old fact' }]);
  });
});
