# Personal Learning Loop V1 PR 2 Implementation Plan

> **Execution rule:** Use `spine:work`. Keep exactly one writer in this isolated worktree. Do not implement until the frozen plan passes a new exact-hash native two-reviewer pressure test. Stop before PR 3.

**Review status:** Implementation remains blocked. The latest two-round review found three final durability/consistency seams; this revision closes them but has not received a post-revision exact-hash review.

## Objective

Implement only ADR PR 2: exact candidate and authority binding, class-specific canonical activation, correction blocking, complete lineage tracking, and crash-recoverable exact reversal.

The result must lower Sawyer supervision by making ordinary operation, crash recovery, abort, rebuild, and replay deterministic. It must not add a daemon, scheduler, queue service, dashboard, second memory store, reviewer layer, or runtime activation.

## Delivery lock

- Repository: `uncfreak1255-code/gbrain`.
- Base: PR 1 squash merge `500ae0c3b2c1c885f04f4c3126d093fef7e6f930`.
- Working branch: `feat/personal-learning-loop-pr2`.
- Writer: parent execution context only.
- Scope authority: `docs/architecture/personal-learning-loop-v1.md`, especially sections 6 and 8-10 plus PR 2 in section 14.
- Acceptance gate: every PR 2 ADR exit regression, `bun run verify`, `bun run test`, exact-head GitHub checks, and one independent submitted native GitHub review from a non-author identity.
- Excluded: PR 3 context retrieval/injection and telemetry; PR 4 adapters; PR 5 outcomes, settlement, baseline scoring, and verdicts; canary arming or activation; live/global configuration; `~/.codex`; skills; new MCPs; Company Knowledge; Seascape; deployment; external mutation.

## Architecture decision

### Options considered

1. **Patch each canonical writer independently.** Rejected. The repository has many live Markdown writers, and a future writer could silently omit the lineage fence.
2. **Store lineage in a database or sidecar file.** Rejected. The database is a rebuildable index, and a sidecar becomes a second canonical memory store and breaks atomic fact-plus-lineage transitions.
3. **Use one shared filesystem-canonical write boundary with an embedded protected fence.** Selected. Facts and lineage remain in one canonical Markdown page and one atomic rename. Every live writer uses the same preservation/rejection policy.

### Selected shape

- Existing `## Facts` remains canonical for personal fact rows.
- One deterministic `gbrain:learning-loop:v1` metadata fence in the same Markdown page stores only typed identity, managed-row mappings, blocked identities, correction lineages, reversal attempts, immutable commit markers, and at most one pending ledger-delivery record.
- A new small shared owner, `src/core/canonical-page-write.ts`, becomes the only live-filesystem replacement primitive. It centralizes root confinement, lock acquisition, managed-fence preservation, temp-write validation, and atomic rename. It is not a store or control plane.
- `src/core/learning-loop-knowledge.ts` owns the strict metadata codec and pure Learning Loop state reducer. Generic writers cannot construct or mutate lineage state.
- The append-only Learning Loop ledger remains non-authoritative evidence. Canonical Markdown remains sufficient to rebuild block, lineage, reversal, and active-fact state.
- The database remains a derived index reconciled only after a successful canonical rename.

## Non-negotiable invariants

### Authority and activation

- Every PR 2 canonical mutation requires `learning_loop.mode === canary`, a replay-derived active V2 run, and exact equality with its frozen brain, source, slug, corpus binding, and destination-root binding.
- A PR 1/V1 armed run lacks frozen roots and is capture-only. It cannot activate, correct, reverse, or mutate canonical knowledge; it must be aborted and re-armed under V2.
- Direct user authority comes only from a GBrain-read Codex transcript row whose parsed role is `user`. The authority event binds the exact normalized claim fingerprint, class, scope, target, trigger, provider/session, transcript hash, message locator, message hash, and source role.
- Assistant/model text, unrelated user text in the same session, caller-supplied transcript text, and a changed authoritative transcript hash cannot gain user authority.
- Adapters cannot assert repeated-pattern authority. GBrain derives it from the same identity observed in two distinct accepted eligible sessions.
- `friction` and `business_candidate` never activate. Verified-outcome authority is modeled and blocked correctly but has no agent-facing producer until PR 5.

### Canonical state

