# Default Source Recovery Refresh Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the `default` source as a sealed recovery checkout and make DB-first page writes refresh that checkout without weakening manifest validation.

**Architecture:** The live `default` source is not a normal file-authoritative repo. `mcp:put_page` writes the database first, 23 live page paths still depend on recovery-only slug identity, and the current checkout has no durability hook. The fix is to treat a manifest-backed source as a recovery mirror: after a source write, export a fresh complete checkout in a private directory, commit it, prove it with a real source sync, then swap it into service while preserving the previous checkout.

**Tech Stack:** Bun, TypeScript, PGLite/Postgres engine paths, source-scoped export, sync lock and recovery manifest validation, local Git plumbing.

---

### Task 1: Add a recovery-refresh primitive for manifest-backed sources

**Files:**
- Create: `src/core/recovery-source-refresh.ts`
- Modify: `src/commands/export.ts`
- Modify: `src/core/write-through.ts`

- [ ] **Step 1: Add a helper that detects a recovery-backed source checkout**

Read the source row, confirm `local_path` exists, and treat a regular `.gbrain-export-manifest.json` at that root as the recovery-mode signal. Do not validate by mutating anything.

- [ ] **Step 2: Add a helper that exports a fresh private checkout**

Use `runExport(engine, ['--dir', <fresh-dir>, '--source', <id>])` to produce a complete source-scoped export in a new absent directory beside the current checkout.

- [ ] **Step 3: Add a helper that initializes and commits the fresh checkout**

Initialize a local Git repo, set local test-safe identity, stage all files, and create one commit for the fresh sealed snapshot.

- [ ] **Step 4: Add a helper that preserves the current checkout and switches the new one in**

Rename the current checkout to a unique preserved path only after the fresh export has already passed sync proof. Then move the fresh committed checkout into the active configured path. If the second rename fails, roll back.

- [ ] **Step 5: Return a structured receipt**

Report old path, new path, preserved path, whether sync proof passed, and whether the source used direct write-through or full recovery refresh.

### Task 2: Route recovery-backed writes through the refresh path

**Files:**
- Modify: `src/core/write-through.ts`
- Modify: `src/core/operations.ts`
- Modify: `src/commands/brainstorm.ts`

- [ ] **Step 1: Freeze the decision at the write boundary**

When the target source checkout is recovery-backed, do not write a single file into that sealed checkout.

- [ ] **Step 2: Serialize the write and sync boundary**

For recovery-backed writes, hold the source sync lock across the post-write refresh path so sync cannot race the refresh proof. Use `performSync(..., { repoPath: <fresh-dir>, sourceId, noPull: true, noEmbed: true, noExtract: true, skipLock: true })` inside that lock.

- [ ] **Step 3: Keep normal write-through unchanged for non-recovery sources**

Plain local repos still use atomic single-file write-through plus optional durability-hook commit.

- [ ] **Step 4: Preserve best-effort behavior where the source is not recovery-backed**

Do not broaden failure behavior for ordinary repos. The new strict path is only for the manifest-backed recovery contract.

### Task 3: Add regression coverage for the selected operating model

**Files:**
- Modify: `test/write-through.test.ts`
- Modify: `test/export-sync-slug-roundtrip.test.ts`
- Create if needed: `test/recovery-source-refresh.serial.test.ts`

- [ ] **Step 1: Prove that a new DB-first page write refreshes the recovery checkout**

Seed a manifest-backed checkout, perform a write that lands via `put_page`-style semantics, and assert the active checkout becomes a fresh committed export with no untracked page and a matching manifest count.

- [ ] **Step 2: Prove that legacy slug identities still survive**

Keep at least one fixture where `slugifyPath(<stored-slug>.md) !== <stored-slug>` and show the refreshed checkout still syncs back to the original stored slug.

- [ ] **Step 3: Keep fail-closed tamper coverage intact**

Retain or extend the existing tests for partial receipts, forged receipts, edited files, and late file additions. The change must not weaken those failures.

### Task 4: Verify and close out

**Files:**
- No planned source edits; verification and live readback only.

- [ ] **Step 1: Run focused regression tests**

Run:
```bash
bun test test/write-through.test.ts test/write-through-commit.serial.test.ts test/export-sync-slug-roundtrip.test.ts test/recovery-source-refresh.serial.test.ts
```

- [ ] **Step 2: Run the repo verification lane**

Run:
```bash
bun run ci:local:diff
```

- [ ] **Step 3: Run the review gate**

Run the configured Codex autoreview branch receipt against the task branch.

- [ ] **Step 4: Run live proof against the default source**

Verify the active default checkout Git state, run a real default-source sync, and confirm Autopilot status/log read back cleanly after the change.
