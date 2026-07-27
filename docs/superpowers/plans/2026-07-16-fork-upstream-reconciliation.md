# Fork Upstream Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED: Use `@senior-orchestrator`, `@loopy`, `@verification-before-completion`, and the repo review/ship lane. Keep edits in the task worktree; do not merge histories, change runtime pins, deploy, or modify machine-level configuration.

**Goal:** Make the downstream fork behavior-current with upstream safety and correctness fixes through fresh-state cutoff `upstream/master@323d7d63` while preserving the fork's newer release line and proven local features.

**Architecture:** Treat `origin/master` as the integration base and `upstream/master` as donor material. Compare each of the 23 upstream-only commits for patch equivalence, then carry only missing fixes. Prefer exact upstream patches when they fit the current code; manually port only the narrow behavior when upstream release metadata, migration numbering, or superseded downstream code makes a whole commit unsafe. Keep upstream-only features and mixed provider work out unless their dependency and proof surface are clear.

**Tech Stack:** TypeScript, Bun, PGLite/Postgres test harnesses, GitHub Actions, repo-local fork propagation loop.

**Acceptance gate:** Focused regressions for every adopted behavior, `bun run verify`, the relevant E2E lifecycle, a non-empty clean Codex autoreview receipt, green PR checks, mergeability, and post-merge `origin/master` readback.

---

## Chunk 1: Lock the equivalence matrix

### Task 1: Classify every upstream-only commit

- [x] **Step 1: Refresh refs and record divergence.**

  Run `bun run check:upstream -- --fetch` and compare `origin/master`, `upstream/master`, and the clean task branch.

- [x] **Step 2: Reject a graph merge.**

  Run `git merge-tree --write-tree --messages origin/master upstream/master`. Treat the broad conflict set as evidence that behavior backports are safer than merging histories.

- [x] **Step 3: Identify already-equivalent work.**

  Confirm downstream equivalents for the dead-job/supervisor reliability wave, JSONB batching wave, and the doctor test stabilization before carrying any upstream patch.

- [x] **Step 4: Identify intentional deferrals.**

  Defer Life Chronicle and upstream release metadata. Defer mixed gateway/provider changes until the narrow missing behavior can be proved independently of downstream's stronger tool-result persistence and replay code.

## Chunk 2: Backport missing safety and correctness behavior

### Task 2: Carry the high-confidence upstream fixes

**Security and safety:**
- `dde1132a` as narrow current-tree ports: path/dotfile/write confinement, safe transcription process execution, and schema/search-path/RLS hardening with the next free downstream migration number. Reject its DCR grant-default change: this fork's `/authorize` path auto-issues codes and has no authenticated approval step, so calling that path consent-bearing would create a false security boundary.
- `058f448b` as a narrow current-tree port: never steal a live PGLite lock and classify corrupted-store startup failures with an actionable recovery hint.
- `bb3376e3`: hide generated admin bootstrap tokens from non-TTY output unless explicitly requested.
- `f15163f7`: normalize reconcile paths and refuse suspicious mass deletes by default.
- `659b6e9b`: skip Markdown lexing when a page cannot contain a fenced block.

**Correctness and source isolation:**
- `814258dd` partially: include `page_id` on alias-injected search results and filter invalid page IDs before contradiction queries; retain downstream's stronger JSONB binding work.
- `42ab0956`: preserve target identity across migration resume; retain downstream's stronger source-catalog copy.
- `68ed7baf`: quarantine ambiguous bare-name entity matches.
- `8e84c5b4`: parse escaped pipes in facts/takes fence round-trips.
- `010847c0`: enforce source scope through Think gather and graph reads.
- `d0447a59`: normalize BIGINT file sizes before JSON or CLI formatting.
- `836d8301`: exclude generated corpus roots from orphan reports.
- `285cf39f` partially: register `takes.bootstrap_enabled` only; do not advertise absent Chronicle settings.
- `7a275bf0`: source-scope Takes page lookup.
- `ec3910af`: preserve source routing for image/shared import transactions.
- `bb417051`: include resolved hard excludes in the search-cache knobs hash.

