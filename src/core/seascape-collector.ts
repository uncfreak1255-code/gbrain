import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import matter from 'gray-matter';
import { loadConfig } from './config.ts';
import type { BrainEngine } from './engine.ts';
import { operations, type OperationContext } from './operations.ts';
import { resolveSourceWithTier } from './source-resolver.ts';

export const DEFAULT_SEASCAPE_OPS_SNAPSHOT_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'seascape-ops',
  'state',
  'staging',
  'hostaway-data',
  'snapshots',
);

export const DEFAULT_SEASCAPE_ANALYTICS_STATUS_DIR = join(
  homedir(),
  'Projects',
  'seascape-analytics',
  'docs',
  'status',
);

type SeascapeView = 'revenue' | 'guest_ops' | 'owner';
type SeascapeScope = 'portfolio' | 'property' | 'analytics';

interface SnapshotEnvelope<T> {
  generated_at?: string;
  kind?: string;
  record_count?: number;
  records?: T[];
  stale_after?: string;
}

interface ReservationRecord {
  listing_map_id?: number;
  listing_name?: string;
  property_slug?: string;
  total_price?: number;
  check_in_at?: string;
  check_out_at?: string;
}

interface ListingRecord {
  listing_map_id?: number;
  internal_name?: string;
  external_name?: string;
  city?: string;
  state?: string;
  country?: string;
  description?: string | null;
  house_rules?: string | null;
  special_instruction?: string | null;
}

interface ConversationRecord {
  listing_map_id?: number;
  hostaway_reservation_id?: string | number | null;
  last_message_at?: string | null;
  requires_attention?: boolean;
}

interface OwnerStatementRecord {
  listing_map_ids?: number[] | null;
  listing_name?: string | null;
  owner_payout?: number | null;
  statement_period_start?: string | null;
  statement_period_end?: string | null;
}

interface GuestRecord {
  repeat_candidate_reason?: string | null;
}

interface Ga4Receipt {
  report_window?: {
    label?: string;
    start_date?: string;
    end_date?: string;
  };
  headline_metrics?: Array<{
    label?: string;
    display_value?: string;
    value?: number;
  }>;
}

interface GscImpactReceipt {
  reported_window?: {
    label?: string;
    start_date?: string;
    end_date?: string;
  };
  impact_metric?: {
    value?: number;
    unit?: string;
    window_days?: number;
  };
  summary?: {
    headline?: string;
  };
}

interface WeeklySearchOperatorReceipt {
  window_start?: string | null;
  window_end?: string | null;
  recommendation?: {
    branch_slug?: string | null;
    reason?: string | null;
  } | null;
  cluster_summary?: Array<{
    cluster?: string;
    gsc_clicks?: number;
    ga4_sessions?: number;
  }>;
  seo_queue_summary?: Array<{
    seo_queue_bucket?: string;
    pages?: number;
  }>;
}

interface WeeklyAIDecisionReceipt {
  date_or_window?: {
    window_start?: string;
    window_end?: string;
    emitted_at?: string;
  };
  next_branch?: string | null;
  report_recommendation?: string | null;
  reason?: string | null;
  ai_visibility_summary?: {
    status?: string;
    analytics_quality_status?: string;
  } | null;
}

interface AttributionReceipt {
  window?: {
    window_start?: string;
    window_end?: string;
  };
  candidate_count?: number;
  diagnostic?: {
    blocker?: string | null;
  } | null;
}

export interface SeascapeIngestPagePlan {
  slug: string;
  title: string;
  view: SeascapeView;
  scope: SeascapeScope;
  property_slug?: string;
  window_label?: string;
  summary_lines: string[];
  related_titles?: string[];
  timeline_entries?: string[];
  source_paths: string[];
  primary_source_path: string;
}

export interface SeascapeIngestGroup {
  view: SeascapeView;
  page_count: number;
  pages: SeascapeIngestPagePlan[];
}

export interface SeascapePrivacySkip {
  surface: string;
  records: number;
  reason: string;
}

export interface SeascapeDeferredSurface {
  surface: string;
  records?: number;
  reason: string;
}

export interface SeascapeAnalyticsReceiptRef {
  id: 'ga4_performance' | 'gsc_search_impact' | 'weekly_search' | 'weekly_ai_visibility' | 'direct_booking_attribution';
  path: string;
  window_label?: string;
}

export interface SeascapeIngestPlan {
  schema_version: 1;
  receipt_type: 'seascape_rollup_ingest_plan';
  status: 'ready' | 'partial' | 'blocked';
  dry_run: true;
  ops_snapshot_dir: string;
  analytics_status_dir: string;
  total_pages: number;
  groups: SeascapeIngestGroup[];
  analytics_receipts: SeascapeAnalyticsReceiptRef[];
  privacy_skips: SeascapePrivacySkip[];
  deferred_surfaces: SeascapeDeferredSurface[];
  warnings: string[];
  missing: string[];
  ops_summary: {
    generated_at: string | null;
    properties_covered: number;
    reservations: number;
    conversations: number;
    owner_statements: number;
    guests: number;
    payments: number;
    message_templates: number;
    unmapped_owner_statements: number;
    unallocated_owner_statements: number;
  };
}

export interface SeascapeWriteResult {
  written: number;
  slugs: string[];
}

interface PropertySummary {
  listing_map_id: number;
  property_slug: string;
  display_name: string;
  city?: string;
  state?: string;
  country?: string;
  reservation_count: number;
  conversation_count: number;
  attention_count: number;
  owner_statement_count: number;
  revenue_total: number;
  owner_payout_total: number;
  first_check_in?: string;
  last_check_out?: string;
  latest_message_at?: string;
  statement_period_start?: string;
  statement_period_end?: string;
}

interface PageWriteTarget {
  slug: string;
  content: string;
  sourceUri: string;
}

