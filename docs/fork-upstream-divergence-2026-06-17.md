# Fork vs upstream divergence report - 2026-06-17

This report compares Sawyer's fork, `uncfreak1255-code/gbrain`, against real upstream `garrytan/gbrain`.
It is read-only analysis: no merge, rebase, cherry-pick, or code/config change was performed.

## Executive recommendation

Use **clean overlay on fresh upstream** as the default path.

Do not cut over blindly: the fork has real keeper work, especially local Ollama `bge-m3` defaults, source-row preservation in `migrate-engine`, the SkillOpt candidate review route, and several receipts/tests that document Sawyer-specific evaluation work.

Do not merge forward blindly either: upstream has moved 25 commits / releases ahead and changed the same engine, cycle, doctor, operations, sync, and CLI surfaces that the fork patched. A direct merge would put human-owned invariants in the conflict path, especially engine parity, source scoping, cycle freshness, and model pricing.

The safest path is:

1. Create a fresh branch from `upstream/master`.
2. Re-apply only the keeper fork changes as small patches.
3. Drop fork fixes that upstream already solved differently.
4. Verify with focused tests first, then `bun run check:pr-branch-base`, typecheck, and the diff-aware/local CI gate.

## Comparison anchors

Commands used:

```bash
git remote add upstream https://github.com/garrytan/gbrain.git
git fetch upstream master --tags
git merge-base HEAD upstream/master
git rev-list --left-right --count upstream/master...HEAD
```

| Item | Value |
| --- | --- |
| Fork branch analyzed | `claude/gbrain-merge-review-bs9spa` from fork `master` |
| Fork HEAD | `c79fcb59eae0b5af99eb1435334e98072a05a6e0` |
| Fork version | `0.42.25.0` |
| Upstream HEAD | `70d5f36db60d435b40f83031473f1911f6bc2f9a` |
| Upstream version | `0.42.50.0` |
| True merge-base | `9a0bae8d62cdd1e0dd6655e24e082fe6c69c5dac` |
| Merge-base version | `0.42.25.0` |
| Commit count | upstream-only `25`, fork-only `46` |

## File-level split since merge-base

The file sets below are based on:

```bash
BASE=$(git merge-base HEAD upstream/master)
git diff --name-only "$BASE" HEAD
git diff --name-only "$BASE" upstream/master
```

| Bucket | Count | Meaning |
| --- | ---: | --- |
| Fork-only changed files | 110 | Changed in Sawyer fork since `BASE`, untouched by upstream since `BASE` |
| Upstream-only changed files | 268 | Changed upstream since `BASE`, untouched by fork since `BASE` |
| Both-side changed files | 30 | Changed by both fork and upstream since `BASE`; this is the conflict/reconcile zone |
| Fork total changed files | 140 | `110 + 30`; sanity check passes |
| Upstream total changed files | 298 | `268 + 30` |

## What the fork uniquely adds

Primary fork-only or fork-led work observed from `git log --no-merges upstream/master..HEAD`:

