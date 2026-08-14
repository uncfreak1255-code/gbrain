import { describe, expect, test } from 'bun:test';
import {
  buildHealthSummary,
} from '../src/commands/status.ts';
import { classifyAutopilotRuntime } from '../src/core/autopilot-status.ts';
import {
  crontabIndicatesAutopilotInstall,
  remainingAutopilotProbeTimeout,
} from '../src/commands/autopilot.ts';

describe('autopilot runtime status', () => {
  test('a stale lock does not claim that automation is installed', () => {
    const status = classifyAutopilotRuntime({
      scheduleInstalled: false,
      lockfilePresent: true,
      pid: 999_999,
      running: false,
      lockFresh: false,
      manualDisabledReason: null,
    });

    expect(status.state).toBe('stale_lock');
    expect(status.installed).toBe(false);
    expect(status.lock_status).toBe('stale');
  });

  test('a fresh lock with a dead PID is still stale', () => {
    const status = classifyAutopilotRuntime({
      scheduleInstalled: true,
      lockfilePresent: true,
      pid: 1234,
      running: false,
      lockFresh: true,
      manualDisabledReason: null,
    });
    expect(status.state).toBe('stale_lock');
    expect(status.installed).toBe(true);
    expect(status.lock_status).toBe('stale');
  });

  test('a fresh unreadable lock is still stale', () => {
    const status = classifyAutopilotRuntime({
      scheduleInstalled: true,
      lockfilePresent: true,
      pid: null,
      running: false,
      lockFresh: true,
      manualDisabledReason: null,
    });
    expect(status.state).toBe('stale_lock');
    expect(status.lock_status).toBe('stale');
  });

  test('a schedule artifact is installed even when no process currently owns it', () => {
    const status = classifyAutopilotRuntime({
      scheduleInstalled: true,
      lockfilePresent: false,
      pid: null,
      running: false,
      lockFresh: false,
      manualDisabledReason: null,
    });

    expect(status.state).toBe('installed');
    expect(status.installed).toBe(true);
    expect(status.lock_status).toBe('absent');
  });

  test('a live unscheduled daemon is reported as running', () => {
    const status = classifyAutopilotRuntime({
      scheduleInstalled: false,
      lockfilePresent: true,
      pid: 1234,
      running: true,
      lockFresh: true,
      manualDisabledReason: null,
    });
    expect(status.state).toBe('running');
    expect(status.installed).toBe(false);
    expect(status.lock_status).toBe('running');
  });

  test('manual disable is explicit and outranks scheduler and lock evidence', () => {
    const status = classifyAutopilotRuntime({
      scheduleInstalled: true,
      lockfilePresent: true,
      pid: 123,
      running: true,
      lockFresh: true,
      manualDisabledReason: 'manual automation disabled',
    });

    expect(status.state).toBe('manual_disabled');
    expect(status.manual_disabled_reason).toBe('manual automation disabled');
  });
});

describe('watchdog health summary', () => {
  test('separates database health from stale maintenance', () => {
    expect(buildHealthSummary('stale')).toEqual({
      database: 'healthy',
      maintenance: 'stale',
      summary: 'database healthy / maintenance stale',
    });
  });
});

describe('autopilot crontab classification', () => {
  test('status-only watchdog lines do not claim an installed scheduler', () => {
    expect(crontabIndicatesAutopilotInstall('*/10 * * * * gbrain autopilot --status --json')).toBe(false);
    expect(crontabIndicatesAutopilotInstall('# gbrain autopilot --repo /brain')).toBe(false);
    expect(crontabIndicatesAutopilotInstall("*/5 * * * * '/brain/.gbrain/autopilot-run.sh'")).toBe(true);
  });
});

describe('autopilot scheduler probe budget', () => {
  test('remaining budget never resets for later probes', () => {
    expect(remainingAutopilotProbeTimeout(1_000, 100)).toBe(900);
    expect(remainingAutopilotProbeTimeout(1_000, 1_050)).toBe(1);
    expect(remainingAutopilotProbeTimeout(null, 1_000)).toBeUndefined();
  });
});