export function planSeascapeIngest(opts: {
  opsSnapshotDir?: string;
  analyticsStatusDir?: string;
} = {}): SeascapeIngestPlan {
  const opsSnapshotDir = opts.opsSnapshotDir ?? DEFAULT_SEASCAPE_OPS_SNAPSHOT_DIR;
  const analyticsStatusDir = opts.analyticsStatusDir ?? DEFAULT_SEASCAPE_ANALYTICS_STATUS_DIR;
  const warnings: string[] = [];
  const missing: string[] = [];

  const reservations = loadSnapshot<ReservationRecord>(opsSnapshotDir, 'reservations-latest.json', { required: true, missing });
  const listings = loadSnapshot<ListingRecord>(opsSnapshotDir, 'listings-latest.json', { required: true, missing });
  const conversations = loadSnapshot<ConversationRecord>(opsSnapshotDir, 'conversations-latest.json', { required: true, missing });
  const ownerStatements = loadSnapshot<OwnerStatementRecord>(opsSnapshotDir, 'owner-statements-latest.json', { required: true, missing });
  const guests = loadSnapshot<GuestRecord>(opsSnapshotDir, 'guests-latest.json', { required: false, missing: [] });
  const payments = loadSnapshot<Record<string, unknown>>(opsSnapshotDir, 'payments-latest.json', { required: false, missing: [] });
  const messageTemplates = loadSnapshot<Record<string, unknown>>(opsSnapshotDir, 'message-templates-latest.json', { required: false, missing: [] });

  const blocked = missing.length > 0
    || !reservations?.records
    || !listings?.records
    || !conversations?.records
    || !ownerStatements?.records;

  const reservationRecords = reservations?.records ?? [];
  const listingRecords = listings?.records ?? [];
  const conversationRecords = conversations?.records ?? [];
  const ownerStatementRecords = ownerStatements?.records ?? [];
  const guestRecords = guests?.records ?? [];

  const listingFreeTextCount = listingRecords.filter(hasListingFreeText).length;
  const propertySummaries = buildPropertySummaries({
    reservations: reservationRecords,
    listings: listingRecords,
    conversations: conversationRecords,
    ownerStatements: ownerStatementRecords,
  });

  const unmappedOwnerStatements = ownerStatementRecords.filter((record) => listingMapIds(record).length === 0).length;
  const multiListingOwnerStatements = ownerStatementRecords.filter((record) => listingMapIds(record).length > 1).length;
  const unallocatedOwnerStatements = unmappedOwnerStatements + multiListingOwnerStatements;
  if (unmappedOwnerStatements > 0) {
    warnings.push(`${unmappedOwnerStatements} owner statement rows lacked a listing id and stay portfolio-only in V1.`);
  }
  if (multiListingOwnerStatements > 0) {
    warnings.push(`${multiListingOwnerStatements} owner statement rows mapped to multiple listings and stay portfolio-only in V1.`);
  }

  const analytics = loadAnalyticsArtifacts(analyticsStatusDir, warnings);

  const revenuePages = buildRevenuePages({
    opsSnapshotDir,
    propertySummaries,
    reservations,
    ownerStatements,
    analytics,
  });
  const guestOpsPages = buildGuestOpsPages({
    opsSnapshotDir,
    propertySummaries,
    conversations,
  });
  const ownerPages = buildOwnerPages({
    opsSnapshotDir,
    propertySummaries,
    ownerStatements,
    unmappedOwnerStatements,
    unallocatedOwnerStatements,
  });

  const groups: SeascapeIngestGroup[] = [
    { view: 'revenue', page_count: revenuePages.length, pages: revenuePages },
    { view: 'guest_ops', page_count: guestOpsPages.length, pages: guestOpsPages },
    { view: 'owner', page_count: ownerPages.length, pages: ownerPages },
  ];

  if (!analytics.ga4) warnings.push('GA4 performance receipt not found; revenue analytics will stay partial.');
  if (!analytics.gsc) warnings.push('GSC impact receipt not found; search impact page will stay partial.');
  if (!analytics.weeklySearch) warnings.push('Weekly search operator/decision receipts not found; weekly search page will stay partial.');
  if (!analytics.weeklyAI) warnings.push('Weekly AI visibility receipt not found; AI visibility page will stay partial.');
  if (!analytics.attribution) warnings.push('Direct-booking attribution receipt not found; attribution page will stay partial.');
  warnings.push('Owner-specific analytics receipts are not part of the current status directory, so owner pages stay ops-only in V1.');

  const analyticsReceipts = [
    analytics.ga4 ? { id: 'ga4_performance', path: analytics.ga4.primary_source_path, window_label: analytics.ga4.window_label } : null,
    analytics.gsc ? { id: 'gsc_search_impact', path: analytics.gsc.primary_source_path, window_label: analytics.gsc.window_label } : null,
    analytics.weeklySearch ? { id: 'weekly_search', path: analytics.weeklySearch.primary_source_path, window_label: analytics.weeklySearch.window_label } : null,
    analytics.weeklyAI ? { id: 'weekly_ai_visibility', path: analytics.weeklyAI.primary_source_path, window_label: analytics.weeklyAI.window_label } : null,
    analytics.attribution ? { id: 'direct_booking_attribution', path: analytics.attribution.primary_source_path, window_label: analytics.attribution.window_label } : null,
  ].filter(Boolean) as SeascapeAnalyticsReceiptRef[];

  const deferredSurfaces: SeascapeDeferredSurface[] = [
    {
      surface: 'reservation stay-event pages',
      records: numeric(reservations?.record_count),
      reason: 'Kept out of the first pass so V1 stays a 23-page rollup spine instead of a 500+ page event import.',
    },
    {
      surface: 'owner statement history pages',
      records: uniqueOwnerStatementPeriods(ownerStatementRecords),
      reason: 'Monthly statement history is deferred until the rollup pages prove useful.',
    },
    {
      surface: 'message templates',
      records: numeric(messageTemplates?.record_count),
      reason: 'Operational draft surfaces stay out of the first rollup cut.',
    },
  ];
  const repeatCandidateCount = guestRecords.filter((record) => cleanString(record.repeat_candidate_reason)).length;
  if (repeatCandidateCount > 0) {
    deferredSurfaces.push({
      surface: 'repeat-guest note candidates',
      records: repeatCandidateCount,
      reason: 'Repeat-candidate notes stay deferred until the rollup pages are stable.',
    });
  }

  const totalPages = groups.reduce((sum, group) => sum + group.page_count, 0);
  const status: SeascapeIngestPlan['status'] = blocked
    ? 'blocked'
    : warnings.some((warning) => /not found|partial|decision-only/i.test(warning))
      ? 'partial'
      : 'ready';

  return {
    schema_version: 1,
    receipt_type: 'seascape_rollup_ingest_plan',
    status,
    dry_run: true,
    ops_snapshot_dir: opsSnapshotDir,
    analytics_status_dir: analyticsStatusDir,
    total_pages: blocked ? 0 : totalPages,
    groups,
    analytics_receipts: blocked ? [] : analyticsReceipts,
    privacy_skips: [
      {
        surface: 'raw guest profiles',
        records: numeric(guests?.record_count),
        reason: 'Guest rows carry contact/profile data and stay out of V1.',
      },
      {
        surface: 'raw payment rows',
        records: numeric(payments?.record_count),
        reason: 'Payment rows can expose billing/refund detail and stay out of V1.',
      },
      {
        surface: 'conversation preview rows',
        records: numeric(conversations?.record_count),
        reason: 'Message-preview rows are operationally useful but remain private for the first cut.',
      },
      {
        surface: 'listing free-text fields',
        records: listingFreeTextCount,
        reason: 'Descriptions, rules, and instructions need separate review before becoming memory pages.',
      },
    ],
    deferred_surfaces: blocked ? [] : deferredSurfaces,
    warnings,
    missing,
    ops_summary: {
      generated_at: latestGeneratedAt([
        reservations?.generated_at,
        listings?.generated_at,
        conversations?.generated_at,
        ownerStatements?.generated_at,
      ]),
      properties_covered: propertySummaries.length,
      reservations: numeric(reservations?.record_count),
      conversations: numeric(conversations?.record_count),
      owner_statements: numeric(ownerStatements?.record_count),
      guests: numeric(guests?.record_count),
      payments: numeric(payments?.record_count),
      message_templates: numeric(messageTemplates?.record_count),
      unmapped_owner_statements: unmappedOwnerStatements,
      unallocated_owner_statements: unallocatedOwnerStatements,
    },
  };
}

