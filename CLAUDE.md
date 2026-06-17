# CLAUDE.md

GBrain is a personal knowledge brain and GStack mod for agent platforms. Pluggable
engines: PGLite (embedded Postgres via WASM, zero-config default) or Postgres + pgvector
+ hybrid search in a managed Supabase instance. `gbrain init` defaults to PGLite;
suggests Supabase for 1000+ files. GStack teaches agents how to code. GBrain teaches
agents everything else: brain ops, signal detection, content ingestion, enrichment,
cron scheduling, reports, identity, and access control.

## Commands (verified against package.json)

| Task | Command |
|---|---|
| Dev / run the CLI | `bun run src/cli.ts` (or `bun run dev`) |
| Build the binary | `bun run build` |
| Typecheck | `bun run typecheck` (`tsc --noEmit`) |
| Tests | `bun run test` (typecheck + shell pre-checks + unit runner) |
| Single test file | `bun test <path>` |
| Verify gate | `bun run verify` |
| Full local CI | `bun run ci:local` (Docker: gitleaks + units + 29 E2E) |
| Regenerate LLM bundle | `bun run build:llms` (REQUIRED after any CLAUDE.md / reference-doc edit) |

`bun test` (the bun runner) skips TypeScript type checking — it only enforces runtime
behavior. Run `bun run typecheck` before push even when only test files changed.

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

Contract-first: `src/core/operations.ts` defines the shared operations (run
`gbrain --tools-json` for the live list and count). CLI and MCP server are both generated
from this single source. Engine factory (`src/core/engine-factory.ts`) dynamically imports
the configured engine (`'pglite'` or `'postgres'`). Skills are fat markdown files
(tool-agnostic, work with both CLI and plugin contexts).

**Trust boundary:** `OperationContext.remote` distinguishes trusted local CLI callers
(`remote: false` set by `src/cli.ts`) from untrusted agent-facing callers
(`remote: true` set by `src/mcp/server.ts`). Security-sensitive operations like
`file_upload` tighten filesystem confinement when `remote=true` and default to
strict behavior when unset.

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
| search modes (keyword / hybrid / direct CLI) | `docs/guides/search-modes.md` |
| search-mode config knobs + cost/pricing matrix | `docs/eval/SEARCH_MODE_METHODOLOGY.md` |
| schema packs / page types / extraction | `docs/architecture/schema-packs.md`, `type-taxonomy.md`, `lens-packs.md` |
| thin-client / remote MCP / cross-modal | `docs/architecture/thin-client.md` |
| the CLI surface (commands + flags) | `gbrain --help` / `gbrain --tools-json`, plus the relevant `KEY_FILES.md` entry |
| running or writing tests | `docs/TESTING.md` |
| bulk-command progress wiring | `docs/progress-events.md` |
| eval methodology / metrics | `docs/eval/` |
| brains vs sources / topology | `docs/architecture/brains-and-sources.md`, `topologies.md` |
| skill routing | `skills/RESOLVER.md` |
| shipping a release / CHANGELOG / PR conventions / merge-conflict recovery / privacy + responsible-disclosure | `docs/RELEASING.md` |

The per-file index (`## Key files`), the thin-client routing seam, and the testing
discipline used to live inline here. They moved to the docs above so this file
stays small enough to load every session. Nothing was lost — the pre-move content
is in git, and the docs carry every load-bearing invariant (compressed to
current-state).

## Maintaining CLAUDE.md and the reference docs

CLAUDE.md must stay an orientation kernel, not the implementation spec. Four
enforcement facts keep it that way:

- **CLAUDE.md is orientation, not the implementation spec.** It carries the North
  Star, the two axes, architecture + cross-cutting invariants, the resolver, and
  the commands. Per-file/per-command/per-test detail lives in the reference docs
  and loads on demand.
- **Reference docs (`KEY_FILES.md`, `thin-client.md`, `TESTING.md`) describe
  CURRENT behavior only.** Release history goes in `CHANGELOG.md` + git. Do NOT
  append `**vX.Y.Z (#NNN):**` clauses, codex/review tags, or "pre-fix/then/was-now"
  narration. When a file's behavior changes, UPDATE its entry to the new truth.
- **CI is the enforcement, not prose.** `scripts/check-key-files-current-state.sh`
  (in `bun run verify`) fails on the bolded-release-clause marker in the reference
  docs AND on a CLAUDE.md size cap (60KB).
