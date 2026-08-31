# Sawyer Learning Loop V1 — Codex ten-session closed-loop canary

**Status:** implementation contract; no runtime behavior is enabled by this document  
**Owner:** GBrain core, with one thin Codex adapter in the existing repository that owns active Codex session hooks  
**Decision:** integrate existing GBrain primitives; do not build a parallel memory product

## 1. Executive decision

The Sawyer Learning Loop closes one narrow loop:

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

V1 runs for **ten eligible Codex sessions** and finalizes itself with one verdict:

- **keep** — safe and useful, but not yet proven enough to broaden;
- **repair** — one bounded component must be corrected before further use;
- **broaden** — reliable enough to add Claude ingestion through the same provider-neutral contract.

The user must not maintain a Markdown promotion flow, remember an end date, inspect a queue, advance a counter, or revisit the experiment manually.

V1 is the single active personal-agent self-improvement initiative. It does not include research ingestion, automatic skill edits, Seascape canon promotion, deployment, scheduling, or live activation.

## 2. Definition of done

V1 is complete only when all of the following are true:

1. Ten eligible Codex sessions are counted automatically and exactly once.
2. Each eligible completion is captured without blocking normal Codex work.
3. Qualified direct preferences, goals, corrections, proven lessons, and repeated friction can update private canonical GBrain knowledge.
4. Single-session agent inference cannot silently become an active belief.
5. A processed direct correction supersedes the conflicting belief in canonical Markdown and survives rebuild.
6. A later session receives at most five relevant learned items under an 800-token budget.
7. Every supplied memory is identified by a **brain-qualified rebuild-stable pointer**.
8. Outcomes and later corrections are linked to those exact pointers.
9. The canary finalizes itself once and emits `keep`, `repair`, or `broaden` with traceable evidence.
10. Injection can be disabled independently of capture.
11. Nothing writes Seascape canon or performs an external action.
12. Sawyer performs no recurring maintenance action to keep the loop running.

Storage, extraction, or a generated summary alone does not satisfy this definition.

## 3. Non-negotiable invariants

### 3.1 Filesystem-canonical personal knowledge

Durable personal knowledge follows the existing GBrain system-of-record contract:

- canonical personal beliefs live in Markdown under a user-owned GBrain source;
- fact fences are the durable representation;
- database fact rows are rebuildable indexes;
- database-only memory is not authoritative;
- corrections must survive rebuild by changing the canonical fence.

V1 does not introduce a new authoritative memory database.

### 3.2 Brain identity is part of memory identity

GBrain has two independent routing axes: **brain** and **source**. `source_id`, slug, and row number identify a fact only inside one brain.

Therefore every durable personal-memory pointer and configured canonical destination must include the resolved brain identity. Learning Loop operations must route explicitly to that brain and must never inherit an unrelated `.gbrain-mount`, `GBRAIN_BRAIN_ID`, working-directory mount, or other ambient checkout routing.

This prevents a later Codex session running from a team/mounted checkout from resolving or mutating the same source/slug coordinates in the wrong database.

### 3.3 Operational evidence is not personal truth

Session, injection, outcome, and canary events are operational evidence. They may live in one append-only local JSONL ledger under `$GBRAIN_HOME`. The ledger may nominate or support a canonical belief, but it is not the active personal operating model.

### 3.4 Personal and Seascape authority remain separate

- Personal operating preferences and cross-vendor lessons belong to the configured personal brain/source.
- Seascape business claims remain controlled business knowledge.
- A personal session may produce an existing candidate-only Seascape writeback evaluation.
- V1 cannot promote, rewrite, merge, deploy, send, or otherwise mutate Seascape canon or an external system.

### 3.5 Clients remain thin

Provider-specific clients submit normalized events and request context through the GBrain operation layer. They do not own distillation, thresholds, memory selection, correction semantics, routing policy, or canary scoring.

### 3.6 Fail open for work, fail closed for learning

Capture, retrieval, telemetry, and canary-accounting failures must never prevent ordinary Codex work. Failure returns no injected context and records a local diagnostic when possible.

Uncertain learning remains inactive. A routing ambiguity, session-identity conflict, or contradictory observation must not silently become truth.

### 3.7 No supervision layer

V1 creates no dashboard, work queue, standing approval step, agent hierarchy, notification channel, or receipt-review obligation. The terminal user surface is one plain-English conclusion with enough evidence to trust it.

## 4. Existing GBrain primitives to reuse

