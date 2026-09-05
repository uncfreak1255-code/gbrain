# CLAUDE.md

GBrain is a personal knowledge brain and GStack mod for agent platforms. Pluggable
engines: PGLite (embedded Postgres via WASM, zero-config default) or Postgres + pgvector
+ hybrid search in a managed Supabase instance. `gbrain init` defaults to PGLite;
suggests Supabase for 1000+ files. GStack teaches agents how to code. GBrain teaches
agents everything else: brain ops, signal detection, content ingestion, enrichment,
cron scheduling, reports, identity, and access control.

## North Star

gbrain aims to be the **next Postgres for memory**: the most well-tested, widest-coverage,
best-for-the-most-at-the-least retrieval + agent memory system for company brains and
personal AI, built to serve a billion people. Every feature and every eval is judged
against this bar. "gbrain is best" is a WHOLE-SYSTEM claim — proven across the full
BrainBench suite (retrieval, longmemeval, calibration, …) — not by any single feature.
When scoping an eval, prove the FEATURE delivers value to gbrain users; do not waste it
proving that gbrain's particular algorithm beats some other algorithm (a research
bake-off, off-mission).

## Two organizational axes (read this first)

GBrain knowledge is organized along two orthogonal axes. Users AND agents must
understand both, or queries misroute silently.

- **Brain** — WHICH DATABASE. Your personal brain is `host`. You can mount
  additional brains (team-published, each with their own DB and access policy)
  via `gbrain mounts add` (v0.19+). Routing: `--brain`, `GBRAIN_BRAIN_ID`,
  `.gbrain-mount` dotfile.
- **Source** — WHICH REPO INSIDE THE DATABASE. A brain can hold many sources
  (wiki, gstack, openclaw, essays). Slugs scope per source. Routing:
  `--source`, `GBRAIN_SOURCE`, `.gbrain-source` dotfile.

Both axes follow the same 6-tier resolution pattern. Read
`docs/architecture/brains-and-sources.md` for topology diagrams (personal, team
mount, CEO-class with multiple team brains) and
`skills/conventions/brain-routing.md` for the agent-facing decision table.

## Architecture

Contract-first: `src/core/operations.ts` defines ~92 shared operations (notable:
`get_recent_salience`, `find_anomalies`, `get_recent_transcripts`, `find_trajectory`,
`volunteer_context` — push-based context, see `docs/guides/push-context.md`). CLI and MCP
server are both generated from this single source. Engine factory (`src/core/engine-factory.ts`)
dynamically imports the configured engine (`'pglite'` or `'postgres'`). Skills are fat
markdown files (tool-agnostic, work with both CLI and plugin contexts).

Some agent-facing surfaces are CLI-only (not ops): `gbrain autopilot` (self-maintaining
brain daemon — sync → extract → embed on an interval, durable via the minion queue), the
durability/push path (`gbrain sources harden`), and the deterministic ingestion collectors
(`gbrain drive ingest`, `gbrain outlook scan` — code collects + classifies, LLM judges).

**Trust boundary:** `OperationContext.remote` distinguishes trusted local CLI callers
(`remote: false` set by `src/cli.ts`) from untrusted agent-facing callers
(`remote: true` set by `src/mcp/server.ts`). Security-sensitive operations like
`file_upload` tighten filesystem confinement when `remote=true` and default to
strict behavior when unset.

**Brain-repo push + credentials (secure by default).** `gbrain sources harden` /
`--pat-file` on `sources add` is gbrain's first push path and first credential storage.
The GitHub token is wired per-repo (least-privilege; reuses an existing credential helper
when present) and NEVER enters the repo, the tracked remote URL, logs, or any run report.
Push automation is installed locally per-machine, not committed. Hardening proves push
works with a `pushProbe` dry-run before declaring done, so a read-only token or protected
branch surfaces immediately instead of silently dropping writes. `git-remote.ts` keeps the
SSRF-hardened flags on every git invocation. See the `git-remote.ts` / `sources-harden.ts`
entries in `KEY_FILES.md`.

**Cross-cutting invariants (must-never-violate, regardless of which file you touch).**
These used to be buried across the per-file index; they live here so they always load.
Per-file detail is in `docs/architecture/KEY_FILES.md`.

- **Trust is fail-closed.** `OperationContext.remote` is REQUIRED on the type. Anything not
  strictly `false` is treated as remote/untrusted (`ctx.remote === false` for trusted-only
  sites; `ctx.remote !== false` for untrust-unless-explicit-false). Don't default it falsy.