export function buildSeascapePages(plan: SeascapeIngestPlan): PageWriteTarget[] {
  const pages: PageWriteTarget[] = [];
  for (const group of plan.groups) {
    for (const page of group.pages) {
      pages.push(buildPageWriteTarget(plan, page));
    }
  }
  return pages;
}

export async function writeSeascapeIngest(engine: BrainEngine, plan: SeascapeIngestPlan, opts: {
  sourceId?: string;
} = {}): Promise<SeascapeWriteResult> {
  if (plan.status === 'blocked') {
    throw new Error(`Seascape ingest plan is blocked: ${plan.missing.join('; ')}`);
  }
  const putPageOp = operations.find((op) => op.name === 'put_page');
  if (!putPageOp) throw new Error('put_page operation missing');
  const cfg = loadConfig() ?? { engine: 'pglite' as const };
  const sourceId = opts.sourceId
    ?? (await resolveSourceWithTier(engine, undefined, process.cwd())).source_id;
  const ctx: OperationContext = {
    engine,
    config: cfg,
    logger: {
      info: (msg: string) => process.stderr.write(`[seascape] ${msg}\n`),
      warn: (msg: string) => process.stderr.write(`[seascape] WARN: ${msg}\n`),
      error: (msg: string) => process.stderr.write(`[seascape] ERROR: ${msg}\n`),
    },
    dryRun: false,
    remote: false,
    sourceId,
  };

  const slugs: string[] = [];
  for (const page of buildSeascapePages(plan)) {
    await putPageOp.handler(ctx, {
      slug: page.slug,
      content: page.content,
      source_kind: 'seascape-rollup',
      source_uri: page.sourceUri,
      ingested_via: 'seascape-rollup',
      // These pages are privacy-screened summaries synthesized by the local
      // collector, not raw guest/email/message payloads, so keep the normal
      // local auto-link + auto-timeline hooks on.
    });
    slugs.push(page.slug);
  }
  return { written: slugs.length, slugs };
}

export function printSeascapeSummary(plan: SeascapeIngestPlan, json = false): void {
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`status: ${plan.status}`);
  console.log(`planned pages: ${plan.total_pages}`);
  for (const group of plan.groups) {
    console.log(`  ${group.view}: ${group.page_count}`);
  }
  console.log(`ops snapshot dir: ${plan.ops_snapshot_dir}`);
  console.log(`analytics status dir: ${plan.analytics_status_dir}`);
  for (const skip of plan.privacy_skips) {
    console.log(`privacy skip - ${skip.surface}: ${skip.records}`);
  }
  if (plan.warnings.length > 0) {
    console.log('warnings:');
    for (const warning of plan.warnings) console.log(`  - ${warning}`);
  }
  if (plan.missing.length > 0) {
    console.log('missing:');
    for (const item of plan.missing) console.log(`  - ${item}`);
  }
}

interface SnapshotLoadOpts {
  required: boolean;
  missing: string[];
}

function loadSnapshot<T>(dir: string, fileName: string, opts: SnapshotLoadOpts): SnapshotEnvelope<T> | null {
  const filePath = join(dir, fileName);
  if (!existsSync(filePath)) {
    if (opts.required) opts.missing.push(`Missing required snapshot: ${filePath}`);
    return null;
  }
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as SnapshotEnvelope<T>;
  if (!Array.isArray(raw.records)) {
    if (opts.required) opts.missing.push(`Snapshot has no records array: ${filePath}`);
    return null;
  }
  return raw;
}

