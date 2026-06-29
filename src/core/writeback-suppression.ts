import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { gbrainPath } from './config.ts';
import type { WritebackEvaluation } from './writeback-candidate.ts';

export const WRITEBACK_SUPPRESSION_SCHEMA_VERSION = 'gbrain-writeback-suppression-v1' as const;

export interface WritebackSuppressionEntry {
  suppression_key: string;
  verdict: Exclude<WritebackEvaluation['verdict'], 'candidate' | 'no_owner' | 'suppressed'>;
  recorded_at: string;
}

export interface WritebackSuppressionState {
  schema_version: typeof WRITEBACK_SUPPRESSION_SCHEMA_VERSION;
  entries: WritebackSuppressionEntry[];
}

const EMPTY_STATE: WritebackSuppressionState = {
  schema_version: WRITEBACK_SUPPRESSION_SCHEMA_VERSION,
  entries: [],
};

export function defaultWritebackSuppressionPath(): string {
  return gbrainPath('writeback-suppression-state.json');
}

export function loadWritebackSuppressionState(opts: { statePath?: string } = {}): WritebackSuppressionState {
  const path = opts.statePath ?? defaultWritebackSuppressionPath();
  if (!existsSync(path)) return { ...EMPTY_STATE, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (parsed.schema_version !== WRITEBACK_SUPPRESSION_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      return { ...EMPTY_STATE, entries: [] };
    }
    return {
      schema_version: WRITEBACK_SUPPRESSION_SCHEMA_VERSION,
      entries: parsed.entries as WritebackSuppressionEntry[],
    };
  } catch {
    return { ...EMPTY_STATE, entries: [] };
  }
}

export function saveWritebackSuppressionState(
  state: WritebackSuppressionState,
  opts: { statePath?: string } = {},
): void {
  const path = opts.statePath ?? defaultWritebackSuppressionPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o644 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

export function upsertWritebackSuppression(
  state: WritebackSuppressionState,
  entry: WritebackSuppressionEntry,
): WritebackSuppressionState {
  const others = state.entries.filter((existing) => existing.suppression_key !== entry.suppression_key);
  return {
    schema_version: WRITEBACK_SUPPRESSION_SCHEMA_VERSION,
    entries: [...others, entry],
  };
}

export function buildWritebackSuppressionEntry(
  evaluation: WritebackEvaluation,
  now = new Date(),
): WritebackSuppressionEntry | null {
  if (!evaluation.suppression_key) return null;
  if (
    evaluation.verdict === 'candidate' ||
    evaluation.verdict === 'no_owner' ||
    evaluation.verdict === 'suppressed'
  ) {
    return null;
  }
  return {
    suppression_key: evaluation.suppression_key,
    verdict: evaluation.verdict,
    recorded_at: now.toISOString(),
  };
}

export function applyWritebackSuppression(
  evaluation: WritebackEvaluation,
  state: WritebackSuppressionState,
): WritebackEvaluation {
  if (!evaluation.suppression_key) return evaluation;
  const prior = state.entries.find((entry) => entry.suppression_key === evaluation.suppression_key);
  if (!prior) return evaluation;
  return {
    ...evaluation,
    verdict: 'suppressed',
    candidate: null,
    reason: `Unchanged ${prior.verdict} candidate remains suppressed until the underlying residue changes.`,
  };
}