- One atomic page rename makes fact rows, managed-row mappings, block state, lineage generation/fingerprint, reversal phase/checkpoint, commit marker, and pending ledger delivery visible together.
- Generic content writers preserve the complete existing facts fence and Learning Loop metadata fence byte-for-byte on a managed page. If submitted content differs on either protected fence, the write fails closed with an actionable error.
- Non-lineage fact writers may add or change only rows not listed as Learning Loop-managed. They must preserve every managed row and the metadata fence exactly.
- Only the Learning Loop transition reducer may change a managed row, block, lineage, reversal, or Learning Loop metadata field.
- Checkout rebuild/recovery copies both protected fences from the current canonical page into staging and validates them before publish. Missing, malformed, conflicting, or unrepresentable managed state aborts the whole publish.
- Delete, rename, phantom redirect, migration rewrite, and frontmatter repair reject a managed page unless their adapter explicitly proves protected state is preserved.
- The last accepted canonical transition event binds `protected_state_hash`: SHA-256 of canonical managed fact rows plus block, lineage, reversal, and immutable commit-marker state, excluding the hash field and `pending_delivery`. Legal ordinary body, frontmatter, takes, timeline, backlink, and non-managed-fact edits do not change this hash. If manual or out-of-process edits remove or alter managed metadata/rows, the next inspect, recovery, rebuild, mutation, or retrieval prerequisite detects the mismatch and fails closed. Missing metadata is never interpreted as an unblocked claim.
- For a managed page, filesystem commit is always first. Only after exact canonical readback may GBrain import or reconcile the database. A rejected canonical write leaves both the file and database unchanged.

Before any caller classifies a target as unmanaged, one shared expected-managed preflight checks the exact `brain_id + source_id + canonical_slug` under the source boundary. A valid canonical metadata fence is positive evidence. Replayed Learning Loop transition history, the active run's frozen destination, and derived database managed-row markers are fail-closed expectation hints only: they may prove that protected canonical state is expected, but they can never reconstruct or authorize that state. If any hint expects managed state and the canonical metadata or managed rows are absent, malformed, conflicting, or do not match the last accepted `protected_state_hash`, the operation returns `managed_state_unavailable` before any database or filesystem mutation. Failure or disagreement while reading an existing hint also fails closed. Only when canonical inspection proves the target is absent or validly unmanaged and every available hint agrees that no managed state exists may the ordinary unmanaged path run. The shared canonical writer repeats this expectation check after page-lock acquisition and immediately before rename, so deletion or corruption between preflight and commit cannot downgrade a managed page to unmanaged.

### No ambient routing

- No mutation or recovery derives brain, source, corpus, or destination from cwd, mounts, environment, or caller paths.
- Every pointer is `brain_id + source_id + canonical_slug + fact_row`.
- Every operation recomputes the active brain from explicit config and compares it with the frozen run before transcript or destination discovery.

## Frozen root bindings

PR 2 introduces V2 arm inputs while keeping V1 replay-compatible.

Each V2 `run_armed` event freezes:

```text
corpus_binding = {
  source_id,
  configured_root_hash,
  canonical_realpath,
  device,
  inode,
  binding_hash
}

destination_binding = {
  brain_id,
  source_id,
  canonical_slug,
  topology: source_local_path | sync_repo_path,
  configured_root_hash,
  canonical_realpath,
  device,
  inode,
  binding_hash
}
```

- `binding_hash` is SHA-256 of repository `canonicalJson` over the other normalized fields.
- Arming resolves each root twice, before and after baseline discovery, and fails if value, realpath, device, or inode changes.
- Every transcript read re-resolves current corpus configuration and requires exact binding equality before opening a session file.
- Every canonical read, lock, temp write, rebuild, and rename re-resolves current destination configuration and requires exact binding equality.
- Root rebinding, source-local-path change, repo-path change, directory replacement, symlink replacement, wrong brain, wrong source, or wrong slug fails closed for learning. Ordinary agent work remains available outside the Learning Loop.
- The final parent directory is realpathed and its device/inode and root containment are rechecked immediately before rename and again after durable rename/readback.
- The supported threat boundary is explicit: every GBrain-owned root swap/rebind uses the source boundary and therefore cannot race the rename. Symlink/path replacement visible before the final check fails closed. Node/Bun does not expose portable dirfd-anchored `renameat`; the plan does not claim prevention of a hostile privileged process replacing the verified parent between the final check and the rename syscall. A post-rename binding mismatch is a hard trust failure, disables further learning, and is never accepted as a valid canonical transition. If the ADR is interpreted to require hostile-local dirfd protection, implementation must stop for an architecture decision rather than add FFI/native infrastructure in PR 2.