| Need | Existing seam | V1 treatment |
|---|---|---|
| Transcript enumeration/hashing | `src/core/cycle/transcript-discovery.ts` | Reuse; no second corpus walker |
| Recent local transcripts | `src/core/transcripts.ts` | Reuse local-only boundary |
| Conversation parsing | `src/core/conversation-parser/*` | Reuse |
| Durable facts | fact fences + `src/core/cycle/extract-facts.ts` | Keep Markdown canonical |
| Duplicate/supersede classification | `src/core/facts/classify.ts` | Supporting evidence only; user correction outranks it |
| Durable correction | `src/core/facts/forget.ts` + fence renderer | Reuse fence-rewrite semantics |
| Brain/source routing | existing brain + source resolver | Resolve once, persist brain identity, then route explicitly |
| Proactive context discovery | `src/core/context/volunteer.ts` | Reuse precision-biased discovery |
| Context telemetry | `src/core/context/volunteer-events.ts` | Reuse/compose; add exact memory-pointer linkage |
| Friction evidence | `src/core/friction.ts` | Evidence source, not truth |
| Search telemetry | `src/core/eval-capture.ts` | Reuse privacy/operation-layer precedent |
| Seascape boundary | `src/core/writeback-candidate.ts` | Preserve candidate-only / `writes:false` |
| Kill switch | config-backed feature-flag pattern | One central Learning Loop mode resolver |
| Skill optimization | `src/core/skillopt/*`, `src/core/skillify/*` | Explicitly out of V1 |

## 5. Provider-neutral contracts

### 5.1 Completed session envelope

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

### 5.2 Session uniqueness and replay handling

The uniqueness boundary is **`(provider, provider_session_id)`**.

On capture:

1. If no prior completion exists for that pair, accept the event and persist its `content_hash`.
2. If the pair already exists with the **same** `content_hash`, treat delivery as an idempotent retry. Append no second `session_completed` event and do not advance the canary.
3. If the pair already exists with a **different** `content_hash`, fail closed for learning: append a diagnostic conflict, append no second completion, perform no distillation/injection accounting from the conflicting delivery, and do not advance the canary.

A changing transcript cannot turn one provider session into two eligible sessions.

Raw transcript paths are accepted only from trusted local callers. Remote MCP callers cannot use a path parameter to read arbitrary local files.

### 5.3 Session eligibility

```ts
interface SessionEligibilityV1 {
  eligible: boolean;
  reason:
    | 'eligible'
    | 'not_completed'
    | 'duplicate'
    | 'session_identity_conflict'
    | 'empty_or_too_short'
    | 'no_material_decision_or_outcome'
    | 'unsupported_provider'
    | 'canary_already_terminal';
  signals: string[];
}
```

Eligibility is deterministic and pure after uniqueness has been established. A completed session qualifies when it contains at least one material signal:

- substantive implementation or repair outcome;
- pull-request or code-review disposition;
- explicit user correction;
- meaningful strategy decision;
- repeated operating friction;
- reusable lesson backed by objective evidence;
- a machine-owned open loop with a real completion trigger.

Simple lookups, empty starts, login-only failures, abandoned sessions, generated housekeeping, duplicate deliveries, and session-identity conflicts do not count.

### 5.4 Canonical personal destination

```ts
interface PersonalMemoryDestinationV1 {
  brain_id: string;
  source_id: string;
  operating_model_slug: string;
}
```

Arming resolves and freezes this destination. Every later activation, correction, retrieval, rebuild check, and outcome operation must route explicitly to `brain_id` and `source_id` from the frozen destination.

### 5.5 Canonical memory pointer

```ts
interface MemoryPointerV1 {
  brain_id: string;
  source_id: string;
  source_markdown_slug: string;
  row_num: number;
}
```

Stable rendering:

```text
<brain_id>:<source_id>:<source_markdown_slug>#<row_num>
```

The brain/source/page/row coordinate is rebuild-stable. Runtime database fact IDs must not be exposed as durable memory IDs.

### 5.6 Context bundle

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

The agent receives readable statements. Exact brain-qualified pointers are retained for outcome linkage and explicit routing.

### 5.7 Session outcome

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

`agent_report` may supplement evidence but cannot establish a beneficial use or override a user correction by itself.

## 6. Local event ledger

V1 uses one append-only versioned local event stream:

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

1. Every line carries `schema_version`, timestamp, event ID, and relevant provider session ID.
2. Writes are append-only and malformed-line tolerant like the friction ledger.
3. Canary state is reduced from events; no mutable integer is the sole source of truth.
4. The reducer enforces uniqueness by `(provider, provider_session_id)` before counting or distillation.
5. Same-hash replay is idempotent; different-hash replay is a diagnostic conflict.
6. Finalization is idempotent. Once `canary_finalized` exists, later events cannot refinalize it.
7. The ledger stores hashes, brain-qualified pointers, classifications, and bounded references rather than duplicating full transcripts.
8. Candidate observations may remain ledger-only because they are not active truth.

