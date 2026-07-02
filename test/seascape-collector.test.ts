import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { __testing as commandTesting, runSeascape } from '../src/commands/seascape.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __testing,
  buildSeascapePages,
  planSeascapeIngest,
  writeSeascapeIngest,
} from '../src/core/seascape-collector.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

describe('seascape rollup collector', () => {
  test('plans the rollup-only V1 cut and keeps the page count aligned', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-seascape-plan-'));
    try {
      const opsDir = join(root, 'ops');
      const analyticsDir = join(root, 'analytics');
      mkdirSync(opsDir, { recursive: true });
      mkdirSync(analyticsDir, { recursive: true });

      writeSnapshot(opsDir, 'reservations-latest.json', {
        generated_at: '2026-06-29T23:08:42.893Z',
        kind: 'reservations',
        record_count: 2,
        records: [
          { listing_map_id: 101, listing_name: 'River House', property_slug: 'river-house', total_price: 900, check_in_at: '2026-06-20', check_out_at: '2026-06-24' },
          { listing_map_id: 202, listing_name: 'The Oasis', property_slug: 'the-oasis', total_price: 1200, check_in_at: '2026-06-28', check_out_at: '2026-07-01' },
        ],
      });
      writeSnapshot(opsDir, 'listings-latest.json', {
        generated_at: '2026-06-29T23:08:42.893Z',
        kind: 'listings',
        record_count: 2,
        records: [
          { listing_map_id: 101, internal_name: 'Riverview', city: 'Bradenton', state: 'FL', description: 'Long listing text' },
          { listing_map_id: 202, internal_name: '75th ST', city: 'Bradenton', state: 'FL' },
        ],
      });
      writeSnapshot(opsDir, 'conversations-latest.json', {
        generated_at: '2026-06-29T23:10:34.631Z',
        kind: 'conversations',
        record_count: 2,
        records: [
          { listing_map_id: 101, requires_attention: false, last_message_at: '2026-06-22 08:00:00' },
          { listing_map_id: 202, requires_attention: true, last_message_at: '2026-06-28 09:30:00' },
        ],
      });
      writeSnapshot(opsDir, 'owner-statements-latest.json', {
        generated_at: '2026-06-29T23:08:54.580Z',
        kind: 'owner-statements',
        record_count: 4,
        records: [
          { listing_map_ids: [101], listing_name: 'Riverview', owner_payout: 5000, statement_period_start: '2026-05-01', statement_period_end: '2026-05-31' },
          { listing_map_ids: [202], listing_name: '75th ST', owner_payout: 7000, statement_period_start: '2026-05-01', statement_period_end: '2026-05-31' },
          { listing_map_ids: [101, 202], listing_name: 'Portfolio adjustment', owner_payout: 900, statement_period_start: '2026-05-01', statement_period_end: '2026-05-31' },
          { listing_map_ids: [], listing_name: null, owner_payout: 100, statement_period_start: '2026-05-01', statement_period_end: '2026-05-31' },
        ],
      });
      writeSnapshot(opsDir, 'guests-latest.json', {
        generated_at: '2026-06-29T23:08:42.893Z',
        kind: 'guests',
        record_count: 4,
        records: [
          { repeat_candidate_reason: 'repeat booking' },
          {},
          {},
          {},
        ],
      });
      writeSnapshot(opsDir, 'payments-latest.json', {
        generated_at: '2026-06-29T23:08:42.893Z',
        kind: 'payments',
        record_count: 6,
        records: [{}],
      });
      writeSnapshot(opsDir, 'message-templates-latest.json', {
        generated_at: '2026-05-19T17:38:56.868Z',
        kind: 'message-templates',
        record_count: 2,
        records: [{}],
      });

      writeJson(join(analyticsDir, 'ga4-performance-email-2026-05-19-to-2026-06-15.json'), {
        report_window: { label: '2026-05-19 to 2026-06-15' },
        headline_metrics: [
          { label: 'Active Users', display_value: '891' },
          { label: 'New Users', display_value: '875' },
        ],
      });
      writeJson(join(analyticsDir, 'gsc-search-impact-email-2026-06-21.json'), {
        reported_window: { label: '2026-05-24 to 2026-06-20' },
        impact_metric: { value: 450, unit: 'clicks' },
        summary: { headline: 'search clicks grew' },
      });
      writeJson(join(analyticsDir, 'weekly-search-operator-report-2026-06-15-to-2026-06-21.json'), {
        window_start: '2026-06-15',
        window_end: '2026-06-21',
        recommendation: { branch_slug: 'hold-and-reread' },
        cluster_summary: [{ cluster: 'guide_winners', gsc_clicks: 39, ga4_sessions: 232 }],
        seo_queue_summary: [{ seo_queue_bucket: 'wait', pages: 5 }],
      });
      writeJson(join(analyticsDir, 'weekly-search-decision-2026-06-15-to-2026-06-21.json'), {
        cluster_summary: [{ cluster: 'guide_winners', gsc_clicks: 39, ga4_sessions: 232 }],
      });
      writeJson(join(analyticsDir, 'weekly-ai-visibility-decision-2026-06-15-to-2026-06-21.json'), {
        date_or_window: { window_start: '2026-06-15', window_end: '2026-06-21' },
        next_branch: 'hold-and-reread',
        report_recommendation: 'fix measurement first',
        ai_visibility_summary: { status: 'fresh but thin' },
        reason: 'query-level measurements are stale',
      });
      writeJson(join(analyticsDir, 'post-stay-attribution-candidate-export-2026-06-12-to-2026-06-18.json'), {
        window: { window_start: '2026-06-12', window_end: '2026-06-18' },
        candidate_count: 0,
        diagnostic: { blocker: 'no_matching_confirmed_direct_reservations' },
      });

      const plan = planSeascapeIngest({
        opsSnapshotDir: opsDir,
        analyticsStatusDir: analyticsDir,
      });

      expect(plan.status).toBe('ready');
      expect(plan.total_pages).toBe(14);
      expect(plan.groups.map((group) => [group.view, group.page_count])).toEqual([
        ['revenue', 8],
        ['guest_ops', 3],
        ['owner', 3],
      ]);
      expect(plan.privacy_skips.map((skip) => [skip.surface, skip.records])).toEqual([
        ['raw guest profiles', 4],
        ['raw payment rows', 6],
        ['conversation preview rows', 2],
        ['listing free-text fields', 1],
      ]);
      expect(plan.deferred_surfaces.find((surface) => surface.surface === 'reservation stay-event pages')?.records).toBe(2);
      expect(plan.warnings).toContain('1 owner statement rows lacked a listing id and stay portfolio-only in V1.');
      expect(plan.warnings).toContain('1 owner statement rows mapped to multiple listings and stay portfolio-only in V1.');
      expect(plan.ops_summary.unallocated_owner_statements).toBe(2);
      expect(plan.analytics_receipts.map((receipt) => receipt.id)).toEqual([
        'ga4_performance',
        'gsc_search_impact',
        'weekly_search',
        'weekly_ai_visibility',
        'direct_booking_attribution',
      ]);

      const pages = buildSeascapePages(plan);
      const riverHousePage = pages.find((page) => page.slug === 'companies/seascape-properties/river-house');
      expect(riverHousePage?.content).toContain('[[notes/seascape/guest-ops/properties/river-house]]');
      const parsed = matter(riverHousePage?.content ?? '');
      expect(parsed.data.type).toBe('company');
      expect(parsed.data.facts_backstop_skip).toBe(true);
      expect(parsed.data.related).toEqual([
        'Seascape revenue snapshot',
        'River House guest ops snapshot',
        'River House owner snapshot',
      ]);
      expect(parsed.content).toContain('## Timeline');
      expect(parsed.content).toContain('- **2026-06-24** | Revenue rollup refreshed for the latest staged stay window.');
      const revenuePortfolio = pages.find((page) => page.slug === 'notes/seascape/revenue/portfolio')?.content ?? '';
      expect(revenuePortfolio).toContain('Related property pages');
      expect(revenuePortfolio).toContain('Owner payout total in snapshot: $13,000.00');
      expect(pages.find((page) => page.slug === 'notes/seascape/guest-ops/portfolio')?.content).toContain('Property companies: [[companies/seascape-properties/river-house]], [[companies/seascape-properties/the-oasis]]');
      const ownerPortfolio = pages.find((page) => page.slug === 'notes/seascape/owner/portfolio')?.content ?? '';
      expect(ownerPortfolio).toContain('Property companies: [[companies/seascape-properties/river-house]], [[companies/seascape-properties/the-oasis]]');
      expect(ownerPortfolio).toContain('Owner payout total: $13,000.00');
      expect(ownerPortfolio).toContain('Unallocated owner statement rows: 2');
      expect(pages.find((page) => page.slug === 'notes/seascape/owner/properties/river-house')?.content).toContain('Owner payout total: $5,000.00');
      expect(pages.find((page) => page.slug === 'notes/seascape/owner/properties/the-oasis')?.content).toContain('Owner payout total: $7,000.00');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dry-run prints summary and never calls the writer', async () => {
    let printed = false;
    let wrote = false;
    await runSeascape({} as never, ['ingest', '--dry-run'], {
      plan: () => ({
        schema_version: 1,
        receipt_type: 'seascape_rollup_ingest_plan',
        status: 'ready',
        dry_run: true,
        ops_snapshot_dir: '/ops',
        analytics_status_dir: '/analytics',
        total_pages: 23,
        groups: [],
        analytics_receipts: [],
        privacy_skips: [],
        deferred_surfaces: [],
        warnings: [],
        missing: [],
        ops_summary: {
          generated_at: null,
          properties_covered: 5,
          reservations: 500,
          conversations: 100,
          owner_statements: 141,
          guests: 2444,
          payments: 1363,
          message_templates: 10,
          unmapped_owner_statements: 0,
          unallocated_owner_statements: 0,
        },
      }),
      writePlan: async () => {
        wrote = true;
        return { written: 1, slugs: ['should-not-write'] };
      },
      printSummary: () => {
        printed = true;
      },
    });

    expect(printed).toBe(true);
    expect(wrote).toBe(false);
  });

  test('latestJsonByPrefix picks the newest matching receipt file', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-seascape-files-'));
    try {
      writeJson(join(root, 'weekly-search-operator-report-2026-06-01-to-2026-06-07.json'), {});
      writeJson(join(root, 'weekly-search-operator-report-2026-06-15-to-2026-06-21.json'), {});
      expect(__testing.latestJsonByPrefix(root, 'weekly-search-operator-report-')?.endsWith('2026-06-15-to-2026-06-21.json')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('decision-only weekly search receipt makes the plan partial', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-seascape-partial-'));
    try {
      const { opsDir, analyticsDir } = buildFixture(root);
      rmSync(join(analyticsDir, 'weekly-search-operator-report-2026-06-15-to-2026-06-21.json'));

      const plan = planSeascapeIngest({
        opsSnapshotDir: opsDir,
        analyticsStatusDir: analyticsDir,
      });

      expect(plan.status).toBe('partial');
      expect(plan.warnings).toContain('Weekly search decision exists without operator receipt; weekly search page is decision-only.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('mismatched weekly search receipts make the plan partial without mixing sources', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-seascape-weekly-mismatch-'));
    try {
      const { opsDir, analyticsDir } = buildFixture(root);
      const mismatchedDecisionPath = join(analyticsDir, 'weekly-search-decision-2026-06-22-to-2026-06-28.json');
      writeJson(mismatchedDecisionPath, {
        cluster_summary: [{ cluster: 'newer_window', gsc_clicks: 999, ga4_sessions: 999 }],
      });

      const plan = planSeascapeIngest({
        opsSnapshotDir: opsDir,
        analyticsStatusDir: analyticsDir,
      });

      expect(plan.status).toBe('partial');
      expect(plan.warnings).toContain('Weekly search operator and decision receipts cover different windows; weekly search page is partial.');
      const weeklyPage = buildSeascapePages(plan).find((page) => page.slug === 'notes/seascape/revenue/weekly-search');
      const parsed = matter(weeklyPage?.content ?? '');
      expect(parsed.content).toContain('Top cluster by search clicks: guide_winners');
      expect(parsed.content).not.toContain('newer_window');
      expect(parsed.data.source_paths).not.toContain(mismatchedDecisionPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('parseArgs tolerates the full CLI command prefix', () => {
    expect(requireSeascapeSubcommand(commandTesting.parseArgs(['seascape', 'ingest', '--json']))).toBe('ingest');
    expect(requireSeascapeSubcommand(commandTesting.parseArgs(['ingest', '--json']))).toBe('ingest');
  });

  test('write requires an explicit source id', async () => {
    await expect(runSeascape({} as never, ['ingest', '--write'], {
      plan: () => ({
        schema_version: 1,
        receipt_type: 'seascape_rollup_ingest_plan',
        status: 'ready',
        dry_run: true,
        ops_snapshot_dir: '/ops',
        analytics_status_dir: '/analytics',
        total_pages: 23,
        groups: [],
        analytics_receipts: [],
        privacy_skips: [],
        deferred_surfaces: [],
        warnings: [],
        missing: [],
        ops_summary: {
          generated_at: null,
          properties_covered: 5,
          reservations: 500,
          conversations: 100,
          owner_statements: 141,
          guests: 2444,
          payments: 1363,
          message_templates: 10,
          unmapped_owner_statements: 0,
          unallocated_owner_statements: 0,
        },
      }),
    })).rejects.toThrow('--source <id>');
  });
});

describe('seascape rollup writer', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    resetGateway();
  });

  test('writeSeascapeIngest keeps local graph and timeline hooks on for rollup pages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-seascape-write-'));
    try {
      const { opsDir, analyticsDir } = buildFixture(root);
      const repoDir = join(root, 'brain');
      mkdirSync(repoDir, { recursive: true });
      await engine.setConfig('sync.repo_path', repoDir);
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ('seascape-rollups', 'Seascape rollups', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      );

      const plan = planSeascapeIngest({
        opsSnapshotDir: opsDir,
        analyticsStatusDir: analyticsDir,
      });
      expect(plan.status).toBe('ready');

      const result = await writeSeascapeIngest(engine, plan, { sourceId: 'seascape-rollups' });
      expect(result.written).toBe(14);

      const guestPortfolioLinks = await engine.getLinks('notes/seascape/guest-ops/portfolio', { sourceId: 'seascape-rollups' });
      expect(guestPortfolioLinks.map((link) => link.to_slug)).toEqual(expect.arrayContaining([
        'companies/seascape-properties/river-house',
        'companies/seascape-properties/the-oasis',
      ]));

      const ownerPortfolioLinks = await engine.getLinks('notes/seascape/owner/portfolio', { sourceId: 'seascape-rollups' });
      expect(ownerPortfolioLinks.map((link) => link.to_slug)).toEqual(expect.arrayContaining([
        'companies/seascape-properties/river-house',
        'companies/seascape-properties/the-oasis',
      ]));

      const timelineRows = await engine.executeRaw<{ date: string; summary: string }>(
        `SELECT te.date::text AS date, te.summary
           FROM timeline_entries te
           JOIN pages p ON p.id = te.page_id
          WHERE p.source_id = 'seascape-rollups' AND p.slug = $1
          ORDER BY te.date, te.summary`,
        ['companies/seascape-properties/river-house'],
      );
      expect(timelineRows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          date: '2026-06-24',
          summary: 'Revenue rollup refreshed for the latest staged stay window.',
        }),
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function buildFixture(root: string): { opsDir: string; analyticsDir: string } {
  const opsDir = join(root, 'ops');
  const analyticsDir = join(root, 'analytics');
  mkdirSync(opsDir, { recursive: true });
  mkdirSync(analyticsDir, { recursive: true });

  writeSnapshot(opsDir, 'reservations-latest.json', {
    generated_at: '2026-06-29T23:08:42.893Z',
    kind: 'reservations',
    record_count: 2,
    records: [
      { listing_map_id: 101, listing_name: 'River House', property_slug: 'river-house', total_price: 900, check_in_at: '2026-06-20', check_out_at: '2026-06-24' },
      { listing_map_id: 202, listing_name: 'The Oasis', property_slug: 'the-oasis', total_price: 1200, check_in_at: '2026-06-28', check_out_at: '2026-07-01' },
    ],
  });
  writeSnapshot(opsDir, 'listings-latest.json', {
    generated_at: '2026-06-29T23:08:42.893Z',
    kind: 'listings',
    record_count: 2,
    records: [
      { listing_map_id: 101, internal_name: 'Riverview', city: 'Bradenton', state: 'FL', description: 'Long listing text' },
      { listing_map_id: 202, internal_name: '75th ST', city: 'Bradenton', state: 'FL' },
    ],
  });
  writeSnapshot(opsDir, 'conversations-latest.json', {
    generated_at: '2026-06-29T23:10:34.631Z',
    kind: 'conversations',
    record_count: 2,
    records: [
      { listing_map_id: 101, requires_attention: false, last_message_at: '2026-06-22 08:00:00' },
      { listing_map_id: 202, requires_attention: true, last_message_at: '2026-06-28 09:30:00' },
    ],
  });
  writeSnapshot(opsDir, 'owner-statements-latest.json', {
    generated_at: '2026-06-29T23:08:54.580Z',
    kind: 'owner-statements',
    record_count: 4,
    records: [
      { listing_map_ids: [101], listing_name: 'Riverview', owner_payout: 5000, statement_period_start: '2026-05-01', statement_period_end: '2026-05-31' },
      { listing_map_ids: [202], listing_name: '75th ST', owner_payout: 7000, statement_period_start: '2026-05-01', statement_period_end: '2026-05-31' },
      { listing_map_ids: [101, 202], listing_name: 'Portfolio adjustment', owner_payout: 900, statement_period_start: '2026-05-01', statement_period_end: '2026-05-31' },
      { listing_map_ids: [], listing_name: null, owner_payout: 100, statement_period_start: '2026-05-01', statement_period_end: '2026-05-31' },
    ],
  });
  writeSnapshot(opsDir, 'guests-latest.json', {
    generated_at: '2026-06-29T23:08:42.893Z',
    kind: 'guests',
    record_count: 4,
    records: [
      { repeat_candidate_reason: 'repeat booking' },
      {},
      {},
      {},
    ],
  });
  writeSnapshot(opsDir, 'payments-latest.json', {
    generated_at: '2026-06-29T23:08:42.893Z',
    kind: 'payments',
    record_count: 6,
    records: [{}],
  });
  writeSnapshot(opsDir, 'message-templates-latest.json', {
    generated_at: '2026-05-19T17:38:56.868Z',
    kind: 'message-templates',
    record_count: 2,
    records: [{}],
  });

  writeJson(join(analyticsDir, 'ga4-performance-email-2026-05-19-to-2026-06-15.json'), {
    report_window: { label: '2026-05-19 to 2026-06-15' },
    headline_metrics: [
      { label: 'Active Users', display_value: '891' },
      { label: 'New Users', display_value: '875' },
    ],
  });
  writeJson(join(analyticsDir, 'gsc-search-impact-email-2026-06-21.json'), {
    reported_window: { label: '2026-05-24 to 2026-06-20' },
    impact_metric: { value: 450, unit: 'clicks' },
    summary: { headline: 'search clicks grew' },
  });
  writeJson(join(analyticsDir, 'weekly-search-operator-report-2026-06-15-to-2026-06-21.json'), {
    window_start: '2026-06-15',
    window_end: '2026-06-21',
    recommendation: { branch_slug: 'hold-and-reread' },
    cluster_summary: [{ cluster: 'guide_winners', gsc_clicks: 39, ga4_sessions: 232 }],
    seo_queue_summary: [{ seo_queue_bucket: 'wait', pages: 5 }],
  });
  writeJson(join(analyticsDir, 'weekly-search-decision-2026-06-15-to-2026-06-21.json'), {
    cluster_summary: [{ cluster: 'guide_winners', gsc_clicks: 39, ga4_sessions: 232 }],
  });
  writeJson(join(analyticsDir, 'weekly-ai-visibility-decision-2026-06-15-to-2026-06-21.json'), {
    date_or_window: { window_start: '2026-06-15', window_end: '2026-06-21' },
    next_branch: 'hold-and-reread',
    report_recommendation: 'fix measurement first',
    ai_visibility_summary: { status: 'fresh but thin' },
    reason: 'query-level measurements are stale',
  });
  writeJson(join(analyticsDir, 'post-stay-attribution-candidate-export-2026-06-12-to-2026-06-18.json'), {
    window: { window_start: '2026-06-12', window_end: '2026-06-18' },
    candidate_count: 0,
    diagnostic: { blocker: 'no_matching_confirmed_direct_reservations' },
  });

  return { opsDir, analyticsDir };
}

function writeSnapshot(dir: string, fileName: string, body: Record<string, unknown>): void {
  writeJson(join(dir, fileName), body);
}

function writeJson(filePath: string, body: Record<string, unknown>): void {
  writeFileSync(filePath, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

function requireSeascapeSubcommand(parsed: { subcmd: string }): string {
  return parsed.subcmd;
}