- **Source isolation.** Every read-side op routes through `sourceScopeOpts(ctx)`; precedence
  is federated array (`ctx.auth.allowedSources`) > scalar (`ctx.sourceId`) > nothing. Don't
  hand-roll source filtering — a missed thread is a cross-source data leak.
- **JSONB: never `JSON.stringify` into a `::jsonb` cast.** postgres.js double-encodes it;
  PGLite hides the bug. Pass raw objects to `engine.executeRaw`, or use `executeRawJsonb`.
  Guarded by `scripts/check-jsonb-pattern.sh`.
- **Engine parity.** `src/core/postgres-engine.ts` and `src/core/pglite-engine.ts` move in
  lockstep — a new method/SQL shape lands in BOTH, pinned by `test/e2e/engine-parity.test.ts`.
  Forward-referenced columns/indexes go in the bootstrap probe set (guarded by
  `test/schema-bootstrap-coverage.test.ts`).
- **Contract-first.** `src/core/operations.ts` is the single source; CLI + MCP are generated
  from it. Every op carries `scope: 'read'|'write'|'admin'` + optional `localOnly`. HTTP
  dispatch enforces scope/localOnly before the handler runs.
- **Migrations.** Schema DDL lives in the `MIGRATIONS` array in `src/core/migrate.ts`.
  `CREATE INDEX CONCURRENTLY` needs `transaction: false` (pre-drop invalid remnants on
  Postgres; plain `CREATE INDEX` on PGLite via `sqlFor.pglite`).
- **Multi-source.** Slug uniqueness is `(source_id, slug)`, not slug. Key batch ops and
  reverse-writes on the composite key; `validateSourceId` before any `source_id` path join.
- **One canonical chat-pricing table.** All paid-cloud chat/completion prices live ONCE in
  `src/core/model-pricing.ts` (`CANONICAL_PRICING` + `canonicalLookup`). Every other table
  (`anthropic-pricing.ts`'s `ANTHROPIC_PRICING`, `takes-quality-eval/pricing.ts`'s
  `MODEL_PRICING`, the contradictions/cross-modal/skillopt cost views) is a DERIVED view, never
  a hand-copied duplicate — so cross-table price drift is structurally impossible. Update a
  price in `model-pricing.ts` only; each consumer keeps its own key allowlist + miss policy
  (fail-closed vs warn-only vs null), not its own numbers. Pinned by `test/model-pricing.test.ts`
  (drift guard asserts each view equals canonical). Embeddings price separately in
  `embedding-pricing.ts` (different unit).


## Reference map (load on demand)

CLAUDE.md is the always-loaded orientation + dispatcher. Detailed reference loads
on demand — read the linked doc before working in that area. (Same two-layer
pattern gbrain ships for its own skills: thin router in `skills/RESOLVER.md`, fat
detail on demand.)

| When you're working on... | Read first |
|---|---|
| any file in `src/` (what it does + its invariants) | `docs/architecture/KEY_FILES.md` — find the file's entry |
| search / ranking / hybrid / retrieval | `docs/architecture/RETRIEVAL.md` + the `search/*` entries in `KEY_FILES.md` |
| search mode bundles (`conservative`/`balanced`/`tokenmax`) / cost knobs / `knobs_hash` | `docs/architecture/search-mode-config.md` |
| which search COMMAND to use (keyword vs hybrid vs direct get) | `docs/guides/search-modes.md` |
| embedding spend gates / cost gate / `spend.posture` / off switches | `docs/operations/spend-controls.md` |
| push-based context (volunteer/watch/reflex window) | `docs/guides/push-context.md` |
| deterministic ingestion collectors (Drive, Outlook, code-collects-LLM-judges) | `docs/guides/deterministic-collectors.md` + the `drive.ts`/`outlook.ts` entries in `KEY_FILES.md` |
| brain-repo durability / push / credential storage | the `git-remote.ts`/`sources-harden.ts` entries in `KEY_FILES.md` |
| self-maintaining brain daemon | the `autopilot.ts` entries in `KEY_FILES.md` |
| DB-contention-aware backfill pacing | `docs/operations/pace-mode.md` + `src/core/pace-mode.ts`, `db-pacer.ts` |
| schema packs / page types / extraction | `docs/architecture/schema-packs.md`, `type-taxonomy.md`, `lens-packs.md` |
| thin-client / remote MCP / cross-modal | `docs/architecture/thin-client.md` |
| the CLI surface (commands + flags) | `gbrain --help` / `gbrain --tools-json`, plus the relevant `KEY_FILES.md` entry |
| running or writing tests | `docs/TESTING.md` |
| bulk-command progress wiring | `docs/progress-events.md` |
| eval methodology / metrics | `docs/eval/` |
| brains vs sources / topology | `docs/architecture/brains-and-sources.md`, `topologies.md` |
| skill routing | `skills/RESOLVER.md` |
| shipping a release / CHANGELOG / PR conventions | `docs/RELEASING.md` (ship IRON RULES stay inline below) |