## 7. Distillation and authority

V1 may learn:

- **constraint** — a hard way agents should or should not operate;
- **preference** — a durable user preference;
- **goal** — a current objective with a completion/expiry condition when practical;
- **lesson** — an approach proven to work or fail;
- **friction** — a repeated supervision problem that may later become a lesson;
- **open loop** — unfinished work only when it has a machine-observable completion trigger;
- **business candidate** — quarantined observation relevant to Seascape but not business truth.

Activation rules:

| Evidence | Treatment |
|---|---|
| Direct user correction | Activate immediately and supersede conflict |
| Explicit durable user preference | May activate immediately |
| Explicit current goal | May activate immediately |
| Verified operational outcome | May activate/strengthen a lesson |
| Same friction in two independent eligible sessions | May activate scoped lesson |
| Same self-improvement opportunity in three independent sessions | Future candidate only; V1 edits nothing |
| Single agent inference | Candidate only |
| External research | Out of V1 |
| Seascape business claim | Quarantine / existing candidate-only boundary |

A session is independent only when its `(provider, provider_session_id)` differs from all earlier counted sessions. Content hashes help detect replay and corruption; they do not create a second session identity.

### Canonical placement

V1 writes active personal learning only to the frozen `PersonalMemoryDestinationV1`. Ambient brain/source resolution may be used during explicit arming to choose the destination, but after arming all operations route by the frozen `brain_id` and `source_id`.

All activated rows are private. Existing fact kinds and fence schema are reused; do not widen the fact fence solely for V1.

### Correction algorithm

A direct correction must:

1. route explicitly to the pointer's `brain_id` and `source_id`;
2. identify the active conflicting canonical row;
3. append the corrected row;
4. strike the old row and add `superseded by #N` through the existing renderer;
5. reconcile the derived fact index in that same brain/source;
6. append `memory_superseded` with old and new brain-qualified pointers;
7. prevent the old pointer from selection immediately;
8. pass a rebuild regression proving the old belief remains inactive.

Appending a second contradictory active row is a failure.

## 8. Retrieval and injection

Selection order:

1. Directly applicable hard constraints.
2. Directly applicable explicit current goals.
3. Proven repository/project lessons.
4. Relevant durable preferences.
5. At most one machine-owned open loop.

Never inject inactive, forgotten, superseded, candidate-only, stale PR, completed/triggerless, unrelated business, raw transcript, or merely recent items.

Every retrieval starts from the frozen personal destination and routes explicitly to its `brain_id`. A current checkout's mounted brain must not change the lookup target.

A `context_supplied` event is appended before substantive agent work and contains provider session ID, request hash, exact brain-qualified pointers, ranking rationale, token estimate, and mode.

## 9. Outcome measurement

Strong evidence includes:

- explicit user correction;
- user repeating an instruction already supplied in the bundle;
- agent asking for information contained in a supplied memory;
- objective test/build/review/merge/deploy evidence;
- a known recurrent failure being avoided in a comparable successful task;
- a machine-owned completion trigger firing;
- a supplied item demonstrably causing a wrong action.

Agent self-report is weak evidence only.

Outcome processing must use the `brain_id` carried by each supplied pointer. It may strengthen, narrow, supersede, or mark an item irrelevant for a scope, but must not delete an active canonical belief merely because it was unused.

## 10. Canary state machine

```text
off ──explicit arm──> armed ──first eligible completion──> running
                                              │
                                              └──10th eligible completion──> terminal
```

Configuration:

```text
learning_loop.mode = off | capture | canary
```

- `off`: no Learning Loop capture or injection;
- `capture`: capture/distill/outcome evidence; inject nothing; advance no canary;
- `canary`: capture, inject, measure, and count eligible Codex sessions.

Default is `off`. Repository merge does not activate V1.

### Arming

`canary_armed` freezes:

- contract version;
- activation timestamp;
- provider allow-list (`codex` only);
- target count (`10`);
- thresholds;
- full `PersonalMemoryDestinationV1` including `brain_id`;
- current GBrain version;
- optional automatic baseline references.

If enough prior transcripts exist, arming may freeze up to ten prior eligible sessions as comparison evidence. Missing baseline data prevents `broaden` but does not force `repair`.

### Counting

