/**
 * Regression tests for failedJobsHint (src/core/source-health.ts).
 *
 * The defect this locks down: `failed_jobs_24h` counts BOTH the 'failed' and
 * 'dead' job statuses, but the operator hint hard-coded
 * `gbrain jobs list --status failed`, and `--status` accepts only ONE status.
 * On a brain whose failures were all 'dead' (retries exhausted), the warning
 * counted 166 jobs while the command it named printed "No jobs found" — so the
 * alarm read as a false positive and a five-minute sync death loop stayed
 * invisible for three days.
 *
 * The contract under test: the hint must never name a command that would
 * return none of the rows it just counted.
 */
import { describe, test, expect } from 'bun:test';
import { failedJobsHint } from '../src/core/source-health.ts';

const DEAD_CMD = '`gbrain jobs list --status dead`';
const FAILED_CMD = '`gbrain jobs list --status failed`';

describe('failedJobsHint', () => {
  test('dead-only: names --status dead, never only --status failed', () => {
    // Sawyer's real 2026-08-30 case: 166 counted, all of them dead.
    const hint = failedJobsHint({
      failed_jobs_24h: 166,
      dead_jobs_24h: 166,
      failed_only_jobs_24h: 0,
    });
    expect(hint).toContain(DEAD_CMD);
    expect(hint).toContain('166');
    // The exact bug: pointing the operator at an empty list.
    expect(hint).not.toContain(FAILED_CMD);
  });

  test('failed-only: names --status failed', () => {
    const hint = failedJobsHint({
      failed_jobs_24h: 7,
      dead_jobs_24h: 0,
      failed_only_jobs_24h: 7,
    });
    expect(hint).toContain(FAILED_CMD);
    expect(hint).not.toContain(DEAD_CMD);
  });

  test('mixed: names both, so neither half is hidden', () => {
    const hint = failedJobsHint({
      failed_jobs_24h: 10,
      dead_jobs_24h: 6,
      failed_only_jobs_24h: 4,
    });
    expect(hint).toContain(DEAD_CMD);
    expect(hint).toContain(FAILED_CMD);
    expect(hint).toContain('dead 6');
    expect(hint).toContain('failed 4');
  });

  test('split unavailable (legacy metric): names both rather than guessing', () => {
    // A pre-v0.11 brain returns no split. Naming one half would be a coin
    // flip, and a wrong guess is the original defect.
    const hint = failedJobsHint({
      failed_jobs_24h: 12,
      dead_jobs_24h: 0,
      failed_only_jobs_24h: 0,
    });
    expect(hint).toContain(DEAD_CMD);
    expect(hint).toContain(FAILED_CMD);
  });

  test('INVARIANT: the named command always covers a counted row', () => {
    // Property check across the whole shape space: for every split, at least
    // one status named in the hint must be a status that has rows.
    for (const dead of [0, 1, 5]) {
      for (const failed of [0, 1, 5]) {
        const total = dead + failed;
        if (total === 0) continue;
        const hint = failedJobsHint({
          failed_jobs_24h: total,
          dead_jobs_24h: dead,
          failed_only_jobs_24h: failed,
        });
        const namesDead = hint.includes(DEAD_CMD);
        const namesFailed = hint.includes(FAILED_CMD);
        const coversARealRow = (namesDead && dead > 0) || (namesFailed && failed > 0);
        expect(coversARealRow).toBe(true);
      }
    }
  });
});