function buildPropertySummaries(input: {
  reservations: ReservationRecord[];
  listings: ListingRecord[];
  conversations: ConversationRecord[];
  ownerStatements: OwnerStatementRecord[];
}): PropertySummary[] {
  const summaries = new Map<number, PropertySummary>();

  const reservationSlugByListing = new Map<number, string>();
  const reservationNameByListing = new Map<number, string>();
  for (const record of input.reservations) {
    const listingMapId = numeric(record.listing_map_id);
    if (!listingMapId) continue;
    const propertySlug = cleanString(record.property_slug);
    if (propertySlug) reservationSlugByListing.set(listingMapId, propertySlug);
    const listingName = cleanString(record.listing_name);
    if (listingName) reservationNameByListing.set(listingMapId, listingName);
  }

  for (const listing of input.listings) {
    const listingMapId = numeric(listing.listing_map_id);
    if (!listingMapId) continue;
    const propertySlug = reservationSlugByListing.get(listingMapId)
      ?? slugPart(cleanString(listing.internal_name) || cleanString(listing.external_name) || `listing-${listingMapId}`);
    summaries.set(listingMapId, {
      listing_map_id: listingMapId,
      property_slug: propertySlug,
      display_name: titleizeSlug(propertySlug, reservationNameByListing.get(listingMapId), listing.internal_name, listing.external_name),
      city: cleanString(listing.city) || undefined,
      state: cleanString(listing.state) || undefined,
      country: cleanString(listing.country) || undefined,
      reservation_count: 0,
      conversation_count: 0,
      attention_count: 0,
      owner_statement_count: 0,
      revenue_total: 0,
      owner_payout_total: 0,
    });
  }

  for (const record of input.reservations) {
    const listingMapId = numeric(record.listing_map_id);
    if (!listingMapId) continue;
    const summary = ensurePropertySummary(summaries, listingMapId, reservationSlugByListing.get(listingMapId), record.listing_name);
    summary.reservation_count += 1;
    summary.revenue_total += numeric(record.total_price);
    summary.first_check_in = minText(summary.first_check_in, cleanString(record.check_in_at));
    summary.last_check_out = maxText(summary.last_check_out, cleanString(record.check_out_at));
  }

  for (const record of input.conversations) {
    const listingMapId = numeric(record.listing_map_id);
    if (!listingMapId) continue;
    const summary = ensurePropertySummary(summaries, listingMapId, reservationSlugByListing.get(listingMapId), undefined);
    summary.conversation_count += 1;
    if (Boolean(record.requires_attention)) summary.attention_count += 1;
    summary.latest_message_at = maxText(summary.latest_message_at, cleanString(record.last_message_at));
  }

  for (const record of input.ownerStatements) {
    const ids = listingMapIds(record);
    if (ids.length !== 1) continue;
    const listingMapId = ids[0]!;
    const summary = ensurePropertySummary(summaries, listingMapId, reservationSlugByListing.get(listingMapId), record.listing_name);
    summary.owner_statement_count += 1;
    summary.owner_payout_total += numeric(record.owner_payout);
    summary.statement_period_start = minText(summary.statement_period_start, cleanString(record.statement_period_start));
    summary.statement_period_end = maxText(summary.statement_period_end, cleanString(record.statement_period_end));
  }

  return Array.from(summaries.values()).sort((a, b) => a.property_slug.localeCompare(b.property_slug));
}

function ensurePropertySummary(
  summaries: Map<number, PropertySummary>,
  listingMapId: number,
  maybeSlug?: string,
  maybeName?: string | null,
): PropertySummary {
  let summary = summaries.get(listingMapId);
  if (!summary) {
    const propertySlug = slugPart(cleanString(maybeSlug) || cleanString(maybeName) || `listing-${listingMapId}`);
    summary = {
      listing_map_id: listingMapId,
      property_slug: propertySlug,
      display_name: titleizeSlug(propertySlug, maybeName),
      reservation_count: 0,
      conversation_count: 0,
      attention_count: 0,
      owner_statement_count: 0,
      revenue_total: 0,
      owner_payout_total: 0,
    };
    summaries.set(listingMapId, summary);
  }
  return summary;
}