## Shared canonical-writer contract

All live writers below must route through `canonical-page-write.ts` or explicitly refuse a managed page:

| Writer | Existing owner | PR 2 adapter behavior |
|---|---|---|
| DB-to-Markdown write-through used by `put_page`, brainstorm, and sync re-export | `src/core/write-through.ts` | All three callers run the shared expected-managed preflight before DB mutation or unmanaged classification. Unmanaged pages retain the current DB-first path only after that preflight proves no managed expectation. For a managed canonical page, `put_page` and brainstorm merge ordinary content with the exact protected fences, commit through the shared boundary, read back the exact canonical bytes, and only then import/reconcile the database. If a previously managed page has deleted, malformed, conflicting, or hash-mismatched protected bytes, all three callers reject with `managed_state_unavailable`; sync re-export must never recreate managed state from a DB row. |
| Fact append/stub | `src/core/facts/fence-write.ts` | Non-lineage-fact mode; managed rows immutable |
| Fact forget/strike | `src/core/facts/forget.ts` | Reject managed row; allow non-managed row through shared boundary |
| Takes add/edit/revisit | `src/commands/takes.ts` | Preserve protected fences for takes mutations; refuse interactive revisit on a managed page |
| Backlink fixer | `src/commands/backlinks.ts` | Ordinary-content mode |
| Frontmatter CLI fix/set | `src/commands/frontmatter.ts` | Ordinary-content mode |
| Markdown lint fixer | `src/commands/lint.ts` | Ordinary-content mode |
| Pattern reverse-write | `src/core/cycle/patterns.ts` | Ordinary-content mode |
| Synthesis and summary reverse-write | `src/core/cycle/synthesize.ts` | Ordinary-content mode |
| Phantom redirect/materialization | `src/core/cycle/phantom-redirect.ts` | Reject when source or target is managed |
| Whole-checkout recovery publish | `src/core/recovery-source-refresh.ts` | Copy and validate protected fences into staging before atomic checkout publish |
| Frontmatter repair | `src/core/brain-writer.ts` | Preserve both protected fences |
| Historical facts migration rewrite | `src/commands/migrations/v0_32_2.ts` | Skip/refuse managed pages; migration cannot rewrite them |
| Source checkout refresh/replacement/removal | `src/core/sources-ops.ts` | Refuse while the source is bound to an active V2 run; after terminal, preserve canonical history under existing destructive authority rules |

`src/commands/export.ts` is excluded because it writes a caller-selected export, not a live canonical source. It still must not be used as a Learning Loop rebuild proof.

The shared boundary exposes only four explicit modes:

1. `ordinary_content`: protected fences must remain byte-identical.
2. `non_lineage_fact`: managed facts and metadata must remain semantically and byte stable.
3. `learning_transition`: requires the Learning Loop reducer and all frozen/lifecycle guards.
4. `checkout_rebuild`: copies protected fences from the current canonical source and validates the complete staged checkout before publish.

There is no unguarded `force` or `preserve=false` option.

## Concurrency and lock order

### Harden existing locks

- Replace page-lock check-then-write with exclusive create (`O_CREAT|O_EXCL`).
- Page lock identity is SHA-256 of canonical `brain_id + NUL + source_id + NUL + slug`, not slug alone.
- Lock contents contain PID, random holder token, and refreshed timestamp.
- Refresh and release succeed only when the token still matches.
- Stale recovery uses observed-content compare-before-unlink and retries exclusive acquisition; it never overwrites a live lock.
- Add same-process and two-process barrier tests.
- The shared canonical writer writes and `fsync`s the unique temp file, atomically renames it, then `fsync`s the containing directory before reporting canonical commit. Tests assert syscall order through a narrow injected filesystem seam. Process-exit and power-loss guarantees are reported separately.

### Global order

Any operation that may touch a live canonical source follows this order:

```text
source sync/write boundary
  -> Learning Loop lifecycle lock
    -> page-qualified lock
      -> Learning Loop ledger lock
```