| Area | Evidence | Initial disposition |
| --- | --- | --- |
| Ollama local embeddings | `861593b1 Add Ollama bge-m3 embedding defaults`; `src/core/ai/recipes/ollama.ts` adds `bge-m3`, 1024 dims, alias | **KEEP**. This directly matches Sawyer's local embedding posture. |
| Engine migration source preservation | `8c561b51 Copy source rows during migrate to preserve source-backed pages`; `src/commands/migrate-engine.ts` adds source migration rows | **KEEP / MANUAL PORT**. Upstream has `migrate-engine.ts`, but the fork has materially different source-row copy logic. |
| SkillOpt candidate review | `083a0ad3 feat(skillopt): add candidate review route`; `src/core/skillopt/review.ts` is fork-only | **KEEP IF STILL USED**. It gives a deterministic review surface for skill optimization candidates. |
| LongMemEval V2 tracking / cleaned receipts | `ee396a47`, `039f3be6`; fixture and receipt files under `docs/eval/results/` and `test/fixtures/longmemeval-v2-mini/` | **KEEP AS EVIDENCE OR ARCHIVE**. Not a runtime blocker, but useful benchmark evidence. |
| Reranker mini receipt harness | `35a166cf`; `scripts/eval-reranker-receipt.ts` and receipt JSON | **KEEP AS BOXED RECEIPT ONLY**. Repeated runs were not stable enough to become product direction. |
| Autopilot source checkout / brain-dir / freshness stamp | `0224d5de`, `42e1d640`; touches `src/commands/autopilot.ts`, `src/core/cycle.ts`, tests | **CONFLICT / MANUAL PORT**. Upstream changed cycle/autopilot heavily; preserve the behavior, not necessarily the patch. |
| Dream synth safety gates | `45b626ec`, `44b01713`; touches `src/commands/dream.ts`, `src/core/cycle.ts`, `src/core/cycle/synthesize.ts` | **CONFLICT / MANUAL PORT**. Valuable safety behavior, but upstream cycle changed. |
| Gateway replay tool-result history | `0d2f9977`; `src/core/ai/gateway.ts` | **VERIFY THEN DROP OR PORT**. Upstream changed gateway/operation paths in v0.42.41+; do not assume the fork fix is still needed. |
| Content-sanity noise demotion | `6f7ccbb9`; `src/commands/doctor.ts`, `src/core/audit/content-sanity-audit.ts` | **VERIFY THEN DROP OR PORT**. Upstream v0.42.41 says doctor/content-sanity correctness changed; compare behavior before keeping. |
| Search-mode pricing refresh | `2f7398fe`; `src/core/model-pricing.ts`, search methodology docs | **HUMAN-OWNED**. Pricing is volatile and must be reverified against official provider pricing before choosing fork vs upstream. |
| PR ancestry guard | `scripts/check-pr-branch-base.sh`, `scripts/install-pr-branch-hook.sh` | **KEEP FOR FORK WORKFLOW** if Sawyer keeps a fork. Not needed if cutting over to upstream-only runtime. |

## What upstream would add

Upstream `HEAD..upstream/master` contains the following release commits:

| Upstream commit | Release / headline |
| --- | --- |
| `70d5f36d` | `v0.42.50.0` CI reliability hardening: cancellation, timeouts, actionlint, hermetic E2E env |
| `7968f840` | `v0.42.49.0` native DB-contention pacing for embed/sync backfills |
| `7ea92d60` | `v0.42.48.0` brain repo durability hardening with PAT + URL |
| `9d88680a` | `v0.42.47.0` brain-resident skillpacks + proactive `gbrain advisor` |
| `c023a604` | `v0.42.46.0` federated read scope reaches by-slug reads |
| `5c49225e` | `v0.42.45.0` delta-aware sync cost estimator; stop wedging daily cron |
| `090bb532` | `v0.42.44.0` tutorial deploy-link correction |
| `a81f7e05` | `v0.42.43.0` push-based context and teardown-exit hardening |
| `4ee530f3` | `v0.42.42.0` bounded CLI teardown / explicit exit |
| `7c27fa12` | `v0.42.41.0` data-loss / availability triage wave |
| `ecd6ae87` | `v0.42.40.0` safe UTF-16 handling before JSONB writes |
| `8f45624e` | `v0.42.39.0` Retrieval Reflex |
| `03ffc6eb` | `v0.42.37.0` jobs lock reaping, disconnect bound, cooperative abort |
| `1eb430a2` | `v0.42.37.0` source-isolation grant enforcement and frontmatter guard |
| `959af106` | `v0.42.36.0` resumable, durable, single-flight sync |
| `612753f3` | `v0.42.35.0` recover from unreachable `last_commit` |
| `099d9a8f` | `v0.42.34.0` typed-edge relational retrieval |
| `b31de661` | `v0.42.33.0` confine sync re-clone to gbrain-owned clones |
| `5a06af5a` | `v0.42.32.0` non-string frontmatter titles and auto-skip failure ledger |
| `f401d740` | `v0.42.31.0` link source provenance and link add/remove commands |
| `613da940` | `v0.42.29.0` minions long-job abort accounting and supervisor singleton |
| `f7f8512b` | `v0.42.28.0` batch inserts use `jsonb_to_recordset` |
| `80581445` | `v0.42.26.0` Supabase connection-string docs |

