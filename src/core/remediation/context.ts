// src/core/remediation/context.ts
// v0.41.18.0 (A1, codex finding #2). Extracted verbatim from
// src/commands/doctor.ts:loadRecommendationContext so both the doctor
// CLI shell AND the new gbrain onboard / MCP run_onboard surfaces
// build the same context object.
//
// Pure read; no side effects.

import type { BrainEngine } from '../engine.ts';
import type { RecommendationContext } from '../brain-score-recommendations.ts';
import { CHUNKER_VERSION } from '../chunkers/code.ts';
import { isSourceUnchangedSinceSync } from '../git-head.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../link-extraction.ts';
import {
  EXTRACTION_LAG_WARN_PCT_DEFAULT,
  resolveEnvNumber,
} from '../extraction-lag.ts';

const DEFAULT_SYNC_REMEDIATION_WARN_HOURS = 24;
const SYNC_FRESHNESS_WARN_HOURS_ENV = 'GBRAIN_SYNC_FRESHNESS_WARN_HOURS';
const DEFAULT_EXTRACT_ATOMS_WARN_THRESHOLD = 10;
const DEFAULT_EXTRACT_ATOMS_DRAIN_WINDOW_SECONDS = 120;

// Re-export so consumers can `import { RecommendationContext } from '../remediation'`
// — the canonical RecommendationContext type still lives in
// brain-score-recommendations.ts (it's also the input to computeRecommendations).
export type { RecommendationContext };

/**
 * Build RecommendationContext from engine + config. Pure read; no
 * side effects. Used by computeRemediationPlan, runRemediation, and
 * the doctor CLI surface.
 */
