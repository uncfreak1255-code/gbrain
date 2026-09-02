# Personal Learning Loop V1 PR 2 Implementation Plan

> **Execution rule:** Use `spine:work`. Keep exactly one writer in this isolated worktree. Do not implement until the frozen plan passes a new exact-hash native two-reviewer pressure test. Stop before PR 3.

**Review status:** Implementation remains blocked. The latest exact-hash review found three undefined execution contracts: path-writer source identity, configured-root hashing/topology, and semantic sequencing. This revision defines them but has not received a post-revision exact-hash review.

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
- The same owner exports the read-only `inspectExpectedManagedState` preflight and exact-canonical-readback reconciliation entry point used by page-DB mutators. No caller may infer unmanaged state from a missing file/fence or call the engine page primitive first.
- `src/core/learning-loop-knowledge.ts` owns the strict metadata codec and pure Learning Loop state reducer. Generic writers cannot construct or mutate lineage state.
- The append-only Learning Loop ledger remains non-authoritative evidence. Canonical Markdown remains sufficient to rebuild block, lineage, reversal, and active-fact state.
- The database remains a derived index reconciled only after a successful canonical rename.
- The existing database config plane may hold at most one temporary, strictly decoded `learning_loop.mode_transition_intent_v1` record. It is non-authoritative delivery-safety metadata, not memory, a queue, or a second control plane. It cannot authorize a claim or reconstruct canonical managed state, and it is cleared only after exact terminal delivery is durable and canonical `pending_delivery` is clear.
- The reserved-config authority boundary covers all supported typed GBrain APIs at runtime and every repository-owned raw SQL/migration site by exact checked-in structural inventory. Arbitrary new in-process code with `BrainEngine.executeRaw*`/`runMigration`, a compromised migration, or an actor holding direct database/DDL credentials is outside PR 2's trusted-local threat model. PR 2 does not claim to sandbox trusted application code or database administrators; that would require a separate raw-API and database-role redesign.

## Non-negotiable invariants

### Authority and activation

- Every PR 2 canonical learning mutation requires `learning_loop.mode === canary`, no mode-transition intent, a replay-derived active V2 run, and exact equality with its frozen brain, source, slug, corpus binding, and destination-root binding. The only off-mode exception is the narrow disabled-recovery path defined below: it may consume only the complete exact `run_aborted` event stored in `learning_loop.mode_transition_intent_v1`, durably deliver any earlier canonical `pending_delivery`, atomically replace that acknowledged record with the stored terminal event, durably deliver it, clear canonical pending state, then atomically set the requested mode and delete the same intent. These are delivery-bookkeeping renames, not new learning transitions. The exception cannot create or regenerate an event, create authority, activate or reinstate a claim, lift a block, advance a lineage/reversal phase, or begin any other canonical transition.
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
- The last accepted canonical transition event binds `protected_state_hash`: SHA-256 of canonical managed fact rows plus block, lineage, reversal, and immutable commit-marker state, excluding the hash field and `pending_delivery`. Legal ordinary body, frontmatter, takes, timeline, backlink, and non-managed-fact edits do not change this hash. If manual or out-of-process edits remove or alter managed metadata/rows, the next trusted-local inspect, recovery, rebuild, or mutation detects the mismatch and fails closed. Missing metadata is never interpreted as an unblocked claim.
- For a managed page, filesystem commit is always first. Only after exact canonical readback may GBrain import or reconcile the database. A rejected canonical write leaves both the file and database unchanged.

Before any caller classifies a target as unmanaged, one shared expected-managed preflight checks the exact `brain_id + source_id + canonical_slug` under the source boundary. A valid canonical metadata fence is positive evidence. Replayed Learning Loop transition history, the active run's frozen destination, and derived database managed-row markers are fail-closed expectation hints only: they may prove that protected canonical state is expected, but they can never reconstruct or authorize that state. If any hint expects managed state and the canonical metadata or managed rows are absent, malformed, conflicting, or do not match the last accepted `protected_state_hash`, the operation returns `managed_state_unavailable` before any database or filesystem mutation. Failure or disagreement while reading an existing hint also fails closed. Only when canonical inspection proves the target is absent or validly unmanaged and every available hint agrees that no managed state exists may the ordinary unmanaged path run. The shared canonical writer repeats this expectation check after page-lock acquisition and immediately before rename, so deletion or corruption between preflight and commit cannot downgrade a managed page to unmanaged.

