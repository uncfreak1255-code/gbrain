import { describe, expect, test } from 'bun:test';

import {
  checkSourcePathHealth,
  checkSyncFreshness,
} from '../src/commands/doctor.ts';
import type { SourceHygieneDecision, SourceHygienePacket } from '../src/core/source-hygiene.ts';

function sourceDecision(
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
    source_config_known: true,
    dependent_row_count: 0,
    dependent_data_known: true,
    nonterminal_work_count: 0,
    work_state_known: true,
    live_sync_lock: false,
    lock_state_known: true,
    live_cycle_lock: false,
    cycle_lock_state_known: true,
    classification,
    recovery_mode: classification === 'archive_candidate' ? 'archive_review' : 'manual',
    proposed_command_argv: null,
    veto_reasons: [],
    safe_for_agent_review: classification !== 'recovery_required',
    ...overrides,
  };
}

function packet(sources: SourceHygieneDecision[]): SourceHygienePacket {
  return { schema_version: 1, filesystem_inspected: true, sources };
}

describe('Doctor source path health', () => {
  test('populated missing source is a red root failure with no sync command', async () => {
    const hygiene = packet([
      sourceDecision('default', 'recovery_required', { dependent_row_count: 443 }),
    ]);
    const check = await checkSourcePathHealth({} as never, { packet: hygiene });

    expect(check).toMatchObject({
      name: 'source_path_health',
      status: 'fail',
      remediation_status: 'blocked',
    });
    expect(check.message).toContain('default');
    expect(check.message).not.toContain('gbrain sync');
  });

  test('reports an interrupted archive with its resumable command', async () => {
    const hygiene = packet([
      sourceDecision('stuck-drain', 'recovery_required', {
        draining: true,
        recovery_mode: 'archive_resume',
        proposed_command_argv: ['gbrain', 'sources', 'archive', 'stuck-drain'],
        safe_for_agent_review: true,
      }),
    ]);
    const check = await checkSourcePathHealth({} as never, { packet: hygiene });

    expect(check.message).toContain('interrupted');
    expect(check.details).toMatchObject({
      recovery_required: [{
        source_id: 'stuck-drain',
        proposed_command_argv: ['gbrain', 'sources', 'archive', 'stuck-drain'],
      }],
    });
  });

  test('reports migration drains without suggesting a plain archive command', async () => {
    const hygiene = packet([
      sourceDecision('migration-stuck', 'recovery_required', {
        draining: true,
        recovery_mode: 'migration_resume',
        proposed_command_argv: null,
        safe_for_agent_review: true,
      }),
    ]);
    const check = await checkSourcePathHealth({} as never, { packet: hygiene });

    expect(check.message).toContain('engine migration');
    expect(check.details).toMatchObject({
      fix_hint: expect.stringContaining('Rerun the interrupted engine migration'),
      recovery_required: [{
        source_id: 'migration-stuck',
        proposed_command_argv: null,
      }],
    });
  });

  test('empty missing source is a warning for adversarial soft-archive review', async () => {
    const hygiene = packet([
      sourceDecision('empty-source', 'archive_candidate', {
        proposed_command_argv: [
          'gbrain', 'sources', 'archive', 'empty-source', '--if-hygiene-candidate',
        ],
      }),
    ]);
    const check = await checkSourcePathHealth({} as never, { packet: hygiene });

    expect(check).toMatchObject({
      name: 'source_path_health',
      status: 'warn',
      remediation_status: 'human_only',
    });
  });

  test('sync freshness replaces the generic sync hint for manual recovery', async () => {
    const engine = {
      executeRaw: async () => [{
        id: 'default',
        name: 'default',
        local_path: '/fixture/missing',
        last_sync_at: null,
        last_commit: null,
        chunker_version: null,
        newest_content_at: null,
      }],
    };
    const check = await checkSyncFreshness(engine as never, {
      localOnly: true,
      sourceHygiene: packet([
        sourceDecision('default', 'recovery_required', { dependent_row_count: 443 }),
      ]),
    });

    expect(check.status).toBe('fail');
    expect(check.message).toContain('recover it before sync');
    expect(check.message).not.toContain('Run `gbrain sync');
    expect(check.details).toMatchObject({
      unchanged_count: 0,
      synced_recently_count: 0,
      stale_count: 1,
    });
  });
});
