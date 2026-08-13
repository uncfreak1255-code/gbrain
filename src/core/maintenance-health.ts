import type { SqlQuery } from './sql-query.ts';

export const DEFAULT_GLOBAL_MAINTENANCE_FLOOR_MINUTES = 60;

export type MaintenanceHealthState = 'fresh' | 'stale' | 'unknown';

export interface MaintenanceHealth {
  state: MaintenanceHealthState;
  last_global_at: string | null;
  age_seconds: number | null;
  stale_after_minutes: number;
}

export function classifyMaintenanceHealth(
  lastGlobalAt: string | null,
  nowMs = Date.now(),
  staleAfterMinutes = DEFAULT_GLOBAL_MAINTENANCE_FLOOR_MINUTES,
): MaintenanceHealth {
  const parsed = lastGlobalAt ? new Date(lastGlobalAt).getTime() : NaN;
  const age_seconds = Number.isFinite(parsed)
    ? Math.max(0, Math.floor((nowMs - parsed) / 1000))
    : null;
  const stale = !Number.isFinite(parsed)
    || (nowMs - parsed) / 60_000 >= staleAfterMinutes;
  return {
    state: stale ? 'stale' : 'fresh',
    last_global_at: lastGlobalAt,
    age_seconds,
    stale_after_minutes: staleAfterMinutes,
  };
}

export function healthSummary(maintenance: MaintenanceHealthState | 'manual_disabled'): string {
  const label = maintenance === 'manual_disabled' ? 'manual automation disabled' : maintenance;
  return `database healthy / maintenance ${label}`;
}

/** Read the DB-plane maintenance receipt without turning liveness into a hard failure. */
export async function readMaintenanceHealth(sql: SqlQuery, timeoutMs?: number): Promise<MaintenanceHealth> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const query = sql`
      SELECT key, value
        FROM config
       WHERE key IN ('autopilot.last_global_at', 'autopilot.global_floor_min')
    `;
    const rows = timeoutMs !== undefined && timeoutMs > 0
      ? await Promise.race([
        query,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ])
      : await query;
    if (rows === null) {
      return {
        state: 'unknown',
        last_global_at: null,
        age_seconds: null,
        stale_after_minutes: DEFAULT_GLOBAL_MAINTENANCE_FLOOR_MINUTES,
      };
    }
    const values = new Map(
      rows.map((row) => [String(row.key), typeof row.value === 'string' ? row.value : null]),
    );
    const rawFloor = values.get('autopilot.global_floor_min');
    const parsedFloor = rawFloor == null ? NaN : Number.parseInt(rawFloor, 10);
    const floor = Number.isFinite(parsedFloor) && parsedFloor >= 1
      ? parsedFloor
      : DEFAULT_GLOBAL_MAINTENANCE_FLOOR_MINUTES;
    return classifyMaintenanceHealth(values.get('autopilot.last_global_at') ?? null, Date.now(), floor);
  } catch {
    return {
      state: 'unknown',
      last_global_at: null,
      age_seconds: null,
      stale_after_minutes: DEFAULT_GLOBAL_MAINTENANCE_FLOOR_MINUTES,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
