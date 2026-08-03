/**
 * Stable hash used by Markdown-file imports for idempotency.
 *
 * This intentionally excludes only frontmatter fields that GBrain derives at
 * import time. Keep recovery verification on this exact function so a
 * source-scoped export is bound to the same source content identity that the
 * importer will later use to decide whether a page is unchanged.
 */

import { createHash } from 'crypto';
import type { ParsedMarkdown } from './markdown.ts';
import { QUARANTINE_KEY, CONTENT_FLAG_KEY } from './quarantine.ts';
import { EMBED_SKIP_KEY } from './embed-skip.ts';

const HASH_EPHEMERAL_FRONTMATTER_KEYS = [
  'captured_at',
  'ingested_at',
  QUARANTINE_KEY,
  CONTENT_FLAG_KEY,
  EMBED_SKIP_KEY,
];

export function hashParsedMarkdownForImport(
  parsed: Pick<ParsedMarkdown, 'title' | 'type' | 'compiled_truth' | 'timeline' | 'frontmatter' | 'tags'>,
): string {
  const stableFrontmatter: Record<string, unknown> = { ...parsed.frontmatter };
  for (const key of HASH_EPHEMERAL_FRONTMATTER_KEYS) {
    delete stableFrontmatter[key];
  }

  return createHash('sha256')
    .update(JSON.stringify({
      title: parsed.title,
      type: parsed.type,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: stableFrontmatter,
      tags: parsed.tags.sort(),
    }))
    .digest('hex');
}