- Only unique `eligible=true` Codex completions after `canary_armed` count.
- `(provider, provider_session_id)` is the uniqueness boundary.
- Same-hash duplicate delivery is ignored for counting.
- Different-hash delivery for an existing session ID is diagnostic conflict and never counts.
- Unsupported providers do not count.
- Session ten triggers one fail-closed finalization reduction.
- Once terminal, later sessions do not alter the verdict.

### Hard failure conditions

Any of these forces `repair`:

- a processed corrected belief is supplied again;
- a memory operation resolves against a different brain than its frozen destination/pointer;
- an unsupported high-impact belief causes an action;
- a Seascape canon or external write occurs through V1;
- duplicate/conflicting completion advances the counter;
- the canary requires Sawyer to remember or manually advance it;
- injection materially blocks ordinary Codex work;
- finalization is non-deterministic or occurs more than once.

### Verdict

**Broaden** only when all hard gates pass, at least three beneficial uses have strong traceable evidence, no more than two materially irrelevant injections occur, direct correction propagation passes, baseline comparison improves when available, and no recurring maintenance is assigned to Sawyer.

The only V1-authorized broadening is adding a Claude adapter to these same contracts.

**Keep** when hard gates pass and the system is low-maintenance but evidence is insufficient for `broaden`.

**Repair** when capture, identity/routing, relevance, correction, or measurement is not trustworthy. Name exactly one smallest component to repair before rerunning a bounded canary.

## 11. Privacy and security

1. Raw transcript access remains local-only.
2. Transcript paths resolve only under configured corpus roots.
3. No raw transcript is exposed through remote MCP.
4. Model-assisted distillation uses existing AI-gateway privacy/provider controls.
5. Active Learning Loop facts are `visibility=private`.
6. Operational events store hashes, brain-qualified pointers, classifications, and bounded references rather than conversation bodies.
7. Existing self-consumption guards remain in force.
8. Generated Learning Loop output must not be rediscovered as a new raw session.
9. Seascape writeback remains fail-closed on ambiguous ownership/proof.

## 12. Delivery sequence

Only one implementation PR may be actively mutated at a time.

### PR 0 — this contract

Freeze architecture, identity/routing, replay semantics, state machine, gates, and delivery order. Runtime behavior remains unchanged.

### PR 1 — event contract, eligibility, idempotent capture

Owned by GBrain.

- Add provider-neutral event/types modules.
- Add append-only ledger writer/reader/reducer with hermetic tests.
- Enforce `(provider, provider_session_id)` uniqueness.
- Same hash = idempotent retry; different hash = diagnostic conflict.
- Add deterministic session eligibility.
- Reuse transcript discovery/parser.
- Add local-only completed-session operation/CLI seam.
- Add `learning_loop.mode` resolver, default `off`.
- Define/persist brain-qualified personal destination and pointer types needed by later PRs; do not retrieve or write memories yet.
- Do not distill or inject.

### PR 2 — canonical activation and correction

- Add observation classification and activation thresholds.
- Route all writes explicitly to frozen `brain_id` + `source_id`.
- Reuse facts classifier and fence renderer.
- Add direct-correction supersession and rebuild proof.
- Preserve Seascape boundary.
- Do not inject.

### PR 3 — context bundle and exact injection telemetry

- Reuse volunteer/retrieval discovery.
- Start from frozen personal `brain_id` + `source_id`.
- Select active facts by authority/scope/relevance.
- Enforce five-item/800-token caps.
- Append exact brain-qualified pointer ledger.
- Expose one provider-neutral local operation.
- Fail open to an empty bundle.

### PR 4 — thin Codex adapter

Owned by the repository that already controls active Codex close/bootstrap hooks. Do not install equivalent hooks in both `agent-config` and `codex-config`.

- Bootstrap requests one Learning Context Bundle.
- Close submits one Completed Session envelope and local objective evidence.
- Retries preserve provider session ID.
- Adapter does not own memory/routing logic.
- No live activation in the PR.

### PR 5 — outcome reducer and finalization

- Link exact supplied pointers to corrections, repetition, relevance, and objective outcomes.
- Route feedback by pointer `brain_id`.
- Add baseline comparison when available.
- Implement deterministic ten-session verdict and plain-English result.

### PR 6 — successful-canary cleanup only

Created only after `keep` or `broaden`.

- Remove displaced manual personal-memory promotion.
- Remove session summaries no runtime consumer uses.
- Remove reminder-based canary tracking.
- Remove duplicate context bootstrap paths.
- Do not add Claude, research, skills, or business automation here.

## 13. Minimum test matrix

### Capture and state

