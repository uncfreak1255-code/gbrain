import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const AUTOPILOT_SRC = readFileSync(
  join(import.meta.dir, '..', 'src', 'commands', 'autopilot.ts'),
  'utf8',
);

describe('autopilot source-hygiene full-cycle gates', () => {
  test('inline mode inspects source hygiene before invoking runCycle', () => {
    const inlineStart = AUTOPILOT_SRC.indexOf('// Inline fallback');
    const inspectIdx = AUTOPILOT_SRC.indexOf('inspectSourceHygiene(engine', inlineStart);
    const runCycleIdx = AUTOPILOT_SRC.indexOf("import('../core/cycle.ts')", inlineStart);

    expect(inlineStart).toBeGreaterThan(-1);
    expect(inspectIdx).toBeGreaterThan(inlineStart);
    expect(runCycleIdx).toBeGreaterThan(inspectIdx);
    expect(AUTOPILOT_SRC.slice(inspectIdx, runCycleIdx)).toContain('source_hygiene_blocked');
  });

  test('minion dispatch passes recovery state into the pure decision', () => {
    expect(AUTOPILOT_SRC).toContain('sourceRecoveryBlocked,');
    expect(AUTOPILOT_SRC).toContain("source.classification === 'recovery_required'");
  });
});
