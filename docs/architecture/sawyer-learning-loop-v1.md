# Sawyer Learning Loop V1 — Codex ten-session closed-loop canary

**Status:** proposed contract; no runtime behavior is enabled by this document  
**Owner:** GBrain core, with one thin Codex adapter in the existing repository that owns active Codex session hooks  
**Decision:** integrate existing GBrain primitives; do not build a parallel memory product  
**Tracking:** the draft pull request carrying this document is the single implementation tracker because GitHub Issues are disabled in this repository

## 1. Executive decision

The Sawyer Learning Loop closes one specific loop:

```text
completed Codex session
        ↓
local evidence capture
        ↓
qualified personal learning or correction
        ↓
canonical private GBrain knowledge
        ↓
thin relevant context for a later session
        ↓
objective outcome or user correction
        ↓
updated knowledge and canary evidence
```

V1 runs for **ten eligible Codex sessions**, then completes itself with one terminal verdict:

- **keep** — safe and useful, but not yet proven enough to broaden;
- **repair** — one bounded component must be corrected before further use;
- **broaden** — the loop is reliable enough to add Claude ingestion through the same provider-neutral contract.

The user must not maintain a Markdown promotion flow, remember an end date, inspect a queue, advance a counter, or revisit an experiment manually.

This is the single active personal-agent self-improvement initiative. V1 does not include research ingestion, automatic skill edits, Seascape canon promotion, deployment, installation, scheduling, or live activation.

## 2. Problem statement

GBrain already stores and retrieves substantial personal context, but the full behavioral loop is not expressed as one product contract. Existing capabilities can capture transcripts, extract and supersede facts, volunteer context, log friction, and record retrieval telemetry. What is missing is a narrow lifecycle that can answer all of these questions for one Codex session:

1. Was this a completed, eligible session?
2. What did it teach that is authoritative enough to retain?
3. Did it correct an existing belief?
4. Which exact learned items were supplied to a later session?
5. Did those items improve execution, prove irrelevant, or cause a correction?
6. Has the ten-session experiment completed, and what is its deterministic verdict?

Without the use-and-measure steps, transcript capture is storage and session summarization is prettier storage. Without explicit correction semantics, repeated model inference becomes self-reinforcing folklore.

## 3. Definition of done

V1 is complete only when all of the following are true:

1. Ten eligible Codex sessions are counted automatically and exactly once.
2. Each eligible completion is captured without blocking normal Codex work.
3. Qualified direct preferences, goals, corrections, proven lessons, and repeated friction can update private canonical GBrain knowledge.
4. Single-session agent inference cannot silently become an active belief.
5. A processed direct correction supersedes the conflicting belief in canonical Markdown.
6. The superseded belief does not return after a GBrain rebuild.
7. A later session receives at most five relevant learned items under a hard token budget.
8. The system records the exact canonical memory pointers supplied to that session.
9. Outcomes and later corrections are linked to those pointers.
10. The canary finalizes itself once and emits `keep`, `repair`, or `broaden` with traceable evidence.
11. Injection can be disabled independently of capture through one configuration key.
12. Nothing writes Seascape canon or performs an external action.
13. Sawyer performs no recurring maintenance action to keep the loop running.

Storage, extraction, or a generated summary alone does not satisfy this definition.

## 4. Non-negotiable invariants

### 4.1 Filesystem-canonical personal knowledge

Durable user knowledge follows the existing system-of-record contract:

- canonical personal beliefs live in Markdown under a user-owned GBrain source;
- fact fences are the durable fact representation;
- database fact rows are rebuildable indexes;
- a database-only memory row is not authoritative;
- corrections must survive rebuild by changing the canonical fence.

V1 does not introduce a new authoritative memory database.

### 4.2 Operational evidence is not personal truth

Session, injection, outcome, and canary events are operational evidence. They may live in an append-only local JSONL ledger under `$GBRAIN_HOME`, following the existing friction-log pattern. The ledger can nominate or support a canonical belief, but the ledger itself is not the active personal operating model.

