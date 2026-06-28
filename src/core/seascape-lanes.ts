export type SeascapeLaneId =
  | 'seascape-hub'
  | 'seascape-ops'
  | 'seascape-vacations-site'
  | 'seascape-analytics'
  | 'sawyer-hub';

export type SeascapeLaneSourceRole =
  | 'company_knowledge'
  | 'runtime_ops'
  | 'public_site'
  | 'measurement'
  | 'daily_front_door';

export interface SeascapeLaneDefinition {
  id: SeascapeLaneId;
  source_role: SeascapeLaneSourceRole;
  display_name: string;
  operator_alias: string;
  responsibility: string;
  proof_requirement: string;
  default_next_step: string;
  source_matchers: readonly RegExp[];
  candidate_matchers: readonly RegExp[];
}

const LANES: readonly SeascapeLaneDefinition[] = [
  {
    id: 'seascape-hub',
    source_role: 'company_knowledge',
    display_name: 'Seascape Hub',
    operator_alias: 'company knowledge',
    responsibility: 'Business context, strategy, decisions, research, and durable company memory.',
    proof_requirement: 'Verify against Hub canon, decision packets, or source runtime proof before writing canon.',
    default_next_step: 'Verify against Hub packet/canon and source runtime proof before writing a Hub update.',
    source_matchers: [/\bseascape-hub\b/i],
    candidate_matchers: [
      /\bseascape hub\b/i,
      /\bstrategy\b/i,
      /\bcanon\b/i,
      /\bdecision packet\b/i,
      /\bowner demand\b/i,
      /\bpricing strategy\b/i,
      /\bbusiness canon\b/i,
    ],
  },
  {
    id: 'seascape-vacations-site',
    source_role: 'public_site',
    display_name: 'Seascape Vacations Site',
    operator_alias: 'public site execution',
    responsibility: 'Public pages, SEO copy, stays, landing surfaces, and customer-facing site work.',
    proof_requirement: 'Verify against live site behavior, readback, or repo proof before changing public content.',
    default_next_step: 'Verify against site repo/runtime proof, then write the smallest public-site update if still true.',
    source_matchers: [/\bseascape-vacations-site\b/i, /\bvacations-site\b/i],
    candidate_matchers: [
      /\bpublic site\b/i,
      /\bvacations site\b/i,
      /\bstay page\b/i,
      /\bowner page\b/i,
      /\bseo copy\b/i,
      /\blanding page\b/i,
      /\barticle\b/i,
      /\bguide\b/i,
    ],
  },
  {
    id: 'seascape-ops',
    source_role: 'runtime_ops',
    display_name: 'Seascape Ops',
    operator_alias: 'runtime and operators',
    responsibility: 'Workers, alerts, operator workflows, delivery state, and runtime receipts.',
    proof_requirement: 'Verify against ops code, logs, or runtime receipts before writing operational state.',
    default_next_step: 'Verify against ops code, logs, or receipts before writing an ops update.',
    source_matchers: [/\bseascape-ops\b/i],
    candidate_matchers: [
      /\bruntime\b/i,
      /\boperator\b/i,
      /\bworker\b/i,
      /\boutlook\b/i,
      /\bdrive\b/i,
      /\bhostaway\b/i,
      /\bpricelabs\b/i,
      /\bguest\b/i,
      /\bowner lead\b/i,
      /\bautomation\b/i,
      /\bscheduler\b/i,
    ],
  },
  {
    id: 'seascape-analytics',
    source_role: 'measurement',
    display_name: 'Seascape Analytics',
    operator_alias: 'measurement',
    responsibility: 'Analytics, attribution, dashboards, metrics, and evidence for business decisions.',
    proof_requirement: 'Verify against measurement queries, dashboards, or receipts before writing metric claims.',
    default_next_step: 'Verify against analytics queries, dashboards, or receipts before writing a measurement update.',
    source_matchers: [/\bseascape-analytics\b/i],
    candidate_matchers: [
      /\banalytics\b/i,
      /\bmeasurement\b/i,
      /\battribution\b/i,
      /\bdashboard\b/i,
      /\bmetric\b/i,
      /\bmetrics\b/i,
      /\bfunnel\b/i,
      /\bconversion rate\b/i,
    ],
  },
  {
    id: 'sawyer-hub',
    source_role: 'daily_front_door',
    display_name: 'Sawyer Hub',
    operator_alias: 'daily front door',
    responsibility: 'Today, open loops, receipts, next actions, and Sawyer-facing operating context.',
    proof_requirement: 'Verify against current receipts and active operating context before writing Sawyer orchestration surfaces.',
    default_next_step: 'Verify against Sawyer Hub current surfaces before writing a small orchestration update.',
    source_matchers: [/\bsawyer-hub\b/i],
    candidate_matchers: [
      /\bsawyer hub\b/i,
      /\btoday'?s focus\b/i,
      /\bpersonal orchestration\b/i,
      /\bcontrol room\b/i,
      /\breview board\b/i,
      /\bhome\.md\b/i,
    ],
  },
] as const;

export const SEASCAPE_LANES: readonly SeascapeLaneDefinition[] = LANES;

export function getSeascapeLane(id: SeascapeLaneId): SeascapeLaneDefinition {
  const lane = LANES.find((entry) => entry.id === id);
  if (!lane) {
    throw new Error(`Unknown Seascape lane: ${id}`);
  }
  return lane;
}

export function isSeascapeLaneId(value: unknown): value is SeascapeLaneId {
  return typeof value === 'string' && LANES.some((lane) => lane.id === value);
}

export function matchSeascapeLaneForSource(source: {
  id: string;
  name: string;
  local_path: string | null;
}): SeascapeLaneDefinition | null {
  const haystack = `${source.id} ${source.name} ${source.local_path ?? ''}`;
  for (const lane of LANES) {
    if (lane.source_matchers.some((re) => re.test(haystack))) {
      return lane;
    }
  }
  return null;
}