The missing upstream releases are directly relevant to Sawyer's current pain:

- `gbrain advisor` gives the "what should I do next?" surface that Sawyer has been asking for.
- Brain repo durability hardening targets stale local-only brain repo writes.
- Sync cost estimator and resumable/single-flight sync target cron babysitting.
- Retrieval Reflex and push-based context target agents forgetting to ask the brain.
- Federated by-slug reads and source-isolation fixes target multi-source correctness.
- DB pacing and bounded teardown target long-running production reliability.

## Conflict zone

These 30 files changed on both sides since the true merge-base:

```text
AGENTS.md
CLAUDE.md
TODOS.md
docs/RELEASING.md
docs/architecture/KEY_FILES.md
llms-full.txt
package.json
src/cli.ts
src/commands/autopilot.ts
src/commands/doctor.ts
src/commands/import.ts
src/commands/init.ts
src/commands/jobs.ts
src/commands/migrate-engine.ts
src/commands/onboard.ts
src/commands/sync.ts
src/core/ai/gateway.ts
src/core/config.ts
src/core/cycle.ts
src/core/embedding-dim-check.ts
src/core/operations.ts
src/core/pglite-engine.ts
src/core/postgres-engine.ts
src/core/sync.ts
test/doctor-federation-health.test.ts
test/e2e/helpers.ts
test/embedding-dim-check.test.ts
test/fix-wave-structural.test.ts
test/sync-cost-preview.test.ts
test/sync.test.ts
```

Human-owned hotspots:

| Hotspot | Why it matters |
| --- | --- |
| `src/core/postgres-engine.ts` + `src/core/pglite-engine.ts` | Upstream made many engine correctness changes after `BASE` (federated reads, JSONB safety, PGLite lock/exit, batch insert shape). The fork has source-config / E2E guard work. Engine parity must be reviewed deliberately. |
| `src/core/operations.ts` | Upstream changed source-scope, retrieval, advisor/skillpack, and context behavior. Fork carries replay guard keeper work. This is core API surface, not a casual merge file. |
| `src/core/cycle.ts` + `src/commands/autopilot.ts` | Both sides touched cycle/autopilot. Upstream has abort, sync, teardown, and context changes; fork has source checkout, brain-dir, Dream guard, and freshness-stamp fixes. Preserve behavior through tests. |
| `src/commands/doctor.ts` | Upstream changed doctor for Retrieval Reflex, teardown exits, job locks, content sanity, graph coverage, and exit code. Fork changed content-sanity noise and probe surfaces. The output contract matters to operators. |
| `src/core/ai/gateway.ts` | Fork fixed replay tool-result history; upstream touched gateway via the v0.42.41 triage wave. Verify the bug still reproduces before carrying the patch. |
| `src/commands/migrate-engine.ts` | Upstream added `effectiveEnvDatabaseUrl`; fork added source-row copy. These should be merged as one intentional migration contract. |
| `src/core/model-pricing.ts` | This file is fork-only changed, but it is invariant-critical. The fork adds newer model IDs/prices; upstream has older values. Pricing must be reverified against official provider pages before promotion. |
| `VERSION`, `package.json`, `CHANGELOG.md` | Upstream has release truth through `0.42.50.0`; fork stayed at `0.42.25.0` despite many merged PRs. Any continued fork needs an explicit version policy. |

## Redundancy pass