- No code path may acquire these locks in reverse order.
- Ordinary canonical writers enter the source write boundary too. This lets arm, Learning Loop mutation, page writers, and whole-checkout publish serialize without a detection race.
- The source-boundary callback receives a branded, source-bound `SourceWriteLease`. Nested writers such as sync re-export and recovery refresh pass that lease into `canonical-page-write.ts`; the helper validates the source and does not reacquire the same non-reentrant database lock. Callers without the exact lease acquire the boundary normally. There is no boolean `skipLock` escape hatch.
- `src/commands/sync.ts` owns the outer lease for `performSyncInner` and passes it to nested `writePageThrough` calls. `src/core/recovery-source-refresh.ts` does the same for staged checkout work. Wrong-source, stale, forged, or missing leases fail closed in managed-page mode.
- Under the lifecycle lock, every Learning Loop transition replays the ledger and rechecks mode, active run, terminal state, frozen bindings, and destination immediately before page rename.
- Ledger append occurs only after canonical rename and while lifecycle/page ownership is still held.
- Database index reconciliation happens after ledger delivery and canonical acknowledgement. Reconciliation failure leaves canonical truth intact and is retried from canonical state.

### Arm, abort, and mode transitions

- Arm acquires the destination source boundary, then lifecycle lock, freezes both roots, performs baseline discovery, rechecks both bindings, and appends V2 `run_armed`.
- Abort/off first reads a non-authoritative active-run snapshot to choose the frozen source boundary, acquires it, then acquires lifecycle and replays the ledger. If the run changed, it releases and retries up to three times.
- With lifecycle and page ownership, abort/off drains or acknowledges the single canonical pending ledger delivery before appending `run_aborted`.
- Only after pending delivery is proven in the ledger may the terminal event append. Therefore no recovered learning event can appear causally after terminal state.
- If canonical recovery cannot complete, leaving canary must still disable behavior: the requested non-canary mode is written under lifecycle lock, the active run remains nonterminal and non-injecting, and the operation returns `disabled_recovery_pending`. The next trusted-local inspect/abort/arm/mode operation retries recovery automatically. A new run cannot arm until recovery appends the terminal abort.
- Direct owner abort uses the same path. If recovery fails, it forces mode `off` and returns the same recoverable state.
- This is a bounded recovery state, not a queue or supervision surface: at most one active run and one pending canonical delivery exist, and ordinary owner operations retry it automatically.
- Whole-checkout recovery, source refresh/replacement, and source removal are refused while that source is frozen by an active V2 run. They do not publish a new root inode. After the run is terminal, checkout recovery may proceed only after copying and validating protected fences; a later run freezes the new root identity.

## Canonical event-delivery protocol

The metadata fence contains `pending_delivery: null | ExactEventRecord`.

- A canonical transition precomputes the complete versioned event bytes, `event_id`, payload hash, timestamp, and semantic sequence before mutation.
- The atomic page rename stores the resulting canonical state and that exact record together.
- While locks remain held, GBrain appends those exact bytes to the ledger and reads them back.
- The append path `fsync`s the ledger file before readback. If the append created the ledger, it also `fsync`s the ledger parent directory. Terminal events use the same durable append primitive.
- A second atomic canonical rename clears `pending_delivery` only after durable exact ledger equality is proven.
- Crash after canonical rename but before append: recovery appends the exact stored bytes once.
- Crash after append but before acknowledgement: recovery recognizes same-ID/same-payload and clears the record without double-counting.
- Same-ID/different-payload, a second pending record, malformed bytes, or unexplained canonical/ledger disagreement fails closed.
- New canonical transitions cannot begin while `pending_delivery` is non-null; they must recover it first.
- Atomic predecessor-supersession/successor-creation is one discriminated canonical transition and one exact event record containing both sides and inherited obligations. A predecessor cannot become terminal without its linked successor in the same page rename.

This is synchronous crash recovery embedded in canonical state, not a scheduler, daemon, or durable work queue.

Power-loss tests model loss of every write that was not followed by the required file/directory `fsync`. Clearing `pending_delivery` while the corresponding ledger event is not durable is forbidden.

## Identity and canonical encoding

- Use repository `canonicalJson`; hash normalized UTF-8 bytes with SHA-256.
- Claim normalization: Unicode NFC, CRLF/CR to LF, horizontal/vertical whitespace folding to one space, trim, reject empty/control-bearing/oversized input.
- Scope is a discriminated union:
  - `global` with reserved null target;
  - `repository` with exact `repo:<forge>/<owner>/<repo>` target;
  - `project` with one stable explicit project key.