function buildRevenuePages(input: {
  opsSnapshotDir: string;
  propertySummaries: PropertySummary[];
  reservations: SnapshotEnvelope<ReservationRecord> | null;
  ownerStatements: SnapshotEnvelope<OwnerStatementRecord> | null;
  analytics: ReturnType<typeof loadAnalyticsArtifacts>;
}): SeascapeIngestPagePlan[] {
  if (!input.reservations?.records || !input.ownerStatements?.records) return [];
  const pages: SeascapeIngestPagePlan[] = [];
  const propertySlugs = input.propertySummaries.map((property) => propertyRevenueSlug(property.property_slug));
  const revenuePortfolio = {
    slug: revenuePortfolioSlug(),
    title: 'Seascape revenue snapshot',
    view: 'revenue' as const,
    scope: 'portfolio' as const,
    summary_lines: [
      `Reservations snapshot rows: ${numeric(input.reservations.record_count)}`,
      `Properties covered: ${input.propertySummaries.length}`,
      `Gross booked revenue in snapshot: ${formatUsd(sumBy(input.propertySummaries, (property) => property.revenue_total))}`,
      `Owner payout total in snapshot: ${formatUsd(sumBy(input.ownerStatements.records, (record) => numeric(record.owner_payout)))}`,
      `Related property pages: ${propertySlugs.map((slug) => `[[${slug}]]`).join(', ')}`,
    ],
    related_titles: input.propertySummaries.map((property) => `${property.display_name} revenue snapshot`),
    timeline_entries: buildTimelineEntries(datePortion(input.reservations.generated_at), 'Revenue rollup refreshed from reservations and owner statements.'),
    source_paths: [join(input.opsSnapshotDir, 'reservations-latest.json'), join(input.opsSnapshotDir, 'owner-statements-latest.json')],
    primary_source_path: join(input.opsSnapshotDir, 'reservations-latest.json'),
  };
  pages.push(revenuePortfolio);

  for (const property of input.propertySummaries) {
    pages.push({
      slug: propertyRevenueSlug(property.property_slug),
      title: `${property.display_name} revenue snapshot`,
      view: 'revenue',
      scope: 'property',
      property_slug: property.property_slug,
      summary_lines: [
        `Portfolio page: [[${revenuePortfolio.slug}]]`,
        `Guest ops page: [[${propertyGuestOpsSlug(property.property_slug)}]]`,
        `Owner page: [[${propertyOwnerSlug(property.property_slug)}]]`,
        `Reservation rows: ${property.reservation_count}`,
        `Gross booked revenue: ${formatUsd(property.revenue_total)}`,
        `Owner payout total: ${formatUsd(property.owner_payout_total)}`,
        property.first_check_in && property.last_check_out ? `Stay window covered: ${property.first_check_in} to ${property.last_check_out}` : 'Stay window covered: unavailable',
      ],
      related_titles: [
        revenuePortfolio.title,
        `${property.display_name} guest ops snapshot`,
        `${property.display_name} owner snapshot`,
      ],
      timeline_entries: buildTimelineEntries(
        datePortion(property.last_check_out) ?? datePortion(input.reservations.generated_at),
        'Revenue rollup refreshed for the latest staged stay window.',
      ),
      source_paths: [join(input.opsSnapshotDir, 'reservations-latest.json'), join(input.opsSnapshotDir, 'owner-statements-latest.json')],
      primary_source_path: join(input.opsSnapshotDir, 'reservations-latest.json'),
    });
  }

  if (input.analytics.ga4) pages.push(input.analytics.ga4);
  if (input.analytics.gsc) pages.push(input.analytics.gsc);
  if (input.analytics.weeklySearch) pages.push(input.analytics.weeklySearch);
  if (input.analytics.weeklyAI) pages.push(input.analytics.weeklyAI);
  if (input.analytics.attribution) pages.push(input.analytics.attribution);
  return pages;
}

function buildGuestOpsPages(input: {
  opsSnapshotDir: string;
  propertySummaries: PropertySummary[];
  conversations: SnapshotEnvelope<ConversationRecord> | null;
}): SeascapeIngestPagePlan[] {
  if (!input.conversations?.records) return [];
  const pages: SeascapeIngestPagePlan[] = [];
  const propertySlugs = input.propertySummaries.map((property) => propertyGuestOpsSlug(property.property_slug));
  const propertyCompanySlugs = input.propertySummaries.map((property) => propertyRevenueSlug(property.property_slug));
  pages.push({
    slug: guestOpsPortfolioSlug(),
    title: 'Seascape guest ops snapshot',
    view: 'guest_ops',
    scope: 'portfolio',
    summary_lines: [
      `Conversation rows: ${numeric(input.conversations.record_count)}`,
      `Requires attention now: ${sumBy(input.propertySummaries, (property) => property.attention_count)}`,
      `Properties covered: ${input.propertySummaries.length}`,
      `Related property pages: ${propertySlugs.map((slug) => `[[${slug}]]`).join(', ')}`,
      `Property companies: ${propertyCompanySlugs.map((slug) => `[[${slug}]]`).join(', ')}`,
    ],
    related_titles: input.propertySummaries.map((property) => `${property.display_name} guest ops snapshot`),
    timeline_entries: buildTimelineEntries(datePortion(input.conversations.generated_at), 'Guest operations rollup refreshed from staged conversation data.'),
    source_paths: [join(input.opsSnapshotDir, 'conversations-latest.json')],
    primary_source_path: join(input.opsSnapshotDir, 'conversations-latest.json'),
  });

  for (const property of input.propertySummaries) {
    pages.push({
      slug: propertyGuestOpsSlug(property.property_slug),
      title: `${property.display_name} guest ops snapshot`,
      view: 'guest_ops',
      scope: 'property',
      property_slug: property.property_slug,
      summary_lines: [
        `Portfolio page: [[${guestOpsPortfolioSlug()}]]`,
        `Revenue page: [[${propertyRevenueSlug(property.property_slug)}]]`,
        `Owner page: [[${propertyOwnerSlug(property.property_slug)}]]`,
        `Conversation rows: ${property.conversation_count}`,
        `Requires attention: ${property.attention_count}`,
        property.latest_message_at ? `Latest message timestamp: ${property.latest_message_at}` : 'Latest message timestamp: unavailable',
      ],
      related_titles: [
        'Seascape guest ops snapshot',
        `${property.display_name} revenue snapshot`,
        `${property.display_name} owner snapshot`,
      ],
      timeline_entries: buildTimelineEntries(
        datePortion(property.latest_message_at) ?? datePortion(input.conversations.generated_at),
        'Guest operations rollup refreshed for the latest staged message activity.',
      ),
      source_paths: [join(input.opsSnapshotDir, 'conversations-latest.json')],
      primary_source_path: join(input.opsSnapshotDir, 'conversations-latest.json'),
    });
  }
  return pages;
}

