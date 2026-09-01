# Personal Learning Loop V1 — architecture decision and implementation plan

**Status:** approved design direction; implementation remains staged and disabled by default

**Owner:** GBrain core, plus one thin adapter in the existing owner of active Codex session hooks

**Decision:** close one measurable learning loop by composing existing GBrain primitives; do not create a parallel memory product, agent hierarchy, dashboard, queue, or supervision layer

## 1. Decision and intended outcome

Personal Learning Loop V1 will connect four steps that are currently separate:

```text
capture completed work
  -> distill a qualified lesson or correction
  -> supply a thin relevant slice to a later agent
  -> measure whether the supplied context helped or was corrected
```

The first proof is a self-completing canary covering exactly **10 eligible Codex sessions**. The canary ends automatically with one result:

- **keep** — safe and useful, but not yet proven enough to expand;
- **repair** — one bounded trust, relevance, or reliability defect must be corrected before another run;
- **broaden** — all gates passed, permitting a later Claude ingestion adapter that uses the same GBrain contracts.

This pull request is an architecture decision and implementation plan. It does not freeze every wire field or serialization byte before code exists. Each implementation pull request must introduce the versioned schema, canonical encoding, golden vectors, and adversarial tests for the surface it adds. No implementation may weaken the behavioral requirements in this document.

Merging this document activates nothing.

## 2. Why this is the right agent strategy

The scarce asset is not another permanent agent persona. It is the vendor-neutral history connecting:

- what an agent was told;
- what it did;
- what the user corrected;
- what objective outcome followed; and
- whether the correction improved later work.

Codex, Claude, ChatGPT, and future providers should remain replaceable clients. GBrain owns the durable learning substrate. Agents receive only the context relevant to the current task.

The system is valuable only when all four steps work. Capture without later use is storage. Summarization without outcome measurement is self-reinforcing folklore.

## 3. System roles and authority

| Surface | Responsibility | Authority boundary |
|---|---|---|
| **GBrain raw session source** | Local transcript discovery and parsing | Private evidence; not directly injected as durable truth |
| **GBrain operational ledger** | Append-only session, eligibility, context, correction, outcome, settlement, and canary events | Operational evidence only; rebuildable and non-authoritative for personal claims |
| **GBrain canonical personal source** | Current preferences, constraints, goals, proven lessons, and bounded open loops | Authoritative personal operating model |
| **Personal orchestration projection** | Optional generated human-readable projection | Never required for activation, retrieval, promotion, or canary completion |
| **Business knowledge owner** | Controlled durable business knowledge | Separate business authority; no automatic promotion from this personal loop |
| **Codex / later Claude adapter** | Submit normalized events, request context, perform work, return outcomes | Thin authorized client; cannot define thresholds, inspect arbitrary local paths, control the run, or mutate canonical truth directly |
| **User** | Strategy, business judgment, irreversible or external-action exceptions | No routine memory maintenance, counter advancement, receipt review, or promotion work |

## 4. Sources of truth

### 4.1 Raw sessions

Raw transcripts stay local. They are evidence inputs, not the personal operating model. Transcript text is not copied into routine operational telemetry.

### 4.2 Operational evidence

One append-only local ledger records machine-readable events such as:

- session discovered and completed;
- authoritative transcript hash and size;
- GBrain-owned eligibility decision;
- context requested and supplied;
- candidate learning observed;
- canonical memory activated, blocked, reversed, or superseded;
- objective outcome or explicit user signal recorded;
- open-loop trigger transitioned;
- session settled;
- canary armed, finalized, or aborted.

The ledger may be replayed to rebuild derived run state. It does not itself make an inferred personal claim true.

### 4.3 Canonical personal knowledge

Durable active personal knowledge remains in the existing GBrain filesystem-canonical Markdown/fact-fence model. Database rows remain rebuildable indexes.

A memory is active only when a permitted activation rule writes it to the configured canonical personal source. Candidate observations, session summaries, model confidence, and operational events alone are not active memory.

A direct correction also creates durable blocked-claim state keyed to the corrected claim identity. That state survives rebuild and prevents later model inference or repeated-pattern evidence from silently reactivating the obsolete belief.

### 4.4 Business knowledge

A possible business fact may be surfaced only as an evidence-backed candidate through the existing business boundary. V1 cannot promote, rewrite, merge, deploy, send, or otherwise mutate business canon or any external system.

## 5. V1 scope

V1 includes only:

1. Codex session-close capture.
2. GBrain-owned deterministic eligibility.
3. Candidate learning and direct correction handling.
4. Canonical personal-memory activation under explicit rules.
5. Durable correction blocking and explicit user reversal.
6. Thin task-relevant context retrieval.
7. Exact context-supply telemetry.
8. Typed outcome evidence and session settlement.
9. A 10-eligible-session canary with automatic `keep`, `repair`, or `broaden` disposition.
10. Cleanup of displaced manual personal-memory machinery only after successful proof.

V1 explicitly excludes:

- Claude or ChatGPT ingestion;
- research ingestion;
- automatic skill or configuration edits;
- live `~/.codex` changes;
- automatic PR, merge, deploy, install, send, or schedule actions;
- a new memory database, repository, knowledge graph, dashboard, inbox, queue, or notification channel;
- autonomous business-canon promotion;
- more than one active self-improvement change;
- exposing owner controls or server-local transcript access to untrusted MCP or remote callers.

## 6. Operating modes, trusted controls, and activation

One central mode resolver exposes:

```text
learning_loop.mode = off | capture | canary
```

- **off** — no Learning Loop capture, distillation, injection, counting, or canonical activation.
- **capture** — local session/evidence capture and candidate distillation may run; no context injection, no canary counting, and no automatic canonical activation.
- **canary** — capture, qualified activation/correction, context injection, outcome measurement, and counting operate only for one explicitly armed run.

Default is `off`. A merge cannot arm or activate a run.

