/**
 * Tests for the recovery-required freshness dispatch block.
 *
 * Context: the `default` source produced 166 dead sync jobs in 24h — one roughly
 * every five minutes for three days — each dying on the same deterministic
 * "Invalid source-scoped recovery manifest" guard, which cannot resolve without
 * an operator re-export. These lock the block narrow: it must stop THAT storm
 * and nothing else, and it must never keep a source blocked after the condition
 * actually changes — including a successful in-process `gbrain sync` that
 * stamps `last_sync_at` without writing a newer `minion_jobs` row.
 */
import { describe, test, expect } from 'bun:test';
import {
  decideFreshnessDispatch,
  isRecoveryRequiredError,
} from '../src/core/source-recovery-block.ts';

// The real error text observed on 2026-08-30.
const REAL_ERROR =
  'Invalid source-scoped recovery manifest in /Users/sawbeck/.gstack-brain-worktree: ' +
  'source page count 617 does not match the trusted active source count 704. ' +
  'Recreate the checkout with `gbrain export --source <id> --dir <new-private-dir>` before syncing.';

describe('isRecoveryRequiredError', () => {
  test('matches the real guard message', () => {
    expect(isRecoveryRequiredError(REAL_ERROR)).toBe(true);
  });

  test('does not match unrelated failures that SHOULD retry', () => {
    for (const text of [
      'ECONNREFUSED connecting to postgres',
      'sync timed out after 300000ms',
      'fatal: could not read from remote repository',
      'Error: EACCES: permission denied',
      'embed provider returned 429',
    ]) {
      expect(isRecoveryRequiredError(text)).toBe(false);
    }
  });

  test('is safe on empty and non-string input', () => {
    expect(isRecoveryRequiredError(null)).toBe(false);
    expect(isRecoveryRequiredError(undefined)).toBe(false);
    expect(isRecoveryRequiredError('')).toBe(false);
  });
});

describe('decideFreshnessDispatch', () => {
  test('BLOCKS the storm: newest terminal job died on the recovery manifest', () => {
    const d = decideFreshnessDispatch({ status: 'dead', error: REAL_ERROR });
    expect(d.skip).toBe(true);
    expect(d.reason).toBe('recovery_required');
    expect(d.remedy).toContain('gbrain export --source');
  });

  test("blocks on 'failed' as well as 'dead' — both are terminal", () => {
    expect(decideFreshnessDispatch({ status: 'failed', error: REAL_ERROR }).skip).toBe(true);
  });

  test('a transient failure still retries — the block must not swallow it', () => {
    const d = decideFreshnessDispatch({ status: 'dead', error: 'sync timed out after 300000ms' });
    expect(d.skip).toBe(false);
    expect(d.reason).toBe(null);
  });

  test('RESUMES automatically: a later successful sync clears the block', () => {
    // After the operator re-exports and syncs, the newest terminal job is a
    // success. Nothing should have to be cleared by hand.
    const d = decideFreshnessDispatch({ status: 'completed', error: REAL_ERROR });
    expect(d.skip).toBe(false);
  });

  test('does not block while a job is still in flight', () => {
    for (const status of ['waiting', 'active', 'delayed', 'waiting-children']) {
      expect(decideFreshnessDispatch({ status, error: REAL_ERROR }).skip).toBe(false);
    }
  });

  test('a source with no job history is never blocked', () => {
    expect(decideFreshnessDispatch(null).skip).toBe(false);
    expect(decideFreshnessDispatch(undefined).skip).toBe(false);
  });

  test('a cancelled job carrying the signature blocks', () => {
    // Cancellation mid-flight can still record the guard's message; the
    // checkout is no less invalid for having been cancelled.
    expect(decideFreshnessDispatch({ status: 'cancelled', error: REAL_ERROR }).skip).toBe(true);
  });

  test('status casing does not change the verdict', () => {
    expect(decideFreshnessDispatch({ status: 'DEAD', error: REAL_ERROR }).skip).toBe(true);
    expect(decideFreshnessDispatch({ status: 'Completed', error: REAL_ERROR }).skip).toBe(false);
  });

  test('a terminal job with no error text does not block', () => {
    expect(decideFreshnessDispatch({ status: 'dead', error: null }).skip).toBe(false);
  });

  test('a later last_sync_at (hand gbrain sync) lifts the block', () => {
    // `gbrain sync` stamps last_sync_at and never writes a minion_jobs row.
    // After the age gate expires, the old dead recovery job is still newest
    // — without this compare, freshness stays wedged after the printed remedy.
    const d = decideFreshnessDispatch(
      {
        status: 'dead',
        error: REAL_ERROR,
        finishedAt: '2026-08-30T10:00:00.000Z',
      },
      '2026-08-30T11:00:00.000Z',
    );
    expect(d.skip).toBe(false);
    expect(d.reason).toBe(null);
  });

  test('an older last_sync_at does not lift the block', () => {
    // That stamp is the pre-failure sync, not proof the condition changed.
    const d = decideFreshnessDispatch(
      {
        status: 'dead',
        error: REAL_ERROR,
        finishedAt: '2026-08-30T11:00:00.000Z',
      },
      '2026-08-30T10:00:00.000Z',
    );
    expect(d.skip).toBe(true);
    expect(d.reason).toBe('recovery_required');
  });

  test('last_sync_at cannot lift when the blocking job has no timestamp', () => {
    expect(
      decideFreshnessDispatch(
        { status: 'dead', error: REAL_ERROR },
        '2026-08-30T11:00:00.000Z',
      ).skip,
    ).toBe(true);
  });

  test('Date last_sync_at later than Date finishedAt lifts the block', () => {
    expect(
      decideFreshnessDispatch(
        {
          status: 'dead',
          error: REAL_ERROR,
          finishedAt: new Date('2026-08-30T10:00:00.000Z'),
        },
        new Date('2026-08-30T11:00:00.000Z'),
      ).skip,
    ).toBe(false);
  });
});