export async function loadRecommendationContext(
  engine: BrainEngine,
  opts: {
    repoPath?: string;
    sourceScoped?: boolean;
    inspectLocalSourcePaths?: boolean;
    /** Focused test/integration seam to reuse a packet without another scan. */
    sourceHygienePacket?: RecommendationContext['sourceHygiene'];
  } = {},
): Promise<RecommendationContext> {
  // v0.37 fix wave (Lane E.4 + CDX2-11): read schema-sizing fields from
  // gateway, not DB. The DB plane is schema-applied metadata; the file
  // plane is the gateway runtime source. Pre-fix this context produced
  // stale recommendations on fresh installs whose DB rows hadn't been
  // populated.
  //
  // Also extended the API-key check to recognize the ZE key alongside
  // OpenAI (was OpenAI-only). After Lane C.3, zeroentropy_api_key lives
  // in GBrainConfig + propagates to the gateway env dict.
  const repoPath = opts.repoPath ?? await engine.getConfig('sync.repo_path');
  let sourceId: string | undefined;
  let repoNeedsSync = false;
  let staleExtractionPages = 0;
  let staleExtractionTotalPages = 0;
  let extractAtomsPackDeclaresPhase: boolean | undefined;
  let extractAtomsBacklogBySource: RecommendationContext['extractAtomsBacklogBySource'];
  let extractAtomsDrainWindowSeconds = DEFAULT_EXTRACT_ATOMS_DRAIN_WINDOW_SECONDS;
  let sourceHygiene: RecommendationContext['sourceHygiene'] = opts.sourceHygienePacket;

  if (opts.inspectLocalSourcePaths === true && !sourceHygiene) {
    const { inspectSourceHygiene } = await import('../source-hygiene.ts');
    sourceHygiene = await inspectSourceHygiene(engine, { inspectFilesystem: true });
  }

  if (repoPath) {
    try {
      const configuredSourceId = await engine.getConfig('sources.default');
      const rows = await engine.executeRaw<{
        id: string;
        local_path: string | null;
        last_commit: string | null;
        chunker_version: string | number | null;
        last_sync_at: string | Date | null;
      }>(
        `SELECT id, local_path, last_commit, chunker_version, last_sync_at
           FROM sources
          WHERE local_path = $1
            AND archived = false
          ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END, id
          LIMIT 1`,
        [repoPath, configuredSourceId ?? 'default'],
      );
      const source = rows[0];
      if (source) {
        if (opts.sourceScoped === true) sourceId = source.id;
        const gitFresh = opts.inspectLocalSourcePaths === true
          ? isSourceUnchangedSinceSync(source.local_path, source.last_commit, {
              requireCleanWorkingTree: 'ignore-untracked',
            })
          : false;
        const chunkerFresh = String(source.chunker_version ?? '') === String(CHUNKER_VERSION);
        repoNeedsSync = !chunkerFresh || (!gitFresh && isPastSyncRemediationWindow(source.last_sync_at));
        const sourceDecision = sourceHygiene?.sources.find((row) => row.source_id === source.id);
        if (
          sourceDecision?.classification === 'recovery_required' &&
          sourceDecision.recovery_mode !== 'managed_clone_sync'
        ) {
          repoNeedsSync = false;
        }
      } else {
        repoNeedsSync = true;
      }
    } catch {
      // Older or partially migrated schemas should still be able to render a
      // remediation plan; stale extraction below is best-effort for the same reason.
    }
  }

  try {
    const totalRows = await engine.executeRaw<{ count: number }>(
      sourceId
        ? `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL AND source_id = $1`
        : `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL`,
      sourceId ? [sourceId] : [],
    );
    staleExtractionTotalPages = Number(totalRows[0]?.count ?? 0);
    staleExtractionPages = await engine.countStalePagesForExtraction({
      sourceId,
      versionTs: LINK_EXTRACTOR_VERSION_TS,
    });
  } catch {
    staleExtractionPages = 0;
    staleExtractionTotalPages = 0;
  }

  try {
    const configuredWindow = await engine.getConfig('autopilot.auto_drain.window_seconds');
    extractAtomsDrainWindowSeconds = parsePositiveInt(
      configuredWindow,
      DEFAULT_EXTRACT_ATOMS_DRAIN_WINDOW_SECONDS,
    );
  } catch {
    extractAtomsDrainWindowSeconds = DEFAULT_EXTRACT_ATOMS_DRAIN_WINDOW_SECONDS;
  }

  try {
    const { packDeclaresPhase } = await import('../cycle.ts');
    extractAtomsPackDeclaresPhase = await packDeclaresPhase(engine, 'extract_atoms');
  } catch {
    extractAtomsPackDeclaresPhase = false;
  }

  if (extractAtomsPackDeclaresPhase === false) {
    try {
      const { countExtractAtomsBacklog } = await import('../cycle/extract-atoms.ts');
      const sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
        `SELECT id, local_path
           FROM sources
          WHERE archived = false
          ORDER BY id`,
        [],
      );
      const scopedSources = sources.length > 0
        ? sources
        : [{ id: sourceId ?? 'default', local_path: repoPath ?? null }];
      const backlogs: NonNullable<RecommendationContext['extractAtomsBacklogBySource']> = [];
      for (const src of scopedSources) {
        const backlog = await countExtractAtomsBacklog(engine, src.id);
        if (backlog !== null && backlog > 0) {
          backlogs.push({
            sourceId: src.id,
            backlog,
            repoPath: src.local_path ?? undefined,
          });
        }
      }
      extractAtomsBacklogBySource = backlogs;
    } catch {
      extractAtomsBacklogBySource = [];
    }
  }

  let embeddingModel: string | undefined;
  let embeddingDimensions: number | undefined;
  try {
    const gw = await import('../ai/gateway.ts');
    embeddingModel = gw.getEmbeddingModel();
    embeddingDimensions = gw.getEmbeddingDimensions();
  } catch {
    // Gateway unconfigured — fall back to DB plane as a best-effort hint
    // (preserves doctor running before any engine.connect()).
    const dbModel = await engine.getConfig('embedding_model');
    const dbDims = await engine.getConfig('embedding_dimensions');
    embeddingModel = dbModel ?? undefined;
    embeddingDimensions = dbDims ? Number(dbDims) : undefined;
  }
  // v0.40.x: recipe-aware provider check, shared with autopilot.ts via
  // embeddingProviderConfigured(). Local providers (ollama, llama-server —
  // empty auth_env.required) need no hosted key; hosted providers check
  // their OWN required key (so a Voyage brain is judged by VOYAGE_API_KEY,
  // not by whether an OpenAI/ZE key happens to exist — the pre-fix wart).
  // fileCfg loads synchronously, so the resolveKey closure is sync.
  const { loadConfigFileOnly } = await import('../config.ts');
  const fileCfg = loadConfigFileOnly();
  const { embeddingProviderConfigured, HOSTED_EMBED_KEY_CONFIG } = await import(
    '../brain-score-recommendations.ts'
  );
  const embeddingConfigured = embeddingProviderConfigured(embeddingModel, (envVar) => {
    const cfgField = HOSTED_EMBED_KEY_CONFIG[envVar];
    const fromCfg = cfgField ? (fileCfg as Record<string, unknown> | null)?.[cfgField] : undefined;
    return !!(process.env[envVar] || fromCfg);
  });
  return {
    sourceId,
    repoPath: repoPath ?? undefined,
    repoNeedsSync,
    staleExtractionPages,
    staleExtractionTotalPages,
    staleExtractionSourceScoped: opts.sourceScoped === true,
    extractionLagWarnPct: resolveEnvNumber(
      'GBRAIN_EXTRACTION_LAG_WARN_PCT',
      EXTRACTION_LAG_WARN_PCT_DEFAULT,
      { unit: '%', warnPrefix: '[gbrain doctor]' },
    ),
    embeddingModel,
    embeddingDimensions,
    embeddingProviderConfigured: embeddingConfigured,
    hasChatApiKey: !!(process.env.ANTHROPIC_API_KEY || fileCfg?.anthropic_api_key),
    extractAtomsPackDeclaresPhase,
    extractAtomsBacklogBySource,
    extractAtomsWarnThreshold: DEFAULT_EXTRACT_ATOMS_WARN_THRESHOLD,
    extractAtomsDrainWindowSeconds,
    sourceHygiene,
  };
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isPastSyncRemediationWindow(lastSyncAt: string | Date | null): boolean {
  if (!lastSyncAt) return true;
  const lastSyncMs = lastSyncAt instanceof Date ? lastSyncAt.getTime() : Date.parse(lastSyncAt);
  if (!Number.isFinite(lastSyncMs)) return true;
  const ageMs = Date.now() - lastSyncMs;
  if (ageMs < 0) return true;
  return ageMs >= syncRemediationWarnHours() * 60 * 60 * 1000;
}

function syncRemediationWarnHours(): number {
  const raw = process.env[SYNC_FRESHNESS_WARN_HOURS_ENV];
  if (raw === undefined || raw === '') return DEFAULT_SYNC_REMEDIATION_WARN_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SYNC_REMEDIATION_WARN_HOURS;
}
