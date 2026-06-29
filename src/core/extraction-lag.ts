// Shared extraction-lag threshold helpers for doctor, sync nudges, and
// remediation planning. The planner must not recommend extract work that the
// live doctor check already classifies as below the backlog threshold.

const warnedEnvNumbers = new Set<string>();

export const EXTRACTION_LAG_WARN_PCT_DEFAULT = 20;
export const EXTRACTION_LAG_MIN_PAGES = 100;

export function resolveEnvNumber(
  varName: string,
  fallback: number,
  opts?: { unit?: string; warnPrefix?: string },
): number {
  const raw = process.env[varName];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    if (!warnedEnvNumbers.has(varName)) {
      warnedEnvNumbers.add(varName);
      const prefix = opts?.warnPrefix ?? '[gbrain]';
      console.warn(
        `${prefix} Ignoring invalid ${varName}=${raw}; using default ${fallback}${opts?.unit ?? ''}.`,
      );
    }
    return fallback;
  }
  return n;
}

export function shouldWarnForExtractionLag(opts: {
  totalPages: number;
  stalePages: number;
  sourceScoped?: boolean;
  warnPct?: number;
}): boolean {
  const total = Math.max(0, opts.totalPages);
  const stale = Math.max(0, opts.stalePages);
  if (total === 0 || stale === 0) return false;
  if (total < EXTRACTION_LAG_MIN_PAGES && opts.sourceScoped !== true) return false;
  const warnPct = opts.warnPct ?? EXTRACTION_LAG_WARN_PCT_DEFAULT;
  return (stale / total) * 100 > warnPct;
}
