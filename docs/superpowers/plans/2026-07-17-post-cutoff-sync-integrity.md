# Post-Cutoff Sync Integrity Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selectively port upstream commit `42375bde` so sync preserves ordinary `ops/` content and never-committed write-through pages without weakening the fork's existing confinement and mass-delete guards.

**Architecture:** Keep the existing fork implementation as the base and port only the missing behavior from the frozen upstream cutoff `f72de979`. Treat the four defects as one data-preservation family: canonical sync classification, full-sync collection parity, DB-only reconciliation, and hardened write-through durability. Preserve the existing `GBRAIN_ALLOW_MASS_RECONCILE` valve, source scoping, symlink confinement, and fail-closed write boundaries.

**Tech Stack:** TypeScript, Bun tests, Git-backed sync fixtures, PGLite unit tests, PostgreSQL E2E where mapped.

---

## Chunk 1: Data-preservation behavior

### Task 1: Make `ops/` ordinary syncable content

**Files:**
- Modify: `src/core/sync.ts`
- Modify: `src/commands/sync.ts`
- Modify: `src/commands/extract.ts`
- Modify: `test/brain-writer-walk-prune.test.ts`
- Modify: `test/sync-isSyncable-shape.test.ts`
- Modify: `test/sync-strategy.test.ts`
- Modify: `test/sync.test.ts`
- Create: `test/sync-ops-pages.serial.test.ts`
- Create: `test/import-git-fastpath-prune.test.ts`

- [x] **Step 1: Add failing regression coverage**

Assert that `ops/tasks.md` is syncable, walkers and the git fast path include `ops/`, hidden/vendor paths remain excluded through the existing canonical classifier, and a deliberate page under a genuinely pruned directory is not deleted by the unsyncable-modified loop.

- [x] **Step 2: Run the focused tests and record the expected failures**

Run:

```bash
bun test test/brain-writer-walk-prune.test.ts test/import-git-fastpath-prune.test.ts test/sync-isSyncable-shape.test.ts test/sync-strategy.test.ts test/sync.test.ts
bun test test/sync-ops-pages.serial.test.ts
```

Expected: the new `ops/` assertions fail against the current branch because `PRUNE_DIR_NAMES` still contains `ops`.

- [x] **Step 3: Remove the stale `ops` prune rule**

Update `PRUNE_DIR_NAMES` and nearby current-state comments in `src/core/sync.ts` and `src/commands/extract.ts`. In `src/commands/sync.ts`, skip both `metafile` and `pruned-dir` rows in the unsyncable-modified delete loop.

- [x] **Step 4: Rerun the focused tests**

Expected: all Task 1 tests pass.

### Task 2: Preserve DB-only write-through pages during full reconciliation

**Files:**
- Modify: `src/commands/sync.ts`
- Create: `test/sync-reconcile-db-only.serial.test.ts`
- Modify: `test/e2e/sync.test.ts`

- [x] **Step 1: Add failing DB-only reconciliation coverage**

Cover a never-committed page whose materialized file is absent and a formerly committed page whose file was genuinely deleted. Assert the former is preserved and re-exported while the latter remains deletable.

- [x] **Step 2: Run the focused regression and record the expected failure**

Run:

```bash
bun test test/sync-reconcile-db-only.serial.test.ts
```

Expected: the current full-sync path classifies both pages as stale and deletes both below the mass-delete threshold.

- [x] **Step 3: Add git-history classification**

Add `listEverCommittedPaths(repoPath)` and partition stale slugs into never-committed DB-only pages versus genuinely deleted file-backed pages. Best-effort re-export the DB-only pages through `writePageThrough`; preserve them even if re-export fails. Keep the existing mass-delete gate ahead of the partition.

- [x] **Step 4: Rerun sync reconciliation coverage**

Expected: DB-only pages survive and formerly committed deletions still reconcile.

### Task 3: Commit write-through artifacts only on durability-hardened repos

**Files:**
- Modify: `src/core/brain-repo-durability.ts`
- Modify: `src/core/write-through.ts`
- Modify: `test/brain-durability-hook.serial.test.ts`
- Create: `test/write-through-commit.serial.test.ts`

- [x] **Step 1: Add failing durability regressions**

Prove that the helper stages and commits before any pull/rebase path, that an installed durability hook is detected, and that write-through commits only the explicit generated file while leaving unrelated dirt untouched.

- [x] **Step 2: Run the focused regressions and record the expected failures**

Run:

```bash
bun test test/brain-durability-hook.serial.test.ts test/write-through-commit.serial.test.ts
```

Expected: the current helper pulls before staging and `writePageThrough` never reports a commit.

- [x] **Step 3: Implement path-limited best-effort commits**

Move the committed helper's stage/commit phase before remote reconciliation. Add `isDurabilityHardened` and `commitWriteThroughFile`, then have `writePageThrough` return `committed: true` only after a successful explicit-path commit. Do not fail the DB or filesystem write when git durability fails.

- [x] **Step 4: Rerun durability coverage**

Expected: hardened repositories commit the one artifact; unhardened repositories and git failures remain non-fatal.

## Chunk 2: Documentation and delivery proof

### Task 4: Update current-state docs

**Files:**
- Modify: `docs/architecture/KEY_FILES.md`
- Regenerate if needed: `llms.txt`
- Regenerate: `llms-full.txt`

- [x] **Step 1: Update only provably stale entries**

Describe the new sync preservation and hardened write-through behavior in current-state language without release-history narration or sensitive attack-surface detail.

- [x] **Step 2: Regenerate documentation bundles**

Run:

```bash
bun run build:llms
bun run check:doc-history
bun test test/build-llms.test.ts
```

Expected: clean generation, doc-history pass, and all build-llms tests pass.

### Task 5: Prove and publish the branch

**Files:**
- Review the complete branch diff against `origin/master`

- [x] **Step 1: Run focused and repo gates**

Run the Task 1–3 focused suites, then:

```bash
bun run typecheck
bun run verify
bun run test
bun run test:slow
```

Capture full output before inspecting tails. Then follow `docs/TESTING.md`'s explicit PostgreSQL lifecycle: locate or prepare `.env.testing`, start a disposable pgvector container on a free port, bootstrap it through `gbrain doctor`, source `~/.zshrc`, run `DATABASE_URL=<test-url> bun run test:e2e`, and tear the container down in all outcomes. A skipped E2E run is not a pass. `bun run ci:local` is an acceptable stronger substitute when the host has enough memory.

- [x] **Step 2: Run the simplify checkpoint**

Inspect only the branch diff for unclear names, duplicated logic, hidden side effects, swallowed errors, dead code, and missing focused tests. Apply only in-scope corrections and rerun affected proof.

- [x] **Step 3: Run advisory review**

Run the configured Codex Autoreview and GStack review against the complete branch diff. Resolve actionable findings and rerun proof.

- [ ] **Step 4: Use the repo ship workflow**

Use `/ship` rather than hand-written commit/push/PR commands. Let it allocate the next valid version, update all release surfaces, run document-release, and create the PR with a version-first title.

- [ ] **Step 5: Bind the landing review**

After push and PR creation, run a clean full-branch Codex review with:

```text
--mode branch --base origin/master --ref <current-head> --merge-receipt <fresh-path>
```

The receipt's fetched base SHA and reviewed head SHA must exactly match the current PR.

- [ ] **Step 6: Merge only on the full gate**

Require green PR checks, zero unresolved review threads, GitHub mergeability, and the SHA-bound clean receipt. Merge under the standing contract, verify `origin/master`, and report branch/worktree residue without deleting it.
