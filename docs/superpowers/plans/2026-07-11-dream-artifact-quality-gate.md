# Dream Artifact Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make nightly Dream quality a fail-closed review-eligibility gate while keeping legitimate no-work runs clean and preserving Dream as non-canonical.

**Architecture:** Quality scoring owns whether an artifact can enter a promotion-review queue. The local nightly wrapper owns operational classification: no work is a skip, a scored failure is quarantined, and unsafe fan-out/timeouts remain failed runs. The launchd job declares the artifact policy explicitly; it does not invoke a paid Dream run during verification.

**Tech Stack:** Bun/TypeScript tests, zsh wrapper, launchd plist, JSON receipts.

---

## Chunk 1: Receipt eligibility and wrapper behavior

### Task 1: Pin the failed-artifact boundary with tests

**Files:**
- Modify: `test/eval-dream-quality.test.ts`
- Create: `test/nightly-dream-synth-policy.test.ts`

- [x] **Step 1: Add a failing receipt test**

Create a structurally weak, owner-matched Dream page and assert that it scores
below the threshold, has `needs_promotion_review === false`, and produces zero
promotion candidates. A passing page must retain the existing candidate behavior.

- [x] **Step 2: Add an isolated wrapper harness**

Run `/Users/sawbeck/.gbrain/nightly-dream-synth.sh` against fake `bun` and
`launchctl` binaries in a temporary directory. Cover these receipts without
touching launchd, the real queue, or Dream data:

```ts
expect(run({ children: 0, written: false })).toMatchObject({ exit: 0, run: 'skipped', artifact: 'skipped' });
expect(run({ children: 1, written: true, verdict: 'fail' })).toMatchObject({ exit: 0, artifact: 'quarantined' });
expect(run({ children: 1, written: true, verdict: 'pass' })).toMatchObject({ exit: 0, artifact: 'review_eligible' });
expect(run({ children: 2, written: false })).toMatchObject({ exit: 65, run: 'child_limit_exceeded' });
```

- [x] **Step 3: Run the new tests red**

Run: `bun test test/eval-dream-quality.test.ts test/nightly-dream-synth-policy.test.ts`

Expected: failures because failed pages can still be promotion candidates and
the wrapper has no artifact/run disposition fields.

### Task 2: Implement the minimum policy

**Files:**
- Modify: `src/core/dream-quality.ts`
- Modify: `/Users/sawbeck/.gbrain/nightly-dream-synth.sh`

- [x] **Step 1: Gate promotion review on passing quality**

Change the page score result so `needs_promotion_review` is true only when the
page both passes the deterministic quality score and maps to an owning review
lane. This makes `promotion_queue` inherently exclude failed pages.

- [x] **Step 2: Classify wrapper outcomes separately**

Add the explicit wrapper policy below while preserving the existing strict
canary flags for manual canaries:

```text
children == 0 && no written slugs  -> dream_run_disposition=skipped, dream_artifact_disposition=skipped, exit 0
children == 1 && quality pass      -> completed, review_eligible, exit 0
children == 1 && quality fail      -> completed, quarantined, exit 0
children > configured maximum      -> child_limit_exceeded, not_written, exit 65
missing/malformed quality receipt  -> completed, quality_unavailable, nonzero exit
```

Record raw evaluator status separately from wrapper gate status. Keep a
strict `DREAM_REQUIRE_QUALITY_PASS=true` canary fail-closed even when the
ordinary artifact policy would otherwise quarantine a valid failed receipt.

- [x] **Step 3: Run the focused tests green**

Run: `bun test test/eval-dream-quality.test.ts test/nightly-dream-synth-policy.test.ts`

Expected: all tests pass; no live Dream invocation occurs.

## Chunk 2: Live declaration and closeout

### Task 3: Declare the policy in the existing scheduled job

**Files:**
- Modify: `/Users/sawbeck/Library/LaunchAgents/com.gbrain.nightly-dream-synth.plist`
- Modify: `docs/guides/loop-routing.md`

- [x] **Step 1: Set explicit policy environment values**

Set `DREAM_MAX_CHILDREN=1` and `DREAM_ARTIFACT_QUALITY_GATE=true` in the
existing nightly job only. Do not add a new job or change its schedule.

- [x] **Step 2: Document the non-canonical outcome table**

Add the four wrapper outcomes to the existing Dream Value Loop: skipped,
review-eligible, quarantined, and failed. State that a passing receipt permits
human review only; it never promotes canon.

- [x] **Step 3: Verify the loaded runtime**

Run: `plutil -lint /Users/sawbeck/Library/LaunchAgents/com.gbrain.nightly-dream-synth.plist`

Then reload only `com.gbrain.nightly-dream-synth` and verify `launchctl print`
shows the same 02:15 schedule and the explicit environment values. Verify the
queue remains empty and autopilot remains loaded. Do not run a paid Dream cycle.

### Task 4: Close with proof

**Files:**
- Modify: `docs/superpowers/plans/2026-07-11-dream-artifact-quality-gate.md`

- [x] **Step 1: Run syntax, type, docs, and diff checks**

Run:

```bash
zsh -n /Users/sawbeck/.gbrain/nightly-dream-synth.sh
bun run typecheck
bun run build:llms
git diff --check
```

- [x] **Step 2: Review the current diff**

Run the configured Codex autoreview because the implementation changes source,
tests, a runtime wrapper, and launchd configuration. Resolve any actionable
finding and rerun the focused proof.

- [x] **Step 3: Write a compact receipt**

Record only disposition values, command results, and the live launchd readback
under `~/.gbrain/receipts/drift-checks/`. Do not include raw transcripts or
Dream page bodies, and do not promote anything into canon.