function buildOwnerPages(input: {
  opsSnapshotDir: string;
  propertySummaries: PropertySummary[];
  ownerStatements: SnapshotEnvelope<OwnerStatementRecord> | null;
  unmappedOwnerStatements: number;
  unallocatedOwnerStatements: number;
}): SeascapeIngestPagePlan[] {
  if (!input.ownerStatements?.records) return [];
  const pages: SeascapeIngestPagePlan[] = [];
  const propertySlugs = input.propertySummaries.map((property) => propertyOwnerSlug(property.property_slug));
  const propertyCompanySlugs = input.propertySummaries.map((property) => propertyRevenueSlug(property.property_slug));
  pages.push({
    slug: ownerPortfolioSlug(),
    title: 'Seascape owner snapshot',
    view: 'owner',
    scope: 'portfolio',
    summary_lines: [
      `Owner statement rows: ${numeric(input.ownerStatements.record_count)}`,
      `Properties covered: ${input.propertySummaries.length}`,
      `Owner payout total: ${formatUsd(sumBy(input.ownerStatements.records, (record) => numeric(record.owner_payout)))}`,
      `Unmapped owner statement rows: ${input.unmappedOwnerStatements}`,
      `Unallocated owner statement rows: ${input.unallocatedOwnerStatements}`,
      `Related property pages: ${propertySlugs.map((slug) => `[[${slug}]]`).join(', ')}`,
      `Property companies: ${propertyCompanySlugs.map((slug) => `[[${slug}]]`).join(', ')}`,
    ],
    related_titles: input.propertySummaries.map((property) => `${property.display_name} owner snapshot`),
    timeline_entries: buildTimelineEntries(datePortion(input.ownerStatements.generated_at), 'Owner rollup refreshed from staged owner statements.'),
    source_paths: [join(input.opsSnapshotDir, 'owner-statements-latest.json')],
    primary_source_path: join(input.opsSnapshotDir, 'owner-statements-latest.json'),
  });

  for (const property of input.propertySummaries) {
    pages.push({
      slug: propertyOwnerSlug(property.property_slug),
      title: `${property.display_name} owner snapshot`,
      view: 'owner',
      scope: 'property',
      property_slug: property.property_slug,
      summary_lines: [
        `Portfolio page: [[${ownerPortfolioSlug()}]]`,
        `Revenue page: [[${propertyRevenueSlug(property.property_slug)}]]`,
        `Guest ops page: [[${propertyGuestOpsSlug(property.property_slug)}]]`,
        `Owner statement rows: ${property.owner_statement_count}`,
        `Owner payout total: ${formatUsd(property.owner_payout_total)}`,
        property.statement_period_start && property.statement_period_end
          ? `Statement period coverage: ${property.statement_period_start} to ${property.statement_period_end}`
          : 'Statement period coverage: unavailable',
      ],
      related_titles: [
        'Seascape owner snapshot',
        `${property.display_name} revenue snapshot`,
        `${property.display_name} guest ops snapshot`,
      ],
      timeline_entries: buildTimelineEntries(
        datePortion(property.statement_period_end) ?? datePortion(input.ownerStatements.generated_at),
        'Owner rollup refreshed for the latest staged statement period.',
      ),
      source_paths: [join(input.opsSnapshotDir, 'owner-statements-latest.json')],
      primary_source_path: join(input.opsSnapshotDir, 'owner-statements-latest.json'),
    });
  }
  return pages;
}

function loadAnalyticsArtifacts(analyticsStatusDir: string, warnings: string[]): {
  ga4: SeascapeIngestPagePlan | null;
  gsc: SeascapeIngestPagePlan | null;
  weeklySearch: SeascapeIngestPagePlan | null;
  weeklyAI: SeascapeIngestPagePlan | null;
  attribution: SeascapeIngestPagePlan | null;
} {
  const ga4Path = latestJsonByPrefix(analyticsStatusDir, 'ga4-performance-email-');
  const gscPath = latestJsonByPrefix(analyticsStatusDir, 'gsc-search-impact-email-');
  const weeklySearchOperatorPath = latestJsonByPrefix(analyticsStatusDir, 'weekly-search-operator-report-');
  const weeklySearchDecisionPath = latestJsonByPrefix(analyticsStatusDir, 'weekly-search-decision-');
  const weeklyAIPath = latestJsonByPrefix(analyticsStatusDir, 'weekly-ai-visibility-decision-');
  const attributionPath = latestJsonByPrefix(analyticsStatusDir, 'post-stay-attribution-candidate-export-');

  const ga4 = ga4Path ? buildGa4Page(ga4Path) : null;
  const gsc = gscPath ? buildGscPage(gscPath) : null;
  const weeklySearch = weeklySearchOperatorPath || weeklySearchDecisionPath
    ? buildWeeklySearchPage(weeklySearchOperatorPath, weeklySearchDecisionPath, warnings)
    : null;
  const weeklyAI = weeklyAIPath ? buildWeeklyAIPage(weeklyAIPath) : null;
  const attribution = attributionPath ? buildAttributionPage(attributionPath) : null;
  return { ga4, gsc, weeklySearch, weeklyAI, attribution };
}

function buildGa4Page(filePath: string): SeascapeIngestPagePlan {
  const receipt = loadJson<Ga4Receipt>(filePath);
  const metrics = (receipt.headline_metrics ?? []).slice(0, 4).map((metric) => {
    const label = cleanString(metric.label) || 'Metric';
    const value = cleanString(metric.display_value) || String(metric.value ?? '');
    return `${label}: ${value}`;
  });
  return {
    slug: 'notes/seascape/revenue/ga4-performance',
    title: 'Seascape GA4 performance summary',
    view: 'revenue',
    scope: 'analytics',
    summary_lines: [
      `Revenue portfolio page: [[${revenuePortfolioSlug()}]]`,
      `Report window: ${cleanString(receipt.report_window?.label) || 'unknown'}`,
      ...metrics,
    ],
    related_titles: ['Seascape revenue snapshot'],
    timeline_entries: buildTimelineEntries(
      datePortion(receipt.report_window?.end_date) ?? datePortion(receipt.report_window?.label),
      'GA4 performance receipt summarized into the Seascape revenue lane.',
    ),
    source_paths: [filePath],
    primary_source_path: filePath,
    window_label: cleanString(receipt.report_window?.label) || undefined,
  };
}

