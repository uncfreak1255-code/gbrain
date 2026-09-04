# v0.48.2 Personal Learning Loop Forward-Port Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one repository-only candidate based on `662dac6b0468dacb8eeb93b12063debdabbba7b3` that retains upstream v0.48.2.0 and PR #115 while adding the merged Personal Learning Loop behavior through PR #121 and excluding PR #122.

**Architecture:** Forward-port behavior onto the installed lineage instead of joining the old fork history. Add the learning-loop foundation and canonical mutation layer to the newer v0.48.2 architecture, retain upstream receipt/reranker/readiness/schema implementations, and adapt locking and persistent scope identity at their current owners.

**Tech Stack:** TypeScript, Bun, PGLite/Postgres parity, Markdown-backed canonical pages, GBrain operation contracts.

---

## Chunk 1: Source reconstruction and patch boundary

### Task 1: Freeze exact lineage and exclusions

**Files:**
- Create: `docs/superpowers/plans/2026-09-04-v0482-learning-loop-forward-port.md`

- [ ] Record `v0.48.2.0` tag `5cfb84f1d3a809c70064c292c23db3d538d5c551`.
- [ ] Record installed and PR #115 merge commit `662dac6b0468dacb8eeb93b12063debdabbba7b3`.
- [ ] Record GitHub master `f1d2a2cd13505d799daf1465c8b5c634deaf06a8` and open PR #122 head `21c0e9ce5f0fa082007d1a085cdbd33062f3f412`.
- [ ] Map each PR with `git diff <merge>^1 <merge>` and classify its behavior as ported, already present, superseded, or omitted.
- [ ] Confirm PR #118 receipt semantics already exist in newer form on the base; do not replace them.
- [ ] Extract the full PR #122 material diff and build a symbol/path exclusion check.

## Chunk 2: Learning-loop foundation

### Task 2: Port PR #113 trusted capture foundation

**Files:**
- Create: `src/core/learning-loop.ts`
- Modify: `src/core/config.ts`, `src/core/operations.ts`, CLI/MCP dispatch and trust-boundary callers selected by the current v0.48.2 architecture
- Test: `test/learning-loop.test.ts`, `test/learning-loop-trust-boundary.test.ts`, relevant operation and upgrade-checkpoint tests

- [ ] Apply the PR #113 material patch without committing and inspect every conflict against current owners.
- [ ] Keep default `learning_loop.mode=off`, trusted-local controls, provider/session binding, GBrain-owned transcript discovery/hash/eligibility, append-only ledger, deterministic lifecycle, and the exact ten-session cohort foundation.
- [ ] Preserve v0.48.2 operation façades, trust checks, reranker/readiness changes, and configuration semantics.
- [ ] Run the focused PR #113 tests and require zero failures.

### Task 3: Port PR #114 authority and canonical mutation behavior

**Files:**
- Create: `src/core/canonical-page-write.ts`, `src/core/learning-loop-knowledge.ts`
- Modify: current canonical page mutation callers, engine interfaces/implementations, config, operations, and writer inventory
- Test: `test/canonical-page-write.test.ts`, `test/learning-loop-authority.test.ts`, `test/learning-loop-config-boundary.test.ts`, `test/learning-loop-correction.test.ts`, `test/learning-loop-identity.test.ts`, `test/learning-loop-knowledge.test.ts`, `test/learning-loop-managed-import.serial.test.ts`, `test/learning-loop-recovery.test.ts`, `test/learning-loop-reversal.test.ts`, `test/learning-loop-writer-inventory.test.ts`

- [ ] Apply the PR #114 material patch without committing and resolve toward current v0.48.2 primitives.
- [ ] Preserve claim-bound authority, canonical personal-memory activation, durable correction blocking, replacement/reversal lineage, and managed-page mutation protection.
- [ ] Regenerate writer inventory from the resulting current tree instead of accepting an obsolete historical fixture mechanically.
- [ ] Run the focused PR #114 tests and require zero failures.

## Chunk 3: Current-line hardening