`inspectExpectedManagedState` returns a module-constructed, runtime-validated `PageDbMutationPermit` bound to brain, source, slug, mutation class, source lease, and either the exact canonical readback hash or proven-unmanaged result. Managed content reconciliation receives a permit only after verified canonical readback; managed destructive/content-replacement permits are never issued. Derived-only permits name one allowlisted operation and column set. Import and engine mutation boundaries validate the permit against their actual target and class immediately before mutation; a missing, forged, stale, wrong-target, or broader permit fails closed. The permit is authority to update the derived index under an already-proven classification, never authority to construct canonical state.

PR 2 does not change generic `query`, `search`, or `get_page` reads and does not claim that those DB-derived views prove a managed fact is active. They cannot authorize a Learning Loop transition. Context injection remains absent until PR 3; PR 3 must name its exact read owner and add canonical expected-managed inspection before any managed row becomes injectable. PR 2 tests only the trusted-local inspect/recovery/rebuild/mutation gates it owns.

### No ambient routing

- No mutation or recovery derives brain, source, corpus, or destination from cwd, mounts, environment, or caller paths.
- Every pointer is `brain_id + source_id + canonical_slug + fact_row`.
- Every operation recomputes the active brain from explicit config and compares it with the frozen run before transcript or destination discovery.
- Every live canonical writer uses `SourceQualifiedCanonicalTarget = { brain_id, source_id, canonical_slug }`. The source ID is an explicit typed command/operation input; the writer resolves the configured root for that source, derives and confines `<root>/<canonical_slug>.md`, obtains the exact source lease, and runs expected-managed inspection before classification and again under the page lock immediately before rename. A caller path, `--dir`, `GBRAIN_SOURCE`, cwd, dotfile, or mount can never select or override this identity.
- Path-oriented `takes`, `backlinks`, `frontmatter`, and `lint` commands have two disjoint lanes. The source-qualified lane requires explicit `--source` plus a slug for any registered canonical source and uses the shared boundary. The legacy standalone lane may preserve current arbitrary-path behavior only when a read-only inventory proves the target is outside every configured canonical source root and contains no valid Learning Loop metadata fence. The path comparison is rejection-only: it never chooses a source. A target inside one registered root without exact explicit source identity, inside overlapping roots, equal under symlink/realpath ambiguity, or unreadable during inventory fails before write. Missing/corrupt expected managed state inside a registered root is `managed_state_unavailable`, never standalone/unmanaged fallback.
- `SourceQualifiedCanonicalTarget` is threaded through the command handler and content transform. `canonical-page-write.ts` returns exact canonical readback plus any derived-index permit; downstream code cannot substitute the original path or submitted bytes. Same slug in two sources can modify only the explicitly named source.

## Frozen root bindings

PR 2 introduces V2 arm inputs while keeping V1 replay-compatible.

`configured_root_hash` is SHA-256 of UTF-8 repository `canonicalJson` over one closed preimage. Configured values are exact strings after strict string, non-empty, absolute-path, and NUL rejection and before `realpath`; a plane or textual-value change therefore changes the hash even when it resolves to the same inode.

```text
CorpusConfiguredRootPreimageV1 = {
  schema_version: 1,
  binding_kind: corpus_codex,
  root: { plane: db_config | file_config, key: learning_loop.corpus.codex.root, value },
  source: { plane: db_config | file_config, key: learning_loop.corpus.codex.source_id, value }
}

DestinationConfiguredRootPreimageV1 = {
  schema_version: 1,
  binding_kind: destination,
  source_id,
  topology: source_local_path | sync_repo_path,
  root: { plane: sources_row | db_config, key: sources.local_path | sync.repo_path, value }
}
```

