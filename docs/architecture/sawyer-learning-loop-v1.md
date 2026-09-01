# Sawyer Learning Loop V1 — architecture decision and implementation plan

**Status:** approved design direction; implementation remains staged and disabled by default  
**Owner:** GBrain core, plus one thin adapter in the existing owner of active Codex session hooks  
**Decision:** close one measurable learning loop by composing existing GBrain primitives; do not create a parallel memory product, agent hierarchy, dashboard, queue, or supervision layer

## 1. Decision and intended outcome

Sawyer Learning Loop V1 will connect four steps that are currently separate:

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
- what Sawyer corrected;
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
| **Sawyer Hub** | Optional generated human-readable projection | Never required for activation, retrieval, promotion, or canary completion |
| **Seascape Hub** | Controlled durable business knowledge | Separate business authority; no automatic promotion from this personal loop |
| **Codex / later Claude adapter** | Submit normalized events, request context, perform work, return outcomes | Thin client; cannot define thresholds, authority, or verdicts |
| **Sawyer** | Strategy, business judgment, irreversible or external-action exceptions | No routine memory maintenance, counter advancement, receipt review, or promotion work |

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
- canonical memory activated or superseded;
- objective outcome or explicit user signal recorded;
- open-loop trigger transitioned;
- session settled;
- canary armed, finalized, or aborted.

The ledger may be replayed to rebuild derived run state. It does not itself make an inferred personal claim true.

### 4.3 Canonical personal knowledge

Durable active personal knowledge remains in the existing GBrain filesystem-canonical Markdown/fact-fence model. Database rows remain rebuildable indexes.

A memory is active only when a permitted activation rule writes it to the configured canonical personal source. Candidate observations, session summaries, model confidence, and operational events alone are not active memory.

### 4.4 Business knowledge

A possible Seascape fact may be surfaced only as an evidence-backed candidate through the existing business boundary. V1 cannot promote, rewrite, merge, deploy, send, or otherwise mutate Seascape canon or any external system.

## 5. V1 scope

V1 includes only:

1. Codex session-close capture.
2. GBrain-owned deterministic eligibility.
3. Candidate learning and direct correction handling.
4. Canonical personal-memory activation under explicit rules.
5. Thin task-relevant context retrieval.
6. Exact context-supply telemetry.
7. Typed outcome evidence and session settlement.
8. A 10-eligible-session canary with automatic `keep`, `repair`, or `broaden` disposition.
9. Cleanup of displaced manual personal-memory machinery only after successful proof.

V1 explicitly excludes:

- Claude or ChatGPT ingestion;
- research ingestion;
- automatic skill or configuration edits;
- live `~/.codex` changes;
- automatic PR, merge, deploy, install, send, or schedule actions;
- a new memory database, repository, knowledge graph, dashboard, inbox, queue, or notification channel;
- autonomous Seascape canon promotion;
- more than one active self-improvement change.

## 6. Operating modes and activation

One central mode resolver exposes:

```text
learning_loop.mode = off | capture | canary
```

- **off** — no Learning Loop capture, distillation, injection, counting, or canonical activation.
- **capture** — local session/evidence capture and candidate distillation may run; no context injection, no canary counting, and no automatic canonical activation.
- **canary** — capture, qualified activation/correction, context injection, outcome measurement, and counting operate only for one explicitly armed run.

Default is `off`. A merge cannot arm or activate a run.

Changing out of `canary` first appends a terminal abort for the active run, then changes mode. Capture and injection are independently disableable so ordinary Codex work continues if the loop is rolled back.

## 7. Canary lifecycle

### 7.1 Arming

An explicit arm operation creates an immutable `run_id`. Only one run may be nonterminal at once.

Arming freezes at least:

- contract/schema version;
- GBrain implementation commit/version;
- provider allow-list, exactly `codex` for V1;
- target cohort size, exactly 10;
- eligibility-classifier version and thresholds;
- personal destination including `brain_id`, `source_id`, and canonical page/slug;
- verdict thresholds;
- baseline object or explicit no-baseline state.

Reducers use the frozen run inputs, never mutable current defaults.

### 7.2 Session identity and authoritative transcript data

Global session uniqueness is `(provider, provider_session_id)`.

GBrain—not the adapter—must resolve the transcript through configured local corpus boundaries, read the exact bytes consumed by the parser, and compute the authoritative size and content hash.

