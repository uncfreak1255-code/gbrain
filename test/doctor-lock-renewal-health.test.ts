// TODO-LR-2 — lock_renewal_health doctor check.
//
// Covers the audit thresholds from TODOS.md plus the queue blind spot where a
// row still looks active but its renewal heartbeat stopped moving.

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkLockRenewalHealth, doctorReportRemote } from '../src/commands/doctor.ts';
import {
  lockRenewalAudit,
  LOCK_RENEWAL_FEATURE_NAME,
} from '../src/core/audit/lock-renewal-audit.ts';
import { computeIsoWeekFilename } from '../src/core/audit/audit-writer.ts';
import { withEnv } from './helpers/with-env.ts';

let tmpDir: string;
let base: PGLiteEngine;
let pgLike: BrainEngine;

beforeAll(async () => {
  base = new PGLiteEngine();
  await base.connect({});
  await base.initSchema();
  pgLike = {
    kind: 'postgres',
    executeRaw: base.executeRaw.bind(base),
    getStats: base.getStats.bind(base),
    getConfig: base.getConfig.bind(base),
    getHealth: base.getHealth.bind(base),
  } as unknown as BrainEngine;
});

afterAll(async () => {
  await base.disconnect();
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-renewal-health-'));
  await base.executeRaw('DELETE FROM minion_jobs');
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
});

async function withAuditEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_AUDIT_DIR: tmpDir, GBRAIN_LOCK_RENEWAL_STALE_SECONDS: '120' }, fn);
}

function auditFile(): string {
  return path.join(tmpDir, computeIsoWeekFilename(LOCK_RENEWAL_FEATURE_NAME));
}

describe('checkLockRenewalHealth', () => {
  test('ok when there are no audit incidents and no stale active rows', async () => {
    await withAuditEnv(async () => {
      const check = await checkLockRenewalHealth(pgLike);
      expect(check.name).toBe('lock_renewal_health');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('No unsafe lock-renewal pattern');
    });
  });

  test('warns at five gave_up audit events', async () => {
    await withAuditEnv(async () => {
      for (let i = 0; i < 5; i++) {
        lockRenewalAudit.logGaveUp(100 + i, 'autopilot-cycle', 3, new Error('renewLock timed out'));
      }
      const check = await checkLockRenewalHealth(pgLike);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('5 gave_up');
      expect(check.message).toContain('autopilot-cycle=5');
      expect(check.details?.gave_up).toBe(5);
    });
  });

  test('warns at twenty failure audit events', async () => {
    await withAuditEnv(async () => {
      for (let i = 0; i < 20; i++) {
        lockRenewalAudit.logFailure(200 + i, 'embed', 1, new Error('connection ended'));
      }
      const check = await checkLockRenewalHealth(pgLike);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('20 failure');
      expect(check.message).toContain('embed=20');
      expect(check.details?.failures).toBe(20);
    });
  });

  test('warns when active jobs have future locks but stale renewal timestamps', async () => {
    await withAuditEnv(async () => {
      await base.executeRaw(
        `INSERT INTO minion_jobs (name, queue, status, lock_until, updated_at, started_at)
         VALUES ('autopilot-cycle', 'default', 'active',
                 now() + interval '10 minutes',
                 now() - interval '5 minutes',
                 now() - interval '6 minutes')`,
      );
      const check = await checkLockRenewalHealth(pgLike);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('future locks but no renewal update');
      expect(check.message).toContain('autopilot-cycle@default');
      expect(check.details?.stale_active_jobs).toBe(1);
    });
  });

  test('does not warn below audit thresholds', async () => {
    await withAuditEnv(async () => {
      for (let i = 0; i < 4; i++) {
        lockRenewalAudit.logGaveUp(300 + i, 'sync', 3, new Error('one-off timeout'));
      }
      for (let i = 0; i < 19; i++) {
        lockRenewalAudit.logFailure(400 + i, 'sync', 1, new Error('connection blip'));
      }
      const check = await checkLockRenewalHealth(pgLike);
      expect(check.status).toBe('ok');
      expect(check.details?.gave_up).toBe(4);
      expect(check.details?.failures).toBe(19);
    });
  });

  test('surfaces corrupt lock-renewal audit JSONL as operator-visible warn', async () => {
    await withAuditEnv(async () => {
      fs.writeFileSync(auditFile(), 'not-json\n', 'utf8');
      const check = await checkLockRenewalHealth(pgLike);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('corrupt lock-renewal audit JSONL');
      expect(check.details?.corrupted_lines).toBe(1);
    });
  });

  test('doctorReportRemote includes lock_renewal_health', async () => {
    await withAuditEnv(async () => {
      const report = await doctorReportRemote(pgLike);
      expect(report.checks.some((c) => c.name === 'lock_renewal_health')).toBe(true);
    });
  });
});
