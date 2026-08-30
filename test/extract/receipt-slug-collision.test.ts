/**
 * Regression: an empty deadline/failure receipt must not overwrite a real one.
 *
 * `receiptSlug` keeps only the first 8 characters of the run id (`shortRunId`),
 * so a run id that LEADS with a kind label spends the window on a constant:
 *
 *   atoms-msxpnsow-defa  -> atoms-ms   (2 chars of entropy)
 *
 * Two atoms runs for one source on one day therefore rendered the identical
 * slug, and `writeReceipt` upserts — the later receipt overwrote the earlier.
 *
 * That was survivable while receipts were written only after atoms were
 * committed. It stopped being survivable when this change started writing
 * failure-only and deadline-only receipts: a drain's final batch routinely
 * hits the deadline after discovery and extracts nothing, so an EMPTY receipt
 * would erase the audit trail of the batches that actually wrote atoms.
 *
 * Fix: build the run id with the base36 millisecond stamp FIRST, so it fills
 * the whole 8-char window. The canonical D-EXTRACT-17 slug shape is unchanged,
 * and all rounds of one run still share a directory.
 */
import { describe, test, expect } from 'bun:test';
import { receiptSlug, shortRunId, buildExtractRunId } from '../../src/core/extract/receipt-writer.ts';

const AT = '2026-08-30T10:00:00.000Z';

/**
 * The PRODUCTION builder, not a local copy. extract-atoms.ts calls exactly
 * this, so reverting the fix makes these tests fail — a hand-rolled helper
 * here would pass against the bug and prove nothing.
 */
const atomsRunId = (t: number, source = 'default') =>
  buildExtractRunId('atoms', source, t);

/** The shape it built before the fix, kept so the bug stays described. */
const legacyRunId = (t: number, source = 'default') =>
  `atoms-${t.toString(36)}-${source.slice(0, 4)}`;

const slug = (runId: string, source = 'default') =>
  receiptSlug({
    kind: 'atoms',
    source_id: source,
    run_id: runId,
    round: 'single',
    extracted_at: AT,
    total_rows: 0,
  } as Parameters<typeof receiptSlug>[0]);

const T0 = 1787000000000;

describe('atoms receipt slug uniqueness', () => {
  test('the OLD run-id shape collided — this is the bug being fixed', () => {
    // Documents the defect so a future refactor that reintroduces a leading
    // label fails here rather than silently eating receipts.
    expect(shortRunId(legacyRunId(T0))).toBe(shortRunId(legacyRunId(T0 + 5 * 60 * 1000)));
  });

  test('two runs five minutes apart now get distinct slugs', () => {
    expect(slug(atomsRunId(T0))).not.toBe(slug(atomsRunId(T0 + 5 * 60 * 1000)));
  });

  test('an empty deadline receipt cannot overwrite an earlier real one', () => {
    // Production sequence: batch 1 extracts atoms, batch 2 hits the deadline
    // after discovery and extracts nothing.
    const real = slug(atomsRunId(T0));
    const emptyDeadline = slug(atomsRunId(T0 + 90 * 1000));
    expect(emptyDeadline).not.toBe(real);
  });

  test('runs one second apart are still distinct', () => {
    expect(slug(atomsRunId(T0))).not.toBe(slug(atomsRunId(T0 + 1000)));
  });

  test('the run id fills the whole 8-char window with entropy', () => {
    const short = shortRunId(atomsRunId(T0));
    expect(short.length).toBe(8);
    // No constant label inside the window.
    expect(short).not.toContain('atoms');
  });

  test('D-EXTRACT-17 shape is preserved', () => {
    expect(slug(atomsRunId(T0))).toMatch(
      /^extracts\/\d{4}-\d{2}-\d{2}\/atoms\/default\/[^/]{8}\/round-single$/,
    );
  });

  test('all rounds of one run still share the run_id_short directory', () => {
    const runId = atomsRunId(T0);
    const dir = (round: string) =>
      receiptSlug({
        kind: 'atoms', source_id: 'default', run_id: runId, round,
        extracted_at: AT, total_rows: 0,
      } as Parameters<typeof receiptSlug>[0]).split('/round-')[0];
    expect(dir('single')).toBe(dir('full'));
    expect(dir('trial')).toBe(dir('full'));
  });

  test('different sources never share a slug', () => {
    const t = T0;
    expect(slug(atomsRunId(t, 'default'), 'default'))
      .not.toBe(slug(atomsRunId(t, 'seascape-ops'), 'seascape-ops'));
  });
});