- Trigger is reserved null for non-open-loop classes; open loops require an exact typed trigger identity and state.
- Opaque values use length-prefixed canonical encoding, never delimiter concatenation.
- Managed pointer ordering is UTF-8 byte order over canonical pointer encoding.
- Replacement-set fingerprint hashes the complete sorted pointer list.
- Any successful lineage-changing transition advances `lineage_generation` exactly once. A rejected transition changes no bytes.

### Class-to-fact mapping

| Learning class | Fact-fence kind | Activation predicate |
|---|---|---|
| constraint | `belief` | exact direct-user authority or authoritative correction/reversal |
| preference | `preference` | exact direct-user authority or authoritative correction/reversal |
| goal | `commitment` | exact direct-user authority or authoritative correction/reversal |
| lesson | `fact` | exact verified outcome, or same identity in two distinct eligible sessions; not blocked |
| friction | none | candidate only |
| open loop | `commitment` | exact user/verified authority plus exact pending trigger; not blocked |
| business candidate | none | existing candidate-only path; never personal activation |

The metadata mapping preserves the richer Learning Loop class because the facts fence kind is intentionally coarser.

## Implementation sequence inside PR 2

All phases remain on one draft PR 2 branch. Do not open PR 3. Freeze each phase with focused proof before starting the next.

### Phase 1 — V2 run bindings and exact identity codecs

**Primary files**

- Modify `src/core/learning-loop.ts`.
- Modify `src/core/operations.ts` only for V2 arm/result shapes.
- Test `test/learning-loop.test.ts`.
- Create `test/learning-loop-identity.test.ts`.

**Work**

1. Add golden canonical encoding/hash vectors for claim, scope, target, trigger, pointer, root binding, and replacement sets.
2. Add V2 `run_armed` fields and replay validation while retaining V1 replay compatibility.
3. Freeze corpus and destination bindings at arm; double-check them around baseline discovery.
4. Make V1 runs fail closed for canonical mutation.
5. Prove root/path/topology rebinding and inode replacement are rejected.

### Phase 2 — shared canonical write boundary and lock hardening

**Primary files**

- Create `src/core/canonical-page-write.ts`.
- Modify `src/core/page-lock.ts`.
- Create `src/core/learning-loop-knowledge.ts` with codec only.
- Test `test/page-lock.test.ts`.
- Create `test/canonical-page-write.test.ts`.
- Create `test/learning-loop-knowledge.test.ts`.

**Work**

1. Implement exclusive token-owned page locks and two-process contention proof.
2. Implement strict metadata-fence parse/render and malformed-state rejection.
3. Implement the four explicit writer modes and unique temp-sibling rename.
4. Reparse staged bytes and recheck root/parent identity and containment immediately before rename.
5. `fsync` temp contents before rename and the parent directory after rename.
6. Prove generic writes cannot remove/change protected fences or managed rows.

### Phase 3 — route every live canonical writer

**Primary files**

- Modify only the writer owners in the inventory table.
- Add focused regression tests beside each existing writer suite.

**Work**

1. Generate the initial inventory from every file write, rename, unlink, copy, and directory-swap call under `src/`; classify each as live canonical, non-live output, configuration/state, temp/quarantine, or test-only.
2. Replace direct live Markdown writes with the shared boundary, including takes, backlinks, frontmatter, and lint.
3. Preserve current behavior for unmanaged pages.
4. Reject managed interactive editor entry, phantom redirect, destructive migration rewrite, unsupported delete/rename, and active-V2 source checkout replacement/removal.
5. Make whole-checkout recovery carry and validate protected fences before publish, and refuse it during an active V2 run.
6. Add a structural test generated from filesystem-mutation call sites. Every live-canonical site must import the shared boundary or appear in a narrow reviewed rejection adapter; non-live sites are classified in the test fixture with a reason. A new unclassified filesystem mutation fails CI.
7. Replace the managed form of every DB-to-Markdown caller with one canonical-first flow. `put_page`, brainstorm, and sync re-export call the same expected-managed preflight keyed by exact brain/source/slug before any import or unmanaged classification. The preflight uses canonical inspection plus replayed transition history, the active frozen destination, and derived managed-row markers only as fail-closed expectation hints; absence, corruption, hash mismatch, lookup failure, or disagreement rejects without mutation. For a valid managed `put_page` or brainstorm target, atomically write the submitted ordinary-content merge before `importFromContent`, then reconcile the database from exact canonical readback. `writePageThrough` remains an after-DB renderer only for a target proven unmanaged. Sync re-export must never synthesize protected state from the DB. Add barrier tests that delete or corrupt the metadata fence or managed rows after the first preflight and prove the pre-rename recheck still rejects. Unmanaged callers retain existing behavior.

