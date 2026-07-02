import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPromotedEventFeed } from '../src/core/promoted-events.ts';

describe('promoted event feed planner', () => {
  test('plans event rows from Seascape rollups and timestamped Codex closeouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-promoted-events-'));
    try {
      const opsDir = join(root, 'ops');
      const analyticsDir = join(root, 'analytics');
      const closeoutDir = join(root, 'closeouts');
      mkdirSync(opsDir, { recursive: true });
      mkdirSync(analyticsDir, { recursive: true });
      mkdirSync(join(closeoutDir, 'projects-seascape-analytics'), { recursive: true });

      writeJson(join(opsDir, 'reservations-latest.json'), {
        generated_at: '2026-06-29T23:08:42.893Z',
        kind: 'reservations',
        record_count: 1,
        records: [
          { listing_map_id: 101, listing_name: 'River House', property_slug: 'river-house', total_price: 900, check_in_at: '2026-06-20', check_out_at: '2026-06-24' },
        ],
      });
      writeJson(join(opsDir, 'listings-latest.json'), {
        generated_at: '2026-06-29T23:08:42.893Z',
        kind: 'listings',
        record_count: 1,
        records: [{ listing_map_id: 101, internal_name: 'River House' }],
      });
      writeJson(join(opsDir, 'conversations-latest.json'), {
        generated_at: '2026-06-29T23:10:34.631Z',
        kind: 'conversations',
        record_count: 1,
        records: [{ listing_map_id: 101, requires_attention: true, last_message_at: '2026-06-28 09:30:00' }],
      });
      writeJson(join(opsDir, 'owner-statements-latest.json'), {
        generated_at: '2026-06-29T23:08:54.580Z',
        kind: 'owner-statements',
        record_count: 1,
        records: [{ listing_map_ids: [101], listing_name: 'River House', owner_payout: 5000, statement_period_start: '2026-05-01', statement_period_end: '2026-05-31' }],
      });
      writeJson(join(opsDir, 'guests-latest.json'), { generated_at: '2026-06-29T23:08:42.893Z', kind: 'guests', record_count: 0, records: [] });
      writeJson(join(opsDir, 'payments-latest.json'), { generated_at: '2026-06-29T23:08:42.893Z', kind: 'payments', record_count: 0, records: [] });
      writeJson(join(opsDir, 'message-templates-latest.json'), { generated_at: '2026-05-19T17:38:56.868Z', kind: 'message-templates', record_count: 0, records: [] });

      writeJson(join(analyticsDir, 'weekly-ai-visibility-decision-2026-06-15-to-2026-06-21.json'), {
        date_or_window: { window_start: '2026-06-15', window_end: '2026-06-21' },
        next_branch: 'hold-and-reread',
        report_recommendation: 'fix measurement first',
      });

      writeJson(join(closeoutDir, 'projects-seascape-analytics', '2026-07-01T12-00-00Z.json'), {
        generated_at: '2026-07-01T12:00:00+00:00',
        root: '/Users/sawbeck/Projects/seascape-analytics',
        receipt_files: {
          markdown: '/Users/sawbeck/.codex/state/closeout-receipts/projects-seascape-analytics/2026-07-01T12-00-00Z.md',
          json: '/Users/sawbeck/.codex/state/closeout-receipts/projects-seascape-analytics/2026-07-01T12-00-00Z.json',
        },
        branch: 'codex/example',
        classification: 'git-repo',
        staged_paths: 0,
        unstaged_paths: 0,
        untracked_paths: 0,
        verification: ['bun test', 'bunx tsc --noEmit --pretty false'],
      });
      writeJson(join(closeoutDir, 'projects-seascape-analytics', 'latest.json'), {
        generated_at: '2026-07-01T12:00:00+00:00',
        root: '/Users/sawbeck/Projects/seascape-analytics',
      });

      const plan = planPromotedEventFeed({
        seascapeOpsSnapshotDir: opsDir,
        seascapeAnalyticsStatusDir: analyticsDir,
        codexCloseoutDir: closeoutDir,
        codexCloseoutLimit: 10,
      });

      expect(plan.event_count).toBeGreaterThan(0);
      expect(plan.events).toContainEqual(expect.objectContaining({
        date: '2026-07-01',
        entity: 'seascape-analytics',
        kind: 'codex_closeout',
        event: 'Closeout recorded on codex/example: clean; verification commands 2.',
        source_receipt: '/Users/sawbeck/.codex/state/closeout-receipts/projects-seascape-analytics/2026-07-01T12-00-00Z.md',
      }));
      expect(plan.events).toContainEqual(expect.objectContaining({
        date: '2026-06-24',
        entity: 'companies/seascape-properties/river-house',
        kind: 'seascape_rollup',
      }));
      expect(plan.events.find((event) => event.kind === 'codex_closeout')?.wikilinks).toEqual(['[[projects/seascape-analytics]]']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeJson(filePath: string, body: Record<string, unknown>): void {
  writeFileSync(filePath, JSON.stringify(body, null, 2) + '\n', 'utf8');
}
