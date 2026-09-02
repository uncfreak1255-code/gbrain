# Personal Learning Loop V1 PR 2 Implementation Plan

> **For Codex:** Use `spine:work` to execute this plan. Keep one writer in the isolated PR 2 worktree and stop before PR 3.

**Goal:** Add exact, rebuildable personal-learning activation, correction blocking, and crash-recoverable reversal behavior without enabling the loop or adding a new control plane.

**Architecture:** Extend the existing Learning Loop V1 ledger with versioned candidate, authority, activation, correction, lineage, and reversal evidence. Store authoritative active facts and their blocked-claim/lineage/reversal state together in the destination's existing filesystem-canonical Markdown page: facts remain in the existing fact fence, while one deterministic Learning Loop metadata fence records only typed identity and recovery state. A page lock plus one atomic temp-file rename commits fact and metadata changes together; the database remains a rebuildable index and the ledger remains non-authoritative evidence. All canonical mutations pass through one page-local lineage mutation function.

**Tech Stack:** TypeScript, Bun, existing GBrain operations, append-only Learning Loop JSONL ledger, filesystem-canonical Markdown facts, existing page locks, PGLite/Postgres rebuild index APIs.

## Delivery and safety boundary

- Owner repository: `uncfreak1255-code/gbrain`.
- Base: PR 1 squash merge `500ae0c3b2c1c885f04f4c3126d093fef7e6f930`.
- Writer: this parent execution context only.
- Scope: ADR section 14, PR 2 only.
- Excluded: context retrieval/injection, context telemetry, adapter work, outcomes/verdicts, PR 3+, canary arming or activation, live/global configuration, `~/.codex`, skills, MCP additions, Company Knowledge, Seascape, deploys, and external mutation.
- Acceptance gate: focused ADR regressions; `bun run verify`; `bun run test`; complete exact-head GitHub check set; one independent submitted native GitHub review from a non-author identity; exact-head guarded merge only if repository policy permits.

## BLOCKED — two-round plan pressure test

Implementation must not start from this plan until the following architecture gaps are resolved in a newly frozen plan and fresh review:

1. Existing ordinary canonical-page writers (`put_page`, sync/import, and DB-to-file write-through) can overwrite or bypass the proposed Learning Loop metadata fence and common lineage guard. The smallest safe change is to make every write to a metadata-bearing destination preserve and validate that fence through the same guard, with an overwrite-attempt regression.
2. An armed run freezes `brain_id`, `source_id`, and slug but not the arm-time canonical source/corpus realpaths or their configuration identity. The smallest safe change is to freeze those resolved roots/hashes and require exact equality before every transcript read, lock acquisition, and canonical rename, with post-arm rebinding regressions.
3. Canonical mutation and recovery are not yet ordered against mode-off/abort lifecycle changes. The smallest safe change is one documented lock order with the lifecycle lock outermost, a final in-lock mode/run/destination recheck before rename, and explicit causal recovery rules for a canonically committed event intent whose ledger delivery occurs after abort/off.

The second pressure-test reducer result for plan hash `199faec28c04313ecdcf4aa7bcf6adb5ebb358ad891ad8cf58c3391ea0093d69` was `block`. No implementation proof exists.

## Canonical contracts

- Canonical encoding is the repository's existing `canonicalJson` over fully validated typed values. Hashes are SHA-256 of UTF-8 canonical bytes.
- Claim normalization is deterministic Unicode NFC plus whitespace folding and trim. Empty, control-bearing, or oversized claims fail closed.
- Scope is a discriminated union: `global` with null target, `repository` with `repo:<forge>/<owner>/<repo>`, or `project` with a stable non-empty project key. Trigger is either reserved null or an explicit typed pending/terminal identity.
- A claim identity contains fingerprint, class, scope, exact target, and trigger where applicable. A pointer contains brain, source, canonical slug, and fact row.
- Authority contains the exact claim identity, authority class, provider/session, parsed source role, and transcript message identity. Direct-user authority is accepted only when the authoritative local transcript contains the exact normalized claim in the referenced user-role message. Assistant/model text cannot qualify.
- The Learning Loop metadata fence is a deterministic, versioned JSON object inside the same canonical Markdown file as the fact fence. It contains typed fact mappings, blocked identities, correction lineages, immutable commit markers, and reversal roots/attempts. It contains no transcript body, prompt, secret, or verbatim correction.
- Every PR 2 canonical mutation requires `learning_loop.mode === canary`, one replay-derived active armed run, and exact equality to that run's computed `brain_id`, frozen source, and frozen canonical slug. `off`, `capture`, unarmed, terminal-run, wrong-brain, wrong-source, and wrong-slug requests fail before path discovery or writes.
- One destination resolver recomputes active brain identity, validates the canonical slug, resolves only the registered source's canonical local root, and rejects absolute paths, traversal, malformed slugs, source mismatch, and symlink escape before lock/read/rename. It rechecks containment immediately before rename.
- All page changes use a hardened page-qualified lock keyed by `brain_id + source_id + slug` and a unique temp sibling followed by atomic rename. Lock acquisition uses exclusive file creation; refresh and release require an unguessable holder token. The fact rows and metadata phase/checkpoint therefore become visible together.
- A ledger append after canonical commit is recoverable evidence. The same atomic Markdown mutation stores an immutable canonical event intent containing the complete precomputed event bytes, identity, payload hash, timestamp, and append order. Recovery may append only those exact bytes and removes or marks the intent delivered only in a later canonical mutation after ledger readback. Same-ID/different-payload retries fail closed. Ledger data never overrides canonical Markdown.

