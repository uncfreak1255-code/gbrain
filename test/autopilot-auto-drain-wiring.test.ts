/**
 * #1685 GAP D — autopilot auto-drain wiring regression guards.
 *
 * The submission is inline in the autopilot tick body, so these are
 * source-shape assertions (the proven `autopilot-*-wiring.test.ts` pattern).
 * The load-bearing one is CODEX #2: the idempotency key MUST carry a time slot,
 * else queue.add returns the first completed job forever and the source never
 * drains again.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(import.meta.dir, '../src/commands/autopilot.ts'), 'utf8');
const DRAIN_SUBMIT = SRC.indexOf("'extract-atoms-drain',");
const DRAIN_BLOCK = DRAIN_SUBMIT >= 0 ? SRC.slice(DRAIN_SUBMIT, DRAIN_SUBMIT + 1800) : '';

describe('autopilot auto-drain wiring', () => {
  test('CODEX #2: idempotency key includes a UTC-day time slot (not static)', () => {
    expect(SRC).toContain('autopilot-extract-atoms-drain:${src.id}:${utcDay}');
    // A static key would be the regression — guard against the bare form.
    expect(SRC).not.toContain('`autopilot-extract-atoms-drain:${src.id}`');
  });

  test('CODEX #1: submits with allowProtectedSubmit', () => {
    expect(DRAIN_SUBMIT).toBeGreaterThanOrEqual(0);
    expect(DRAIN_BLOCK).toContain('allowProtectedSubmit: true');
  });

  test('CODEX #3: enumerates sources and counts backlog per source', () => {
    expect(SRC).toContain('loadAllSources(engine)');
    expect(SRC).toContain('countExtractAtomsBacklog(engine, src.id)');
  });

  test('rechecks trusted-local source hygiene before protected submission', () => {
    expect(SRC).toContain('inspectSourceHygiene(engine');
    expect(SRC).toContain('gateProtectedSourceWork(sourceHygiene, src.id)');
    expect(SRC).toMatch(/if \(!sourceGate\.allowed\)[\s\S]{0,1600}queue\.add/);
  });

  test('gates on pack NOT declaring extract_atoms (the silent-backlog condition)', () => {
    expect(SRC).toContain("packDeclaresPhase(engine, 'extract_atoms')");
  });

  test('gates on the enabled flag and a daily spend cap (DECISION 3C)', () => {
    expect(SRC).toContain('autopilot.auto_drain.enabled');
    expect(SRC).toContain('autopilot.auto_drain.max_usd_per_day');
    expect(SRC).toContain('maxJobsToday');
  });

  test('is Postgres-gated (PGLite has no worker surface)', () => {
    expect(SRC).toMatch(/engine\.kind === 'postgres'[\s\S]{0,400}auto_drain/);
  });

  test('CODEX impl #4: no maxWaiting (it coalesces by name+queue, not source)', () => {
    // maxWaiting would return source A's waiting job for source B's submit,
    // never queuing B and over-counting the cap. The per-source idempotency key
    // is the dedup; a pre-check on it avoids counting idempotency-hit re-submits.
    expect(DRAIN_SUBMIT).toBeGreaterThanOrEqual(0);
    expect(DRAIN_BLOCK).not.toContain('maxWaiting');
    expect(SRC).toContain('WHERE idempotency_key = $1 LIMIT 1');
  });

  test('provider failures get one bounded retry with fixed backoff', () => {
    expect(DRAIN_SUBMIT).toBeGreaterThanOrEqual(0);
    expect(DRAIN_BLOCK).toMatch(/max_attempts:\s*2/);
    expect(DRAIN_BLOCK).toMatch(/backoff_type:\s*'fixed'/);
    expect(DRAIN_BLOCK).toMatch(/backoff_delay:\s*5000/);
    expect(DRAIN_BLOCK).toMatch(/backoff_jitter:\s*0/);
  });
});