function buildGscPage(filePath: string): SeascapeIngestPagePlan {
  const receipt = loadJson<GscImpactReceipt>(filePath);
  const impact = receipt.impact_metric;
  return {
    slug: 'notes/seascape/revenue/gsc-search-impact',
    title: 'Seascape GSC search impact summary',
    view: 'revenue',
    scope: 'analytics',
    summary_lines: [
      `Revenue portfolio page: [[${revenuePortfolioSlug()}]]`,
      `Reported window: ${cleanString(receipt.reported_window?.label) || 'unknown'}`,
      impact ? `Search clicks: ${impact.value ?? 0} ${cleanString(impact.unit)}` : 'Search clicks: unavailable',
      cleanString(receipt.summary?.headline) || 'Receipt summary: unavailable',
    ],
    related_titles: ['Seascape revenue snapshot'],
    timeline_entries: buildTimelineEntries(
      datePortion(receipt.reported_window?.end_date) ?? datePortion(receipt.reported_window?.label),
      'GSC search impact receipt summarized into the Seascape revenue lane.',
    ),
    source_paths: [filePath],
    primary_source_path: filePath,
    window_label: cleanString(receipt.reported_window?.label) || undefined,
  };
}

function buildWeeklySearchPage(
  operatorPath: string | null,
  decisionPath: string | null,
  warnings: string[],
): SeascapeIngestPagePlan {
  const operator = operatorPath ? loadJson<WeeklySearchOperatorReceipt>(operatorPath) : null;
  const operatorWindow = operatorPath ? weeklySearchReceiptSuffix(operatorPath, 'weekly-search-operator-report-') : null;
  const decisionWindow = decisionPath ? weeklySearchReceiptSuffix(decisionPath, 'weekly-search-decision-') : null;
  const decisionMatchesOperator = Boolean(operatorPath && decisionPath && operatorWindow && operatorWindow === decisionWindow);
  const usableDecisionPath = !operatorPath || decisionMatchesOperator ? decisionPath : null;
  const decision = usableDecisionPath ? loadJson<WeeklySearchOperatorReceipt>(usableDecisionPath) : null;
  const clusters = (operator?.cluster_summary ?? decision?.cluster_summary ?? []).slice().sort((a, b) => numeric(b.gsc_clicks) - numeric(a.gsc_clicks));
  const topCluster = clusters[0];
  if (!operatorPath) warnings.push('Weekly search decision exists without operator receipt; weekly search page is decision-only.');
  if (operatorPath && decisionPath && !decisionMatchesOperator) warnings.push('Weekly search operator and decision receipts cover different windows; weekly search page is partial.');
  return {
    slug: 'notes/seascape/revenue/weekly-search',
    title: 'Seascape weekly search summary',
    view: 'revenue',
    scope: 'analytics',
    summary_lines: [
      `Revenue portfolio page: [[${revenuePortfolioSlug()}]]`,
      `Window: ${operator?.window_start && operator?.window_end ? `${operator.window_start} to ${operator.window_end}` : 'unknown'}`,
      operator?.recommendation?.branch_slug ? `Recommendation: ${operator.recommendation.branch_slug}` : 'Recommendation: hold for more readback',
      topCluster ? `Top cluster by search clicks: ${cleanString(topCluster.cluster) || 'unknown'} (${numeric(topCluster.gsc_clicks)} clicks, ${numeric(topCluster.ga4_sessions)} sessions)` : 'Top cluster by search clicks: unavailable',
      operator?.seo_queue_summary ? `SEO queue buckets tracked: ${operator.seo_queue_summary.length}` : 'SEO queue buckets tracked: unavailable',
    ],
    related_titles: ['Seascape revenue snapshot'],
    timeline_entries: buildTimelineEntries(
      datePortion(operator?.window_end),
      'Weekly search receipt summarized into the Seascape revenue lane.',
    ),
    source_paths: [operatorPath, usableDecisionPath].filter(Boolean) as string[],
    primary_source_path: operatorPath ?? decisionPath ?? '',
    window_label: operator?.window_start && operator?.window_end ? `${operator.window_start} to ${operator.window_end}` : undefined,
  };
}

function buildWeeklyAIPage(filePath: string): SeascapeIngestPagePlan {
  const receipt = loadJson<WeeklyAIDecisionReceipt>(filePath);
  const window = receipt.date_or_window?.window_start && receipt.date_or_window?.window_end
    ? `${receipt.date_or_window.window_start} to ${receipt.date_or_window.window_end}`
    : 'unknown';
  return {
    slug: 'notes/seascape/revenue/weekly-ai-visibility',
    title: 'Seascape weekly AI visibility summary',
    view: 'revenue',
    scope: 'analytics',
    summary_lines: [
      `Revenue portfolio page: [[${revenuePortfolioSlug()}]]`,
      `Window: ${window}`,
      `Next branch: ${cleanString(receipt.next_branch) || 'unknown'}`,
      `Recommendation: ${cleanString(receipt.report_recommendation) || 'unknown'}`,
      `AI visibility status: ${cleanString(receipt.ai_visibility_summary?.status) || 'unknown'}`,
      cleanString(receipt.reason) || 'Reason: unavailable',
    ],
    related_titles: ['Seascape revenue snapshot'],
    timeline_entries: buildTimelineEntries(
      datePortion(receipt.date_or_window?.window_end) ?? datePortion(receipt.date_or_window?.emitted_at),
      'Weekly AI visibility receipt summarized into the Seascape revenue lane.',
    ),
    source_paths: [filePath],
    primary_source_path: filePath,
    window_label: window,
  };
}