- same `(provider, provider_session_id, content_hash)` retry is idempotent;
- same `(provider, provider_session_id)` with different hash fails closed as diagnostic conflict;
- neither replay case advances the canary twice;
- interrupted, abandoned, empty, and lookup-only sessions do not count;
- eligible session ten finalizes exactly once;
- terminal canary ignores later completions;
- malformed event lines do not corrupt valid state;
- `off`, `capture`, and `canary` differ as specified.

### Brain routing and canonical memory

- personal destination freezes a concrete `brain_id` + `source_id`;
- memory pointer includes `brain_id`;
- retrieval from a checkout pinned to a different `.gbrain-mount` still routes to the pointer/destination brain;
- correction against a pointer cannot mutate the same coordinates in another brain;
- unknown/unavailable brain fails closed for learning and fails open for ordinary agent work;
- direct preference can activate;
- single agent inference remains candidate-only;
- repeated friction activates only at threshold;
- correction supersedes old row and survives rebuild;
- unrelated fact-fence rows round-trip unchanged;
- all active Learning Loop facts are private;
- Seascape business candidate cannot enter the personal writer path.

### Retrieval

- inactive/superseded/forgotten rows are excluded;
- authority and narrow scope outrank recency;
- resolved open work is excluded;
- at most one open loop is selected;
- item/token caps are deterministic;
- bundle pointers exactly match `context_supplied`;
- retrieval failure returns empty bundle without blocking caller.

### Outcome and verdict

- agent self-report alone cannot count as beneficial use;
- correction forces old pointer out of later bundles;
- outcome routing uses pointer `brain_id`, not ambient mount;
- re-asking known answer links to supplied pointer;
- irrelevant injection counts once per session/pointer;
- hard failures deterministically return `repair`;
- `broaden` requires three strong beneficial uses;
- missing baseline prevents `broaden` but not `keep`;
- terminal rendering names evidence and one next action without exposing the ledger.

## 14. Activation and rollback

Merging implementation code does not activate V1.

Activation is a separate explicit local action after implementation PRs are merged and exact-head proof is green:

1. resolve and configure the existing user-owned personal `brain_id`, `source_id`, and operating-model slug;
2. set `learning_loop.mode=capture` for one bounded smoke check;
3. verify one completion is captured and no context is injected;
4. explicitly set `learning_loop.mode=canary` to arm the ten-session run.

Rollback:

- `canary → capture` stops injection while preserving evidence;
- `→ off` stops the full path;
- rebuild derived indexes from canonical Markdown if needed;
- Seascape remains untouched because V1 has no Seascape writer.

## 15. Long-term expansion order

No expansion before the V1 verdict:

1. Claude adapter using the same contracts.
2. Research ingestion as sourced, freshness-bounded hypotheses.
3. General machine-owned experiment completion triggers.
4. One-at-a-time skill/config proposals after repeated or severe verified evidence.
5. Seascape proposal bridge through existing evidence/ownership checks, never direct personal-loop canon promotion.

## 16. Explicit non-goals

V1 does not create a standalone memory product, new repository/database, AI employee org chart, Sawyer Hub runtime dependency, dashboard, queue, second transcript corpus, generic knowledge-graph rewrite, automatic Claude/ChatGPT ingestion, automatic research promotion, automatic skill/config changes, automatic PR/merge/deploy/install/send behavior, automatic Seascape canon changes, or a requirement for Sawyer to inspect Markdown/receipts/telemetry.

## 17. PR 1 implementation handoff

After this contract lands, the next agent should execute only PR 1:

```text
Implement Sawyer Learning Loop V1 PR 1 in uncfreak1255-code/gbrain from the
exact merged version of docs/architecture/sawyer-learning-loop-v1.md.

Scope only:
- provider-neutral event and pointer/destination types;
- PersonalMemoryDestinationV1 with explicit brain_id + source_id;
- MemoryPointerV1 with explicit brain_id;
- append-only local events-v1.jsonl writer/reader/reducer;
- deterministic CompletedSession eligibility;
- uniqueness boundary `(provider, provider_session_id)`;
- same-hash retry = idempotent no-op;
- different-hash retry = diagnostic conflict, no second completion/count;
- learning_loop.mode resolver with default off;
- one trusted-local operation/CLI capture seam;
- hermetic tests, including ambient mounted-brain routing regressions;
- repository proof.

Reuse transcript discovery, brain/source routing, and the operation layer.
Do not implement canonical distillation, context injection, Codex hooks,
outcome scoring, Claude ingestion, skills, research, Sawyer Hub changes,
Seascape writes, activation, scheduling, merge, or deployment. Do not create
a second memory store. Report exact head SHA, proof, remaining review blocker,
and one next action.
```

The implementation must remain smaller than the system it replaces. Reuse an existing GBrain primitive whenever one already owns the behavior.