- **After any CLAUDE.md or reference-doc edit, run `bun run build:llms`** — the
  llms bundle inlines/links these (config in `scripts/llms-config.ts`); the
  freshness + budget test (`bun test test/build-llms.test.ts`) fails CI otherwise.
  This isn't covered by the `verify` gate — only the full unit suite runs it.

## Search modes

GBrain ships three named search modes — `conservative`, `balanced`, `tokenmax` —
that bundle the search-lite knobs into a single config key chosen at install time.
The whole project resolves them through `src/core/search/mode.ts`
(`KNOBS_HASH_VERSION` is the single source of truth for the cache-key parts;
the cache key folds each mode knob + the active embedding column so a write under
one mode/embedding can't be served to a read under another). The cost/pricing
matrix (mode × downstream model, the ~25x corner-to-corner spread, the
realistic-scale natural-pairing anchors) lives in
`docs/eval/SEARCH_MODE_METHODOLOGY.md`; the keyword/hybrid/direct CLI decision
tree lives in `docs/guides/search-modes.md`. The per-knob mode mechanics are
documented per `src/core/search/mode.ts` in `docs/architecture/KEY_FILES.md`.

CLI surfaces:

    gbrain search modes              # what is running, with per-knob attribution
    gbrain search modes --reset      # clear search.* overrides (mode bundle wins)
    gbrain search stats [--days N]   # cache hit rate, intent mix, budget drops
    gbrain search tune [--apply]     # data-driven recommendations

The install picker fires inside `gbrain init` AFTER `engine.initSchema()`
(non-TTY auto-selects). The upgrade banner fires once via `runPostUpgrade`
in `src/commands/upgrade.ts`, gated by `search.mode_upgrade_notice_shown`.

## Eval discipline

Every metric printed by any `gbrain eval *` or `gbrain search stats` command
resolves through `src/core/eval/metric-glossary.ts` so industry terms
(`P@k`, `nDCG@k`, `MRR`, `Jaccard@k`) carry a plain-English line in human
output and a `_meta.metric_glossary` block in JSON output (one block per
response, NOT sibling `_gloss` fields).

The full methodology — datasets, sample selection, pre-registered expectations,
threats to validity, paired-bootstrap + Bonferroni p-value discipline — lives in
`docs/eval/SEARCH_MODE_METHODOLOGY.md`. Auto-regenerated
`docs/eval/METRIC_GLOSSARY.md` is CI-guarded against drift
(`scripts/check-eval-glossary-fresh.sh`).

Per-run records land at `<repo>/.gbrain-evals/eval-results.jsonl`. The user's
personal `~/.gbrain` brain is NEVER touched — the audit trail lives in the source
repo's git history.

## Skills

Read the skill files in `skills/` before doing brain operations. GBrain ships 29 skills
organized by `skills/RESOLVER.md` (`AGENTS.md` is also accepted as of v0.19):

**Original 8 (conformance-migrated):** ingest (thin router), query, maintain, enrich,
briefing, migrate, setup, publish.

**Brain skills (ported from an upstream agent fork):** signal-detector, brain-ops, idea-ingest, media-ingest,
meeting-ingestion, citation-fixer, repo-architecture, skill-creator, daily-task-manager.

**Operational + identity:** daily-task-prep, cross-modal-review, cron-scheduler, reports,
testing, soul-audit, webhook-transforms, data-research, minion-orchestrator. As of
v0.20.4, `minion-orchestrator` is the single unified skill for both lanes of background
work (shell jobs via `gbrain jobs submit shell`, LLM subagents via `gbrain agent run`);
the prior `gbrain-jobs` skill was merged in.

**Skillify loop (v0.19):** skillify (the markdown orchestration), skillpack-check
(agent-readable health report).

**Routing-table compression:** `skills/functional-area-resolver/` — a two-layer dispatch
pattern for shrinking large AGENTS.md / RESOLVER.md files (>=12KB) without losing routing
accuracy, where each functional area declares its sub-skills in a load-bearing
`(dispatcher for: ...)` clause. The A/B eval surface lives outside `skills/` at
`evals/functional-area-resolver/` (so the skillpack bundler doesn't ship eval
infrastructure to downstream installs).

**Operational health (v0.19.1):** smoke-test (post-restart health checks with auto-fix
for Bun, CLI, DB, worker, Zod CJS, gateway, API key, brain repo; user-extensible via
`~/.gbrain/smoke-tests.d/*.sh`).

**Conventions:** `skills/conventions/` has cross-cutting rules (quality, brain-first,
model-routing, test-before-bulk, cross-modal). `skills/_brain-filing-rules.md` and
`skills/_output-rules.md` are shared references.

## Bulk-action progress reporting

All bulk commands (doctor, embed, import, export, sync, extract, migrate,
repair-jsonb, orphans, check-backlinks, lint, integrity auto, eval, files
sync, and apply-migrations) stream progress through the shared reporter
at `src/core/progress.ts`. Agents get heartbeats within 1 second of every
iteration regardless of how slow the underlying work is.

Rules:
- Progress always writes to **stderr**. Stdout stays clean for data output
  (`--json` payloads, final summaries, JSON action events from `extract`).
- Non-TTY default: plain one-line-per-event human text. JSON requires the
  explicit `--progress-json` flag.
- Global flags (`--quiet`, `--progress-json`, `--progress-interval=<ms>`)
  are parsed by `src/core/cli-options.ts` BEFORE command dispatch.
- Phase names are machine-stable `snake_case.dot.path` (e.g.
  `doctor.db_checks`, `sync.imports`). Documented in
  `docs/progress-events.md`; additive changes only.
- `scripts/check-progress-to-stdout.sh` is a CI guard that fails the build
  if any new code writes `\r` progress to stdout. Wired into `bun run test`.
- Minion handlers pass `job.updateProgress` as the `onProgress` callback
  to core functions (DB-backed primary progress channel); stderr from
  `jobs work` stays coarse for daemon liveness only.

When wiring a new bulk command: `import { createProgress } from '../core/progress.ts'`
and `import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts'`.
Create a reporter with `createProgress(cliOptsToProgressOptions(getCliOptions()))`,
`start(phase, total?)` before the loop, `tick()` inside it, `finish()` after.
For single long-running queries, use `startHeartbeat(reporter, note)` with a
try/finally to guarantee cleanup. Never call `process.stdout.write('\r...')`
in bulk paths, the CI guard will fail the build.

## Capturing test output (NEVER pipe through `tail` / `head`)

**Iron rule:** redirect test/check commands to a file FIRST, then `tail` the file
separately. The pipe form (`bun test 2>&1 | tail -10`) makes `$?` the exit code of
`tail` (always 0) and truncates bun's failure details (printed before the summary),
so ship gates fail open. This bit a real ship: a piped run reported "pass/fail"
counts with no failure details, forcing a 23-minute re-run to triage.

```bash
# RIGHT — full output preserved, real exit code visible
bun test > /tmp/units.txt 2>&1
echo "EXIT=$?"
tail -50 /tmp/units.txt
```

Apply the same pattern to any long-running command whose exit code matters
(`bun run typecheck`, `bun run ci:local`, migration runs, eval suites). For
background tasks, use the harness's separate `<id>.exit` file, not the streamed
output.

## Build

`bun build --compile --outfile bin/gbrain src/cli.ts` (or `bun run build`).

## Releasing

**Use `/ship` — never hand-roll a release.** `/ship` owns the VERSION bump,
CHANGELOG, document-release, pre-landing review, test-coverage audit, and
adversarial review; manually running `git commit` + `git push` + `gh pr create`
skips all of it.

`docs/RELEASING.md` carries the full release + contributor process: pre-ship
test requirements, the CHANGELOG voice + release-summary template, the "To take
advantage of vX" self-repair block, version migrations, the GitHub Actions SHA
refresh, PR conventions, the community-PR-wave process, the merge-conflict
recovery procedure, and the Privacy + Responsible-disclosure rules. Read it in
full before any ship.

### Version locations (single source of truth: `VERSION` file)

Every release advances the version in **five files at once** — keep them in sync.
Format is mandatory: `MAJOR.MINOR.PATCH.MICRO` (four numeric segments, no leading
`v`). `/ship`'s Step 12 enforces this via an idempotency check (VERSION vs
package.json drift); the canonical list lives here so future runs and the
auto-update agent know where to look.