## Maintaining CLAUDE.md and the reference docs

CLAUDE.md grew to ~592KB / ~147k tokens once the per-file index became append-only
(one `**vX.Y.Z:**` clause per release per file). That is the exact anti-pattern
gbrain exists to fix. The rules that keep it from recurring:

- **CLAUDE.md is orientation, not the implementation spec.** It carries the North
  Star, the two axes, architecture + cross-cutting invariants, the resolver, and
  the inline IRON RULES. Per-file/per-command/per-test detail lives in the
  reference docs and loads on demand.
- **Reference docs (`KEY_FILES.md`, `thin-client.md`, `TESTING.md`) describe
  CURRENT behavior only.** Release history goes in `CHANGELOG.md` + git. Do NOT
  append `**vX.Y.Z (#NNN):**` clauses, codex/review tags, or "pre-fix/then/was-now"
  narration. When a file's behavior changes, UPDATE its entry to the new truth.
- **CI is the enforcement, not this prose.** `scripts/check-key-files-current-state.sh`
  (in `bun run verify`) fails on the bolded-release-clause marker in the reference
  docs AND on a CLAUDE.md size cap. A written rule caused this disease; a guard
  cures it.
- **After any CLAUDE.md or reference-doc edit, run `bun run build:llms`** — the
  llms bundle inlines/links these (config in `scripts/llms-config.ts`); the
  freshness + budget test (`bun test test/build-llms.test.ts`) fails CI otherwise.

## Search Mode (v0.32.3)

GBrain ships three named search modes — `conservative` / `balanced` / `tokenmax`
— that bundle the search-lite knobs into a single config key. Pick one at install
time; the rest of the project resolves through `src/core/search/mode.ts`.

**Read `docs/architecture/search-mode-config.md` before touching any of it**: the
per-knob bundle table, the cost-anchor matrices (25x corner-to-corner; the same
matrix is duplicated verbatim in the `gbrain init` cost picker — update both), the
`knobs_hash` cache-contamination rules, relational retrieval, and the three
`gbrain search modes|stats|tune` CLI surfaces all live there.

**Resolution chain** (matches the v0.31.12 model-tier pattern at
`src/core/model-config.ts:resolveModel`):

    per-call SearchOpts → per-key config (search.cache.enabled, …) →
      MODE_BUNDLES[search.mode] → MODE_BUNDLES.balanced (fallback)

Mode resolution lives in **bare `hybridSearch`** (NOT just the cached wrapper)
per `[CDX-5+6]` in `~/.claude/plans/lets-take-a-look-validated-parrot.md` — so
`gbrain eval replay` and `gbrain eval longmemeval` test the same mode-affected
behavior as the production `query` op.

**Cache keys are knob-scoped.** `query_cache.knobs_hash` folds the mode knobs, the
active embedding column + provider, and the relational knob + depth into the
lookup filter, so a tokenmax write can never be served to a conservative read (or
a Voyage-embedded row to an OpenAI-embedded query).
`mode.ts:KNOBS_HASH_VERSION` is the single source of truth — bumping it costs a
one-time miss spike on upgrade. Details in `search-mode-config.md`.

## Eval discipline (v0.32.3)

Every metric printed by any `gbrain eval *` or `gbrain search stats` command
resolves through `src/core/eval/metric-glossary.ts` so industry terms
(`P@k`, `nDCG@k`, `MRR`, `Jaccard@k`) carry a plain-English line in human
output and a `_meta.metric_glossary` block in JSON output (one block per
response per `[CDX-25]`, NOT sibling `_gloss` fields).

The full methodology — datasets, sample selection, pre-registered
expectations, threats to validity, paired-bootstrap + Bonferroni p-value
discipline `[CDX-14]` — lives in `docs/eval/SEARCH_MODE_METHODOLOGY.md`.
Auto-regenerated `docs/eval/METRIC_GLOSSARY.md` is CI-guarded against
drift (`scripts/check-eval-glossary-fresh.sh`).