### Task 4: Adapt PR #119 source-qualified page locking

**Files:**
- Modify: `src/core/page-lock.ts`, `src/core/canonical-page-write.ts`, and every current Markdown-plus-DB mutation caller found by writer inventory
- Test: `test/page-lock.test.ts`, `test/canonical-page-write.test.ts`, focused caller tests

- [ ] Compare PR #119 with v0.48.2 adaptation `128d49631f981b08b717c5df0e3a65d25a06a020`.
- [ ] Use logical `(brainId, sourceId, slug)` and canonical physical path identity.
- [ ] Enforce source-before-page lock ordering and serialize Markdown plus DB mirror writes.
- [ ] Preserve nested same-chain safety without using inherited async context as cross-sibling serialization.
- [ ] Prove same-page mutation interleaving is prevented.

### Task 5: Adapt PR #120 bounded source-lock waiting

**Files:**
- Modify: `src/core/db-lock.ts`, `src/core/canonical-page-write.ts`
- Test: `test/db-lock-per-source.test.ts`

- [ ] Add an explicit bounded wait option used only by canonical mutation coordination.
- [ ] Preserve fail-fast as the default for unrelated callers.
- [ ] Prove timeout and release behavior.

### Task 6: Adapt PR #121 persistent scope identity

**Files:**
- Modify: `src/core/learning-loop.ts`, `src/core/learning-loop-knowledge.ts`
- Test: `test/learning-loop-knowledge.test.ts`, `test/learning-loop-authority.test.ts`, identity round-trip tests

- [ ] Persist the full claim and scope identity.
- [ ] Enforce mutually exclusive global, repository, and project targets.
- [ ] Persist forge-qualified repository identity.
- [ ] Reject malformed or contradictory state.
- [ ] Prove exact global/repository/project round trips.

## Chunk 4: Compatibility, exclusion, and closeout proof

### Task 7: Preserve v0.48.2 and PR #115 behavior

**Files:**
- Test only unless a concrete regression is found in the material diff.

- [ ] Run the focused PR #115 spend-control suite and require fail-closed missing/invalid cap and ledger behavior.
- [ ] Run Z.AI recipe/config/model-pricing structural tests without paid inference.
- [ ] Run reranker/readiness tests affected by the forward-port.
- [ ] Run migration/schema bootstrap and engine-parity proof; require no migration removal or downgrade.
- [ ] Compare protected v0.48.2/PR #115 paths against base and explain every material difference.

### Task 8: Run repository proof and compiled provenance

**Files:**
- Generated files only when the current-base generator requires them.

- [ ] Run the complete focused learning-loop and hardening cone.
- [ ] Run `bun run typecheck` and require exit 0.
- [ ] Run `bun run verify` and require exit 0.
- [ ] Run `git diff --check` and require exit 0.
- [ ] Build with `bun build --compile --outfile bin/gbrain src/cli.ts` and require exit 0.
- [ ] Read `./bin/gbrain --version` and bind provenance to the exact candidate SHA/tree.
- [ ] Verify effective default mode is off, no canary is armed by source/config defaults, and no PR #122 path or symbol exists.

### Task 9: Exact-head independent review and PR

**Files:**
- Modify only files required by at most one focused repair round.

- [ ] Commit the verified candidate with the repository guardrail flow.
- [ ] Run one independent read-only breaker against the entire exact material diff and exact SHA.
- [ ] Permit at most one focused repair round; rerun affected and global proof after any repair.
- [ ] Push the branch and create one PR against `upstream-base/v0.48.2.0`; do not merge it.
- [ ] Read back the PR head, base, diff, checks, and mergeability.
- [ ] Recheck `git status --short --branch` and report all remaining residue.

## Stop path

Stop as `BLOCKED` on any user-defined stop condition: broad history merge, material architecture conflict, weakened spend or learning safety, ambiguous schema compatibility, a third distinct reconciliation failure class, more than one substantial repair round, or any need for install/restart/config/spend/credential/activation work.