### 4.3 Personal and Seascape authority remain separate

- Personal operating preferences and cross-vendor lessons belong to the user's personal brain/source.
- Seascape business claims remain controlled business knowledge.
- A personal session may produce a Seascape writeback candidate through the existing candidate-only boundary.
- V1 cannot promote, rewrite, merge, deploy, send, or otherwise mutate Seascape canon or an external system.

### 4.4 Clients remain thin

Provider-specific clients submit normalized events and request context through the operation layer. They do not own distillation, thresholds, memory selection, correction semantics, or canary scoring.

### 4.5 Failure is fail-open for agent work

Capture, distillation, retrieval, telemetry, and canary-accounting failures must never prevent Codex from starting or completing ordinary work. A failure records local diagnostic evidence when possible and returns no injected context.

Fail-open execution does not mean fail-open learning: an uncertain observation remains inactive.

### 4.6 One experiment, no supervision layer

V1 creates no dashboard, work queue, standing approval step, agent hierarchy, notification channel, or receipt-review obligation. Internal evidence may be machine-readable; the terminal user surface is one plain-English conclusion with the evidence needed to trust it.

## 5. Existing GBrain capabilities to reuse

| V1 need | Existing seam | Required treatment |
|---|---|---|
| Transcript enumeration, hashing, self-consumption guard | `src/core/cycle/transcript-discovery.ts` | Reuse; do not create a second corpus walker |
| Recent local transcript access | `src/core/transcripts.ts` | Reuse local-only trust boundary |
| Provider-neutral message parsing | `src/core/conversation-parser/*` | Reuse parser contract and diagnostics |
| Extraction eligibility | `src/core/facts/eligibility.ts` | Reuse where page-shaped input applies; session eligibility remains a separate pure predicate |
| Durable private facts | fact fences and `src/core/cycle/extract-facts.ts` | Reconcile through canonical Markdown |
| Duplicate/supersede/independent classification | `src/core/facts/classify.ts` | Reuse as supporting evidence; direct user correction has higher authority |
| Correction that survives rebuild | `src/core/facts/forget.ts`, fence parser/renderer | Reuse fence-rewrite semantics |
| Rebuild-stable memory coordinates | `source_id`, `source_markdown_slug`, append-only `row_num` | Use as the canonical memory pointer; do not add a second ID system |
| Proactive context discovery | `src/core/context/volunteer.ts` | Reuse precision-biased page discovery, then select eligible active facts |
| Injection telemetry | `src/core/context/volunteer-events.ts` | Extend or compose; current `session_id` support is useful, but page-level approximate usage is insufficient for the canary |
| Friction/delight evidence | `src/core/friction.ts` | Reuse as one evidence source, not as canonical truth |
| Query/search telemetry | `src/core/eval-capture.ts` | Reuse operation-layer capture and privacy precedent |
| Business boundary | `src/core/writeback-candidate.ts` | Preserve `writes: false` behavior |
| Configuration kill switch | config-backed feature-flag pattern | Implement one central mode resolver |
| Skill optimization | `src/core/skillopt/*`, `src/core/skillify/*` | Explicitly out of V1 |

## 6. Provider-neutral contracts

The following shapes define the logical contract. Final names may follow repository conventions, but the semantics must remain provider-neutral and operation-layer owned.

### 6.1 Completed session envelope

```ts
interface CompletedSessionV1 {
  schema_version: 1;
  provider: 'codex';
  provider_session_id: string;
  content_hash: string;
  started_at: string | null;
  completed_at: string;
  completion: 'completed' | 'interrupted' | 'abandoned';
  transcript_ref: {
    local_path: string;
    byte_length: number;
  };
  work_context: {
    cwd: string | null;
    repository: string | null;
    branch: string | null;
    pull_request: string | null;
    task_class: 'implementation' | 'review' | 'research' | 'strategy' | 'operations' | 'other';
  };
  objective_evidence: Array<{
    kind: 'test' | 'build' | 'git' | 'review' | 'merge' | 'deploy' | 'external_action' | 'other';
    status: 'success' | 'failure' | 'blocked' | 'unknown';
    reference?: string;
  }>;
}
```