Per-run records land at `<repo>/.gbrain-evals/eval-results.jsonl` per
`[CDX-23]`. The user's personal `~/.gbrain` brain is NEVER touched —
audit trail lives in the source repo's git history.

## Skills

Read the skill files in `skills/` before doing brain operations. `skills/RESOLVER.md`
is the router and the authoritative inventory — read it rather than trusting a list
here (`AGENTS.md` is also accepted as of v0.19). Skills are fat markdown:
tool-agnostic, working with both CLI and plugin contexts. `minion-orchestrator` is
the single unified skill for BOTH lanes of background work — shell jobs via
`gbrain jobs submit shell` and LLM subagents via `gbrain agent run`.

**Conventions:** `skills/conventions/` has cross-cutting rules (quality, brain-first,
model-routing, test-before-bulk, cross-modal). `skills/_brain-filing-rules.md` and
`skills/_output-rules.md` are shared references.

**Routing-table compression:** `skills/functional-area-resolver/` is a two-layer
dispatch pattern for shrinking large AGENTS.md / RESOLVER.md files (>=12KB) without
losing routing accuracy — one entry per functional area instead of one row per skill.
The `(dispatcher for: ...)` clause is the LOAD-BEARING signal: strip it and lenient
routing accuracy collapses to 41.7% on Sonnet. Method, cross-model receipts, and the
reproduce command live in `evals/functional-area-resolver/README.md` (kept outside
`skills/` deliberately so the skillpack bundler doesn't ship eval infrastructure
downstream).