### Phase 4 — candidate, authority, and activation

**Primary files**

- Modify `src/core/learning-loop.ts`.
- Modify `src/core/learning-loop-knowledge.ts`.
- Modify `src/core/operations.ts`.
- Create `test/learning-loop-authority.test.ts`.
- Extend `test/learning-loop-trust-boundary.test.ts`.

**Work**

1. Add versioned candidate and authority event unions with exact variant equality checks.
2. Parse authoritative transcript rows into stable line/message locators and hashes.
3. Add trusted-local, `localOnly` owner operations. Every handler independently rejects `ctx.remote !== false`; HTTP and stdio omit/deny them.
4. Implement class predicates and GBrain-owned two-distinct-eligible-session repetition.
5. Activate through one canonical transition with exact pending delivery and derived-index reconciliation.
6. Keep verified-outcome producer unavailable until PR 5.

### Phase 5 — correction block and common lineage guard

**Primary files**

- Modify `src/core/learning-loop-knowledge.ts`.
- Modify `src/core/learning-loop.ts` and `src/core/operations.ts` only for typed commands/events.
- Create `test/learning-loop-correction.test.ts`.

**Work**

1. Implement the exact blocked-claim key, correction event, complete active replacement set, sorted fingerprint, and generation.
2. Make activation, correction, supersession, trigger mutation, rebuild reconciliation, and reversal call the same pure lineage reducer.
3. Atomically strike A, append B, create the block/lineage, and persist exact event delivery.
4. Rebuild the database index from Markdown and prove A remains blocked and B active.
5. Prove repetition, verified authority, direct recreation, new pointer, and generic writers cannot reactivate A.

### Phase 6 — reversal and automatic recovery

**Primary files**

- Modify `src/core/learning-loop-knowledge.ts` and `src/core/learning-loop.ts`.
- Modify `src/core/operations.ts` only for typed trusted-local commands.
- Create `test/learning-loop-reversal.test.ts`.
- Create `test/learning-loop-recovery.test.ts`.

**Work**

1. Implement `started -> retired_checkpointed -> rebuild_verified -> commit_intent -> committed`, plus terminal `superseded` and `failed`.
2. In one page rename, snapshot and retire the complete replacement set, advance generation, and store the post-retirement checkpoint.
3. Bind rebuild proof to inherited obligations, pre-retirement set, and post-retirement checkpoint.
4. Persist commit intent, then perform exact generation/fingerprint/set CAS under the common guard.
5. On accepted drift, atomically supersede predecessor and create/link successor with the union of inherited and current obligations.
6. Recover every crash seam automatically from canonical state and exact ledger delivery.
7. Implement abort/off snapshot-retry ordering and `disabled_recovery_pending` behavior.

### Phase 7 — full proof and landing

1. Run focused Learning Loop and writer tests plus `git diff --check`.
2. Run `bun run verify`, redirecting long output to a temporary file and inspecting the final result.
3. Run `bun run test`, redirecting long output to a temporary file and inspecting the final result. Do not repair unrelated baseline failures.
4. Run bounded simplicity review and adversarial exact-head review. Remove unnecessary abstractions or state.
5. Commit, push, and open PR 2 as draft. Mark ready only after scope and proof freeze.
6. Inspect the complete exact-head GitHub check set.
7. Obtain one independent submitted native GitHub review from a non-author identity.
8. Re-read the exact head. Merge only with expected-head SHA guard if repository policy permits, then perform post-merge readback.
9. Stop. Do not begin PR 3.

## Required executable proof matrix

### Trust, identity, and activation

- HTTP and stdio cannot discover or invoke new `localOnly` controls.
- Privileged handlers reject `ctx.remote !== false` even if dispatch filtering regresses.
- Model text cannot gain user authority.
- Unrelated same-session user text cannot authorize another claim.
- Changed transcript bytes after accepted session evaluation fail closed.
- Off, capture, unarmed, terminal, V1 run, wrong brain/source/slug/root/topology cannot mutate canonical state.
- Ineligible sessions and duplicate observations from one session cannot satisfy repetition.
- Class predicates match ADR section 9 exactly.