- Corpus precedence is resolved independently for `root` and `source_id`: a successful database read with a non-null valid value wins; null falls back to the valid file-config value; missing/invalid values reject. A database read error is `binding_unavailable`, not fallback. The selected plane is part of the preimage.
- Destination resolution queries the explicitly armed `source_id`. A valid `sources.local_path` selects `source_local_path`. Otherwise only `source_id === default` may use valid database `sync.repo_path`, selecting `sync_repo_path`; every non-default source without a local path rejects. File config, environment, cwd, mounts, and the ambient source resolver are excluded.
- After hashing the configured preimage, resolve and stat the directory to freeze `canonical_realpath`, device, and inode. Recompute the complete configured preimage, hash, realpath, device, and inode at every required binding check; any config-plane, value, topology, source-row, path, or inode difference fails closed.

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
- Golden tests freeze the complete canonical preimage JSON and SHA-256 bytes for database/file corpus precedence, `source_local_path`, and default-only `sync_repo_path`; they also prove input-key insertion order does not change canonical bytes.
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

Every page-database mutator is also classified; the filesystem inventory alone is insufficient:

| DB mutation class | Existing owners | PR 2 managed-page behavior |
|---|---|---|
| Canonical Markdown import/reconciliation | `src/core/import-file.ts`; callers in `src/commands/import.ts`, `src/commands/sync.ts`, `src/commands/reindex.ts`, `src/commands/quarantine.ts`, `src/commands/jobs.ts`, and `src/core/minions/handlers/ingest-capture.ts` | Enter the exact source boundary and expected-managed preflight. A managed target may reach `importFromContent`, `importFromFile`, `withImportTransaction`, or `tx.putPage` only with a matching canonical-readback permit and those exact bytes. Caller-supplied, generated, recovery, or DB-serialized bytes cannot replace a managed projection. Reindex may reconcile exact canonical bytes. Quarantine must first commit an allowed ordinary-content change through the shared canonical boundary and then import exact readback; sync delete/rename or quarantine refuses missing, renamed, or protected-state-altered managed canonical state. |
| DB-first page content/frontmatter writers | `src/core/operations.ts` (`put_page`, `revert_version`); `src/commands/brainstorm.ts`; `src/core/output/writer.ts`; `src/core/enrichment-service.ts`; generated writers under `src/core/think/`, `src/core/cycle/`, and `src/core/extract/receipt-writer.ts` | Existing or expected-managed targets use canonical-first merge/readback reconciliation or reject. `revert_version`, compiled-truth/frontmatter replacement, and entity enrichment reject a managed target. A new DB-owned/generated slug may keep current behavior only when its namespace/owner check proves it cannot equal an expected managed pointer. |
| Delete, restore, purge, rename, or type mutation | `src/core/operations.ts`; `src/commands/pages.ts`; `src/commands/jobs.ts`; `src/core/cycle.ts`; `src/core/purge-deleted-pages.ts`; `src/core/schema-pack/retype.ts`; `src/core/schema-pack/sync.ts`; sync `deletePage(s)`/`updateSlug`; engine implementations | Soft delete, restore, hard purge, version restore, type rewrite, and sync delete/rename reject an expected-managed target before DB mutation. PR 2 does not define canonical managed delete/rename. Missing canonical bytes are trust failure, not permission to hide, restore, purge, rename, or retype the derived row. Historical/engine migrations skip or reject managed state unless they rebuild the projection from verified canonical files. |
| Derived index-only metadata | contextual-retrieval state, embedding signature, extraction timestamp, emotional weight, effective date, last-retrieved time, and extracted-takes metadata in their current engine/helper owners | Allowed only through an exact checked-in column/symbol allowlist because these fields neither replace canonical content/frontmatter nor change managed/block/lineage identity. Any new page column or broader update is unclassified and fails CI until reviewed. `refreshPageBody` is not derived-only and rejects managed pages. |