Changing out of `canary` first appends a terminal abort for the active run, then changes mode. Capture and injection are independently disableable so ordinary Codex work continues if the loop is rolled back.

### 6.1 Trusted-local control boundary

The following are owner-control operations and must be registered as trusted-local/local-only in GBrain’s contract-first operations layer:

- read or change `learning_loop.mode`;
- arm, abort, reset, or inspect privileged canary state;
- resolve or read a server-local transcript path;
- create authoritative eligibility, authority, correction, activation, blocked-claim, settlement, or terminal events;
- mutate canonical personal knowledge; and
- perform ledger administration or rebuild verification.

Registration metadata is necessary but not sufficient. Every privileged handler must independently reject the operation unless `ctx.remote === false`. Every agent-facing dispatcher—including HTTP and stdio MCP—must also omit `localOnly` operations from discovery and deny their invocation. Handler-level rejection and dispatcher filtering are both required, so one missed or regressed filter cannot expose an owner control.

They are not exposed to an untrusted MCP client, browser caller, remote model, or ordinary provider adapter.

A provider adapter may call only explicitly authorized, versioned submission/request operations for its own source identity: submit bounded session metadata, request bounded context for its own session, submit a typed outcome envelope, and receive the resulting bundle/status. Every such operation authenticates/authorizes the source and binds the caller to the submitted provider/session. The adapter cannot select arbitrary local paths, impersonate another provider/session, change modes, arm/abort a run, append authoritative events, or write canonical memory.

Any uncertainty about caller trust, source authorization, or local-path ownership fails closed for Learning Loop behavior while ordinary agent work proceeds.

## 7. Canary lifecycle

### 7.1 Arming and baseline freeze

An explicit trusted-local arm operation creates an immutable `run_id`. Only one run may be nonterminal at once.

Arming freezes at least:

- contract/schema version;
- GBrain implementation commit/version;
- provider allow-list, exactly `codex` for V1;
- target cohort size, exactly 10;
- eligibility-classifier version and thresholds;
- baseline-evaluator version and supervision-error taxonomy;
- personal destination including `brain_id`, `source_id`, and canonical page/slug;
- verdict thresholds;
- baseline object or explicit no-baseline state;
- the baseline discovery cutoff and source-manifest hash; and
- the authorized adapter/source identity allowed to submit for the run.

Reducers use the frozen run inputs, never mutable current defaults.

The baseline is selected once during arming from a frozen local transcript-discovery snapshot using this exact procedure:

1. Consider unique Codex sessions with `completed_at < armed_at` that are visible in the configured local corpus at the frozen discovery cutoff.
2. Resolve each candidate’s authoritative local bytes/hash and apply the same frozen eligibility classifier used by the canary.
3. Sort eligible candidates by `completed_at` descending, then `provider_session_id` in ascending UTF-8 byte order, then authoritative `content_hash` ascending.
4. Select exactly the first 10 eligible sessions. Later discoveries or file changes cannot alter this ordered set.
5. A baseline is valid only when all 10 selected sessions have complete GBrain-produced evaluation records under the frozen baseline-evaluator version and the same three supervision-error classes used by the canary. Do not skip an unevaluable selected session in favor of an older one.
6. If fewer than 10 eligible sessions exist, authoritative discovery/hash/eligibility is ambiguous, or any selected evaluation is missing/conflicted, freeze `baseline: null`.
7. Otherwise freeze the source-manifest hash, ordered session identities and content hashes, per-session error metrics, aggregate counts, and normalized rate.

This selection is deterministic for one frozen corpus snapshot. A no-baseline run may `keep` or `repair`, never `broaden`.

### 7.2 Session identity and authoritative transcript data

Global session uniqueness is `(provider, provider_session_id)`.

GBrain—not the adapter—must resolve the transcript through configured local corpus boundaries, read the exact bytes consumed by the parser, and compute the authoritative size and content hash.

- Same session identity plus same authoritative hash is an idempotent retry.
- Same session identity plus a different authoritative hash is a conflict and cannot learn, count, or replace the prior completion.
- Adapter-supplied path, size, or hash is only an assertion and must match GBrain’s computation.
- A submitted path is usable only after trusted-local resolution proves it belongs to the authorized provider/session and an allowed corpus root.

### 7.3 GBrain-owned eligibility

For the V1 canary, eligibility is deliberately structural and deterministic. A session is eligible only when all are true:

- provider is in the frozen allow-list and matches the authorized source identity;
- completion state is completed;
- the GBrain-read transcript is at least 256 UTF-8 bytes;
- the existing parser yields at least two non-empty normalized user turns and two non-empty normalized assistant turns.

Normalization and role counting are implemented once in GBrain and covered by golden tests. Adapter labels and task class cannot override eligibility.

Every decision is appended with its classifier version, authoritative transcript hash, counts, and reason before cohort admission.

### 7.4 Sealed cohort

The first 10 accepted eligible sessions form the immutable cohort. Once full, the cohort is sealed.

Later sessions may be captured as diagnostics but cannot count, replace a cohort member, or prevent the original 10 from settling.

### 7.5 Settlement

Every cohort session requires one GBrain-owned close manifest and exactly one expected outcome envelope, even when the outcome contains no positive or negative evidence.

The expected outcome identity is derived by GBrain from the run and session identity. A session settles only after:

- the expected outcome is accepted or an idempotent duplicate is recognized;
- every referenced authoritative event exists and matches the evidence item;
- all required canonical mutations, blocked-claim transitions, or trigger transitions complete;
- every reversal bound to the session reaches durable `committed` state through the recovery protocol in section 8.6, with its pre-retirement set, post-retirement checkpoint, rebuild proof, and final CAS verified; and
- no replay conflict or unresolved trust failure remains.

A nonterminal reversal attempt cannot be ignored, replaced by an empty outcome, or treated as settled. The run cannot finalize until all 10 cohort sessions are settled. Session 10 completion alone is never enough.

### 7.6 Terminal state

A run ends exactly once with either:

- `canary_finalized(keep|broaden)`; or
- `canary_aborted(repair)`.

A hard failure aborts immediately, disables further injection/counting/activation for that run, and preserves history. A later bounded rerun receives a new `run_id`; old terminal events cannot contaminate it.

## 8. Identity, scope, provenance, correction, and replay invariants

### 8.1 Brain-qualified memory identity

Every durable memory pointer includes:

```text
brain_id + source_id + canonical source page/slug + fact row
```

After arming, all retrieval, activation, correction, outcome, and rebuild checks route explicitly to the frozen brain/source. Ambient mounts, cwd, or environment variables cannot redirect an operation.

### 8.2 Exact scope identity

- Global memories carry no target.
- Repository memories use a forge-qualified canonical target such as `repo:github.com/owner/repo`.
- Project memories use one stable project key owned by the caller/domain contract.
- Missing, malformed, or mismatched targets make the item non-injectable.
- The same owner/repository path on another forge is a different target.

Opaque scope/trigger values must use one unambiguous canonical encoding with a reserved null representation. The implementation PR introducing the encoding must include round-trip and malformed-input vectors.

### 8.3 Claim-bound authority

An event cannot authorize an unrelated claim merely because it occurred in the same session.

Every authority-bearing GBrain event used for activation must bind the exact:

- normalized claim fingerprint;
- learning class;
- authority class;
- provider and provider session;
- scope and exact scope target;
- trigger identity/state when applicable; and
- source-role/provenance class.

A learning observation may reference that event only when all relevant fields match exactly. User-statement authority must originate from a parsed user-role message, never assistant/model text.

### 8.4 Evidence-event equality

Outcome evidence uses an accepted GBrain ledger event ID, not a caller-invented string or transcript excerpt.

Before accepting each evidence item, the reducer must validate both event type and variant-specific equality. Depending on the evidence type, matching includes the exact run, provider session, request hash, supplied memory pointer, claim fingerprint, benefit/error class, evidence strength, trigger ID/state, and correction linkage.

For example, an objective event about pointer A cannot authorize a beneficial-use claim for pointer B, even in the same session.

Each implementation PR that introduces an event type must define its versioned payload and exact equality checks beside tests. There is no generic “same session is close enough” rule.

### 8.5 Durable correction block and exact reversal

A correction applies to claim identity, not only one historical pointer.

The authoritative correction transaction creates a durable blocked-claim record keyed by at least:

```text
normalized claim fingerprint + learning class + scope + exact scope target
```

Trigger identity is also part of the key for an open-loop claim. The blocked state is represented in canonical/rebuildable personal knowledge plus an authoritative ledger event, so deleting or rebuilding a database index cannot remove it.

Each blocked claim owns one correction-lineage record containing the originating correction event, the complete set of currently active linked replacement pointers, a canonical fingerprint of that sorted set, and a monotonically increasing `lineage_generation`. Every authoritative canonical mutation that can add, remove, reactivate, supersede, or otherwise change any active member of that correction lineage must execute through the same lineage mutation guard. This includes direct-statement activation, verified-outcome activation, repeated-pattern activation, direct correction, supersession, trigger-state mutation, reversal retirement/commit, and rebuild reconciliation. Each atomic lineage-changing transaction recomputes the active-replacement-set fingerprint and advances `lineage_generation`; otherwise it leaves the prior set/fingerprint/generation unchanged and fails closed. The normal corrected state has exactly one active linked replacement. Missing, ambiguous, or multiple active linked replacements fail closed for a new root reversal, but a persisted nonterminal reversal attempt is recovered by section 8.6 rather than reclassified from the current active set.

While a claim identity is blocked:

- candidate observations may be recorded for diagnostics;
- repeated-pattern or verified-outcome evidence cannot reactivate it;
- a new fact row or pointer with the same blocked identity remains non-injectable; and
- absence of the original pointer alone is not considered correction propagation.

Only a later **explicit direct user reversal**, processed through a trusted-local authoritative operation, may supersede the blocked state, and only when that direct user authority explicitly reinstates the exact blocked claim identity. A new root attempt first acquires the lineage mutation guard and records a durable pre-retirement snapshot containing the current generation, complete active linked-replacement set, and canonical set fingerprint. In the same guarded retirement transaction it places every member of that set into durable pending retirement, supersedes/strikes those rows, recomputes the resulting active set, advances the generation, and atomically records the exact post-retirement checkpoint containing that new generation, new active-set fingerprint, and recomputed active set. There is no committed retirement state without its checkpoint. The block remains active throughout. GBrain then reconciles the derived index and performs a full rebuild whose proof binds both the pre-retirement set that had to be retired and the post-retirement checkpoint that resulted. Only after that proof succeeds may the final commit reacquire the guard and compare-and-swap against the post-retirement checkpoint. Under the guard it recomputes the actual active linked-replacement set and verifies exact equality with the checkpoint before atomically lifting the block and activating the reinstated claim. Any later mutation changes the generation, fingerprint, or actual set and invalidates the checkpoint. The intended retirement transaction’s own generation/fingerprint advance is expected. Crash/retry behavior is governed by section 8.6, so an empty active set after retirement is a resumable phase, not a missing-replacement failure.

### 8.6 Durable reversal state and crash recovery

Every explicit user reversal receives one stable `root_reversal_id`. Each retryable attempt under that authority receives a monotonically increasing `attempt_no`. The ledger and correction-lineage record expose one deterministic phase machine:

```text
started
  -> retired_checkpointed
  -> rebuild_verified
  -> commit_intent
  -> committed
```

An attempt may instead become `superseded` by a named successor attempt or `failed` by a hard failure. `superseded` is terminal for that attempt but never terminal for the root reversal because its successor is created in the same atomic transition. Phase transitions are append-only, idempotent, and bound to the exact blocked identity, authority event, pre-retirement set, lineage generation/fingerprint, and post-retirement checkpoint as applicable.

Rules:

1. **Retirement and checkpoint are one durable transaction.** The guarded canonical retirement mutation and `retired_checkpointed` state commit atomically. A crash cannot leave live replacements retired without a durable attempt/checkpoint that identifies how to resume.
2. **Recovery precedes fresh classification.** On startup, command retry, or a second invocation for the same blocked identity, GBrain reduces the root reversal’s latest phase and follows successor linkage before resolving a new active replacement set. It never restarts at section 10 step 2 merely because the current set is empty. A `superseded` predecessor without its linked successor is not a valid committed state because rule 4 makes those records atomic.
3. **Resume by phase.**
   - `started`: retry or supersede the guarded retirement transaction using its persisted precondition.
   - `retired_checkpointed`: resume index reconciliation and full rebuild from the persisted pre-retirement requirement set and post-retirement checkpoint, even when the current active replacement set is empty.
   - `rebuild_verified`: revalidate the persisted proof and proceed to commit intent/CAS.
   - `commit_intent`: apply the deterministic recovery cases in rule 5.
4. **Checkpoint drift creates a successor atomically.** If accepted guarded lineage mutation makes an attempt’s checkpoint stale, one atomic ledger/lineage transaction must: mark the predecessor `superseded`; allocate and append the successor’s `started` state; bind predecessor and successor IDs in both directions; persist the successor’s complete inherited-obligation set; and bind the current lineage generation/fingerprint used as the successor precondition. Until that entire transaction commits, the predecessor remains nonterminal and recoverable. The successor’s required-retirement set is the union of every still-unverified predecessor obligation and the newly computed complete active linked-replacement set. An empty current set is valid when inherited predecessor obligations remain. A crash cannot expose a terminal superseded predecessor without the successor that carries its obligations.
5. **Final commit is crash-recoverable and recognized drift is resumable.** Before mutating final live state, GBrain persists `commit_intent` containing the verified proof identity, expected post-retirement checkpoint, expected final canonical state hash, and proposed reinstated pointer. The guarded commit atomically applies the final canonical state and stores the same `root_reversal_id/attempt_no` commit marker in the correction-lineage record. That per-attempt marker is immutable and remains available after later accepted lineage mutations. If the process exits before `committed` is appended, startup checks the durable commit marker before classifying current live state:
   - a marker matching the intent proves that the final commit already occurred; recovery appends `committed` idempotently, then replays any accepted guarded lineage mutations ordered after the marker as later state changes, without creating a successor for the completed attempt;
   - with no matching marker, a matching final state alone is not sufficient and fails closed;
   - matching the verified post-retirement checkpoint retries the guarded commit;
   - with no matching marker, a different generation/fingerprint/set that is fully explained by one or more accepted guarded lineage-mutation events after the intent but before the final commit is ordinary checkpoint drift, so rule 4 atomically supersedes the attempt and starts a successor inheriting all prior obligations plus the new active set;
   - any live state that cannot be derived from the accepted guarded lineage history is an unexplained third state, a hard failure, and leaves the block enforced.
6. **No user maintenance.** Recovery runs automatically from ledger/canonical state. It does not create a queue, reminder, or manual promotion step.

A process exit at any phase therefore leaves either the prior blocked state, a durable checkpoint that can resume, a predecessor/successor pair committed atomically, or the fully committed reinstatement. It cannot permanently strand settlement solely because retirement made the current active set empty or because recognized guarded drift occurred after commit intent.

### 8.7 Idempotency and replay

Every appendable command/event family that can affect learning or verdict state has:

- a stable identity;
- a canonical payload hash;
- same-ID/same-payload idempotency; and
- same-ID/changed-payload conflict behavior that fails closed for learning.

Retries cannot double-count sessions, beneficial uses, errors, irrelevant injections, corrections, root reversals, predecessor/successor transitions, inherited obligations, pre-retirement snapshots, post-retirement checkpoints, replacement-set/fingerprint/generation transitions, rebuild proofs, commit intents, trigger transitions, settlement, or terminal state.

The implementation PR introducing a hashed payload must select one canonical encoding and ship golden test vectors before merge. No behavior may depend on an unspecified serializer.

## 9. Memory classes and activation rules

| Class | Canonical activation rule | Injection behavior |
|---|---|---|
| **constraint** | One exact claim-bound direct user statement or authoritative user correction/reversal | Highest priority when applicable |
| **preference** | One exact claim-bound direct user statement or authoritative user correction/reversal | Inject when relevant |
| **goal** | One exact claim-bound direct user statement or authoritative user correction/reversal | Inject while current and unsuperseded |
| **lesson** | One exact claim-bound verified outcome, or the same claim/scope fingerprint observed in at least two distinct accepted **eligible** sessions, provided that identity is not correction-blocked | Inject when relevant and in exact scope |
| **friction** | Operational/candidate evidence only | Never directly injected |
| **open loop** | Exact claim-bound user statement or verified outcome plus a machine-owned pending trigger, provided that identity is not correction-blocked | At most one; inject only while exact trigger remains pending |
| **business candidate** | Existing candidate-only business path | Never written as personal memory |

Additional rules:

- Single-session model inference remains candidate-only.
- Adapters cannot assert `repeated_pattern`; GBrain derives it.
- Repetition requires distinct session identities whose accepted GBrain eligibility decisions are eligible.
- Duplicate observations from one session cannot satisfy the threshold twice.
- A blocked claim identity cannot be reactivated by repetition or verified outcome; only an exact direct user reversal that completes the recoverable state machine in section 8.6 may supersede the block.
- Every activation or mutation capable of recreating or changing a member of a correction lineage must advance that lineage’s generation and active-set fingerprint under the common mutation guard.
- Friction may support a separately stated lesson, but friction text is not silently coerced into guidance.
- Open-loop completion or cancellation appends a typed terminal transition, writes/supersedes canonical state, and makes the old pending row non-injectable after rebuild.

## 10. Direct correction and reversal

Direct user correction is a first-class trusted-local GBrain operation, not another unstructured outcome note.