### Canonical writer and rebuild safety

- Every inventoried live writer preserves both protected fences on a managed page or rejects the operation.
- Ordinary `put_page`, write-through, takes, backlinks, frontmatter, lint, pattern/synthesis, fact append/forget, phantom redirect, migration, and checkout recovery cannot remove or alter managed state.
- Managed `put_page` and brainstorm rejection leaves database and canonical bytes unchanged; successful managed writes import the exact canonical readback afterward. For `put_page`, brainstorm, and sync re-export, a replay/active-run/derived marker that expects managed state makes a deleted fence, malformed fence, missing managed row, or `protected_state_hash` mismatch reject before DB mutation; barrier deletion or corruption between preflight and rename also rejects. Managed sync re-export never reconstructs protected state from a DB row.
- A newly introduced direct live-page writer fails the structural bypass test.
- Root rebinding, directory inode replacement, traversal, absolute slug, and symlink escape visible before final validation fail closed; every GBrain-owned root swap waits on the source boundary.
- Two processes cannot enter the same brain/source/slug mutation; a non-holder cannot refresh/release.
- Nested sync/recovery writes reuse only their exact source-bound lease and do not reacquire or deadlock; wrong-source and forged leases fail.
- Managed rename orders temp-file `fsync`, atomic rename, and parent-directory `fsync`; process-kill and simulated power-loss seams have separate assertions.
- Ledger delivery and terminal append `fsync` ledger bytes and, on creation, the parent directory before canonical acknowledgement; simulated power loss cannot erase an acknowledged event.
- A legal ordinary body/backlink/takes/frontmatter edit preserves `protected_state_hash`, while a one-byte managed-row or lineage change fails exact inspection.
- Full database deletion and rebuild reconstructs identical active facts, blocks, lineages, phases, pointers, generations, and fingerprints from Markdown.

### Correction and lineage

- A to B correction creates one durable block and exact lineage.
- Corrected A cannot reactivate through repetition, verified authority, direct recreation, or a new pointer.
- Every accepted lineage mutation advances generation and complete-set fingerprint exactly once.
- Rejected/bypassed mutation leaves canonical bytes unchanged.
- Generic writers cannot orphan a block from its active replacements.

### Reversal and crash recovery

- Reversal naming A but authorizing C leaves A blocked.
- A to B then exact A reinstatement completes all phases and retires B.
- Later B to C before checkpoint is included in current/inherited obligations.
- B to C after checkpoint or commit intent makes CAS fail and atomically creates a successor for C.
- Direct or repeated recreation after checkpoint also creates a successor.
- A superseded predecessor is never visible without linked successor and inherited obligations.
- Intended retirement generation advance does not self-fail.
- Crash after `retired_checkpointed` resumes with an empty active set.
- Crash after canonical rename/before ledger append recovers the exact event once.
- Crash after ledger append/before canonical acknowledgement does not double-count.
- Crash after `commit_intent` reconciles committed marker, retries exact checkpoint, or creates accepted-drift successor.
- Later accepted mutation after immutable commit marker recovers the attempt as committed before replaying later state.
- Unexplained third-state drift leaves the block enforced and fails closed.
- Abort/off waits for an in-flight canonical commit, drains its pending delivery before terminal append, and cannot admit a later learning event.
- Failed abort recovery disables mode, blocks re-arm, and completes automatically when the canonical source is available again.
- Active V2 run refuses whole-checkout recovery and source replacement/removal without changing the frozen inode; after terminal state, recovery preserves protected fences and a later arm freezes the replacement root.
- A barrier-controlled GBrain root-swap attempt cannot pass the source boundary during canonical rename. A post-rename external binding mismatch is detected as a hard trust failure; no hostile-local dirfd guarantee is claimed.

## Stop conditions

Stop and report `BLOCKED` if:

- a required writer cannot preserve or reject managed state without changing behavior outside PR 2;
- the repository cannot provide one consistent lock order;
- the accepted threat model requires portable hostile-local dirfd-anchored rename rather than serialized GBrain-owned writers and post-write mismatch detection;
- atomic fact-plus-lineage state cannot remain in one canonical Markdown rename;
- recovery would require a daemon, scheduler, queue service, or user-maintained receipt;
- proof requires live/global activation, external mutation, PR 3+, or Seascape;
- CI or required independent review cannot execute.