- Same session identity plus same authoritative hash is an idempotent retry.
- Same session identity plus a different authoritative hash is a conflict and cannot learn, count, or replace the prior completion.
- Adapter-supplied path, size, or hash is only an assertion and must match GBrain’s computation.

### 7.3 GBrain-owned eligibility

For the V1 canary, eligibility is deliberately structural and deterministic. A session is eligible only when all are true:

- provider is in the frozen allow-list;
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
- all required canonical mutations or trigger transitions complete; and
- no replay conflict or unresolved trust failure remains.

The run cannot finalize until all 10 cohort sessions are settled. Session 10 completion alone is never enough.

### 7.6 Terminal state

A run ends exactly once with either:

- `canary_finalized(keep|broaden)`; or
- `canary_aborted(repair)`.

A hard failure aborts immediately, disables further injection/counting/activation for that run, and preserves history. A later bounded rerun receives a new `run_id`; old terminal events cannot contaminate it.

## 8. Identity, scope, provenance, and replay invariants

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

### 8.5 Idempotency and replay

Every appendable command/event family that can affect learning or verdict state has:

- a stable identity;
- a canonical payload hash;
- same-ID/same-payload idempotency; and
- same-ID/changed-payload conflict behavior that fails closed for learning.

Retries cannot double-count sessions, beneficial uses, errors, irrelevant injections, corrections, trigger transitions, settlement, or terminal state.

The implementation PR introducing a hashed payload must select one canonical encoding and ship golden test vectors before merge. No behavior may depend on an unspecified serializer.

## 9. Memory classes and activation rules

| Class | Canonical activation rule | Injection behavior |
|---|---|---|
| **constraint** | One exact claim-bound direct user statement or authoritative user correction | Highest priority when applicable |
| **preference** | One exact claim-bound direct user statement or authoritative user correction | Inject when relevant |
| **goal** | One exact claim-bound direct user statement or authoritative user correction | Inject while current and unsuperseded |
| **lesson** | One exact claim-bound verified outcome, or the same claim/scope fingerprint observed in at least two distinct accepted **eligible** sessions | Inject when relevant and in exact scope |
| **friction** | Operational/candidate evidence only | Never directly injected |
| **open loop** | Exact claim-bound user statement or verified outcome plus a machine-owned pending trigger | At most one; inject only while exact trigger remains pending |
| **business candidate** | Existing candidate-only business path | Never written as personal memory |

Additional rules:

- Single-session model inference remains candidate-only.
- Adapters cannot assert `repeated_pattern`; GBrain derives it.
- Repetition requires distinct session identities whose accepted GBrain eligibility decisions are eligible.
- Duplicate observations from one session cannot satisfy the threshold twice.
- Friction may support a separately stated lesson, but friction text is not silently coerced into guidance.
- Open-loop completion or cancellation appends a typed terminal transition, writes/supersedes canonical state, and makes the old pending row non-injectable after rebuild.

## 10. Direct correction

Direct user correction is a first-class GBrain operation, not another unstructured outcome note.

For one learning transaction it must:

1. route to the exact brain/source of the obsolete memory;
2. write the corrected canonical fact;
3. mark the obsolete row superseded/struck using the existing correction machinery;
4. return an authoritative correction event ID plus exact old and replacement pointers;
5. refresh/reconcile the derived index;
6. verify that the obsolete pointer is immediately non-injectable; and
7. pass a full rebuild check showing only the replacement remains active.

Corrected prose remains in private canonical knowledge, not routine operational telemetry.

Correction propagation passes vacuously when no direct correction occurs during a run. When one does occur, every obsolete pointer must be absent from all later accepted context-supply telemetry and remain absent after rebuild.

## 11. Thin context request and bundle

The adapter submits an explicit context request containing at least:

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

It excludes raw transcripts, stale PR facts, completed work, unsupported inference, unrelated business facts, malformed scope/trigger rows, and superseded memories.

An accepted `context_supplied` event is the sole authority for what the agent actually received. It binds the run, session, request hash, exact brain-qualified pointers, and reconstructed scope/trigger metadata. An outcome payload cannot self-authorize a memory as supplied.

## 12. Outcome evidence and measurement

The implementation PR for outcomes must introduce a complete discriminated evidence union and matching authoritative GBrain event schemas. At minimum, V1 must represent:

- beneficial use of an actually supplied pointer;
- materially irrelevant supplied context;
- repeated known instruction;
- re-asked known answer;
- direct user correction via authoritative correction linkage;
- open-loop trigger completion/cancellation;
- objective task outcome or blocker; and
- trust/privacy/replay failure.

Every variant is pointer-, request-, claim-, trigger-, or correction-bound as applicable. Free-form references, transcript excerpts, prompts, secrets, or verbatim user corrections are rejected before ledger persistence.

### 12.1 Beneficial use

A strong beneficial use counts only when:

- the memory pointer appears in accepted `context_supplied` telemetry for the same run/session/request;
- an accepted authoritative event matches that exact pointer and allowed benefit class;
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

A correction, wrong action caused by memory, cross-scope injection, private-body persistence attempt, conflicting replay, or invalid authority linkage cannot be reclassified as a beneficial use.

## 13. Deterministic verdict

Final reduction occurs only after the sealed cohort has 10 eligible sessions and all 10 are settled.

### 13.1 Hard failures

Any of the following immediately aborts the run as `repair`:

- an incorrect high-impact memory causes action;
- a superseded memory is later supplied;
- brain/source or repository/project scope crosses boundaries;
- Seascape canon or an external system is mutated;
- a transcript body, prompt, secret, or verbatim correction is persisted in operational telemetry;
- session/outcome/evidence identity conflict affects learning state;
- required settlement cannot be proven;
- terminal state becomes ambiguous or duplicated;
- routine canary progress requires Sawyer to inspect a queue/receipt, advance a counter, remember an end date, or perform recurring upkeep.

There is one repair path: `canary_aborted(repair)`. A trust defect discovered during final reduction does not use a competing finalization event.

### 13.2 Broaden

`broaden` requires all of:

- no hard failure;
- exactly 10 eligible, settled cohort sessions;
- at least three strong beneficial uses;
- no more than two materially irrelevant injected pointers;
- correction propagation passes;
- no wrong high-impact active belief survives;
- a valid frozen baseline exists; and
- the canary’s normalized supervision-error rate is strictly lower than the baseline rate.

The supervision-error rate is:

```text
(repeated-known-instruction + re-asked-known-answer + user-correction events)
/ eligible sessions
```

Raw totals across unequal cohorts are never compared.

### 13.3 Keep

Return `keep` when the run is healthy and low-maintenance but one or more broaden gates are unmet. A run without a valid baseline can return `keep`, never `broaden`.

## 14. Implementation sequence

Only one implementation pull request may be actively mutated at a time.

### PR 0 — architecture decision and plan

This document.

Exit condition:

- boundaries, authority, lifecycle, staged ownership, and canary gates are accepted;
- no runtime behavior is enabled.

### PR 1 — session capture, run state, mode resolver, and eligibility

Implement only:

- versioned session/run/eligibility events;
- authoritative local transcript hashing and parser-bound size/counts;
- session replay semantics;
- `off|capture|canary` mode resolver, default `off`;
- explicit arm/abort lifecycle;
- deterministic cohort admission and sealing;
- append-only ledger primitives.

Must not implement context injection, canonical learning writes, outcome scoring, Claude, research, skills, or live activation.

Exit proof includes golden transcript vectors, cross-path rejection, same-ID replay/conflict tests, mode tests, one-active-run tests, cohort-cap tests, and deterministic rebuild/replay.

### PR 2 — candidate learning, exact authority binding, activation, and correction

Implement only:

- versioned candidate/authority event schemas;
- exact claim fingerprinting;
- claim/class/scope/trigger equality validation;
- class-by-class activation predicates from section 9;
- canonical fact-fence mapping and rebuild tests;
- GBrain-owned repeated-pattern derivation from two eligible sessions;
- authoritative correction transaction and supersession verification.

Exit proof includes model-text cannot gain user authority, unrelated same-session user text cannot authorize another claim, ineligible sessions cannot satisfy repetition, cross-scope rows cannot inject, pending/terminal open-loop rebuild behavior, and correction survival after full rebuild.

### PR 3 — context request, thin bundle, and supply telemetry

Implement only:

- versioned context request and canonical request hashing;
- explicit current scope and bounded relevance input;
- precision-biased retrieval from canonical personal facts;
- five-item/800-token budget;
- at-most-one pending open loop;
- exact `context_supplied` telemetry without request text.