For one learning transaction it must:

1. route to the exact brain/source of the obsolete memory;
2. write the corrected canonical fact;
3. mark the obsolete row superseded/struck using the existing correction machinery;
4. create the durable blocked-claim identity for the obsolete claim/class/scope/target/trigger;
5. create the correction-lineage record with its originating correction event, complete active linked-replacement set, canonical set fingerprint, and initial `lineage_generation`;
6. return an authoritative correction event ID plus exact old and replacement pointers and blocked identity;
7. refresh/reconcile the derived index;
8. verify that every row matching the blocked identity is immediately non-injectable; and
9. pass a full rebuild check showing the replacement active and blocked identity still enforced.

Every later authoritative canonical mutation that can change the active linked-replacement set must run under the lineage mutation guard, atomically recompute the complete set fingerprint, and advance `lineage_generation`, or leave the prior state unchanged and fail closed. This includes a later correction of the linked replacement and any direct-statement, verified-outcome, or repeated-pattern activation that could recreate a retired replacement. No path may orphan the block from the active replacement lineage.

Corrected prose remains in private canonical knowledge, not routine operational telemetry.

Correction propagation passes vacuously when no direct correction occurs during a run. When one does occur, the obsolete claim identity—not merely its original pointer—must be absent from all later accepted context-supply telemetry and remain blocked after rebuild.

A later explicit user reversal is a separate trusted-local transaction. Before beginning a new root attempt, GBrain must first run section 8.6 recovery for any existing nonterminal or successor-linked attempt under the same blocked identity. A genuinely new root reversal then:

1. binds and explicitly reinstates the exact blocked identity—including the same normalized claim fingerprint, class, scope, exact target, and trigger identity when applicable;
2. allocates the stable `root_reversal_id` and attempt 1, acquires the lineage mutation guard, and resolves the complete current active linked-replacement set;
3. records `started` with a pre-retirement snapshot of that sorted set, its canonical fingerprint, and current `lineage_generation`;
4. within the same guarded durable transaction, places every snapshotted replacement in pending retirement, supersedes/strikes every member, recomputes the actual active linked-replacement set, advances `lineage_generation`, persists the resulting post-retirement checkpoint, and appends `retired_checkpointed` atomically;
5. releases the guard, reconciles the derived index, performs a full rebuild while the block remains active, and appends `rebuild_verified` only when every required replacement is retired/non-injectable, the blocked identity remains enforced, and reconstructed lineage state exactly matches the post-retirement checkpoint;
6. persists `commit_intent`, reacquires the lineage mutation guard, and compare-and-swaps against the verified post-retirement checkpoint; only exact equality of current generation, active-set fingerprint, and recomputed set permits the final canonical mutation and durable commit marker;
7. atomically lifts the block and activates the reinstated authoritative claim under that guarded commit; and
8. appends or crash-recovers `committed`, then verifies all linked replacements remain retired, the block is lifted, and only the reinstated state is active within that correction lineage.

If the process exits, section 8.6 resumes from the durable phase rather than resolving the now-empty active set as a new reversal. If accepted guarded lineage mutation makes a checkpoint or commit intent stale, the predecessor-to-successor transition and complete inherited obligation set are persisted atomically under rule 4; recovery follows that successor automatically. If any state drift is not explainable by accepted guarded lineage history, the block remains enforced and the run aborts as `repair`. If the new user-authorized claim differs on any identity field, the old block remains and the request is processed separately or fails closed. No inferred or provider-originated event can perform either transition.

## 11. Thin context request and bundle

The authorized adapter submits an explicit context request containing at least:

- run and provider session identity;
- task class;
- forge-qualified repository target or null;
- stable project target or null; and
- a transient bounded relevance window derived from the current request.

The implementation must normalize and hash this request deterministically using one specified canonical codec and golden vectors. The relevance window is limited to the most recent four turns and 2,000 normalized UTF-8 text bytes. Overflow is rejected for Learning Loop retrieval; it is not silently truncated differently by clients.

Retrieval may not infer missing scope or task text from cwd, ambient Git state, mounts, a different checkout, or a raw transcript outside the submitted request.

The returned bundle is ephemeral and contains:

- no more than five items;
- no more than an 800-token estimate;
- applicable constraints first;
- current goals;
- exact-scope proven lessons;
- relevant preferences; and
- at most one pending open loop.

It excludes raw transcripts, stale PR facts, completed work, unsupported inference, unrelated business facts, malformed scope/trigger rows, blocked claims, and superseded memories.

An accepted `context_supplied` event is the sole authority for what the agent actually received. It binds the run, authorized source/session, request hash, exact brain-qualified pointers, and reconstructed scope/trigger/claim identity. An outcome payload cannot self-authorize a memory as supplied.

## 12. Outcome evidence and measurement

The implementation PR for outcomes must introduce a complete discriminated evidence union and matching authoritative GBrain event schemas. At minimum, V1 must represent:

- beneficial use of an actually supplied pointer;
- materially irrelevant supplied context;
- repeated known instruction;
- re-asked known answer;
- direct user correction or reversal via authoritative linkage;
- reversal root/attempt identity, phase transitions, pre-retirement snapshot, atomic retirement/post-retirement checkpoint, rebuild proof, atomic predecessor/successor transition with inherited obligations, commit intent, recognized-drift successor recovery, checkpoint-CAS result, and committed marker;
- open-loop trigger completion/cancellation;
- objective task outcome or blocker; and
- trust/privacy/authorization/replay failure.

Every variant is pointer-, request-, claim-, trigger-, correction-, reversal-attempt-, replacement-set-, lineage-, successor-, checkpoint-, proof-, and source-bound as applicable. Free-form references, transcript excerpts, prompts, secrets, or verbatim user corrections are rejected before ledger persistence.

### 12.1 Beneficial use

A strong beneficial use counts only when:

- the memory pointer appears in accepted `context_supplied` telemetry for the same run/authorized session/request;
- an accepted authoritative event matches that exact pointer, claim identity, and allowed benefit class;
- strength is objective system evidence or an explicit user signal bound to the same claim; and
- the semantic tuple `(run, session, pointer)` has not already counted.

Allowed benefit classes are limited to:

- prevented a repeated known instruction;
- prevented a re-asked known answer;
- avoided a previously evidenced workflow failure; or
- materially improved first-pass execution according to an objective or exact user-bound event.

Agent self-report, generic task success, mere injection, or “context was applied” never counts by itself.

### 12.2 Negative evidence

Errors and materially irrelevant injections are reduced from typed, exact-match authoritative events. One actual irrelevant pointer counts at most once per `(run, session, pointer)`, regardless of duplicate evidence IDs.

A correction, blocked-claim reappearance, unretired or not-rebuild-verified replacement, unrecoverable reversal state, non-atomic/missing successor inheritance, unexplained commit-intent drift, stale/incomplete checkpoint proof, wrong action caused by memory, caller-authorization failure, cross-scope injection, private-body persistence attempt, conflicting replay, or invalid authority linkage cannot be reclassified as a beneficial use.

## 13. Deterministic verdict

Final reduction occurs only after the sealed cohort has 10 eligible sessions and all 10 are settled.

### 13.1 Hard failures

Any of the following immediately aborts the run as `repair`:

- an incorrect high-impact memory causes action;
- a superseded or correction-blocked claim is later supplied without an exact explicit user reversal;
- a reversal lifts a block or activates the reinstated claim before its recoverable phase machine proves every inherited/current retirement obligation and validates the post-retirement checkpoint;
- a reversal commits when current lineage state differs from the verified post-retirement checkpoint without accepted guarded mutations that route the attempt to an atomic successor;
- a predecessor is durably marked `superseded` without the same transaction durably creating and linking the successor plus its inherited obligation set;
- committed canonical retirement exists without a recoverable durable attempt/checkpoint, or startup finds a reversal intent/live state combination outside the final-state, verified-checkpoint, or accepted-guarded-drift successor cases in section 8.6;
- a canonical mutation capable of changing a correction lineage bypasses the common mutation guard or fails to advance its generation/set fingerprint;
- brain/source or repository/project scope crosses boundaries;
- an untrusted/unauthorized caller arms, aborts, changes mode, accesses a local transcript, appends authority, or mutates canonical state;
- any privileged handler accepts a call where `ctx.remote !== false`, or any agent-facing dispatcher advertises or permits invocation of a `localOnly` owner operation;
- business canon or an external system is mutated;
- a transcript body, prompt, secret, or verbatim correction is persisted in operational telemetry;
- session/outcome/evidence identity conflict affects learning state;
- required settlement cannot be proven;
- terminal state becomes ambiguous or duplicated;
- routine canary progress requires the user to inspect a queue/receipt, advance a counter, remember an end date, or perform recurring upkeep.

There is one repair path: `canary_aborted(repair)`. A trust defect discovered during final reduction does not use a competing finalization event.

### 13.2 Broaden

`broaden` requires all of:

- no hard failure;
- exactly 10 eligible, settled cohort sessions;
- at least three strong beneficial uses;
- no more than two materially irrelevant injected pointers;
- correction propagation and durable blocked-claim enforcement pass;
- every reversal bound to a cohort session is durably `committed`, including automatic recovery of interrupted attempts, atomic predecessor/successor inheritance, full inherited/current retirement proof, verified post-retirement checkpoint, and successful final CAS;
- no wrong high-impact active belief survives;
- a valid frozen baseline selected by section 7.1 exists; and
- the canary’s normalized supervision-error rate is strictly lower than the frozen baseline rate.

When a run contains no committed or nonterminal reversal, the reversal-specific recovery/proof/CAS gate passes vacuously. A correction without a reversal is evaluated by correction propagation and durable block enforcement only.

The supervision-error rate is:

```text
(repeated-known-instruction + re-asked-known-answer + user-correction events)
/ eligible sessions
```

The baseline and canary each contain exactly 10 eligible sessions. Raw totals across unequal or differently selected cohorts are never compared.

### 13.3 Keep

Return `keep` when the run is healthy and low-maintenance but one or more broaden gates are unmet. A run without a valid baseline can return `keep`, never `broaden`.

## 14. Implementation sequence

Only one implementation pull request may be actively mutated at a time.

### PR 0 — architecture decision and plan

This document.

Exit condition:

- boundaries, authority, lifecycle, staged ownership, and canary gates are accepted;
- no runtime behavior is enabled.

### PR 1 — trusted controls, session capture, run state, mode resolver, and eligibility

Implement only:

- trusted-local/local-only owner-control operations;
- handler-level `ctx.remote === false` enforcement for every privileged operation;
- `localOnly` discovery/invocation filtering in every agent-facing dispatcher, including HTTP and stdio MCP;
- source-authorized thin adapter submissions;
- versioned session/run/eligibility events;
- authoritative local transcript hashing and parser-bound size/counts;
- session replay semantics;
- `off|capture|canary` mode resolver, default `off`;
- explicit trusted-local arm/abort lifecycle;
- deterministic cohort admission and sealing;
- frozen baseline discovery manifest and deterministic historical cohort selection inputs;
- append-only ledger primitives.

Must not implement context injection, canonical learning writes, outcome scoring, Claude, research, skills, or live activation.

Exit proof includes HTTP and stdio discovery/invocation rejection for `localOnly` operations, direct privileged-handler rejection when `ctx.remote !== false`, untrusted MCP/remote control rejection, source-impersonation rejection, arbitrary-path rejection, golden transcript vectors, cross-path rejection, same-ID replay/conflict tests, mode tests, one-active-run tests, cohort-cap tests, deterministic baseline candidate ordering, and deterministic rebuild/replay.

### PR 2 — candidate learning, exact authority binding, activation, correction blocking, and reversal

Implement only:

- versioned candidate/authority event schemas;
- exact claim fingerprinting;
- claim/class/scope/trigger/source-role equality validation;
- class-by-class activation predicates from section 9;
- canonical fact-fence mapping and rebuild tests;
- GBrain-owned repeated-pattern derivation from two eligible sessions;
- authoritative correction transaction, durable blocked-claim identity, common correction-lineage mutation guard, complete active replacement-set tracking/fingerprint, monotonic lineage generation, recoverable root-reversal/attempt phase state, exact-identity direct user reversal, atomic retirement/checkpoint transaction, rebuild proof, atomic predecessor-supersession/successor-creation with inherited obligations, commit-intent recovery including recognized guarded drift, guarded checkpoint CAS, and supersession verification.

Exit proof includes model text cannot gain user authority, unrelated same-session user text cannot authorize another claim, ineligible sessions cannot satisfy repetition, corrected claims cannot reactivate through repetition/verified outcome/new pointer, a reversal naming blocked identity A but authorizing different claim C leaves A blocked, A→B followed by exact A reinstatement completes all phases and retires B, a later linked B→C update is included in a successor attempt before A unblocks, B→C after checkpoint or commit intent makes CAS fail and atomically creates a successor proof for C, direct-statement or repeated-pattern recreation after checkpoint also forces an atomic successor, process exit cannot observe a superseded predecessor without its linked successor/inherited obligations, the intended retirement transition’s generation advance does not self-fail, process exit after `retired_checkpointed` resumes rebuild with an empty current set, process exit after `commit_intent` reconciles to committed, retries safely, or atomically creates a successor for accepted guarded drift, and correction/block/replacement/reversal state survives full rebuild.

### PR 3 — context request, thin bundle, and supply telemetry

Implement only:

- versioned context request and canonical request hashing;
- explicit current scope and bounded relevance input;
- precision-biased retrieval from canonical personal facts;
- five-item/800-token budget;
- at-most-one pending open loop;
- exact `context_supplied` telemetry without request text.

Exit proof includes canonical hash golden vectors, Unicode/newline behavior, overflow rejection, no ambient scope inference, wrong-brain/wrong-forge/wrong-project exclusions, blocked/superseded/terminal-loop exclusions, source authorization, and exact pointer/claim telemetry.

### PR 4 — thin Codex adapter

Modify only the existing owner of active Codex hooks.

The adapter:

- authenticates/identifies its source and provider session;
- gathers explicit work scope without selecting arbitrary server-local paths;
- submits bounded context requests;
- injects returned context;
- submits session-close metadata and outcomes; and
- fails open for ordinary work when GBrain is unavailable.

It cannot change loop mode, arm/abort runs, append authoritative events, inspect unrelated transcripts, or mutate canonical memory.

No second transcript walker, scheduler, daemon, receipt format, dashboard, or review policy.

### PR 5 — authoritative outcome events, baseline evaluation, settlement, and verdict reducer

Implement only:

- complete typed evidence/event union;
- variant-specific event and authorized-source equality;
- canonical payload encodings and golden vectors;
- outcome/evidence replay semantics;
- frozen baseline-evaluator version, complete per-session evaluation records, and section 7.1 validity reduction;
- GBrain-owned close manifests and expected outcome identity;
- typed correction/reversal phase, checkpoint, proof, atomic successor inheritance, commit-intent/CAS, recognized-drift recovery, and trigger transitions;
- automatic startup/retry reduction of nonterminal and successor-linked reversal attempts;
- session settlement;
- semantic deduplication;
- frozen normalized baseline comparison;
- terminal `keep|broaden|repair` behavior, including vacuous reversal-gate semantics when no reversal exists.

Exit proof includes deterministic baseline selection from competing historical windows, tie-break ordering, fewer-than-10 and missing/conflicted evaluation yielding `baseline:null`, later transcript discovery not changing the frozen baseline, delayed/omitted outcome cannot settle, session 10 cannot finalize early, fabricated pointers cannot count, same-session wrong-pointer evidence is rejected, unauthorized source events are rejected, conflicting retries abort, extra session 11 cannot change the cohort, blocked claims remain blocked, a crash after retirement resumes from the durable checkpoint rather than treating the empty set as a new failure, predecessor supersession and successor creation/inheritance are atomic, accepted guarded drift after `commit_intent` but before the final commit creates a successor rather than corruption, a later accepted mutation after the durable final commit marker recovers the attempt as committed and replays the later mutation without a successor, unexplained third-state drift aborts, no-reversal runs do not fail the reversal-specific gate, hard failures terminate immediately, and replay produces the same verdict.

### Canary activation

After PRs 1–5 land and are independently reviewed:

1. Freeze the baseline automatically by section 7.1; record `baseline:null` when its validity predicate fails.
2. Explicitly arm one run through the trusted-local control.
3. Work normally.
4. The system counts, settles, and finalizes automatically.
5. The user receives one plain-English conclusion and only genuine exceptions.

No manufactured sessions and no date the user must remember.

### PR 6 — delete displaced machinery

Only after a successful `keep` or `broaden` result, remove personal-memory mechanisms that the proven loop replaces, such as manual promotion, unread session-summary Markdown, reminder-based canary tracking, duplicate context stores, and instructions requiring agents to inspect multiple Hub files.

Do not delete rollback capability, correction blocks/history, complete replacement-set lineage/generation, reversal phase/checkpoint/intent/successor state, or raw evidence needed to rebuild.

## 15. Required adversarial proof matrix

Across the implementation sequence, tests must cover at least:

- untrusted HTTP and stdio MCP attempts to discover or invoke `localOnly` owner operations;
- privileged handler invocation with `ctx.remote !== false`;
- untrusted MCP/remote attempts to arm, abort, change mode, or inspect local transcripts;
- adapter source impersonation and cross-session submission;
- same session/same hash retry;
- same session/changed transcript conflict;
- adapter size/hash disagreement with GBrain bytes;
- path outside configured transcript roots or unrelated to the authorized source session;
- interrupted and structurally ineligible sessions;
- ineligible sessions attempting repeated-pattern activation;
- session 11 arriving while the first 10 settle;
- stale run terminal event contaminating a rerun;
- multiple possible baseline windows and deterministic newest-10 selection;
- equal completion timestamps using the defined bytewise tie breakers;
- fewer than 10 historical eligible sessions;
- a selected historical session with missing/conflicted evaluation;
- a later transcript discovery attempting to change an armed baseline;
- wrong brain/source pointer;
- same repository name on different forges;
- missing/mismatched project target;
- literal sentinel-like scope/trigger values;
- assistant text posing as a user statement;
- a user event authorizing a different claim in the same session;
- objective event for pointer A authorizing pointer B;
- fabricated “supplied” pointer absent from context telemetry;
- corrected claim reappearing under a new pointer after two eligible observations;
- verified outcome attempting to reactivate a correction-blocked claim;
- a reversal naming blocked identity A while authorizing different claim C;
- A→B correction followed by exact A reinstatement through every durable phase;
- linked B→C correction followed by A reinstatement, with C incorporated into a successor attempt;
- B→C or recreated B after checkpoint but before commit, causing checkpoint-CAS failure and atomic successor recovery;
- the same accepted guarded drift after `commit_intent`, producing an atomic successor rather than an unexplained-state abort;
- a crash at every byte boundary around the atomic predecessor-superseded/successor-started/linkage/inherited-obligation transaction, proving either the predecessor remains nonterminal or the complete successor is visible;
- planned retirement advancing generation/fingerprint without self-invalidating its own checkpoint;
- process exit immediately before and after each reversal phase transition;
- process exit after replacements retire but before rebuild, followed by automatic resume from `retired_checkpointed` despite an empty current active set;
- process exit after rebuild verification and after commit intent;
- final canonical state present with missing committed ledger event, completed idempotently from the durable commit marker;
- a later accepted lineage mutation after the durable final commit marker, recovering the marked attempt as committed before replaying that later mutation;
- checkpoint state still present after commit intent, retried safely;
- explainable guarded lineage drift after commit intent, routed to an inherited-obligation successor;
- a third unexpected live state not derivable from accepted guarded mutation history, aborting as repair while preserving the block;
- successor attempt inheriting all unresolved predecessor retirement obligations;
- any canonical lineage mutation attempting to bypass the common guard or omit a generation/set-fingerprint update;
- completed/cancelled/triggerless open loop after rebuild;
- direct correction followed by retrieval and full rebuild;
- duplicate beneficial or irrelevant evidence under different IDs;
- outcome omitted, delayed, duplicated, or changed on retry;
- trigger ID/state mismatch;
- Unicode/newline/request-hash golden vectors;
- request overflow behavior;
- raw text, prompt, quote, or secret attempted in telemetry;
- final reduction replay under changed current config;
- hard failure before and during final reduction;
- rollback followed by a clean new arm;
- no reversal producing a vacuously passing reversal-specific recovery/proof/CAS gate;
- no baseline preventing `broaden`;
- baseline/canary comparison using frozen rates and identical cohort sizes;
- GBrain outage not blocking ordinary Codex work;
- no business-canon or external write path.

## 16. Definition of done

V1 is complete only when:

- PRs 1–5 are merged under their owning repository gates;
- every owner-control handler independently enforces `ctx.remote === false`, and every agent-facing dispatcher hides and rejects `localOnly` owner operations;
- the loop is explicitly armed by a trusted-local owner control, not enabled by merge or an untrusted caller;
- the baseline is frozen once using section 7.1’s deterministic newest-10 selection or explicitly recorded as null;
- exactly 10 eligible Codex sessions count and settle automatically;
- relevant context is actually supplied and measured;
- direct correction removes obsolete beliefs and durably blocks their claim identities immediately and after rebuild;
- only an exact direct user reinstatement can lift a correction block, and only after the recoverable reversal phase machine retires/proves every inherited/current replacement obligation and successfully commits against the verified checkpoint;
- interruption at any reversal phase resumes or reconciles automatically, predecessor supersession cannot lose successor obligations, and accepted guarded drift after commit intent creates a successor rather than a manual incident;
- every canonical mutation capable of changing a correction lineage is serialized through the common guard and advances the complete set fingerprint/generation;
- no incorrect high-impact belief or contradictory linked replacement survives;
- no business-canon or external write occurs;
- no dashboard, queue, reminder, manual promotion, or recurring user maintenance is introduced;
- the system produces one automatic `keep`, `repair`, or `broaden` result; and
- successful proof is followed by deletion of displaced manual machinery.

The first permitted broadening is a Claude adapter using the same GBrain authority, authorization, correction, recovery, and evidence model. Research ingestion, self-editing skills/config, and business-canon proposal promotion remain separate later decisions.

## 17. Implementation handoff

The next coding task is **PR 1 only**.

The implementing agent must:

- read this ADR and current repository instructions;
- inspect and reuse existing transcript discovery/parser, operation authorization, and configuration patterns;
- define versioned schemas and canonical encodings beside code and golden tests;
- mark owner controls and server-local transcript operations trusted-local/local-only;
- independently enforce `ctx.remote === false` inside every privileged handler;
- filter `localOnly` operations from discovery and deny invocation in every agent-facing dispatcher, including stdio MCP and HTTP;
- authorize thin adapter submissions to one exact source/provider session;
- preserve ordinary Codex work when Learning Loop operations fail;
- keep the default mode `off`;
- implement only the deterministic baseline discovery inputs assigned to PR 1, leaving baseline evaluation/verdict logic to PR 5;
- avoid context retrieval, memory activation, outcome scoring, Claude, research, skills, personal-projection automation, business-canon writes, and live/global configuration;
- run the repository’s normal proof;
- obtain an independent exact-head review before landing.

A discovered need outside PR 1 becomes a note for the later named increment; it does not expand the active implementation.
