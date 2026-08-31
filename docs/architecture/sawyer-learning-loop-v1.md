# Sawyer Learning Loop V1 — Codex ten-session closed-loop canary

**Status:** implementation contract; no runtime behavior is enabled by this document  
**Owner:** GBrain core, with one thin Codex adapter in the existing repository that owns active Codex session hooks  
**Decision:** integrate existing GBrain primitives; do not build a parallel memory product

## 1. Executive decision

The Sawyer Learning Loop closes one narrow loop:

```text
completed agent session
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

V1 evaluates **ten eligible Codex sessions inside one explicitly armed canary run** and finalizes that run with one verdict:

- **keep** — safe and useful, but not proven enough to broaden;
- **repair** — one bounded component must be corrected before another run starts;
- **broaden** — reliable enough to add Claude ingestion through the same provider-neutral contract.

The user must not maintain a Markdown promotion flow, remember an end date, inspect a queue, advance a counter, or revisit the experiment manually.

V1 is the single active personal-agent self-improvement initiative. It excludes research ingestion, automatic skill edits, Seascape canon promotion, deployment, scheduling, and live activation.

## 2. Definition of done

V1 is complete when:

1. Ten eligible Codex sessions are counted automatically and exactly once within one `run_id`.
2. Each eligible completion is captured without blocking normal Codex work.
3. Direct preferences, goals, corrections, proven lessons, and repeated friction may update private canonical GBrain knowledge.
4. Single-session agent inference cannot silently become active truth.
5. Direct correction supersedes the conflicting canonical row and survives rebuild.
6. A later session receives at most five relevant learned items under an 800-token budget.
7. Every supplied memory uses a brain-qualified rebuild-stable pointer.
8. Outcomes and corrections link to those exact pointers and the active `run_id`.
9. Every canary run freezes all verdict inputs at arming and finalizes exactly once with `keep`, `repair`, or `broaden`.
10. A later bounded rerun can start without deleting prior evidence.
11. Injection can be disabled independently of capture.
12. Nothing writes Seascape canon or performs an external action.
13. Sawyer performs no recurring maintenance action.

Storage or summarization alone does not satisfy V1.

## 3. Core invariants

### 3.1 Filesystem-canonical personal knowledge

Durable personal knowledge follows the existing GBrain system-of-record contract:

- canonical beliefs live in Markdown under a user-owned GBrain source;
- fact fences are durable;
- database fact rows are rebuildable indexes;
- database-only memory is not authoritative;
- corrections change canonical fences and survive rebuild.

No new authoritative memory database is introduced.

### 3.2 Brain identity is part of memory identity

GBrain routes independently by **brain** and **source**. Source ID, slug, and row number are only unique inside a brain.

Every durable personal-memory pointer and configured personal destination therefore includes `brain_id`. After the destination is armed, every Learning Loop activation, retrieval, correction, rebuild check, and outcome operation routes explicitly to that brain and source. Ambient `.gbrain-mount`, `GBRAIN_BRAIN_ID`, cwd-based mount resolution, or another checkout cannot silently redirect the operation.

### 3.3 Canary terminal state is run-scoped

The event ledger is historical and append-only. It may contain multiple canary attempts over time.

Every `canary_armed` creates a unique `run_id`. All run-specific events carry that `run_id`. Counting, hard failures, frozen thresholds, baselines, beneficial-use evidence, and `canary_finalized` are reduced within one run only.

A terminal event from an older run must never block a later explicitly armed rerun. Historical evidence remains preserved; it is not deleted or rewritten to restart the experiment.

Only one run may be `armed` or `running` at a time in V1.

### 3.4 Run inputs are immutable

A verdict must be reproducible from the ledger even if GBrain code or configuration changes during the ten-session run.

At arming, the run freezes:

- contract version;
- GBrain version/commit identity;
- provider allow-list;
- target eligible-session count;
- all verdict thresholds;
- full personal-memory destination;
- baseline reference and baseline metrics, or an explicit `baseline: null` state.

Reducers read these frozen values from `canary_armed`; they never substitute current config or current binary defaults.

### 3.5 Operational evidence is not personal truth

Session, injection, outcome, and canary events are operational evidence in one append-only local ledger. They may nominate or support canonical knowledge, but they are not the active operating model.

### 3.6 Personal and Seascape authority remain separate

- Personal operating knowledge belongs to the configured personal brain/source.
- Seascape business claims remain controlled business knowledge.
- Existing candidate-only Seascape writeback evaluation may surface a candidate.
- V1 cannot promote, rewrite, merge, deploy, send, or otherwise mutate Seascape canon or an external system.

### 3.7 Thin clients; fail open for work, fail closed for learning

Provider clients submit normalized events and request context. They do not own thresholds, routing, correction semantics, or canary scoring.

Capture/retrieval/telemetry failure must not block ordinary work. Routing ambiguity, session-identity conflict, contradictory learning, unavailable canonical brain, or malformed frozen run state fails closed for learning and returns no injected context when appropriate.

### 3.8 No supervision layer

No dashboard, queue, standing approval step, agent hierarchy, notification channel, or receipt-review obligation is created. The user sees one plain-English conclusion and real exceptions.

## 4. Existing GBrain primitives to reuse

| Need | Existing seam | V1 treatment |
|---|---|---|
| Transcript discovery/hashing | `src/core/cycle/transcript-discovery.ts` | Reuse; no second corpus walker |
| Recent local transcripts | `src/core/transcripts.ts` | Reuse local-only boundary |
| Conversation parsing | `src/core/conversation-parser/*` | Reuse |
| Durable facts | fact fences + `src/core/cycle/extract-facts.ts` | Markdown remains canonical |
| Duplicate/supersede classification | `src/core/facts/classify.ts` | Supporting evidence; user correction outranks it |
| Durable correction | `src/core/facts/forget.ts` + fence renderer | Reuse fence rewrite |
| Brain/source routing | existing resolver | Resolve at arming, persist identity, route explicitly thereafter |
| Context discovery | `src/core/context/volunteer.ts` | Reuse precision-biased discovery |
| Context telemetry | `src/core/context/volunteer-events.ts` | Reuse/compose; add exact pointer/run linkage |
| Friction evidence | `src/core/friction.ts` | Evidence, not truth |
| Search telemetry | `src/core/eval-capture.ts` | Reuse privacy/operation-layer precedent |
| Seascape boundary | `src/core/writeback-candidate.ts` | Preserve candidate-only `writes:false` |
| Feature flag | config-backed pattern | One central Learning Loop mode resolver |
| Skill optimization | `src/core/skillopt/*`, `src/core/skillify/*` | Out of V1 |

## 5. Provider-neutral contracts

### 5.1 Provider identity

The schema can represent providers that are allowed in later phases without changing the session/event contract:

```ts
type LearningProviderV1 = 'codex' | 'claude';
```

This is a representational type, not an activation list. V1 canary arming permits only `['codex']`. Claude ingestion remains out of scope until a `broaden` verdict and a later adapter change.

### 5.2 Completed session

```ts
interface CompletedSessionV1 {
  schema_version: 1;
  provider: LearningProviderV1;
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

### 5.3 Session uniqueness and replay

The uniqueness boundary is **`(provider, provider_session_id)`** across the ledger.

1. First completion for the pair: persist it with `content_hash`.
2. Same pair + same hash: idempotent retry; append no second completion and advance no run.
3. Same pair + different hash: diagnostic identity conflict; append no second completion, perform no learning/counting from the conflicting delivery, and advance no run.

A changing transcript cannot turn one provider session into multiple eligible sessions.

### 5.4 Session eligibility

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
    | 'run_already_terminal';
  signals: string[];
}
```

Eligibility runs only after uniqueness is established and the active run's frozen provider allow-list is checked. Material signals include substantive implementation/repair outcome, PR/review disposition, explicit correction, meaningful strategy decision, repeated friction, verified reusable lesson, or a machine-owned open loop with an observable completion trigger.

Simple lookups, empty/login-only/abandoned sessions, generated housekeeping, retries, conflicts, unsupported providers, and terminal-run deliveries do not count.

### 5.5 Personal destination

```ts
interface PersonalMemoryDestinationV1 {
  brain_id: string;
  source_id: string;
  operating_model_slug: string;
}
```

Arming resolves and freezes this destination. Later memory operations never re-resolve the destination from ambient checkout state.

### 5.6 Canonical memory pointer

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

Runtime database fact IDs are not durable memory IDs.

### 5.7 Frozen canary run

```ts
interface CanaryThresholdsV1 {
  min_strong_beneficial_uses: 3;
  max_materially_irrelevant_injections: 2;
  require_correction_propagation: true;
  require_baseline_for_broaden: true;
}

interface CanaryBaselineV1 {
  reference: string;
  eligible_sessions: number;
  repeated_known_instruction_count: number;
  reasked_known_answer_count: number;
  user_correction_count: number;
}

interface CanaryRunV1 {
  run_id: string;
  armed_at: string;
  provider_allowlist: LearningProviderV1[];
  target_eligible_sessions: 10;
  destination: PersonalMemoryDestinationV1;
  contract_version: 1;
  gbrain_version: string;
  thresholds: CanaryThresholdsV1;
  baseline: CanaryBaselineV1 | null;
}
```

V1 arming validates `provider_allowlist` is exactly `['codex']`. `run_id` is generated once at explicit arming and is immutable. `gbrain_version`, thresholds, and baseline are copied into `canary_armed` and are never recomputed from mutable current state.

A baseline may be unavailable. That does not invalidate a safe run, but it **does prevent `broaden`**. A no-baseline run can return `keep` or `repair` only.

### 5.8 Context bundle

```ts
interface LearningContextBundleV1 {
  schema_version: 1;
  run_id: string;
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

### 5.9 Session outcome

```ts
interface SessionOutcomeV1 {
  schema_version: 1;
  run_id: string;
  provider: LearningProviderV1;
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

Agent self-report cannot establish a beneficial use or override a user correction by itself.

## 6. Local event ledger

```text
$GBRAIN_HOME/learning-loop/events-v1.jsonl
```

Event types:

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

Rules:

1. Every line carries schema version, timestamp, event ID, and provider session ID when relevant.
2. Every event from `canary_armed` through `canary_finalized` that affects run state carries `run_id`.
3. `canary_armed` contains the complete immutable `CanaryRunV1`, including thresholds, GBrain version, and baseline state.
4. Session uniqueness is global by `(provider, provider_session_id)` before run counting.
5. Canary state is reduced from events filtered by `run_id` and the frozen run payload.
6. A `canary_finalized(run_id=A)` makes only run A terminal.
7. A later explicitly armed run B may start without deleting run A evidence.
8. At most one nonterminal run exists in V1; arming another while one is active fails closed.
9. Same-hash replay is idempotent; different-hash replay is diagnostic conflict.
10. The ledger stores hashes, brain-qualified pointers, classifications, run IDs, and bounded references—not full transcripts.

Candidate observations may remain ledger-only because they are not active truth.

## 7. Distillation, canonical encoding, and authority

Learnable classes are:

```ts
type LearningClassV1 =
  | 'constraint'
  | 'preference'
  | 'goal'
  | 'lesson'
  | 'friction'
  | 'open_loop'
  | 'business_candidate';
```

### 7.1 Lossless mapping to existing fact fences

GBrain's existing fact fence `kind` enum is intentionally reused. The Learning Loop does **not** add a new fact-fence schema.

Canonical active personal rows map as follows:

| Learning class | Existing fact `kind` | Retrieval behavior |
|---|---|---|
| `constraint` | `preference` | eligible as hard constraint |
| `preference` | `preference` | eligible as durable preference |
| `goal` | `commitment` | eligible while current |
| `lesson` | `belief` | eligible when evidence threshold is met |
| `friction` | `event` | never injected directly; evidence for a later lesson/constraint |
| `open_loop` | `commitment` | eligible only with a machine-owned completion trigger |
| `business_candidate` | none | never written to the personal facts fence |

Because several Learning Loop classes share an existing fact kind, every active Learning Loop row uses a machine-readable discriminator in the existing free-form `context` column:

```text
sll:v1;class=<LearningClassV1>;scope=<global|repository|project>;authority=<user_correction|user_statement|verified_outcome|repeated_pattern>
```

Rules:

1. For an active Learning Loop row, the `context` field must parse exactly to the discriminator grammar above; the human-readable claim remains unmodified in `claim`.
2. Retrieval reconstructs `LearningClassV1`, scope, and authority from this discriminator; it never infers the class from `kind` alone.
3. Existing non-Learning-Loop rows without the discriminator remain valid and unchanged.
4. When a row is superseded, the existing renderer may replace its context with `superseded by #N`; the new active row carries the discriminator, so active retrieval remains lossless.
5. `business_candidate` stays in candidate/evidence machinery and cannot enter the personal facts writer.
6. Raw `friction` may be canonically retained as a private event when useful for provenance, but retrieval never supplies it directly. Thresholded friction must activate a distinct `lesson` or `constraint` row if it is to affect future behavior.

### 7.2 Authority

| Evidence | Treatment |
|---|---|
| Direct user correction | Activate immediately and supersede conflict |
| Explicit durable preference/constraint | May activate immediately |
| Explicit current goal | May activate immediately |
| Verified operational outcome | May activate/strengthen lesson |
| Same friction in two independent eligible sessions | May activate a scoped lesson/constraint; raw friction itself is not injected |
| Same self-improvement opportunity in three independent sessions | Future candidate only |
| Single agent inference | Candidate only |
| External research | Out of V1 |
| Seascape business claim | Quarantine/candidate-only boundary |

A session is independent only when its `(provider, provider_session_id)` differs from every earlier counted session. Content hashes detect retries/conflicts; they do not define a second session identity.

Active personal learning writes only to the frozen destination. Ambient routing may choose the destination at explicit arming, never afterward.

### 7.3 Correction algorithm

A direct correction must:

1. route to the pointer's `brain_id` and `source_id`;
2. identify the active conflicting canonical row;
3. append the corrected row with a valid Learning Loop discriminator;
4. strike the old row with `superseded by #N` through the existing renderer;
5. reconcile the derived index in that same brain/source;
6. append `memory_superseded` with brain-qualified old/new pointers and current `run_id` if a run is active;
7. exclude the old pointer immediately;
8. survive full rebuild.

Two contradictory active rows are a failure.

## 8. Retrieval and injection

Ranking order:

1. Directly applicable hard constraints.
2. Explicit current goals.
3. Proven repository/project lessons.
4. Relevant durable preferences.
5. At most one machine-owned open loop.

Never inject raw friction events, inactive/superseded/forgotten rows, candidate-only inference, stale PR state, completed/triggerless work, unrelated business facts, raw transcripts, or items merely because they are recent.

Every retrieval starts from the active run's frozen personal destination and routes explicitly to its `brain_id` and `source_id`.

Before substantive agent work, append `context_supplied` with `run_id`, provider session ID, request hash, exact brain-qualified pointers, reconstructed Learning Loop types, ranking rationale, token estimate, and mode.

## 9. Outcome measurement

Strong evidence includes explicit correction, repeated known instruction, re-asked known answer, objective test/build/review/merge/deploy evidence, avoidance of a known recurrent failure in a comparable task, machine-owned trigger completion, or a supplied item causing a wrong action.

Agent self-report is weak evidence only.

Outcome processing routes by each pointer's `brain_id` and is reduced within the relevant `run_id`. Non-use alone cannot delete canonical belief.

## 10. Canary lifecycle

```text
off
  └─ explicit arm → run A: armed → running → terminal
                               │
                               └─ repair verdict → bounded fix
                                                    └─ explicit re-arm → run B
```

Configuration:

```text
learning_loop.mode = off | capture | canary
```

- `off`: no V1 capture or injection;
- `capture`: capture/distill/outcome evidence, inject nothing, advance no canary;
- `canary`: run-scoped capture, injection, measurement, and counting.

Default is `off`. Merge never activates V1.

### 10.1 Arming

Explicit arming:

1. refuses if a nonterminal run already exists;
2. creates a new immutable `run_id`;
3. resolves and freezes the full personal destination including `brain_id`;
4. freezes `contract_version`, `gbrain_version`, provider allow-list, target count, and thresholds;
5. freezes either a concrete baseline reference+metrics or explicit `baseline: null`;
6. validates the V1 provider allow-list is exactly `['codex']`;
7. appends one `canary_armed` containing the complete `CanaryRunV1`.

A later rerun after `repair` creates a new `run_id`; prior run evidence remains historical and immutable.

### 10.2 Counting

- only unique eligible completions whose provider is in the active run's frozen allow-list count;
- same-session same-hash retry does not count twice;
- same-session different-hash conflict never counts;
- unsupported providers do not count;
- session ten finalizes that `run_id` once;
- events from prior terminal runs do not affect the new run's count or verdict.

### 10.3 Hard failures

Any of these forces `repair` for the current run:

- corrected belief supplied again;
- memory operation targets a brain other than its frozen destination/pointer;
- unsupported high-impact belief causes action;
- Seascape canon/external write occurs through V1;
- duplicate/conflicting completion advances count;
- active-run state leaks across `run_id`s;
- reducer requires mutable current thresholds/version instead of frozen run inputs;
- rerun requires deletion of historical ledger evidence;
- Sawyer must remember/manually advance the canary;
- injection materially blocks ordinary work;
- finalization for one `run_id` occurs more than once or is non-deterministic.

### 10.4 Deterministic verdict

**Broaden** requires all of the following:

1. no hard failure;
2. at least the frozen `min_strong_beneficial_uses` strong beneficial uses;
3. no more than the frozen `max_materially_irrelevant_injections` materially irrelevant injections;
4. correction propagation passes when required by the frozen threshold set;
5. a non-null frozen baseline exists;
6. compared with that baseline, the canary improves the combined supervision-error count:
   `repeated_known_instruction_count + reasked_known_answer_count + user_correction_count`;
7. no recurring maintenance is assigned to Sawyer.

The only authorized broadening is a Claude adapter using the same provider-neutral contracts.

**Keep** applies when there is no hard failure but any broaden-only requirement is not met. In particular, a run with `baseline: null` **cannot broaden** and returns `keep` if otherwise healthy.

**Repair** applies when capture, run scoping, frozen inputs, identity/routing, relevance, correction, canonical class encoding, or measurement is not trustworthy. Name one smallest component to repair; a later bounded rerun uses a fresh `run_id`.

This precedence is deterministic: `repair` overrides `broaden`; `broaden` requires every broaden gate; otherwise the result is `keep`.

## 11. Privacy and security

1. Raw transcript access remains local-only and under configured corpus roots.
2. No raw transcript is exposed through remote MCP.
3. Model-assisted distillation uses existing AI-gateway privacy/provider controls.
4. Active Learning Loop facts are private.
5. Events store hashes, run IDs, brain-qualified pointers, classifications, frozen run inputs, and bounded references rather than conversation bodies.
6. Existing self-consumption guards remain active.
7. Generated Loop output is not rediscovered as a raw session.
8. Seascape writeback remains fail-closed on ambiguous ownership/proof.

## 12. Delivery sequence

Only one implementation PR may be actively mutated at a time.

### PR 0 — this contract

Freeze architecture, provider representation, brain-qualified identity, session replay semantics, canonical learning-class encoding, frozen run inputs, deterministic verdict rules, run-scoped lifecycle, acceptance gates, and delivery order. No runtime/config activation.

### PR 1 — events, run identity, eligibility, idempotent capture

Owned by GBrain.

- provider-neutral `LearningProviderV1` and session/event types;
- `PersonalMemoryDestinationV1`, `MemoryPointerV1`, `CanaryRunV1` types;
- immutable thresholds, GBrain version, and baseline state in `canary_armed`;
- append-only ledger writer/reader/reducer;
- `run_id` generation and one-active-run invariant;
- global `(provider, provider_session_id)` uniqueness;
- same hash retry = idempotent; different hash = diagnostic conflict;
- deterministic session eligibility using frozen provider allow-list;
- transcript discovery/parser reuse;
- trusted-local completed-session operation/CLI seam;
- `learning_loop.mode`, default off;
- no distillation or injection.

### PR 2 — canonical activation and correction

- observation classification/thresholds;
- explicit frozen brain/source routing;
- lossless `LearningClassV1` → existing fact-kind/context-discriminator mapping;
- existing facts classifier/fence renderer;
- direct correction supersession and rebuild proof;
- Seascape boundary preserved;
- no injection.

### PR 3 — context bundle and exact telemetry

- existing volunteer/retrieval discovery;
- frozen personal destination routing;
- reconstruct Learning Loop class/scope/authority from discriminator;
- authority/scope/relevance filtering;
- five-item/800-token caps;
- exact brain-qualified pointer + `run_id` ledger;
- provider-neutral local operation;
- fail open to empty context.

### PR 4 — thin Codex adapter

Owned by the existing active Codex hook owner only.

- bootstrap requests one context bundle;
- close submits one Completed Session + local objective evidence;
- retries preserve provider session ID;
- no memory/routing/scoring logic in adapter;
- no live activation in PR.

### PR 5 — outcome reducer and run finalization

- link supplied pointers to corrections/repetition/relevance/outcomes;
- route feedback by pointer brain;
- reduce evidence by `run_id` using frozen run thresholds/version/baseline;
- deterministic baseline comparison and no-baseline `keep` rule;
- deterministic ten-session verdict and plain-English result;
- support later explicit re-arm with new run ID after repair.

### PR 6 — successful-canary cleanup only

Only after `keep` or `broaden`:

- remove displaced manual memory promotion;
- remove unused session summaries;
- remove reminder-based canary tracking;
- remove duplicate context bootstrap paths;
- no Claude/research/skills/business expansion here.

## 13. Minimum test matrix

### Capture/run state

- `LearningProviderV1` can represent Codex and Claude while V1 arming accepts only `['codex']`;
- same `(provider, provider_session_id, content_hash)` retry is idempotent;
- same session identity with different hash is diagnostic conflict;
- neither replay case advances count twice;
- interrupted/abandoned/empty/lookup-only sessions do not count;
- unsupported provider does not count;
- `canary_armed` persists thresholds, GBrain version, destination, provider allow-list, target count, and explicit baseline state;
- changing runtime config/version after arming does not change the reduced verdict inputs;
- every run-scoped state event carries `run_id`;
- session ten finalizes exactly once for that run;
- old `canary_finalized` does not make a fresh run terminal;
- a new run after `repair` starts without deleting old events;
- arming while a run is nonterminal fails closed;
- events from two run IDs never contaminate each other's counts/verdicts;
- malformed event lines do not corrupt valid state;
- off/capture/canary modes differ as specified.

### Brain routing/canonical memory

- arming freezes concrete `brain_id` + `source_id`;
- memory pointer includes `brain_id`;
- ambient different `.gbrain-mount` cannot redirect retrieval;
- correction cannot mutate same coordinates in another brain;
- unavailable/unknown brain fails closed for learning and open for ordinary work;
- every active Learning Loop class round-trips losslessly through existing fact kind + context discriminator;
- existing non-Loop fence rows round-trip unchanged;
- raw friction is not injected; thresholded friction becomes a distinct lesson/constraint if activated;
- business candidate cannot enter personal writer;
- direct preference/constraint can activate;
- single inference remains candidate-only;
- correction supersedes old row and survives rebuild;
- active Loop facts are private.

### Retrieval/outcome/verdict

- inactive/superseded/forgotten rows excluded;
- authority/narrow scope outrank recency;
- resolved work excluded;
- at most one open loop;
- item/token caps deterministic;
- bundle pointers and `run_id` match `context_supplied`;
- retrieval failure returns empty bundle without blocking;
- self-report alone is not beneficial use;
- correction removes old pointer from later bundles;
- outcome routing uses pointer brain, not ambient mount;
- irrelevant injection counts once per run/session/pointer;
- broaden requires the frozen minimum strong beneficial uses;
- broaden requires a non-null frozen baseline and improvement over it;
- missing baseline prevents broaden but not keep;
- hard failure always returns repair even if broaden evidence otherwise passes;
- terminal rendering names evidence and one next action without exposing ledger.

## 14. Activation and rollback

Merging implementation code does not activate V1.

Activation after all implementation PRs are green:

1. resolve/configure personal `brain_id`, `source_id`, operating-model slug;
2. set mode `capture` for one smoke check;
3. verify completion capture with no injection;
4. create/freeze a baseline if enough historical evidence exists; otherwise record `baseline: null` and accept that the first healthy run can only return `keep`;
5. explicitly set `canary` and arm run A.

Rollback:

- `canary → capture` stops injection while preserving events;
- `→ off` stops V1;
- derived indexes may rebuild from canonical Markdown;
- Seascape stays untouched.

After a `repair`, fix the named component, verify it, and explicitly arm a new run with a fresh `run_id`. Do not delete the prior run.

## 15. Long-term expansion order

After V1 only:

1. Claude adapter using the same contracts.
2. Research ingestion as sourced freshness-bounded hypotheses.
3. General machine-owned experiment completion triggers.
4. One-at-a-time skill/config proposals after repeated or severe verified evidence.
5. Seascape proposal bridge through existing evidence/ownership checks, never direct personal-loop canon promotion.

## 16. Explicit non-goals

No standalone memory product, new repository/database, AI employee org chart, Sawyer Hub runtime dependency, dashboard, queue, second transcript corpus, generic knowledge-graph rewrite, automatic Claude/ChatGPT ingestion, research promotion, skill/config edits, PR/merge/deploy/install/send behavior, automatic Seascape canon change, or requirement for Sawyer to inspect Markdown/receipts/telemetry.

## 17. PR 1 implementation handoff

```text
Implement Sawyer Learning Loop V1 PR 1 in uncfreak1255-code/gbrain from the
exact merged docs/architecture/sawyer-learning-loop-v1.md.

Scope only:
- provider-neutral LearningProviderV1/session/event types; represent Codex and
  Claude, but enforce the V1 armed provider allow-list is exactly ['codex'];
- PersonalMemoryDestinationV1 with brain_id + source_id;
- MemoryPointerV1 with brain_id;
- CanaryRunV1 with immutable run_id, gbrain_version, thresholds, and explicit
  baseline object-or-null frozen in canary_armed;
- append-only events-v1.jsonl writer/reader/reducer;
- one-active-nonterminal-run invariant;
- deterministic CompletedSession eligibility;
- global uniqueness `(provider, provider_session_id)`;
- same-hash retry = idempotent no-op;
- different-hash retry = diagnostic conflict, no second completion/count;
- state/count/finalization reduced by run_id and frozen run payload;
- old terminal run must not block a new explicitly armed rerun;
- learning_loop.mode resolver, default off;
- one trusted-local capture operation/CLI seam;
- hermetic replay, frozen-config, cross-run, provider-allowlist, and ambient
  mounted-brain regression tests;
- repository proof.

Reuse transcript discovery, brain/source routing, and the operation layer.
Do not implement canonical distillation/class mapping, context injection,
Codex hooks, outcome scoring, Claude ingestion, skills, research, Sawyer Hub
changes, Seascape writes, activation, scheduling, merge, or deployment. Do not
create a second memory store. Report exact head SHA, proof, remaining review
blocker, and one next action.
```

The implementation must remain smaller than the system it replaces. Reuse existing GBrain primitives whenever they already own the behavior.