| File | What lives there |
|---|---|
| `VERSION` | Single source of truth. Read first by `/ship`, the binary, and CI version-gate. Bare 4-segment string, no leading `v`. |
| `package.json` | `"version"` — `gbrain --version` reads it via the compiled binary. CI version-gate cross-checks against `VERSION`. |
| `CHANGELOG.md` | Top entry header `## [X.Y.Z.W] - YYYY-MM-DD` plus the "To take advantage of vX.Y.Z.W" block. |
| `TODOS.md` | TODO entries that mention "follow-up from vX.Y.Z.W" use the filing release's version. |
| `CLAUDE.md` | This file — bump only if a reference here cites a release-introduced behavior; do NOT re-add per-file `vX.Y.Z.W` tags. |

Auto-derived (no manual edit): `bun.lock` (run `bun install` after bumping
`package.json`), and `llms-full.txt` / `llms.txt` (run `bun run build:llms` after
any CLAUDE.md edit — the committed bundles are checked against fresh generator
output by `test/build-llms.test.ts` in CI; `bun run typecheck` clean is NOT enough
to know you can push after a CLAUDE.md edit).

Historical versions (migration filenames, code comments citing the release that
introduced a feature, README marketing version refs) are a permanent record — do
NOT bump them on release.

**Mandatory 3-line version-consistency audit** — run after EVERY merge or commit
that touches VERSION, package.json, or CHANGELOG. The trio MUST agree:

```bash
echo "VERSION:     $(cat VERSION)"
echo "package.json: $(node -e 'process.stdout.write(require("./package.json").version)')"
grep -E "^## \[" CHANGELOG.md | head -1
```

If any line disagrees, the merge is not finished — fix it before pushing or
shipping. The full merge-conflict recovery procedure (resolution order, sed
patterns, pre-push gate) lives in `docs/RELEASING.md`.

### Conductor branch-name = workspace-name (IRON RULE)

Conductor workspaces expect the git branch name to match the workspace directory
name. When they disagree, Conductor silently fails to render the PR view + ship
state. Check this FIRST on every ship and BEFORE creating any PR; if the branch
tail doesn't match the workspace basename, rename the branch (and recreate the PR)
before shipping. Caught the hard way on a ship where workspace `puebla-v4` but
branch `garrytan/gstack-requests` produced a PR Conductor wouldn't display.

```bash
WORKSPACE=$(basename "$PWD")
BRANCH=$(git branch --show-current)
case "$BRANCH" in
  */"$WORKSPACE"|"$WORKSPACE") echo "OK" ;;
  *) echo "MISMATCH: branch=$BRANCH workspace=$WORKSPACE — RENAME BEFORE SHIPPING" ;;
esac
```

### PR title format — version FIRST (IRON RULE)

Every PR title (and the final version-bump commit subject) MUST start with the
version, then the conventional-commit subject:

```
vMAJOR.MINOR.PATCH.MICRO <type>(<scope>): <summary> (#issue or wave ref)
```

Correct: `v0.42.3.0 feat(search): autocut — score-discontinuity result-sizing (#1663 wave 1)`.
The version goes at the BEGINNING, never parenthesized at the end. This matches the
repo's commit-subject convention so the PR list, merge commit, and changelog all
read version-first. Fix a wrong one with `gh pr edit <N> --title "vX.Y.Z.W ..."`.

### Post-ship requirements (MANDATORY)

After EVERY /ship, run /document-release (it reads every .md file, cross-references
the diff, and updates anything that drifted). If `/ship`'s Step 8.5 triggers it
automatically, that counts; if it's skipped for any reason, run it manually before
considering the ship complete. A ship without updated docs is an incomplete ship.

### Privacy + responsible disclosure

Two release-time IRON RULES live in full in `docs/RELEASING.md`:

- **Privacy:** never reference real people, companies, funds, or private agent
  names (e.g. `Wintermute`) in any public artifact — CHANGELOG, README, docs,
  skills, PR titles/bodies, commit messages. Use generic placeholders
  (`alice-example`, `acme-example`, `fund-a`); use `your OpenClaw` for downstream
  agent forks.
- **Responsible disclosure:** when a release fixes a security gap, describe the
  fix functionally — never enumerate the attack surface, exposure window, or most
  sensitive records in public artifacts. The release page is a broadcast channel;
  don't hand attackers a probe list.

## Skill routing

Defer to the global routing in `~/.claude/CLAUDE.md` for which skill handles which
request. Repo-specific override: **ship / deploy / PR / "commit and ship" → invoke
`/ship`, never hand-roll ship operations** (manually running git commit + push +
`gh pr create` skips the VERSION bump, CHANGELOG, document-release, pre-landing
review, and adversarial review `/ship` runs).