### Task 1: Freeze exact identity, authority, and activation types

**Files:**
- Modify: `src/core/learning-loop.ts`
- Test: `test/learning-loop-knowledge.test.ts`

1. Add failing golden tests for canonical claim/scope/trigger encoding and hash vectors, including Unicode, whitespace, null, malformed repository targets, and identity inequality.
2. Add failing tests proving user-role authority must match the exact claim/message and that same-session assistant or unrelated user text cannot authorize it.
3. Add versioned candidate and authority event schemas and exact equality validators to the existing ledger union and replay reducer.
4. Add class activation predicates from ADR section 9. Keep friction and business candidates non-activating; require two distinct eligible session identities for repeated lessons; require the exact pending trigger for open loops.
5. Run the focused test file.

### Task 2: Add one canonical Markdown state codec and atomic mutation primitive

**Files:**
- Create: `src/core/learning-loop-knowledge.ts`
- Modify: `src/core/facts-fence.ts` only if a small exported row-rewrite helper is required
- Modify: `src/core/page-lock.ts`
- Test: `test/learning-loop-knowledge.test.ts`
- Test: `test/page-lock.test.ts`

1. Add failing round-trip and malformed-fence tests for the versioned Learning Loop metadata fence.
2. Add failing mapping tests for `brain_id + source_id + slug + fact row`, active and struck facts, blocked identity, and rebuild from Markdown alone.
3. Implement strict parser/renderer validation. Reject duplicate identities, duplicate pointers, invalid phases, missing successor links, invalid generation/fingerprint pairs, and metadata that disagrees with the fact fence.
4. Harden the existing page lock: exclusive create, random holder token, token-checked refresh/release, stale-holder recovery, and a page-qualified key that includes brain/source/slug. Add same-process and two-process barrier tests proving only one lineage writer enters and a non-holder cannot refresh or release.
5. Implement the destination resolver and tests for wrong brain/source, duplicate slug in another source, absolute/traversal/noncanonical slug, symlink escape/swap, and containment recheck before rename.
6. Implement the single page-lock mutation primitive. It reads one canonical page, validates fact and metadata fences, applies a pure typed mutation, stores the exact immutable event intent, writes a unique temp sibling, reparses it, rechecks target containment, and atomically renames it. No DB mutation occurs before the canonical rename.
7. Implement database index reconciliation from the post-commit fact fence using existing fact extraction and page-scoped rebuild methods.
8. Run focused lock, codec, confinement, and rebuild tests.

### Task 3: Implement activation and GBrain-owned repetition

**Files:**
- Modify: `src/core/learning-loop.ts`
- Modify: `src/core/learning-loop-knowledge.ts`
- Modify: `src/core/operations.ts`
- Test: `test/learning-loop-knowledge.test.ts`
- Test: `test/learning-loop-trust-boundary.test.ts`