The engine `putPage`, `deletePage(s)`, `softDeletePage`, `restorePage`, `purgeDeletedPages`, `revertToVersion`, `updateSlug`, and raw `INSERT`/`UPDATE`/`DELETE` against `pages` are enforcement sinks, not trusted bypasses. Content/destructive callers must carry the matching branded permit from the shared preflight; derived-only methods validate their narrow operation/column classification. Missing, forged, stale, wrong-target, or incompatible permits reject before mutation, and unclassified raw page SQL fails the structural test.

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
- While those locks are held, abort/off precomputes the complete terminal event before canonical work and stores this strict record with `canonicalJson` plus SHA-256:

```text
ModeTransitionIntentV1 = {
  schema_version: 1,
  run_id,
  command_id: "mode-change:" + run_id,
  requested_mode: off | capture,
  reason: mode_changed,
  event: ExactEventRecord,
  brain_id,
  source_id,
  canonical_slug,
  corpus_binding,
  destination_binding,
  expected_prior_pending: ExactEventRecord | null,
  intent_hash
}
```

- `event` already contains its stable event ID, canonical payload bytes/hash, timestamp, semantic sequence, run identity, requested non-canary mode, and abort reason. `expected_prior_pending` freezes the complete exact predecessor record, including its ID, canonical payload bytes/hash, timestamp, and semantic sequence; null means canonical pending must be null. The intent codec rejects unknown fields, invalid sizes or variants, a non-terminal event, binding disagreement, hash disagreement, and any record whose event or predecessor does not encode the other fields exactly.
- In one database transaction, abort/off rechecks that mode is canary and the active run is unchanged, then inserts the exact intent while leaving mode canary. An existing byte-identical intent is an idempotent retry; a different hash, run, event, requested mode, or expected predecessor fails closed. The transaction-scoped engine uses the existing config-table `setConfig` operation; no new table or persistence owner is added.
- Both `learning_loop.mode` and `learning_loop.mode_transition_intent_v1` are reserved at the supported typed config-API sink. `setConfig` and `unsetConfig` require a module-constructed, runtime-validated `LearningLoopConfigMutationPermit` for either key; the permit binds the exact key, operation, lifecycle-lock holder, transaction-scoped engine, and expected old-value hash. Generic config set/unset, `--force`, prefix deletion, import, and any remote operation can never obtain the permit and reject before mutation. Only the typed Learning Loop mode/intent owner may mint it after replay under the lifecycle lock.
- The general `executeRaw`, `executeRawDirect`, and `runMigration` APIs remain privileged internal infrastructure because migrations, bootstrap, checkpointing, queue locks, and source lifecycle use them. PR 2 does not attempt an unsound SQL parser, a trigger that raw DDL can drop, or a broad raw-API refactor. Instead, one exact checked-in config-SQL inventory names every production raw call site by file, symbol, operation class, static/dynamic SQL shape, and allowed key namespace. Its structural test rejects either reserved key in SQL text/parameters, rejects unclassified or moved raw config mutations, and rejects any dynamic config-table key path whose owner cannot prove a disjoint namespace. Bootstrap and migration SQL are classified too. Existing non-overlapping checkpoint/config writers remain allowed. No untrusted operation may accept SQL text, table names, or config keys that flow to a raw API.
- Intent presence is an immediate admission barrier independent of the visible mode. Session submission, activation, correction, reversal, arm, and any mode transition other than exact intent recovery must reject or first enter recovery. Thus a crash after intent commit but before the mode update leaves canary plus an intent, but cannot admit new learning.
- With lifecycle and page ownership, recovery reads canonical `pending_delivery` and requires byte-for-byte equality with `expected_prior_pending` before any append. It durably delivers only those frozen predecessor bytes, then uses one atomic canonical rename to replace that acknowledged record with the exact `event` bytes from the stored intent. When the frozen predecessor is null, the first bookkeeping rename requires canonical pending still null and stores those same exact terminal bytes directly. A stale, missing, extra, same-ID/different-payload, or otherwise altered predecessor fails closed before append or rename. Recovery never recomputes either event.
- Only after the prior pending event is proven in the ledger may the stored terminal event append. The terminal record is cleared only after durable same-ID/same-payload readback. Therefore no recovered learning event can appear causally after terminal state, and no crash can lose or regenerate an already-persisted abort identity.
- On successful canonical terminal delivery and clear, one database transaction re-reads the same intent hash, replays the terminal ledger record, sets `learning_loop.mode` to the stored requested mode, and deletes the intent atomically. A crash before this transaction leaves an idempotently recoverable intent; a crash after it leaves the final non-canary mode with no intent.
- If canonical recovery cannot complete, leaving canary must still disable behavior. One database transaction validates the unchanged exact intent and writes its requested non-canary mode while retaining the intent. The active run remains nonterminal and non-injecting, and the operation returns `disabled_recovery_pending`. Therefore every persisted non-canary/nonterminal failure state has the complete durable intent needed for recovery. A crash before this transaction leaves canary plus the admission barrier; a crash after it leaves non-canary plus the same intent.
- `disabled_recovery_pending` re-enters only through the stored intent and its frozen source and destination bindings, in the normal source -> lifecycle -> page -> ledger lock order. It may append/read back only the exact `expected_prior_pending` bytes after exact canonical equality, reconcile the derived database only from that exact acknowledged canonical readback, install only the stored terminal event, durably append/read back it, clear it, and finalize mode plus intent deletion atomically. Missing intent, different bytes/hash, predecessor disagreement, binding drift, a terminal/replaced run inconsistent with the exact stored event, or an off/capture nonterminal run without an intent fails closed and blocks re-arm. Recovery never synthesizes a replacement record from ledger, database page rows, current time, or caller input.
- Direct owner abort uses the same path. If recovery fails, it changes mode only through the intent-retaining transaction and returns the same recoverable state.
- This is a bounded recovery state, not a queue or supervision surface: at most one active run, one temporary config intent, and one canonical pending delivery exist, and ordinary owner operations retry it automatically.
- Whole-checkout recovery, source refresh/replacement, and source removal are refused while that source is frozen by an active V2 run. They do not publish a new root inode. After the run is terminal, checkout recovery may proceed only after copying and validating protected fences; a later run freezes the new root identity.