The idempotency key is the tuple `(provider, provider_session_id, content_hash)`. Repeated close hooks append no second `session_completed` event and do not advance the canary twice.

Raw transcript paths are accepted only from trusted local callers. Remote MCP callers cannot use a path parameter to read arbitrary local files.

### 6.2 Session eligibility result

```ts
interface SessionEligibilityV1 {
  eligible: boolean;
  reason:
    | 'eligible'
    | 'not_completed'
    | 'duplicate'
    | 'empty_or_too_short'
    | 'no_material_decision_or_outcome'
    | 'unsupported_provider'
    | 'canary_already_terminal';
  signals: string[];
}
```

Eligibility is deterministic and pure. A completed session qualifies when it contains at least one material signal:

- substantive implementation or repair outcome;
- pull-request or code-review disposition;
- explicit user correction;
- meaningful strategy decision;
- repeated operating friction;
- reusable lesson backed by objective evidence;
- a machine-owned open loop with a real completion trigger.

Simple lookups, empty starts, login-only failures, abandoned sessions, and generated housekeeping do not count.

### 6.3 Canonical memory pointer

```ts
interface MemoryPointerV1 {
  source_id: string;
  source_markdown_slug: string;
  row_num: number;
}
```

Its stable external rendering is:

```text
<source_id>:<source_markdown_slug>#<row_num>
```

This coordinate survives database rebuild because the fence row number is append-only and canonical. Runtime database fact IDs must not be exposed as durable memory IDs.

### 6.4 Context bundle

```ts
interface LearningContextBundleV1 {
  schema_version: 1;
  session_id: string;
  generated_at: string;
  request_hash: string;
  max_items: 5;
  max_tokens: 800;
  items: Array<{
    pointer: MemoryPointerV1;
    statement: string;
    type: 'constraint' | 'preference' | 'goal' | 'lesson' | 'open_loop';
    scope: 'global' | 'repository' | 'project';
    rationale: string;
    authority: 'user_correction' | 'user_statement' | 'verified_outcome' | 'repeated_pattern';
  }>;
}
```

The agent receives readable statements and provenance labels. Internal pointer metadata is retained for outcome linkage but need not be shown in the prompt.

### 6.5 Session outcome

```ts
interface SessionOutcomeV1 {
  schema_version: 1;
  provider_session_id: string;
  observed_at: string;
  supplied: MemoryPointerV1[];
  evidence: Array<{
    pointer?: MemoryPointerV1;
    kind:
      | 'applied'
      | 'user_repeated_known_instruction'
      | 'agent_reasked_known_answer'
      | 'user_correction'
      | 'contradicted'
      | 'irrelevant'
      | 'task_success'
      | 'task_failure';
    strength: 'objective' | 'explicit_user' | 'agent_report';
    reference: string;
  }>;
}
```

`agent_report` may supplement evidence but cannot, by itself, establish a beneficial use or override a user correction.

## 7. Local event ledger

V1 should use one append-only, versioned local event stream rather than separate counters and mutable receipts:

```text
$GBRAIN_HOME/learning-loop/events-v1.jsonl
```

Allowed event types:

- `canary_armed`
- `session_completed`
- `session_rejected`
- `observation_recorded`
- `memory_activated`
- `memory_superseded`
- `context_supplied`
- `session_outcome`
- `canary_finalized`
- `diagnostic`

Requirements:

1. Every line carries `schema_version`, timestamp, event ID, and relevant session ID.
2. Writes use the same bounded, append-only, malformed-line-tolerant posture as the friction ledger.
3. Canary state is reduced from events; no mutable integer is the sole source of truth.
4. Finalization is idempotent. Once `canary_finalized` exists, later close hooks cannot increment or refinalize the canary.
5. The ledger stores hashes and local references rather than duplicating full transcripts.
6. No raw conversation text is written into telemetry fields unless it has passed the existing local privacy/redaction boundary.
7. The terminal evidence packet can be derived from the event stream without Sawyer reviewing the stream.

Candidate observations can remain ledger-only because they are not active personal truth. Once an observation earns activation, its durable form must be reconciled into canonical private Markdown.

## 8. Distillation and authority

### 8.1 Learnable classes

V1 may learn:

- **constraint** — a hard way agents should or should not operate;
- **preference** — a durable user preference;
- **goal** — a current objective with an explicit completion/expiry condition when possible;
- **lesson** — an approach proven to work or fail;
- **friction** — a repeated supervision problem that may later become a lesson;
- **open loop** — unfinished work only when it has a machine-observable completion trigger;
- **business candidate** — a quarantined observation that may be relevant to Seascape but cannot enter the personal writer path as business truth.

### 8.2 Activation rules

| Evidence | Activation treatment |
|---|---|
| Direct user correction | Activate immediately and supersede the conflicting row |
| Explicit durable user preference | May activate immediately |
| Explicit current goal | May activate immediately; require status/trigger metadata when practical |
| Verified operational outcome | May activate or strengthen a lesson |
| Same friction in two independent eligible sessions | May activate a scoped workflow lesson |
| Same self-improvement opportunity in three independent eligible sessions | Remains a future skill/config candidate; V1 does not edit anything |
| Single agent inference | Candidate only; never retrieved as truth |
| External research | Out of V1 |
| Seascape business claim | Quarantine or existing candidate-only writeback evaluation |

A session is independent for threshold purposes only when it has a distinct provider session ID and is not a retry/replay of the same content hash.

### 8.3 Canonical placement

V1 writes active personal learning to a configured user-owned personal source and operating-model page. It must not create a new brain merely to separate topics owned by the same user. The exact source and slug are configuration, not hard-coded repository assumptions.

All activated rows are private. Existing fact kinds are reused:

- preference → `preference`;
- goal/open loop → `commitment` when it represents a current commitment;
- constraint/lesson → `belief` or `fact`, with the learning class and scope represented in deterministic context metadata;
- correction → a new active row plus canonical strikethrough/supersession of the old row.

Do not widen the fact-fence schema solely for V1. Use the existing source, context, visibility, notability, validity, and supersession fields. The implementation must define a deterministic, parseable context convention and preserve hand-edited unrelated rows.

### 8.4 Correction algorithm

A direct correction must:

1. identify the active conflicting canonical row;
2. append a corrected canonical row;
3. strike the old row and add `superseded by #N` context through the existing renderer;
4. reconcile the derived fact index;
5. append `memory_superseded` with old and new memory pointers;
6. prevent the old pointer from being selected immediately;
7. pass a rebuild regression proving the old belief remains inactive.

Appending a second contradictory active row is a failure.

## 9. Retrieval and injection

### 9.1 Selection flow

```text
current request + repo/project scope
        ↓
precision-biased page discovery
        ↓
active private fact selection
        ↓
authority, scope, freshness, and correction filters
        ↓
rank and cap
        ↓
context bundle + context_supplied event
```

Use the existing volunteer/retrieval machinery for page discovery where applicable. V1 adds learned-fact selection and stable pointer capture; it does not fork general search.

### 9.2 Ranking order

1. Directly applicable hard constraints.
2. Directly applicable explicit current goals.
3. Proven repository/project lessons.
4. Relevant durable preferences.
5. At most one machine-owned open loop.

Within a class, prefer direct user authority, narrower scope, recent confirmed use, and lower correction/irrelevance history.

### 9.3 Exclusions

