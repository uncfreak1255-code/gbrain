# GBrain state completion plan

Generated from the 2026-06-05 state board review in
`/tmp/gbrain-state-board-20260605.html`.

This is a plan/engineering-review artifact, not a health claim. It separates
repo-fixable work from live brain maintenance. GBrain is not "done" until the
named proof gate for the relevant lane passes.

## Current source truth

- Worktree: `/Users/sawbeck/.codex/worktrees/gbrain-active`
- Branch: `codex/onboard-schema-pack-fallback-clean`
- Fork remote: `fork/codex/onboard-schema-pack-fallback-clean`
- Active source: `gbrain`, resolved by `.gbrain-source`
- Version: `0.42.26.0`
- Current branch commits:
  - `69f7ef28` — `fix: honor home schema pack in onboard checks`
  - `b55867ff` — `chore: guard fork PR branch ancestry`

## Verified receipts

These commands were run from this worktree:

```bash
bun run src/cli.ts sources current --json
bun run src/cli.ts features --json
bun run src/cli.ts status --json
bun run src/cli.ts doctor --json
bun run src/cli.ts doctor --remediation-plan --json
bun test test/onboard-pack-upgrade-checks.test.ts
bun run check:pr-branch-base
bun test test/build-llms.test.ts
```

Read `doctor --json` as the final JSON object after progress chatter. The
command exited non-zero because the live brain is unhealthy; that is a
runtime-health signal, not a failed repo unit test.

## Priority review

| Priority | Item | Classification | Completion gate |
|---|---|---|---|
| P0 | Regenerate `llms` artifacts for the new `AGENTS.md` fork-boundary section. | Repo-fixable now. | `bun run build:llms && bun test test/build-llms.test.ts` |
| P1 | Investigate `content_sanity_audit_recent`. | Runtime/content audit. Do not auto-delete or normalize without reading the event details. | Produce a source/event breakdown and classify keeper vs disposable residue. |
| P1 | Close cycle freshness for sources with no completed full cycle. | Runtime maintenance. Autopilot is running, but doctor still reports missing full-cycle receipts for specific sources. | `gbrain dream --source <id>` per stale source, or a fresh `status --json` readback proving autopilot completed them. |
| P1 | Run graph/timeline extraction intentionally. | Runtime maintenance. Links/timeline coverage are score bottlenecks. | `gbrain extract all` followed by `gbrain doctor --json` showing improved graph/timeline checks. |
| P2 | Drain atom extraction backlog or update the active pack. | Runtime/schema decision. The active pack does not declare `extract_atoms`, so draining may be a one-off, not a durable fix. | `gbrain dream --phase extract_atoms --drain --window 120` or a schema-pack change with tests. |
| P2 | Investigate conversation parser coverage. | Parser/content research. | `gbrain conversation-parser scan <slug>` on representative slugs, then decide parser fix vs opt-in LLM fallback. |
| P2 | Review type proliferation. | Schema-unify decision. | `gbrain onboard --check --explain` and a bounded unification plan. |
| P3 | Optional integrations. | Product/config choice. | `gbrain integrations list`; install only integrations that match Sawyer's actual capture loop. |

## Session execution receipts

This session completed the repo-fixable P0 item.

```bash
bun run build:llms
bun test test/build-llms.test.ts
bun test test/onboard-pack-upgrade-checks.test.ts
bun run check:pr-branch-base
bun run src/cli.ts status --json
bun run src/cli.ts doctor --json
```

Results:

- `build:llms` regenerated `llms.txt` and `llms-full.txt`.
- `test/build-llms.test.ts` passed: 12 pass, 0 fail.
- `test/onboard-pack-upgrade-checks.test.ts` passed: 9 pass, 0 fail.
- `check:pr-branch-base` passed: branch contains `origin/master`.
- `status --json` still showed local mode, autopilot running, no stale locks,
  queue clean, fresh sources, and 100% embedding coverage.
- `doctor --json` still reported `status: unhealthy`; runtime residue remains
  and is not fixed by this repo artifact update.

## Engineering review

### P0 `llms` drift

The failure is deterministic: `test/build-llms.test.ts` compares the committed
`llms.txt` and `llms-full.txt` against `scripts/build-llms.ts` output. The
current branch changed `AGENTS.md`, and `AGENTS.md` is included in
`llms-full.txt`, so the generated bundle must be updated.

This is safe to fix in this session because it is a pure generated-artifact
sync. It does not touch runtime state or change behavior.

### Runtime health priorities

The remaining priorities are not safe to mark complete from repo edits alone.
They touch the live brain database and content corpus. Their gates are live
readbacks (`status`, `doctor`, source-specific cycle receipts, audit event
details), not static code tests.

Important current live readbacks:

- `features --json`: brain score `50`; recommends integrations and sync setup.
- `status --json`: local mode, autopilot installed/running, queue clean,
  sources fresh, 100% embedding coverage.
- `doctor --json`: status `unhealthy`, health score `5`, brain checks `25`,
  with top issues including `content_sanity_audit_recent`,
  `cycle_freshness`, low graph/timeline coverage, atom backlog,
  conversation parser coverage, and type proliferation.
- `doctor --remediation-plan --json`: target score `90` is unreachable from
  the planner because it reports no repo configured for some score-improving
  checks.

The `features --json` "no-sync" recommendation conflicts with `status --json`
showing fresh synced sources. Treat this as a reconciliation item before
changing sync configuration.

## Recommended execution order

1. Fix P0 generated artifacts and commit/push the result to Sawyer's fork.
2. Re-run `doctor --json` and `status --json` sequentially after P0 to ensure
   repo work did not disturb runtime checks.
3. Investigate `content_sanity_audit_recent` with a read-only event breakdown.
4. Run source-specific cycle/extract gates only after confirming the target
   source list and cost/LLM requirements.
5. Defer integrations until Sawyer chooses which capture channels matter.

## Done criteria for this session

This session is complete when:

- `bun test test/build-llms.test.ts` passes.
- `bun test test/onboard-pack-upgrade-checks.test.ts` still passes.
- `bun run check:pr-branch-base` still passes.
- `git status --short --branch` is clean.
- The branch is pushed to `fork`.
- Runtime doctor residue is documented honestly as remaining work, not called
  fixed.