## Canonical event-delivery protocol

The metadata fence contains `pending_delivery: null | ExactEventRecord`.

`ExactEventRecordV1` is a V2-only canonical-delivery envelope:

```text
{
  schema_version: 1,
  event_id,
  event_payload_canonical_json,
  event_payload_sha256,
  brain_id,
  run_id,
  occurred_at,
  semantic_sequence
}
```

- The strict decoder rejects unknown fields and non-JSON payload values, requires `semantic_sequence` to be a positive safe integer, reparses and byte-compares repository `canonicalJson`, checks the payload SHA-256 and existing event-ID derivation, and requires brain, run, timestamp, and sequence equality between envelope and payload.
- Sequence scope is exact `(brain_id, run_id)`. The first V2 canonical transition is 1. Under source -> lifecycle -> page ownership, allocation is `max(last contiguous durable V2 exact record in replay, exact canonical pending_delivery) + 1`. Replay rejects gaps, duplicate sequences, sequence regression, different records at one sequence, or an envelope whose run/brain differs. Canonical pending is the durable sequence source after page rename and before ledger append; ledger replay is the source after durable append/readback. A non-null pending record blocks ordinary allocation, so recovery appends or acknowledges the frozen record and never allocates it again. The sole exception is abort/off: while freezing an intent it may reserve exactly predecessor sequence + 1, stores both complete records atomically in the intent, and makes intent presence block every other allocator before predecessor delivery begins.
- The mode-transition intent freezes the exact next `run_aborted` envelope and its exact predecessor. V1 ledger events retain their current event-ID/hash/JSONL replay behavior and have no semantic sequence. A V1 armed run cannot produce a V2 exact record or canonical mutation; it must abort under its legacy path and re-arm as V2. V1 event order never contributes to the V2 sequence.