Never inject:

- inactive, forgotten, or superseded rows;
- candidate-only inferences;
- stale pull-request state;
- completed or triggerless open work;
- unrelated Seascape business details;
- generic motivational summaries;
- raw transcripts;
- an item merely because it is recent;
- more than five items or more than 800 estimated tokens.

### 9.4 Injection ledger

A `context_supplied` event must be appended before the agent begins substantive work and must include:

- provider session ID;
- request hash;
- each exact memory pointer;
- rank/rationale;
- bundle token estimate;
- configuration mode.

Current page-level approximate usage telemetry is useful but insufficient. Canary scoring must use this exact session-to-pointer ledger.

## 10. Outcome measurement

The loop measures behavior, not memory volume.

### 10.1 Strong evidence

Strong evidence includes:

- an explicit user correction;
- the user repeating an instruction already supplied in the same context bundle;
- the agent asking for information contained in a supplied active memory;
- objective test/build/review/merge/deploy evidence supplied by the adapter;
- a known recurrent failure being avoided in a successful comparable task;
- a machine-owned completion trigger firing;
- a supplied item demonstrably causing the wrong action.

### 10.2 Weak evidence

Weak evidence includes an agent claiming that context was useful. It may be stored as `agent_report` but does not count alone toward the three beneficial-use threshold.

### 10.3 Memory feedback

Outcome processing may:

- increase evidence for a useful active row;
- mark a supplied row irrelevant for that scope;
- narrow its scope;
- supersede it after a direct correction;
- leave it unchanged when evidence is ambiguous.

V1 must not automatically delete an active canonical belief based only on non-use.

## 11. Canary state machine

```text
off ──explicit arm──> armed ──first eligible completion──> running
                                              │
                                              └──10th eligible completion──> terminal
```

The single configuration key is:

```text
learning_loop.mode = off | capture | canary
```

- `off`: no Learning Loop capture or injection;
- `capture`: capture/distill/outcome evidence, but inject nothing and advance no canary;
- `canary`: capture, inject, measure, and count eligible Codex sessions.

Changing `canary` to `capture` is the injection kill switch and preserves evidence. Changing to `off` disables the entire V1 path. The default is `off`; repository merge does not activate it.

### 11.1 Arming

Arming appends `canary_armed` with:

- contract version;
- activation timestamp;
- provider allow-list (`codex` only);
- target session count (`10`);
- thresholds;
- configured personal source/slug;
- current GBrain version;
- optional automatic baseline references.

If enough prior local transcripts exist, arming automatically freezes up to ten prior eligible sessions as comparison evidence. Missing baseline data cannot produce `broaden`; it does not block safe `keep` or `repair`.

### 11.2 Counting

- Only `eligible=true` Codex completions after `canary_armed` count.
- The idempotency tuple prevents duplicate hook delivery from advancing the count.
- Unsupported providers are captured only as rejected evidence and do not count.
- Session ten triggers one atomic/fail-closed finalization reduction.
- Once terminal, later sessions do not alter the verdict.

### 11.3 Hard failure conditions

Any of these forces `repair`:

- a processed corrected belief is supplied again;
- an unsupported high-impact belief causes an action;
- a Seascape canon or external write occurs through V1;
- duplicate completion advances the counter;
- the canary requires Sawyer to remember or manually advance it;
- injection materially blocks ordinary Codex work;
- finalization is non-deterministic or occurs more than once.

### 11.4 Verdict algorithm

**Broaden** only when:

- every hard gate passes;
- at least three beneficial uses have strong traceable evidence;
- no more than two materially irrelevant injections occur;
- direct correction propagation passes;
- repeated-question/instruction evidence improves against the frozen baseline when available;
- no recurring maintenance task is assigned to Sawyer.

The only V1-authorized broadening is adding a Claude adapter to the same contracts.

**Keep** when every hard gate passes and the system is low-maintenance, but the evidence is not sufficient for `broaden`.

