import { describe, expect, test } from 'bun:test';

import {
  collectSourceHygiene,
  sourceHygieneFindings,
} from '../src/core/advisor/collect-source-hygiene.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';
import type { SourceHygieneDecision, SourceHygienePacket } from '../src/core/source-hygiene.ts';

function decision(
  sourceId: string,
  classification: SourceHygieneDecision['classification'],
  overrides: Partial<SourceHygieneDecision> = {},
): SourceHygieneDecision {
  return {
    source_id: sourceId,
    archived: false,
    draining: false,
    has_local_path: true,
    shared_path_source_count: 1,
    repo_state: classification === 'healthy' ? 'healthy' : 'missing',
    remote_recovery_configured: false,
    managed_clone: false,
    configured_default: sourceId === 'default',
    configured_default_known: true,
    dependent_row_count: 0,
    dependent_data_known: true,
    nonterminal_work_count: 0,
    work_state_known: true,
    live_sync_lock: false,
    lock_state_known: true,
    classification,
    recovery_mode: classification === 'archive_candidate' ? 'archive_review' : 'manual',
    proposed_command_argv: classification === 'archive_candidate'
      ? ['gbrain', 'sources', 'archive', sourceId, '--if-hygiene-candidate']
      : null,
    veto_reasons: [],
    safe_for_agent_review: classification !== 'recovery_required',
    ...overrides,
  };
}

function packet(sources: SourceHygieneDecision[]): SourceHygienePacket {
  return { schema_version: 1, filesystem_inspected: true, sources };
}

describe('source-hygiene advisor collector', () => {
  test('surfaces populated/default recovery as critical and not as an all-clear', () => {
    const findings = sourceHygieneFindings(packet([
      decision('default', 'recovery_required', { dependent_row_count: 443 }),
    ]));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'source_recovery_required:default',
      severity: 'critical',
      ask_user: true,
    });
    expect(findings[0]?.fix.command_argv).toBeNull();
  });

  test('surfaces an interrupted drain as an agent-runnable archive resume', () => {
    const findings = sourceHygieneFindings(packet([
      decision('stuck-drain', 'recovery_required', {
        draining: true,
        recovery_mode: 'archive_resume',
        proposed_command_argv: ['gbrain', 'sources', 'archive', 'stuck-drain'],
        safe_for_agent_review: true,
      }),
    ]));

    expect(findings[0]).toMatchObject({
      id: 'source_recovery_required:stuck-drain',
      severity: 'warn',
      ask_user: false,
      fix: { command_argv: ['gbrain', 'sources', 'archive', 'stuck-drain'] },
    });
  });

  test('marks a proven empty source as agent-reviewable soft archive', () => {
    const findings = sourceHygieneFindings(packet([
      decision('empty-source', 'archive_candidate'),
    ]));

    expect(findings[0]).toMatchObject({
      id: 'source_archive_candidate:empty-source',
      severity: 'warn',
      ask_user: false,
      fix: {
        command_argv: [
          'gbrain', 'sources', 'archive', 'empty-source', '--if-hygiene-candidate',
        ],
      },
    });
  });

  test('asks for help when managed recovery lacks safe evidence or a command', () => {
    const ambiguous = sourceHygieneFindings(packet([
      decision('managed-ambiguous', 'recovery_required', {
        recovery_mode: 'managed_clone_sync',
        safe_for_agent_review: false,
        proposed_command_argv: null,
      }),
    ]));
    const actionable = sourceHygieneFindings(packet([
      decision('managed-actionable', 'recovery_required', {
        recovery_mode: 'managed_clone_sync',
        safe_for_agent_review: true,
        proposed_command_argv: ['gbrain', 'sync', '--source', 'managed-actionable'],
      }),
    ]));

    expect(ambiguous[0]).toMatchObject({ ask_user: true, fix: { command_argv: null } });
    expect(actionable[0]).toMatchObject({
      ask_user: false,
      fix: { command_argv: ['gbrain', 'sync', '--source', 'managed-actionable'] },
    });
  });

  test('remote collector returns before any engine or filesystem probe', async () => {
    const ctx = {
      remote: true,
      engine: new Proxy({}, {
        get() { throw new Error('remote engine must not be touched'); },
      }),
    } as unknown as AdvisorContext;

    await expect(collectSourceHygiene.collect(ctx)).resolves.toEqual([]);
  });

  test('missing remote flag fails closed before any engine or filesystem probe', async () => {
    const ctx = {
      engine: new Proxy({}, {
        get() { throw new Error('untrusted engine must not be touched'); },
      }),
    } as unknown as AdvisorContext;

    await expect(collectSourceHygiene.collect(ctx)).resolves.toEqual([]);
  });
});