- A canonical transition precomputes the complete versioned event bytes, `event_id`, payload hash, timestamp, and semantic sequence before mutation.
- The atomic page rename stores the resulting canonical state and that exact record together.
- While locks remain held, GBrain appends those exact bytes to the ledger and reads them back.
- The append path `fsync`s the ledger file before readback. If the append created the ledger, it also `fsync`s the ledger parent directory. Terminal events use the same durable append primitive.
- A second atomic canonical rename clears `pending_delivery` only after durable exact ledger equality is proven.
- Abort/off is the sole replacement case: after durable equality for a prior pending event, the acknowledgement rename replaces that record directly with the exact `run_aborted` bytes from the already-committed `ModeTransitionIntentV1` instead of clearing to null. The terminal event then follows the same append, file/directory `fsync`, exact readback, and final-clear protocol. At every crash point the intent retains the immutable terminal identity and canonical state contains either the prior pending record, the terminal pending record, or a cleared record whose terminal event has already been durably verified.
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
2. Add the closed corpus/destination configured-root preimages, exact DB/file precedence and default-only legacy topology resolver, and golden canonical JSON/SHA-256 vectors.
3. Add V2 `run_armed` fields, strict `ExactEventRecordV1`, contiguous per-brain/run semantic sequencing, and replay validation while retaining V1 replay compatibility.
4. Freeze corpus and destination bindings at arm; double-check them around baseline discovery and every later V2 read/write.
5. Make V1 runs fail closed for V2 exact delivery and canonical mutation.
6. Prove config-plane/value/topology rebinding, path/inode replacement, sequence gap/duplicate/regression, and V1 fixture compatibility.

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

1. Generate the initial inventory from every file write, rename, unlink, copy, and directory-swap call plus every page-row import/mutator call and raw `INSERT`/`UPDATE`/`DELETE` against `pages` under `src/`. Classify filesystem sites as live canonical, non-live output, configuration/state, temp/quarantine, or test-only; classify DB sites as canonical reconciliation, DB-first content, destructive/admin, derived-only allowlisted columns, migration-only, or non-live/test-only.
2. Replace direct live Markdown writes with the shared boundary, including takes, backlinks, frontmatter, and lint.
3. Preserve current behavior for unmanaged pages.
4. Reject managed interactive editor entry, phantom redirect, destructive migration rewrite, unsupported delete/rename, and active-V2 source checkout replacement/removal.
5. Make whole-checkout recovery carry and validate protected fences before publish, and refuse it during an active V2 run.
6. Add structural tests generated from both filesystem-mutation and page-DB-mutation call sites. Detect direct page-row SQL and calls to `importFromContent`, `importFromFile`, `withImportTransaction`, `putPage`, `deletePage(s)`, `softDeletePage`, `restorePage`, `purgeDeletedPages`, `revertToVersion`, `updateSlug`, and body/type replacement helpers. Every site must use the shared boundary/preflight or appear in an exact checked-in file + symbol + classification allowlist with a reason and allowed column set. A new or moved unclassified filesystem or page-DB mutation fails CI.
7. Replace the managed form of every DB-to-Markdown caller with one canonical-first flow. `put_page`, brainstorm, and sync re-export call the same expected-managed preflight keyed by exact brain/source/slug before any import or unmanaged classification. The preflight uses canonical inspection plus replayed transition history, the active frozen destination, and derived managed-row markers only as fail-closed expectation hints; absence, corruption, hash mismatch, lookup failure, or disagreement rejects without mutation. For a valid managed `put_page` or brainstorm target, atomically write the submitted ordinary-content merge before `importFromContent`, then reconcile the database from exact canonical readback. `writePageThrough` remains an after-DB renderer only for a target proven unmanaged. Sync re-export must never synthesize protected state from the DB. Add barrier tests that delete or corrupt the metadata fence or managed rows after the first preflight and prove the pre-rename recheck still rejects. Unmanaged callers retain existing behavior.
8. Route canonical import/reindex/quarantine paths through verified canonical readback for managed targets. Reject managed `revert_version`, output-writer replacements, enrichment replacement, soft delete, restore, purge, rename, retype, refresh-body, DB migration reconstruction, and any generated writer whose namespace can collide. Keep only the explicit derived-column allowlist unchanged. Prove every rejection leaves canonical bytes and the complete page row unchanged.
9. Add explicit source/slug inputs to the source-qualified lanes for takes, backlinks, frontmatter, and lint. Preserve their legacy standalone-path lanes only after rejection-only registered-root inventory proves the target is outside every canonical source and contains no valid Learning Loop fence. Prove unqualified registered-root, overlapping-root, symlink-ambiguous, unreadable, and missing/corrupt managed targets fail before write.

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
- Modify `src/core/engine.ts`, both engine implementations, and `src/commands/config.ts` only to reserve the two Learning Loop config keys behind the typed mutation permit and reject generic set/unset/prefix bypasses.
- Create `test/fixtures/learning-loop-config-sql-inventory.json` and `test/learning-loop-config-boundary.test.ts` for the checked-in production raw-config SQL inventory and structural gate, without changing the general raw APIs or database roles.
- Create `test/learning-loop-reversal.test.ts`.
- Create `test/learning-loop-recovery.test.ts`.