**Repair** when a hard condition fails or capture, relevance, correction, or measurement is not trustworthy. The verdict must name exactly one smallest failing component to repair before rerunning a bounded session-count canary.

## 12. Privacy and security

1. Raw transcript access remains local-only.
2. Transcript paths are resolved under configured corpus roots; reject traversal and unowned roots.
3. No raw transcript is exposed through remote MCP.
4. Any model-assisted distillation routes through the existing AI gateway and privacy/provider-submission controls.
5. Private active facts use `visibility=private`.
6. Operational events store hashes, pointers, classifications, and bounded references rather than conversation bodies.
7. Existing self-consumption guards remain in force.
8. Generated Learning Loop output must not be rediscovered as a new raw session.
9. Seascape writeback continues to fail closed on ambiguous ownership and proof.

## 13. Delivery sequence

Only one implementation PR may be actively mutated at a time.

### PR 0 — this contract

- Freeze architecture, invariants, contracts, state machine, acceptance gates, and delivery order.
- Runtime behavior remains unchanged.
- No config is changed.

### PR 1 — event contract, eligibility, and idempotent capture

Owned by GBrain.

- Add pure event/types modules.
- Add append-only ledger writer/reader/reducer with hermetic tests.
- Add deterministic session eligibility.
- Reuse transcript discovery/parser.
- Add local-only operation/CLI seam for completed session capture.
- Add `learning_loop.mode` resolver, default `off`.
- Do not distill or inject.

### PR 2 — canonical activation and correction

Owned by GBrain.

- Add observation classification and activation thresholds.
- Reuse facts classifier and fence renderer.
- Add deterministic context metadata convention.
- Add direct-correction canonical supersession.
- Prove rebuild durability.
- Preserve Seascape boundary.
- Do not inject.

### PR 3 — context bundle and exact injection telemetry

Owned by GBrain.

- Reuse volunteer/retrieval discovery.
- Select active fact rows by authority/scope/relevance.
- Enforce five-item/800-token caps.
- Append exact pointer ledger.
- Expose one provider-neutral local operation for clients.
- Fail open to an empty bundle.

### PR 4 — thin Codex adapter

Owned by the repository that already controls the active Codex close/bootstrap hooks. Do not install equivalent hooks in both `agent-config` and `codex-config`.

- On bootstrap, request one Learning Context Bundle and inject its readable statements.
- On close, submit one Completed Session envelope and objective evidence available locally.
- Deliver retries safely using the idempotency tuple.
- No memory logic lives in the adapter.
- No live activation in the PR.

### PR 5 — outcome reducer and canary finalization

Owned by GBrain.

- Link supplied pointers to corrections, repetition, relevance, and objective outcomes.
- Add automatic baseline comparison when available.
- Implement the ten-session reducer and deterministic verdict.
- Render one plain-English terminal result.

### PR 6 — successful-canary cleanup only

Created only after a `keep` or `broaden` result.

- Remove displaced manual personal-memory promotion.
- Remove session summaries that no runtime consumer uses.
- Remove reminder-based canary tracking.
- Remove duplicate context bootstrap paths.
- Do not add Claude, research, skills, or business automation in the cleanup PR.

## 14. Test matrix

Every implementation PR must run the repository's normal proof and required exact-head review. At minimum V1 needs hermetic tests for:

### Capture and state

- duplicate close event is idempotent;
- same session ID with a different content hash fails closed as a diagnostic conflict;
- interrupted, abandoned, empty, and lookup-only sessions do not count;
- eligible session ten finalizes exactly once;
- terminal canary ignores later completion events;
- malformed event lines are skipped and reported without corrupting valid state;
- `off`, `capture`, and `canary` modes behave distinctly.

### Canonical memory