Exit proof includes canonical hash golden vectors, Unicode/newline behavior, overflow rejection, no ambient scope inference, wrong-brain/wrong-forge/wrong-project exclusions, superseded/terminal-loop exclusions, and exact pointer telemetry.

### PR 4 — thin Codex adapter

Modify only the existing owner of active Codex hooks.

The adapter:

- gathers provider/session identifiers and explicit work scope;
- submits bounded context requests;
- injects returned context;
- submits session-close metadata and outcomes;
- fails open for ordinary work when GBrain is unavailable.

No second transcript walker, scheduler, daemon, receipt format, dashboard, or review policy.

### PR 5 — authoritative outcome events, settlement, and verdict reducer

Implement only:

- complete typed evidence/event union;
- variant-specific event equality;
- canonical payload encodings and golden vectors;
- outcome/evidence replay semantics;
- GBrain-owned close manifests and expected outcome identity;
- typed trigger transitions;
- session settlement;
- semantic deduplication;
- normalized baseline comparison;
- terminal `keep|broaden|repair` behavior.

Exit proof includes delayed/omitted outcome cannot settle, session 10 cannot finalize early, fabricated pointers cannot count, same-session wrong-pointer evidence is rejected, conflicting retries abort, extra session 11 cannot change the cohort, hard failures terminate immediately, and replay produces the same verdict.

### Canary activation

After PRs 1–5 land and are independently reviewed:

1. Freeze the baseline automatically from prior eligible Codex sessions when valid; otherwise record no baseline.
2. Explicitly arm one run.
3. Work normally.
4. The system counts, settles, and finalizes automatically.
5. Sawyer receives one plain-English conclusion and only genuine exceptions.

No manufactured sessions and no date Sawyer must remember.

### PR 6 — delete displaced machinery

Only after a successful `keep` or `broaden` result, remove personal-memory mechanisms that the proven loop replaces, such as manual promotion, unread session-summary Markdown, reminder-based canary tracking, duplicate context stores, and instructions requiring agents to inspect multiple Hub files.

Do not delete rollback capability or raw evidence needed to rebuild.

## 15. Required adversarial proof matrix

Across the implementation sequence, tests must cover at least:

- same session/same hash retry;
- same session/changed transcript conflict;
- adapter size/hash disagreement with GBrain bytes;
- path outside configured transcript roots;
- interrupted and structurally ineligible sessions;
- ineligible sessions attempting repeated-pattern activation;
- session 11 arriving while the first 10 settle;
- stale run terminal event contaminating a rerun;
- wrong brain/source pointer;
- same repository name on different forges;
- missing/mismatched project target;
- literal sentinel-like scope/trigger values;
- assistant text posing as a user statement;
- a user event authorizing a different claim in the same session;
- objective event for pointer A authorizing pointer B;
- fabricated “supplied” pointer absent from context telemetry;
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
- no baseline preventing `broaden`;
- unequal-size baseline comparison using rates, not totals;
- GBrain outage not blocking ordinary Codex work;
- no Seascape/external write path.

## 16. Definition of done

V1 is complete only when:

- PRs 1–5 are merged under their owning repository gates;
- the loop is explicitly armed, not enabled by merge;
- exactly 10 eligible Codex sessions count and settle automatically;
- relevant context is actually supplied and measured;
- direct correction removes obsolete beliefs immediately and after rebuild;
- no incorrect high-impact belief survives;
- no Seascape or external write occurs;
- no dashboard, queue, reminder, manual promotion, or recurring Sawyer maintenance is introduced;
- the system produces one automatic `keep`, `repair`, or `broaden` result; and
- successful proof is followed by deletion of displaced manual machinery.

The first permitted broadening is a Claude adapter using the same GBrain authority and evidence model. Research ingestion, self-editing skills/config, and Seascape proposal promotion remain separate later decisions.

## 17. Implementation handoff

The next coding task is **PR 1 only**.

The implementing agent must:

- read this ADR and current repository instructions;
- inspect and reuse existing transcript discovery/parser and configuration patterns;
- define versioned schemas and canonical encodings beside code and golden tests;
- preserve ordinary Codex work when Learning Loop operations fail;
- keep the default mode `off`;
- avoid context retrieval, memory activation, outcome scoring, Claude, research, skills, Sawyer Hub automation, Seascape writes, and live/global configuration;
- run the repository’s normal proof;
- obtain an independent exact-head review before landing.

A discovered need outside PR 1 becomes a note for the later named increment; it does not expand the active implementation.