**Work**

1. Implement `started -> retired_checkpointed -> rebuild_verified -> commit_intent -> committed`, plus terminal `superseded` and `failed`.
2. In one page rename, snapshot and retire the complete replacement set, advance generation, and store the post-retirement checkpoint.
3. Bind rebuild proof to inherited obligations, pre-retirement set, and post-retirement checkpoint.
4. Persist commit intent, then perform exact generation/fingerprint/set CAS under the common guard.
5. On accepted drift, atomically supersede predecessor and create/link successor with the union of inherited and current obligations.
6. Recover every crash seam automatically from canonical state and exact ledger delivery.
7. Implement abort/off snapshot-retry ordering and the narrow `ModeTransitionIntentV1` / `disabled_recovery_pending` exception: transactionally persist the complete exact terminal intent plus exact predecessor record before canonical work; reserve both config keys behind the typed lifecycle permit; classify every repository-owned raw config mutation; make intent presence block all admissions; under its frozen bindings, require byte-equal canonical predecessor state, durably deliver/read back only that record, atomically replace it with only the stored terminal record, durably deliver/read back that record, clear it, and transactionally finalize requested mode plus intent deletion.

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
- Every production page-DB mutation site is classified by exact file and symbol. New direct page SQL, import/mutator call, moved call site, unlisted derived column, or missing classification fails the structural bypass test.
- Managed canonical import/reindex reconciles only exact canonical readback. Quarantine, sync delete/rename, version restore, output/frontmatter/enrichment replacement, soft delete, restore, purge, retype, refresh-body, and engine migration reconstruction reject managed targets without changing canonical bytes or any page-row field.
- Existing DB-owned/generated writers remain allowed only for a new slug whose checked namespace/owner cannot collide with an expected managed pointer; collision and ambiguous ownership reject.
- Root rebinding, directory inode replacement, traversal, absolute slug, and symlink escape visible before final validation fail closed; every GBrain-owned root swap waits on the source boundary.
- Corpus root/source DB-over-file precedence, null-only fallback, DB-read failure, exact selected-plane/value hashing, destination local-path preference, default-only sync-repo fallback, and ambient-signal non-effect match the frozen golden vectors.
- Path-based writers require explicit source plus slug for registered roots; an unqualified, overlapping, symlink-ambiguous, or unreadable registered-root target cannot enter the standalone lane. Same slug in two sources modifies only the explicit source.
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
- V2 exact records allocate positive contiguous sequence only within one brain/run; first/next, gap, duplicate, regression, same-sequence different-record, pending-before-append, append-before-clear, and V1-no-sequence fixtures all replay deterministically.
- Crash after `commit_intent` reconciles committed marker, retries exact checkpoint, or creates accepted-drift successor.
- Later accepted mutation after immutable commit marker recovers the attempt as committed before replaying later state.
- Unexplained third-state drift leaves the block enforced and fails closed.
- Abort/off waits for an in-flight canonical commit, drains its pending delivery before terminal append, and cannot admit a later learning event.
- Mode-transition crash tests cover: before the intent transaction (canary, no intent); after intent commit but before canonical work (canary plus intent and admissions disabled); canonical failure before and after the intent-retaining mode transaction; and terminal durability before the final transaction. Any non-canary/nonterminal state must contain the complete exact intent. The final transaction must atomically set the stored requested mode and delete that same intent.
- Failed abort recovery blocks re-arm. A later owner operation may, under the exact bindings in the stored intent, require byte-equal canonical state and durably deliver/read back only its frozen predecessor event, replace it atomically with only the intent's persisted terminal event, reconcile the derived database from exact canonical readback, deliver/read back the terminal event, clear it, then finalize mode and intent deletion. Barrier tests cover a null predecessor versus an unexpected record, missing/extra/stale/same-ID-different-payload predecessor state before append, crash before prior-event append, after append/before replacement, after terminal-record replacement/before append, during terminal append, after terminal append/before readback, after readback/before canonical clear, and after canonical clear/before config finalization. Same-intent retry preserves one stable terminal ID/payload and appends it at most once; a different intent/hash, missing intent with off/capture plus active nonterminal state, or any attempted regeneration fails closed. Authority creation, activation, block lifting, lineage/reversal advancement, new learning transitions, and DB-derived protected-state reconstruction remain forbidden.
- Generic config set/unset with and without `--force`, prefix deletion/import, forged/stale/wrong-transaction permits, and remote operations cannot create, replace, or delete either reserved Learning Loop config key through supported typed APIs. The typed lifecycle owner can perform the two atomic intent/mode transactions in both PGLite and Postgres.
- The raw-config SQL structural gate inventories `executeRaw`, `executeRawDirect`, `runMigration`, schema/bootstrap, and existing checkpoint writers by exact file and symbol. It fails for either reserved key in raw SQL or parameters, an unclassified/moved site, a dynamic config key without a proven disjoint namespace, or an untrusted operation-to-SQL flow. Tests show the existing backfill checkpoint keys remain valid. This is repository-change proof, not a runtime sandbox against arbitrary trusted code or direct database credentials.
- Active V2 run refuses whole-checkout recovery and source replacement/removal without changing the frozen inode; after terminal state, recovery preserves protected fences and a later arm freezes the replacement root.
- A barrier-controlled GBrain root-swap attempt cannot pass the source boundary during canonical rename. A post-rename external binding mismatch is detected as a hard trust failure; no hostile-local dirfd guarantee is claimed.

## Stop conditions

Stop and report `BLOCKED` if:

- a required writer cannot preserve or reject managed state without changing behavior outside PR 2;
- the repository cannot provide one consistent lock order;
- the accepted threat model requires portable hostile-local dirfd-anchored rename rather than serialized GBrain-owned writers and post-write mismatch detection;
- the accepted threat model requires runtime confinement of arbitrary in-process raw SQL, migrations, or direct database administrators rather than typed-API enforcement plus checked-in repository-owned raw-SQL inventory;
- atomic fact-plus-lineage state cannot remain in one canonical Markdown rename;
- recovery would require a daemon, scheduler, queue service, or user-maintained receipt;
- proof requires live/global activation, external mutation, PR 3+, or Seascape;
- CI or required independent review cannot execute.
