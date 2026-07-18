# Pin Eval Expansion Replay Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make captured query evals replay the exact multi-query expansion variants that produced the original result set.

**Architecture:** Add the actual expansion variants to `HybridSearchMeta` without changing the `SearchResult[]` return contract. Eval capture copies fresh-search variants into the existing versioned replay surface after PII scrubbing, skips semantic-cache hits because their results may belong to a similar query, replay reuses pinned variants, and older expanded rows without pinned variants are labeled unpinned rather than fully comparable.

**Tech Stack:** TypeScript, Bun test runner, existing `EvalReplaySurface` and eval-capture/replay paths.

---

### Task 1: Pin and sanitize expansion variants

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/search/hybrid.ts`
- Modify: `src/core/eval-capture.ts`
- Modify: `src/commands/eval-replay.ts`
- Test: `test/eval-capture.test.ts`
- Test: `test/eval-replay.test.ts`
- Test: `test/query-cache.test.ts`

- [x] **Step 1: Write failing tests**

Add focused cases proving:

1. Query capture stores the exact expansion variants reported by a fresh `hybridSearch`.
2. PII scrubbing applies to every stored expansion variant and marks the replay surface privacy-scrubbed when a variant changes.
3. Replay passes stored variants to the search path instead of calling live expansion and forces semantic cache off so a warm row cannot bypass the pinned variants.
4. Expanded v1 rows without stored variants are labeled `query_op_v1_expansion_unpinned`; when the same row is privacy-scrubbed, the label preserves both facts as `query_op_v1_privacy_scrubbed_expansion_unpinned`.
5. Fresh-search metadata retains the exact expansion variants; no variants are emitted when expansion did not apply.
6. Semantic-cache hits are not captured as independent eval rows because similarity hits can come from a different query.

- [x] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
source ~/.zshrc 2>/dev/null || true
bun test test/eval-replay.test.ts
```

Expected: the new assertions fail because `EvalReplaySurface` has no pinned expansion-variant field and replay still calls live expansion.

- [x] **Step 3: Implement the minimal capture contract**

Add optional `expansionQueries?: string[]` to `EvalReplaySurface`.

Add optional `expansion_queries?: string[]` to `HybridSearchMeta`. Populate it when expansion produces variants and carry it through cached metadata for observability.

In `buildEvalCandidateInput`, copy `meta.expansion_queries` into `replay_surface.expansionQueries` before sanitizing the surface. Persist it only when expansion actually ran on a fresh search. Skip semantic-cache hit captures.

In `sanitizeReplaySurface`, scrub every stored expansion variant with the existing PII scrubber. If any variant changes, set `privacy_scrubbed: true`.

- [x] **Step 4: Implement deterministic replay**

When a replay surface contains `expansionQueries`, pass an `expandFn` that returns that stored array and force `useCache: false`. When `expansion: true` is present without stored variants, keep backward-compatible live replay but label the row `query_op_v1_expansion_unpinned` so receipts do not call it fully comparable.

This patch does not change the weekly automation or silently filter old rows. The official weekly gate remains blocked until at least 25 unique captures exist with pinned expansion variants; the closeout must state the current unique pinned-row count.

- [x] **Step 5: Run focused proof**

Run:

```bash
source ~/.zshrc 2>/dev/null || true
bun test test/eval-replay.test.ts
```

Expected: all focused tests pass.

- [x] **Step 6: Run repository verification**

Run:

```bash
bun run verify
bun test test/eval-capture.test.ts test/eval-replay.test.ts test/query-cache.test.ts
```

Expected: all checks and focused neighboring tests pass.

- [x] **Step 7: Reproduce the original failure mode**

Use a temporary comparable baseline with a stored expansion array and a pre-warmed semantic cache, then run the same replay twice. The privacy-safe summaries must match exactly and the pinned expansion path must run rather than returning the warm-cache row. Old rows without stored arrays must report the unpinned label.

- [x] **Step 8: Review and close**

Run the configured Codex autoreview, re-run focused proof after any accepted fix, and report the official weekly gate as blocked until at least 25 unique corrected-surface captures exist.