| Fork change | Upstream overlap | Disposition |
| --- | --- | --- |
| Ollama `bge-m3` local embedding defaults | No upstream change observed in `src/core/ai/recipes/ollama.ts` | **KEEP** |
| `migrate-engine` source row copy | Upstream changed same command, but not the same source-row copy in the visible head comparison | **KEEP / MANUAL PORT** |
| SkillOpt candidate review route | No upstream `src/core/skillopt/review.ts` | **KEEP IF USED** |
| LongMemEval V2 / cleaned dataset receipts | Upstream has broad eval/retrieval work but not these exact receipt files | **KEEP AS RECEIPT, NOT RUNTIME BLOCKER** |
| Reranker receipt harness | Upstream has retrieval/quality work, not this exact mini receipt | **KEEP BOXED OR ARCHIVE** |
| Autopilot source checkout / brain-dir fixes | Upstream changed cycle/autopilot heavily in v0.42.36-v0.42.43 | **CONFLICT; PORT BEHAVIOR ONLY** |
| Dream dry-run / synth safety gates | Upstream changed cycle/dream surfaces | **CONFLICT; PORT BEHAVIOR ONLY** |
| Gateway replay tool-result fix | Upstream changed gateway/operations in v0.42.41 | **VERIFY; LIKELY REDUNDANT OR PARTIAL** |
| Content-sanity noise demotion | Upstream v0.42.41 says doctor/content-sanity correctness changed | **VERIFY; POSSIBLY REDUNDANT** |
| Search-mode pricing refresh | Upstream has canonical pricing table but older values in final content | **HUMAN-OWNED; REVERIFY OFFICIAL PRICING** |
| PR ancestry guard scripts | Upstream does not need Sawyer-fork PR guard | **KEEP ONLY IF FORK CONTINUES** |

## Why overlay beats the alternatives

### Option A: direct merge upstream into fork

Pros:

- Keeps the fork branch identity.
- Git can automatically carry some doc/test additions.

Cons:

- Forces 30 both-side files through one large merge.
- Puts engine parity, operations, cycle, doctor, gateway, sync, and migration code into one conflict event.
- Versioning remains confusing unless the fork adopts a release policy immediately.

Use only if Sawyer wants to keep the fork as a long-lived release line and is willing to pay the manual merge-review cost now.

### Option B: clean overlay on fresh upstream

Pros:

- Starts from known-current upstream `0.42.50.0`.
- Lets Sawyer keep only proven customizations.
- Makes stale fixes cheap to drop.
- Avoids treating fork history as reliable ancestry.
- Produces smaller PRs that can be tested and reverted independently.

Cons:

- Requires manually porting keeper behavior.
- Some fork tests/receipts may become historical artifacts rather than live tests.

This is the recommended path.

### Option C: cut over to upstream entirely

Pros:

- Fastest way to stop version drift.
- Gets `gbrain advisor`, durability hardening, sync fixes, Retrieval Reflex, and the production reliability wave immediately.

Cons:

- Drops at least three real customizations: Ollama `bge-m3`, source-row migration preservation, and SkillOpt candidate review.
- Loses Sawyer-specific evaluation receipts unless archived elsewhere.

Use only if the immediate priority is runtime stability and Sawyer accepts losing/rebuilding local customizations later.

## Proposed overlay work plan

1. Fresh branch from `upstream/master`.
2. Apply keeper patch 1: Ollama `bge-m3` defaults and tests.
3. Apply keeper patch 2: `migrate-engine` source-row preservation, reconciled with upstream's `effectiveEnvDatabaseUrl`.
4. Apply keeper patch 3: SkillOpt candidate review route, if still part of the intended workflow.
5. Reproduce or drop gateway replay/content-sanity/autopilot freshness fixes one by one against upstream.
6. Reverify model pricing from official provider pages before carrying fork pricing.
7. Adopt one fork policy:
   - Runtime default: upstream binary.
   - Fork role: overlay patches only.
   - Version policy: either bump fork versions per batch or explicitly mark it as unreleased tracking work.

## Verification notes

Report-generation checks completed:

- `git merge-base HEAD upstream/master` resolved to `9a0bae8d62cdd1e0dd6655e24e082fe6c69c5dac`.
- Fork/version anchors were read from `VERSION` and `package.json`.
- Upstream/version anchors were read from `upstream/master:VERSION` and `upstream/master:package.json`.
- File-bucket sanity passed: `fork-only 110 + both-side 30 = fork changed 140`.
- The invariant-critical files above are explicitly named.

This report intentionally does not claim the overlay has been implemented or tested. It is the decision input for choosing the next branch strategy.