**Fresh-state extension (`bb417051..323d7d63`):**
- `9f313db3`: restore budget visibility for Sonnet 5 and Fable 5.
- `a12db463`: resolve every bundled schema pack by name.
- `e1e1f3ba`: honor pack-declared atom-extraction types while excluding synthesis outputs.
- `34c0ff0c` as a fork-aware port: never take over an autopilot lock held by a live PID, regardless of mtime.
- `f981f70a`: make atom slugs deterministic across dates and trailing-dash normalization.
- `7202ebf3`: make bounded Takes bootstrap runs progress through uncovered pages.

- [x] **Step 1: Read the owning file contracts in `KEY_FILES.md` before edits.**
- [x] **Step 2: Apply exact upstream patches where current-tree context and tests match.**
- [x] **Step 3: Manually port only the named behavior for mixed or migration-sensitive commits.**
- [x] **Step 4: Keep upstream provenance in the change record and preserve downstream-only behavior.**

## Chunk 3: Prove and close the reconciliation wave

### Task 3: Verify each behavior and the integrated branch

- [x] **Step 1: Run the focused unit tests introduced or extended by the adopted patches.**
- [x] **Step 2: Run the required PGLite and Postgres E2E tests with their documented lifecycle.**
- [x] **Step 3: Run `bun run verify` and the full applicable repo gate.**
- [x] **Step 4: Run the simplify checkpoint over the current diff, then rerun any affected proof.**
- [x] **Step 5: Obtain a non-empty clean autoreview receipt and run the repo landing review.**
- [ ] **Step 6: Use the repo ship workflow for version/changelog, commit, push, PR, CI, and merge if the green-merge contract passes.**
- [ ] **Step 7: Re-read `origin/master`, classify deferred upstream residue, and remove only proven-safe task residue.**

## Explicit residue

- A final fresh-state read found that `upstream/master` advanced from the frozen
  implementation cutoff `323d7d63` to `b075a9c8` after this wave had completed
  verification and review. The 33 new commits are classified, but are not mixed
  into this already-proved release:
  - Release, documentation, and CI-only follow-up: `ff2eb6ff`, `0cf5596c`,
    `41494020`, `fe6838ff`, `10ad7f15`, `9aaa3be0`, and `b075a9c8`.
  - Additive feature, provider, platform, auth, and operator-UX follow-up:
    `9315fd07`, `e0ca7420`, `6abab9d5`, `06f58c2b`, `42f3960b`, `1229bec1`,
    `78bc2fef`, `00523b84`, `cd9bd3f7`, and `0a021f6f`.
  - A separate correctness backport wave should audit and prove `d33aee84`,
    `79d8c677`, `e78f8a15`, `21665458`, `74bc8f8c`, `3a2033e8`, `cfc120fc`,
    `9eac8721`, `c4ff8b63`, `ad1fe25e`, `ff8ce4d7`, `73bbbde0`, `b263d9bc`,
    `7ffac65c`, and `a31f16f4` against the newer downstream code before adoption.
  - `26d2f8ab` is partially equivalent: this wave already carries its Takes
    source isolation and BIGINT-safe output behavior, while its calibration and
    voice-routing changes remain in the follow-up audit.
  - The highest-priority next tranche is source provenance and walker parity,
    sync crash safety, Postgres reconnect safety, active-engine doctor probes,
    effective-date filtering, durable facts jobs, and the paired security-CI
    changes. Freezing this wave at its named cutoff keeps the 4,000-line reviewed
    release reproducible instead of restarting its proof every time the donor
    branch moves.
- Upstream Life Chronicle feature and its configuration keys remain deferred.
- Upstream release/version commits remain deferred because the downstream release line is newer.
- The mixed provider/gateway wave remains deferred pending a separate patch-equivalence pass with provider-specific tests.
- The newly arrived inline-citation timeline feature (`e5380514`) and book-mirror HTML-table change (`9ceca606`) remain deferred as feature/presentation work outside this safety-and-correctness wave.
- The gateway schema helper extraction (`323d7d63`) is already behavior-equivalent in production; only its test seam differs.
- The upstream DCR grant-default patch remains deferred until `/authorize` has a real authenticated operator approval gate; existing explicit DCR behavior is preserved instead of relabeling auto-approval as consent.
- No runtime pin, install, daemon, source-routing, or production state changes are part of this branch.
