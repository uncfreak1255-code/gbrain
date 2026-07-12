# Dream Pre-submit Child Cap Implementation Plan

> **For agentic workers:** REQUIRED: Use `@systematic-debugging`, `@loopy`, and bounded read-only subagents for investigation. Keep edits in the task worktree; do not change the live wrapper, launchd schedule, or corpus configuration as part of this source change.

**Goal:** Make a configured Dream child budget stop fan-out before any excess subagent job is submitted.

**Architecture:** Add an optional `dream.synthesize.max_children_per_cycle` setting to the existing Dream configuration flow. It applies to every configured synthesis invocation, including `--input`, `--date`, and `--from/--to`. Each transcript is atomic: if all of its chunks cannot fit in the remaining per-invocation child-slot budget, record a skip and enqueue none of them. A child returned through idempotency still consumes a slot conservatively because the invocation tracks and waits on it; this protects the bound without mutating or reclassifying a pre-existing job.

**Tech Stack:** TypeScript, Bun test, PGLite E2E harness, existing GBrain Minion queue.

**Current status (2026-07-12):** Source implementation and review gates are complete. A cap hit now returns `SYNTH_CHILD_LIMIT_REACHED`, preserves the diagnostic receipt, and never stamps the cooldown; a zero-child cap miss also avoids an empty summary. PR and merge readback remain the source closeout. The live config, wrapper, schedule, and corpus remain outside this change.

---

## Chunk 1: Reproduce the real enqueue boundary

### Task 1: Add failing scheduled-path regressions

**Files:**
- Modify: `test/e2e/dream-synthesize-chunking.test.ts`

- [x] **Step 1: Add a date-bounded, oversized transcript fixture with `max_children_per_cycle=1`.**

  Configure the existing hermetic rig for a date range, set a small enough prompt budget to produce multiple chunks, and use the test's existing auto-cancel queue helper. Assert no child job is created when the complete transcript cannot fit one remaining slot.

- [x] **Step 2: Assert the failed receipt is diagnostic and leaves no cooldown stamp.**

  Require `children_submitted=0`, the configured cap in phase details, and a child-limit skip reason. Do not accept a first-chunk submission followed by a stop.

- [x] **Step 3: Add a one-child control case.**

  With a single-chunk worthy transcript and the same configured cap, assert exactly one child is queued and `child_limit_reached=false`. This proves the guard does not turn the normal canary path into a blanket skip or report a false cap hit.

- [x] **Step 4: Add the remaining-budget atomicity case.**

  Seed three deterministically ordered transcripts under a cap of two: a one-chunk transcript that occupies one slot, a multi-chunk transcript that cannot fit the remaining slot, and a later one-chunk transcript. Assert the middle transcript creates zero jobs and the later transcript is still eligible for the remaining slot.

- [x] **Step 5: Pin scope and validation.**

  Exercise the same cap through an explicit `--input`-equivalent phase option, and unit-test strict parsing: accept only positive safe integers; reject `0`, negatives, decimals, and trailing characters before fan-out.

- [x] **Step 6: Run the focused test before implementation.**

  Run: `bun test test/e2e/dream-synthesize-chunking.test.ts`

  Expected: the new cap assertions fail because the setting does not yet exist and the fan-out loop has no pre-submit budget check.

## Chunk 2: Add the smallest source guard

### Task 2: Surface the optional configuration and enforce it at `queue.add`

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/core/cycle/synthesize.ts`

- [x] **Step 1: Add `dream.synthesize.max_children_per_cycle` to the typed config merge and recognized-key list.**

  Preserve current behavior when the key is absent. A present but invalid value fails the synthesize phase before fan-out; it must never silently become an unlimited run.

- [x] **Step 2: Load the value into `SynthConfig`.**

  Keep it distinct from `max_transcripts_per_cycle` and `max_chunks_per_transcript`: those are selection and per-transcript guards, while this is the total queue-submission guard.

- [x] **Step 3: Check the full transcript chunk count immediately before its first `queue.add`.**

  If the number of children already tracked by this invocation plus the transcript's chunks exceeds the configured budget, skip the transcript before releasing retryable jobs or submitting a child. Continue only when a later transcript can still fit; never produce a partial transcript. This is deliberately conservative for idempotency hits: a reused child still occupies a tracked slot.

- [x] **Step 4: Record the result in the phase receipt.**

  Include the configured total cap, submitted child count, and explicit cap skips. Emit `child_limit_reached` as a stable boolean on every completed synthesize receipt: `true` when any transcript was skipped by the total cap and `false` otherwise. A capped run remains review-only and must not be mistaken for an unbounded success.

- [x] **Step 5: Re-run the focused regression.**

  Run: `bun test test/e2e/dream-synthesize-chunking.test.ts`

  Expected: PASS with no provider, transcript, or live queue dependency.

## Chunk 3: Document and verify the bounded loop

### Task 3: Make the operator-facing guard clear and close the source change

**Files:**
- Modify: `docs/guides/loop-routing.md`
- Modify: `test/loadConfig-merge.test.ts`
- Modify: `test/dream-cli-flags.test.ts` only if the source surface requires it

- [x] **Step 1: Add a brief Dream Value Loop note.**

  Explain that `max_children_per_cycle` is the pre-submit guard; the machine-local wrapper's `DREAM_MAX_CHILDREN` remains a post-run defense and is not a substitute.

- [x] **Step 2: Extend config-merge coverage.**

  Verify DB configuration loads the new numeric setting without overriding an explicit file-plane value.

- [x] **Step 3: Run source proof.**

  Run focused tests, `bun run typecheck`, `bun run verify`, `bun run build:llms`, `bun run check:doc-history`, and the relevant PGLite E2E test. Run `bun run test:full` or document an environment-only blocker exactly.

- [x] **Step 4: Run the configured autoreview and repo review gates.**

  Keep only evidence-backed fixes. If clean and the green-merge contract passes, use the repo ship workflow to commit, push, open a PR, monitor checks, merge, and read back `origin/master`.

- [x] **Step 5: Stop at the runtime boundary.**

  Do not deploy the source, set the new live config value, reload launchd, or run a paid Dream canary without a separate runtime authorization. The subsequent acceptance gate is a one-child, passing-quality receipt from the real wrapper.