1. Add failing tests for direct user activation of constraint/preference/goal, exact verified activation, two-distinct-eligible-session lesson repetition, same-session deduplication, ineligible-session exclusion, and open-loop pending-trigger enforcement.
2. Add trusted-local, `localOnly` owner operations for recording exact authority and applying canonical learning. Every privileged handler independently requires `ctx.remote === false`.
3. Before transcript or destination discovery, require `mode === canary`, a replay-derived active run, and exact computed brain/frozen destination equality. Add no-write tests for off, capture, unarmed, terminal run, wrong brain, wrong source, and wrong slug.
4. Resolve the transcript from the frozen source/session binding before authority validation and recheck the already accepted authoritative hash. Derive source role and message identity from GBrain-read bytes; do not accept caller text as authority. A changed transcript hash fails closed.
5. Derive repeated-pattern authority only inside GBrain from accepted candidate events tied to two distinct eligible session evaluations.
6. Activate through the common canonical mutation primitive, deliver the exact stored evidence intent to the ledger, and reconcile the index. Same command/payload is idempotent; changed payload conflicts.
7. Prove HTTP and stdio cannot discover or invoke the new local-only operations.

### Task 4: Implement correction block and common lineage guard

**Files:**
- Modify: `src/core/learning-loop.ts`
- Modify: `src/core/learning-loop-knowledge.ts`
- Modify: `src/core/operations.ts`
- Test: `test/learning-loop-correction.test.ts`

1. Add failing tests for A to B correction, pointer and identity binding, complete active replacement set, sorted-set fingerprint, generation increments, and rebuild survival.
2. Add failing tests proving repetition, verified outcome, direct recreation, and a new pointer cannot reactivate blocked A.
3. Implement one guarded canonical mutation path for activation, correction, supersession, trigger changes, reversal retirement/commit, and rebuild reconciliation. Any lineage-changing mutation recomputes the complete sorted active replacement set and advances generation exactly once; failed mutations leave canonical bytes unchanged.
4. Implement trusted-local correction transaction: validate exact direct-user authority, append B, strike A, create block and lineage, atomically commit canonical page, reconcile derived index, verify A is non-active and B active after full page rebuild, then append correction evidence.
5. Prove all exported canonical mutation entry points require the common guard.
6. Add a kill-after-rename/before-ledger-append seam. Recovery must append the exact precomputed correction event once, preserve its ID/payload/timestamp, and reject changed-payload retry.

### Task 5: Implement durable reversal phases and recovery

**Files:**
- Modify: `src/core/learning-loop.ts`
- Modify: `src/core/learning-loop-knowledge.ts`
- Modify: `src/core/operations.ts`
- Test: `test/learning-loop-reversal.test.ts`

1. Add failing tests for exact A reinstatement and A-authority/C-claim mismatch.
2. Add the persisted phase machine: `started -> retired_checkpointed -> rebuild_verified -> commit_intent -> committed`, plus terminal `superseded` and `failed`.
3. In one atomic canonical page mutation, snapshot and retire the complete active replacement set, advance lineage generation, write the post-retirement checkpoint, and enter `retired_checkpointed`.
4. Rebuild the derived index from Markdown, bind proof to pre-retirement obligations and post-retirement checkpoint, then persist `rebuild_verified` and `commit_intent`.
5. Under the common guard, compare-and-swap generation, set fingerprint, and recomputed set. On equality, atomically lift A's block, activate A, and write the immutable attempt commit marker. Recovery appends/recognizes `committed` idempotently.
6. If accepted guarded mutation causes drift, atomically mark predecessor superseded and create/link its successor with unioned inherited obligations. Unexplained drift fails closed with A still blocked.
7. Persist the exact immutable ledger-event intent inside every phase-changing canonical mutation. Recovery drains only those exact intents in their recorded order.
8. Add crash seam tests after each durable phase, including kill-after-rename/before-ledger-append for correction, `retired_checkpointed`, successor creation, and commit marker; empty-set recovery after retirement; post-intent committed-marker recovery; accepted drift successor creation; later B to C replacement; and no observable superseded predecessor without successor. Assert one exact event per intent and same-ID/changed-payload conflict behavior.

### Task 6: Full proof, review, and PR handoff

**Files:**
- Modify only files required by failures caused by this PR.

1. Run focused Learning Loop tests and `git diff --check`.
2. Run `bun run verify`, redirecting long output to a temporary file and inspecting the final result.
3. Run `bun run test`, redirecting long output to a temporary file and inspecting the final result. Do not repair unrelated baseline failures.
4. Run a bounded simplicity review and exact-head adversarial review. Resolve only actionable PR 2 findings, then rerun affected proof.
5. Commit, push, open PR 2 as draft, and inspect the complete GitHub check set.
6. When scope is frozen and required checks pass, mark ready and obtain one independent submitted native GitHub review from a non-author identity if this boundary change requires it.
7. Re-read the exact head. Merge only with an expected-head SHA guard if policy permits, then perform post-merge GitHub readback.
8. Stop. Do not begin PR 3.
