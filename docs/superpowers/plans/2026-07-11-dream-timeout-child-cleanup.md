# Dream Timeout Child Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use the existing test-driven workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a timed-out Dream synthesis run cancels only the subagent jobs it created, leaves a receipt, and cannot be considered schedule-ready without a passing quality evaluation.

**Architecture:** Thread a cooperative abort signal from the one-shot Dream CLI through `runCycle` into `runPhaseSynthesize`. When the signal arrives after child submission, cancel the tracked child job IDs through `MinionQueue.cancelJob`, which also revokes active child locks. Return the exact cancellation count and IDs in the phase result so the wrapper can record the core-owned cleanup without guessing from queue timestamps or broad job names.

**Tech Stack:** Bun, TypeScript, PGLite E2E tests, zsh launchd wrapper.

---

### Task 1: Pin abort cleanup in the synthesizer

**Files:**

- Modify: `test/e2e/dream-synthesize-chunking.test.ts`
- Modify: `src/core/cycle/synthesize.ts`
- Modify: `src/core/cycle.ts`

- [x] **Step 1: Write a failing PGLite regression test**

Create one pre-verdicted transcript, wait until its child is queued, abort the cycle, and assert every child from that cycle is `cancelled` with no active or waiting residue. Assert the phase result contains the exact cancellation count and child IDs.

- [x] **Step 2: Run the focused test and verify the failure**

Run: `bun test test/e2e/dream-synthesize-chunking.test.ts`

Expected: the new test fails because synthesize does not receive the cycle abort signal and leaves its child waiting.

- [x] **Step 3: Implement the smallest signal path**

Install a one-shot SIGINT handler for the Dream CLI (the global SIGTERM handler exits after lock cleanup), thread its `AbortSignal` through `runCycle` into synthesize, and after any abort cancel only the `childIds` collected by that phase using `MinionQueue.cancelJob`. Preserve a nonzero one-shot exit code after writing the partial/aborted receipt (130 for direct SIGINT; the wrapper reports timeout as 124).

- [x] **Step 4: Run the focused test and verify cleanup**

Run: `bun test test/e2e/dream-synthesize-chunking.test.ts`

Expected: PASS, with the regression asserting child cancellation and partial/aborted cycle reporting.

### Task 2: Make the live wrapper’s timeout receipt prove cleanup

**Files:**

- Modify: `/Users/sawbeck/.gbrain/nightly-dream-synth.sh`

- [x] **Step 1: Add a timeout cleanup readback**

On status 124, read `children_cancelled` and `child_ids_cancelled` from the JSON phase result and record the core-owned cleanup before writing the wrapper summary. Do not cancel broad queue jobs by timestamp or name.

- [x] **Step 2: Verify the real entrypoint syntax and timeout receipt shape**

Run: `zsh -n /Users/sawbeck/.gbrain/nightly-dream-synth.sh`

Expected: PASS. The receipt documents `dream_status=124` and cleanup verification without claiming a quality pass.

### Task 3: Re-run the bounded canary

**Files:**

- Runtime only: `/Users/sawbeck/.gbrain/*`

- [x] **Step 1: Restore the documented model split and enable only the canary**

Keep `max_transcripts_per_cycle=1`; set a chunk bound that guarantees a single child or intentionally skips oversize transcripts. Leave launchd unloaded.

- [x] **Step 2: Run the wrapper manually and inspect the receipt**

Expected: either one child produces a review artifact and `gbrain eval dream-quality` passes, or the run stops cleanly with zero active/waiting child jobs.

- [x] **Step 3: Load launchd only after the quality gate passes**

Run: `launchctl bootstrap gui/$(id -u) /Users/sawbeck/Library/LaunchAgents/com.gbrain.nightly-dream-synth.plist`

Expected: schedule is loaded only after the canary’s quality receipt is `pass` and queue readback is clean.