**Brain-resident skillpacks + advisor (v0.42.47.0, #2180):** A brain repo can carry its
own publishable skillpack (`brain_resident: true` in `skillpack.json` + `schema_pack`);
`gbrain skillpack init-brain-pack` scaffolds one with a 5-section machine-parseable README.
Connecting harnesses discover it on `gbrain sources add` (Topology A advisory, bounded nag
via `nag-state.ts`) and over MCP via the source-scoped `list_brain_skillpack` op +
`get_skill --source_id` (gated by `mcp.publish_skills`). The bundled `gbrain-advisor` skill
+ `gbrain advisor` op compute a ranked, read-only list of high-leverage actions from brain
state (8 collectors in `src/core/advisor/`); `--json`+exit codes for CI/cron, local-only
`--apply <id>` behind confirm, exposed over MCP behind `mcp.publish_advisor` (default off,
read-only on remote). Thin-client binary install stays deferred to PR2 `build_skillpack`.

**Operational health (v0.19.1):** smoke-test (8 post-restart health checks with auto-fix
for Bun, CLI, DB, worker, Zod CJS, gateway, API key, brain repo; user-extensible via
`~/.gbrain/smoke-tests.d/*.sh`).

## Bulk-action progress reporting

All bulk commands stream progress through the shared reporter at
`src/core/progress.ts`. Agents get heartbeats within 1 second of every iteration
regardless of how slow the underlying work is. **Wiring instructions, the command
list, and the event schema are in `docs/progress-events.md` — read it before
adding a new bulk command.** The rules that must hold regardless:

- Progress always writes to **stderr**. Stdout stays clean for data output
  (`--json` payloads, final summaries, JSON action events from `extract`).
  Never call `process.stdout.write('\r...')` in bulk paths —
  `scripts/check-progress-to-stdout.sh` is a CI guard wired into `bun run test`
  that fails the build on it.
- Non-TTY default: plain one-line-per-event human text. JSON requires the
  explicit `--progress-json` flag.
- Global flags (`--quiet`, `--progress-json`, `--progress-interval=<ms>`)
  are parsed by `src/core/cli-options.ts` BEFORE command dispatch.
- Phase names are machine-stable `snake_case.dot.path` (e.g.
  `doctor.db_checks`, `sync.imports`); additive changes only.

## Capturing test output (NEVER pipe through `tail` / `head`)

**Iron rule:** when running `bun test`, `bun run test:e2e`, `bun run typecheck`,
or any other test/check command, redirect to a file FIRST, then `tail` the file
separately:

```bash
# RIGHT — full output preserved, real exit code visible
bun test > /tmp/ship_units.txt 2>&1
echo "EXIT=$?"
tail -50 /tmp/ship_units.txt
grep -E '(fail\)|✗|error:' /tmp/ship_units.txt | head -30
```

```bash
# WRONG — exit code is `tail`'s (always 0), failures truncated, ship gates fail open
bun test 2>&1 | tail -10
```

The pipe form hides failures and can report a false success because:
- `$?` after a pipe is the LAST command's exit code (`tail` → 0), not bun's
- bun prints failure details before the summary line, so `tail -N` drops them
- Triage needs the full failure list to distinguish changed behavior from baseline failures

This bit us during v0.26.2 ship: `bun test 2>&1 | tail -10` reported "3911 pass / 23 fail"
but no failure details survived, forcing a 23-minute re-run to triage.

Apply the same pattern to any long-running command whose exit code matters:
`bun run typecheck`, `bun run ci:local`, migration runs, eval suites, etc.
For background tasks (`run_in_background: true`), the harness captures the exit
file separately — use it via the bg task's `<id>.exit` file, not the streamed
output.

## Sync resumability + lock tuning (v0.42.x, #1794)

`gbrain sync` is resumable and converges under pool exhaustion + repeated kills.
Progress banks into the append-only `op_checkpoint_paths` table (one row per drained
path, written via the direct session pool so it survives `EMAXCONNSESSION`); a killed
run resumes from the checkpoint and `last_commit` only advances on true completion. The
per-source lock heartbeats through the direct pool and refuses to steal a live,
recently-refreshed holder. Five env knobs tune it (all env-only, incident-time escape
hatches — no config-dashboard surface by design):

| Env var | Default | What it does |
|---|---|---|
| `GBRAIN_SYNC_CHECKPOINT_EVERY` | 1000 | Flush the checkpoint every N drained files. |
| `GBRAIN_SYNC_CHECKPOINT_SECONDS` | 10 | Also flush every N seconds (whichever comes first) — bounds worst-case loss regardless of throughput. Flush also fires after the first file. |
| `GBRAIN_SYNC_MAX_CHECKPOINT_FAILURES` | 3 | Consecutive failed flushes (each already retried ~12s) before the run aborts with `reason: 'checkpoint_unavailable'` instead of importing work it can never bank. |
| `GBRAIN_SYNC_YIELD_EVERY` | 64 | Yield the event loop (`setTimeout(0)`, NOT `setImmediate` — Bun starves the timers phase under a tight setImmediate loop) every N files so the lock-refresh `setInterval` heartbeat fires mid-import. |
| `GBRAIN_LOCK_STEAL_GRACE_SECONDS` | derived (~600 at 30min TTL) | A holder that refreshed within this window is NOT stolen even if its TTL lapsed (starved-but-alive). Dead holders stop refreshing, age past the grace, and become stealable; TTL stays the backstop. |

## Pace Mode (DB-contention-aware backfill pacing)

A naive `gbrain embed --stale` / large `sync` can saturate a PgBouncer
transaction-mode pooler and starve the minion supervisor's lock renewals
(`lock-renewal-failed` → dead jobs). Pacing is the native, composable fix — it
replaces external SIGSTOP/SIGCONT wrapper scripts. **Opt-in: default mode `off`.**

Two invariants that hold wherever you touch it: the pacer is **fail-open** (a
pacer bug never kills a backfill and never throws an unhandledRejection), and
bundles resolve with **env ABOVE config** (incident escape hatch), unlike search
mode:

    per-call flag → GBRAIN_PACE_* env → config (pace.*) → PACE_BUNDLES[mode] → off

The `gentle`/`balanced`/`aggressive` knob table, the `db-pacer.ts` primitive, the
CLI + job surfaces, and the correctness fixes that longer paced runs widen
(embed-backfill lock sharing, bounded keyset re-entry, budget-timer re-arming)
are in `docs/operations/pace-mode.md`.

## Version locations (single source of truth: `VERSION` file)

Every release keeps **five release-metadata files** in sync using the commands
below and the CI version gate. The canonical list lives here so release
preparation can run in any agent host.

**Version format is mandatory: `MAJOR.MINOR.PATCH.MICRO` (four numeric
segments, dot-separated, no leading `v`).** Every new release MUST use the
4-segment form. The `.MICRO` slot is the dot-suffix follow-up channel: when
a release ships its commit subject ahead of its VERSION bump (e.g. PR #795
landing as `v0.31.4` without bumping the file), the corrective ship lands
as `0.31.4.1` rather than churning the patch number to `0.31.5`. Suffixes
like `-fixwave` are still allowed as needed (`0.31.1.1-fixwave`), but the
four numeric segments are required first. Historical 3-segment versions
(`0.31.3`, `0.22.1`) remain valid in `git log` and migration filenames
(`skills/migrations/v0.21.0.md`); do NOT rewrite them. Going forward only.

**Required release metadata (every release must update all five):**

| File | What lives there | Format |
|---|---|---|
| `VERSION` | The single source of truth. Read by the binary and CI version-gate. | Bare 4-segment string `MAJOR.MINOR.PATCH.MICRO` (e.g. `0.31.4.1`), no leading `v`. |
| `package.json` | Bun/npm package version. `gbrain --version` reads it via the compiled binary's bundled package metadata. CI version-gate cross-checks this against `VERSION` and fails if they drift. | `"version": "0.31.4.1"` |
| `openclaw.plugin.json` | OpenClaw/ClawHub bundle manifest version. The release-workflow guard cross-checks it against `VERSION`. | `"version": "0.31.4.1"` |
| `skills/manifest.json` | Bundled skill-manifest version. The release-workflow guard cross-checks it against `VERSION`. | `"version": "0.31.4.1"` |
| `CHANGELOG.md` | Top entry header `## [0.31.4.1] - YYYY-MM-DD` plus the "To take advantage of v0.31.4.1" block. | Standard Keep-a-Changelog header. |

**Conditional release documentation (update only when affected):**

| File | What lives there | Format |
|---|---|---|
| `TODOS.md` | Any TODO entries that mention "follow-up from vX.Y.Z.W" use the version of the release that filed them. Update only when filing NEW follow-up TODOs. | Inline `vX.Y.Z.W` references in TODO bodies. |
| `CLAUDE.md` | The Key Files section's per-file annotations carry `vX.Y.Z.W (#NNN)` tags noting which release introduced a behavior. Update whenever a wave's annotations get folded in. | Inline `vX.Y.Z.W (#NNN, contributed by @user)` references. |

**Auto-derived (no manual edit; refreshed by their own commands):**

- `bun.lock` — root-package version is auto-pinned from `package.json`. After
  bumping `package.json`, run `bun install` to refresh the lockfile.
- `llms-full.txt` / `llms.txt` — auto-generated documentation bundles. **Any
  CLAUDE.md edit MUST be followed by `bun run build:llms` in the same commit
  (or a follow-up commit before push).** The committed bundles are checked
  against fresh generator output by `test/build-llms.test.ts`, which runs in
  CI shard 1. If you edited CLAUDE.md and didn't regenerate, CI will fail.
  This has bitten the wave 3 times — every CLAUDE.md edit gets a `bun run
  build:llms` chaser, no exceptions. (The `verify` gate doesn't run this
  test; only the full unit suite does. So `bun run typecheck` clean is NOT
  enough to know you can push after a CLAUDE.md edit.)

**Historical (DO NOT bump on release):**

- `skills/migrations/v0.21.0.md` — migration files use the version they
  shipped FROM as their filename. v0.21.0's migration always says v0.21.0.
- `src/commands/migrations/v0_21_0.ts` — same: migration code references
  the schema version it migrates to.
- `test/migrations-v0_21_0.test.ts`, `test/migration-orchestrator-v0_21_0.test.ts`,
  `test/migrate.test.ts` — migration tests reference historical migration
  versions; these are correct as-is and should not move.
- `src/core/db.ts`, `src/core/migrate.ts`, `src/core/import-file.ts`,
  `src/commands/reindex-code.ts` — code comments cite the release that
  introduced a feature. Once written, these are historical record.
- `README.md` — references the latest published feature names by version
  (e.g. "v0.21.0 Code Cathedral"); update only when the README's marketing
  copy is intentionally being refreshed, NOT on every micro/patch bump.

**The CI version-gate** checks `VERSION` against `package.json` and the
release base. `test/scripts/release-workflow.test.ts` also checks both bundled
manifests. If another release claims the selected version, choose the next
valid version and update all five release-metadata files before publication.
No external version allocator is required.

### Mandatory version-consistency audit (run after EVERY merge or commit that touches release metadata)

**All five release-metadata files MUST agree.** Every merge from master can
conflict on release metadata because master ships its own version bumps.
Auto-merge sometimes resolves these silently in unexpected ways. After any
merge, branch update, or version-related edit, run this audit. It's five lines
and never lies:

```bash
echo "VERSION:     $(cat VERSION)"
echo "package.json: $(node -e 'process.stdout.write(require("./package.json").version)')"
echo "openclaw.plugin.json: $(node -e 'process.stdout.write(require("./openclaw.plugin.json").version)')"
echo "skills/manifest.json: $(node -e 'process.stdout.write(require("./skills/manifest.json").version)')"
grep -E "^## \[" CHANGELOG.md | head -1
```

All five MUST show the same `MAJOR.MINOR.PATCH.MICRO`. If any one disagrees,
you have not finished the merge. Fix it before pushing or shipping. There is
no situation in which "I'll fix it next push" is OK, because:

- A `VERSION`/`package.json` mismatch fails the CI version-gate, while either
  bundled-manifest mismatch fails the release-workflow regression test.
- A green CHANGELOG entry under the wrong version header silently lies
  to release-notes consumers.

### Merge-conflict recovery on release metadata

Every merge from master can conflict on those five files, because master ships
its own version bumps, and auto-merge sometimes resolves them silently in
unexpected ways. **The exact 9-step resolution order — including the sed patterns
and the `git checkout --ours/--theirs` anti-pattern — is in
`docs/RELEASING.md`.** Run the 5-line audit above after resolving, and again
before pushing any merge commit; if it doesn't show your version on all five
lines, you have not finished the merge.

## App-specific workspace behavior

Branch naming is governed by the repository and the active workspace. Apply
Conductor-specific naming only when this task actually runs in Conductor and
the current app requires it. Do not rename branches, delete remote refs, or
recreate PRs to satisfy an inactive app's historical convention.

## Releasing

Before any ship, read **[docs/RELEASING.md](docs/RELEASING.md)** in full. It carries the
full release + contributor process: pre-ship test requirements (`bun run ci:local` / the
E2E lifecycle), the CHANGELOG voice + release-summary template, the "To take advantage of
vX" self-repair block, version migrations, the GitHub Actions SHA refresh, PR conventions,
and the community-PR-wave process. Use the native repository commands and
GitHub workflow there; external skills are optional helpers.

The ship-critical IRON RULES stay inline in this file (do NOT relocate them): the
Version-locations table above (the 5-file release-metadata sync + the 5-line audit),
the documentation checks (below),
the Privacy + Responsible-disclosure rules (below), and the PR-title-version-first rule
(below).

## Release documentation

Inspect the release diff and update the documentation affected by its behavior,
commands, or setup changes. Regenerate committed bundles when their sources
change. No separate documentation skill or scan of every Markdown file is
required. An unchanged, accurate document needs no edit.

Check the relevant owners for the changed behavior:
- README.md — does it reflect new features, commands, or setup steps?
- CLAUDE.md — does it reflect new files, test files, or architecture changes?
- CHANGELOG.md — does it cover every commit?
- TODOS.md — are completed items marked done?
- docs/ — do any guides need updating?

A release with inaccurate affected documentation is incomplete.


## Privacy rule: scrub real names from public docs

**Never reference real people, companies, funds, or private agent names in any
public-facing artifact.** Public artifacts include: `CHANGELOG.md`, `README.md`,
`docs/`, `skills/`, PR titles + bodies, commit messages, and comments in checked-in
code. Query examples, benchmark stories, and migration guides MUST use generic
placeholders.

Why: gbrain runs a personal knowledge brain containing notes on real people and
real companies (YC founders, portfolio companies, funds, investors, meeting
attendees). When a doc copies a query like `gbrain graph diana-hu --depth 2` or
names a specific agent fork like `Wintermute`, that real name gets indexed by
search engines, surfaced in cross-references, and distributed with every release.

**Name mapping** to use in examples:
- Agent forks → `your agent fork`, `a downstream agent`, or `agent-fork`
- Example person → `alice-example`, `charlie-example`, or `a-founder`
- Example company → `acme-example`, `widget-co`, or `a-company`
- Example fund → `fund-a`, `fund-b`, `fund-c`
- Example deal → `acme-seed`, `widget-series-a`
- Example meeting → `meetings/2026-04-03` (generic date is fine)
- Example user → `you` or `the user`, never a proper name

**Specific rule: never say `Wintermute` in any CHANGELOG, README, doc, PR, or
commit message.** When the temptation is to illustrate with the real fork name:
- Reader-facing copy → `your OpenClaw` (covers Wintermute, Hermes, AlphaClaw,
  and any other downstream OpenClaw deployment in one term the reader already
  recognizes).
- First-person / origin-story copy → `Garry's OpenClaw` (honest that this is
  the production deployment driving the feature, without exposing the private
  agent's name).

`Wintermute` may appear in private artifacts (scratch plans under
`~/.gstack/projects/…`, memory files, conversation transcripts, CEO-review
plans) — those aren't distributed. Anything checked into this repo or shipped
in a release must use the OpenClaw phrasing above. Sweeping a stale reference
is a small clean-up PR, not a debate.

**When in doubt, ask yourself:** "Would this query reveal private information
about the user's contacts, investments, or portfolio if it were read by a
stranger?" If yes, replace with generic placeholders.

**Illustrative API examples with household-brand companies** (Stripe, Brex, OpenAI,
GitHub, etc.) are fine — they're public entities, not contacts in anyone's brain.
Do not confuse illustrative API examples with queries that reveal real
relationships.

## Responsible-disclosure rule: don't broadcast attack surface in release notes

**When a release fixes a security gap or a user-impacting bug, describe the fix
functionally. Do not enumerate the attack surface, quantify the exposure window,
or highlight the most sensitive records by name in public-facing artifacts.**

Public-facing artifacts include: `CHANGELOG.md`, `README.md`, `docs/`, PR titles
and bodies, commit messages, GitHub issue titles and comments, release pages,
tweets, blog posts.

**Don't write:**
- "10 tables were publicly readable by the anon key for months, including X, Y, Z"
- "X and Y are the most sensitive ones"
- "N tables exposed. Fix: enable RLS on these specific tables: ..."

**Do write:**
- "Security hardening pass. Fresh installs secure by default. Existing brains
  brought to the same bar automatically on upgrade."
- "If `gbrain doctor` still flags anything after upgrade, the message names each
  table and gives the exact fix."

Why: anyone reading the release page before they've upgraded now has a directed
probe list for unpatched installs. The source code ships the specifics anyway
(`src/schema.sql`, `src/core/migrate.ts`, test fixtures) — reverse engineers can
get them. But the release page is a broadcast channel. Don't hand attackers a
curated list with a banner.

**The test:** if a reader with no prior context could read the release note and
walk away knowing "gbrain at version X has table Y readable by anon key until
they patch," the note is too specific. Rewrite until that's no longer possible.

**What IS fine in public artifacts:**
- The mechanism of the fix ("the check now scans every public table instead of
  a hardcoded allowlist").
- User-facing operator ergonomics (the escape-hatch SQL template, the upgrade
  commands, the breaking-change flag).
- Credit to contributors.
- Generic framing of severity ("security posture tightening pass") without
  quantification.

**What stays in private artifacts (plan files, private memories, internal docs):**
- Specific table names, record counts, exposure duration.
- Which records stand out as highest-risk.
- Detailed before/after tables in the "numbers that matter" format.

If the CEO/Eng review of a plan produces a detailed exposure table, keep it in
the plan file under `~/.claude/plans/` or `~/.gstack/projects/`. Don't copy it
into the CHANGELOG or PR body.

Applies retroactively: if you see a prior CHANGELOG entry naming attack-surface
specifics, scrub it as a small cleanup commit, the same way a stale Wintermute
reference gets swept.


## PR title format — version FIRST (IRON RULE)

**Every PR title MUST start with the version, then the conventional-commit subject:**

```
vMAJOR.MINOR.PATCH.MICRO <type>(<scope>): <summary> (#issue or wave ref)
```

Example (correct): `v0.42.3.0 feat(search): autocut — score-discontinuity result-sizing (#1663 wave 1)`

The version goes at the **BEGINNING**, never the end. This matches the repo's
commit-subject convention (`git log` shows `v0.41.38.0 fix: ...`,
`v0.42.1.0 feat: ...`) so the PR list, the merge commit, and the changelog all
read version-first. A title with the version parenthesized at the end
(`feat(search): autocut ... (v0.42.3.0)`) is WRONG — fix it with
`gh pr edit <N> --title "vX.Y.Z.W <type>: <summary>"`.

This applies to any tool that creates or edits a PR title: the version is the
first token. Same rule for the
final commit subject that carries the version bump.


## Skill routing

Use native agent reasoning and the repository commands as the default. Apply an
available skill when the user requests it or its actual task trigger fits. Read
`skills/RESOLVER.md` for GBrain-specific operations. Do not assume a host exposes
a tool named `Skill` or requires an external GStack workflow.

A historical skill name is not a prerequisite or approval gate. If an optional
helper is unavailable, complete the authorized work with the current tools and
preserve the underlying tests, review, privacy, and authorization requirements.
Publication does not authorize runtime installation, service restart, spending,
or production data changes.