- direct user preference can activate;
- single agent inference remains candidate-only;
- repeated friction activates only at threshold;
- correction creates a new row and supersedes the old row;
- old row remains inactive after full rebuild;
- unrelated fact-fence rows round-trip unchanged;
- all activated Learning Loop facts are private;
- Seascape business candidate cannot enter the personal canonical writer path.

### Retrieval

- inactive/superseded/forgotten rows are excluded;
- authority and narrow scope outrank recency;
- resolved open work is excluded;
- at most one open loop is selected;
- item and token caps are deterministic;
- exact pointers in the bundle match the `context_supplied` event;
- retrieval failure returns an empty bundle without blocking the caller.

### Outcome and verdict

- agent self-report alone cannot count as a beneficial use;
- direct correction forces the old pointer out of later bundles;
- re-asking a known answer is linked to the supplied pointer;
- irrelevant injection is counted once per session/pointer;
- every hard failure deterministically returns `repair`;
- `broaden` is impossible without three strong beneficial uses;
- missing baseline prevents `broaden` but does not force `repair`;
- final terminal rendering names evidence and one next action without exposing the internal ledger.

## 15. Activation and rollback

Merging implementation code does not activate V1.

Activation requires a separate explicit local action after all implementation PRs are merged and exact-head proof is green:

1. configure the existing user-owned personal source and operating-model slug;
2. set `learning_loop.mode=capture` for a bounded smoke check;
3. verify one completion is captured and no context is injected;
4. explicitly set `learning_loop.mode=canary` to arm the ten-session run.

Rollback is immediate:

- set mode to `capture` to stop injection while preserving evidence;
- set mode to `off` to stop the full path;
- rebuild the derived fact index from canonical Markdown if needed;
- leave Seascape untouched because V1 has no Seascape writer.

## 16. Long-term expansion order

No expansion begins before the V1 verdict.

1. **Claude adapter** using the same envelope, pointers, context bundle, and outcome contract.
2. **Research ingestion** as sourced, freshness-bounded hypotheses, not personal or business fact promotion.
3. **General machine-owned experiment triggers** based on event counts and observable completion.
4. **One-at-a-time skill/config proposals** only after three independent recurrence events or one severe verified failure; automatic editing remains a separately proven authority boundary.
5. **Seascape proposal bridge** through existing evidence and ownership checks, never direct personal-loop canon promotion.

## 17. Explicit non-goals

V1 does not create:

- a standalone memory product;
- a new repository or database;
- an AI employee organization chart;
- a Sawyer Hub runtime dependency;
- a dashboard or queue;
- a second transcript corpus;
- a generic knowledge graph rewrite;
- automatic Claude or ChatGPT ingestion;
- automatic research promotion;
- automatic skill/config changes;
- automatic PR creation, merge, deploy, install, send, or external mutation;
- automatic Seascape canon changes;
- a requirement for Sawyer to inspect Markdown, receipts, or telemetry.

## 18. Implementation handoff

After this contract lands, the next agent should execute only PR 1.

```text
Implement Sawyer Learning Loop V1 PR 1 in uncfreak1255-code/gbrain from the
exact merged version of docs/architecture/sawyer-learning-loop-v1.md.

Scope only:
- provider-neutral event types;
- append-only local events-v1.jsonl writer/reader/reducer;
- deterministic CompletedSession eligibility;
- idempotent capture keyed by provider + provider_session_id + content_hash;
- learning_loop.mode resolver with default off;
- one trusted-local operation/CLI seam;
- hermetic tests and repository proof.

Reuse transcript discovery and the operation layer. Do not implement
canonical distillation, context injection, Codex hooks, outcome scoring,
Claude ingestion, skills, research, Sawyer Hub changes, Seascape writes,
activation, scheduling, merge, or deployment. Do not create a second memory
store. Report the exact head SHA, proof, remaining review blocker, and one
next action.
```

The implementation must remain smaller than the system it replaces. When a proposed component duplicates an existing GBrain primitive, reuse or extend the primitive instead of adding a parallel layer.