function buildAttributionPage(filePath: string): SeascapeIngestPagePlan {
  const receipt = loadJson<AttributionReceipt>(filePath);
  const window = receipt.window?.window_start && receipt.window?.window_end
    ? `${receipt.window.window_start} to ${receipt.window.window_end}`
    : 'unknown';
  return {
    slug: 'notes/seascape/revenue/direct-booking-attribution',
    title: 'Seascape direct-booking attribution summary',
    view: 'revenue',
    scope: 'analytics',
    summary_lines: [
      `Revenue portfolio page: [[${revenuePortfolioSlug()}]]`,
      `Window: ${window}`,
      `Candidate rows: ${numeric(receipt.candidate_count)}`,
      `Current blocker: ${cleanString(receipt.diagnostic?.blocker) || 'none'}`,
    ],
    related_titles: ['Seascape revenue snapshot'],
    timeline_entries: buildTimelineEntries(
      datePortion(receipt.window?.window_end),
      'Direct-booking attribution receipt summarized into the Seascape revenue lane.',
    ),
    source_paths: [filePath],
    primary_source_path: filePath,
    window_label: window,
  };
}

function buildPageWriteTarget(plan: SeascapeIngestPlan, page: SeascapeIngestPagePlan): PageWriteTarget {
  const title = page.title;
  const timelineLines = (page.timeline_entries ?? []).map((entry) => {
    const [date, ...rest] = entry.split(' ');
    return `- **${date}** | ${rest.join(' ')}`.trim();
  });
  const body = [
    `# ${title}`,
    '',
    `View: ${page.view.replace(/_/g, ' ')}`,
    page.scope === 'property' && page.property_slug ? `Property: ${titleizeSlug(page.property_slug)}` : '',
    `Plan status: ${plan.status}`,
    plan.ops_summary.generated_at ? `Latest ops snapshot: ${plan.ops_summary.generated_at}` : '',
    '',
    '## Summary',
    ...page.summary_lines.map((line) => `- ${line}`),
    '',
    '## Privacy guardrails',
    ...plan.privacy_skips.map((skip) => `- ${skip.surface}: ${skip.reason} (${skip.records})`),
    '',
    '## Source files',
    ...page.source_paths.map((sourcePath) => `- ${sourcePath}`),
    '',
    '## Deferred surfaces',
    ...plan.deferred_surfaces.map((surface) => `- ${surface.surface}: ${surface.reason}${typeof surface.records === 'number' ? ` (${surface.records})` : ''}`),
    '',
    '## Timeline',
    ...(timelineLines.length > 0 ? timelineLines : ['- Timeline signal unavailable for this rollup page.']),
  ].filter(Boolean).join('\n');
  const frontmatter: Record<string, unknown> = {
    type: page.slug.startsWith('companies/') ? 'company' : 'note',
    title,
    date: (plan.ops_summary.generated_at ?? new Date().toISOString()).slice(0, 10),
    captured_via: 'seascape-rollup',
    facts_backstop_skip: true,
    seascape_view: page.view,
    seascape_scope: page.scope,
    property_slug: page.property_slug,
    related: page.related_titles,
    source_paths: page.source_paths,
  };
  for (const [key, value] of Object.entries(frontmatter)) {
    if (typeof value === 'undefined') delete frontmatter[key];
  }
  const content = matter.stringify(body.trim() + '\n', frontmatter);
  return {
    slug: page.slug,
    content,
    sourceUri: pathToFileURL(page.primary_source_path).toString(),
  };
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function latestJsonByPrefix(dir: string, prefix: string): string | null {
  if (!existsSync(dir)) return null;
  const match = readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a))[0];
  return match ? join(dir, match) : null;
}

function weeklySearchReceiptSuffix(filePath: string, prefix: string): string | null {
  const filename = basename(filePath);
  if (!filename.startsWith(prefix) || !filename.endsWith('.json')) return null;
  return filename.slice(prefix.length, -'.json'.length);
}

function hasListingFreeText(record: ListingRecord): boolean {
  return Boolean(cleanString(record.description) || cleanString(record.house_rules) || cleanString(record.special_instruction));
}

function listingMapIds(record: OwnerStatementRecord): number[] {
  if (!Array.isArray(record.listing_map_ids)) return [];
  return record.listing_map_ids
    .map((id) => numeric(id))
    .filter((id) => id > 0);
}

function uniqueOwnerStatementPeriods(records: OwnerStatementRecord[]): number {
  return new Set(
    records.map((record) => `${listingMapIds(record).join('+')}:${cleanString(record.statement_period_start)}:${cleanString(record.statement_period_end)}`),
  ).size;
}

function latestGeneratedAt(values: Array<string | undefined>): string | null {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

function revenuePortfolioSlug(): string {
  return 'notes/seascape/revenue/portfolio';
}

function guestOpsPortfolioSlug(): string {
  return 'notes/seascape/guest-ops/portfolio';
}

function ownerPortfolioSlug(): string {
  return 'notes/seascape/owner/portfolio';
}

function propertyRevenueSlug(propertySlug: string): string {
  return `companies/seascape-properties/${propertySlug}`;
}

function propertyGuestOpsSlug(propertySlug: string): string {
  return `notes/seascape/guest-ops/properties/${propertySlug}`;
}

function propertyOwnerSlug(propertySlug: string): string {
  return `notes/seascape/owner/properties/${propertySlug}`;
}

function sumBy<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numeric(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

function buildTimelineEntries(date: string | null, summary: string): string[] {
  if (!date) return [];
  return [`${date} ${summary}`];
}

function datePortion(value: string | undefined | null): string | null {
  const text = cleanString(value);
  if (!text) return null;
  const match = text.match(/\b\d{4}-\d{2}-\d{2}\b/g);
  return match?.at(-1) ?? null;
}

function slugPart(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown';
}

function titleizeSlug(slug: string, ...fallbacks: Array<string | null | undefined>): string {
  const clean = cleanString(slug);
  if (clean) {
    return clean
      .split('-')
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  for (const fallback of fallbacks) {
    const candidate = cleanString(fallback);
    if (candidate) return candidate;
  }
  return 'Unknown Property';
}

function minText(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxText(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export const __testing = {
  buildPropertySummaries,
  buildSeascapePages,
  latestJsonByPrefix,
  slugPart,
  titleizeSlug,
};
