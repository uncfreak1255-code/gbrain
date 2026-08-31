# Sawyer Learning Loop V1 — canonical contract

**Status:** implementation contract only; merge does not activate runtime behavior  
**Owner:** GBrain core plus one thin adapter in the existing owner of Codex session hooks  
**Decision:** reuse GBrain primitives; do not create a parallel memory product or supervision layer

## 1. Purpose and success condition

Sawyer Learning Loop V1 closes one bounded loop:

```text
completed Codex session
  -> local evidence capture
  -> qualified personal learning/correction
  -> canonical private GBrain fact
  -> thin relevant context on a later session
  -> objective outcome/user correction
  -> deterministic canary verdict
```

V1 evaluates exactly **10 eligible Codex sessions** in one explicitly armed `run_id` and ends with exactly one terminal result:

- `keep`: healthy/useful but not proven enough to broaden;
- `repair`: one bounded component is untrustworthy and must be fixed before a fresh run;
- `broaden`: every broaden gate passed; only then may a later change add a Claude adapter using these same contracts.

The user must not maintain a queue, advance counters, inspect Markdown receipts, remember an end date, or supervise routine progress.

## 2. Non-goals and authority boundaries

V1 does **not** add a dashboard, queue, agent hierarchy, new repository/database, generic knowledge graph, research ingestion, skill/config self-editing, PR/merge/deploy/install/send automation, scheduling, Claude ingestion, ChatGPT ingestion, or Seascape canon promotion.

Personal operating knowledge belongs only to the configured private GBrain destination. Seascape business knowledge remains a separate authority boundary. V1 may surface existing candidate-only business evidence but cannot write, promote, deploy, send, or mutate Seascape canon or any external system.

Raw transcripts remain local-only. Operational telemetry stores hashes, IDs, bounded metadata, and exact pointers—not conversation bodies.

## 3. Reused GBrain seams

V1 reuses existing transcript discovery/parsing, fact fences and fact extraction, classifier/supersession logic, brain/source routing, `context/volunteer` retrieval, context telemetry, friction evidence, AI-gateway privacy controls, and candidate-only Seascape writeback boundaries.

Markdown fact fences remain canonical. Database rows are rebuildable indexes, never the authoritative memory store.

## 4. Core invariants

1. **Brain-qualified identity.** Every durable personal destination and memory pointer includes `brain_id` and `source_id`. After arming, learning/retrieval/correction/outcome operations route explicitly to those identities; ambient mounts, cwd, or environment variables cannot redirect them.
2. **Run-scoped state.** Every canary has an immutable `run_id`. Run-affecting events carry it. Historical terminal runs never contaminate or block a later explicitly armed run.
3. **One active run.** At most one nonterminal run exists. A run is terminal after exactly one `canary_finalized` or `canary_aborted`.
4. **Frozen inputs.** Arming freezes contract version, GBrain version/commit, provider allow-list, target cohort size, thresholds, personal destination, and baseline object-or-null. Reducers never substitute mutable current config.
5. **Fail open for work, fail closed for learning.** Capture/retrieval/telemetry faults cannot block ordinary Codex work. Ambiguous routing, malformed state, replay conflicts, unverifiable scope, invalid trigger state, incomplete settlement, or contradictory canonical knowledge suppress learning/injection or force `repair` as defined below.
6. **No silent inference promotion.** Direct user correction outranks all other evidence. Single-session agent inference is candidate-only.
7. **Canonical rebuildability.** Any active scoped/open-loop fact must retain enough information in canonical Markdown to remain correctly injectable or non-injectable after a full index rebuild.

## 5. Provider and session contracts

```ts
type LearningProviderV1 = 'codex' | 'claude';

type TaskClassV1 =
  | 'implementation'
  | 'review'
  | 'research'
  | 'strategy'
  | 'operations'
  | 'other';

interface CompletedSessionV1 {
  schema_version: 1;
  provider: LearningProviderV1;
  provider_session_id: string;
  content_hash: string;
  started_at: string | null;
  completed_at: string;
  completion: 'completed' | 'interrupted' | 'abandoned';
  transcript_ref: { local_path: string; byte_length: number };
  work_context: {
    repository_target: string | null;
    project_target: string | null;
    branch: string | null;
    pull_request: string | null;
    task_class: TaskClassV1;
  };
}
```

`LearningProviderV1` is representational. V1 arming accepts only `['codex']`.

### Session uniqueness and cohort admission

Global session uniqueness is `(provider, provider_session_id)`:

- first pair: accept with its `content_hash`;
- same pair + same hash: idempotent retry, no second completion/count;
- same pair + different hash: diagnostic conflict, no learning/counting.

Eligibility is evaluated only after uniqueness and active-run provider checks. Interrupted/abandoned/empty/login-only/simple lookup/generated-housekeeping sessions do not count.

**Frozen cohort rule:** once the active run has accepted its frozen `target_eligible_sessions` (10), the cohort is sealed. Later unique eligible sessions are recorded only as non-counting diagnostics/capture evidence until the run becomes terminal; they cannot increase the cohort above 10. The original 10 remain allowed to submit outcomes and settle.

## 6. Canonical scope identities

Repository identity is forge-qualified:

```text
repo:<canonical-forge-host>/<canonical-repository-path>
```

For GitHub the canonical form is `repo:github.com/<lowercase-owner>/<lowercase-repo>`. Scheme, userinfo, trailing `.git`, cwd, branch, and PR number are excluded. Same `owner/name` on another forge is a different target. If canonical remote identity is unavailable, repository target is `null` and repository-scoped memories are non-injectable.

Project scope uses a caller-owned stable project key or `null` when unavailable.

## 7. Frozen canary contract

```ts
interface CanaryThresholdsV1 {
  min_strong_beneficial_uses: 3;
  max_materially_irrelevant_injections: 2;
  require_correction_propagation: true;
  require_baseline_for_broaden: true;
}

interface CanaryBaselineV1 {
  reference: string;
  eligible_sessions: number; // integer >= 1
  repeated_known_instruction_count: number;
  reasked_known_answer_count: number;
  user_correction_count: number;
}

interface CanaryRunV1 {
  run_id: string;
  armed_at: string;
  provider_allowlist: LearningProviderV1[]; // exactly ['codex'] in V1
  target_eligible_sessions: 10;
  destination: {
    brain_id: string;
    source_id: string;
    operating_model_slug: string;
  };
  contract_version: 1;
  gbrain_version: string;
  thresholds: CanaryThresholdsV1;
  baseline: CanaryBaselineV1 | null;
}
```

A baseline with `eligible_sessions < 1` is invalid. If no valid baseline exists, arm with `baseline: null`; that run may `keep` or `repair` but cannot `broaden`.

## 8. Durable memory identity and encoding

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

Active Learning Loop facts reuse existing fact kinds and store one machine-readable discriminator in the existing free-form `context` column:

```text
sll:v1;class=<class>;scope=<global|repository|project>;scope_target=<opaque-or-~>;authority=<authority>;trigger_id=<opaque-or-~>;trigger_state=<none|pending|completed|cancelled>
```

Opaque `scope_target` and `trigger_id` values use canonical **unpadded base64url of UTF-8 bytes**. `~` is the sole null sentinel and is outside the base64url alphabet. Padded, malformed, non-canonical, or undecodable encodings fail closed for injection.

Learning-class mapping:

| Loop class | Existing fact kind | Injection rule |
|---|---|---|
| constraint | preference | hard constraint when applicable |
| preference | preference | durable preference |
| goal | commitment | while current |
| lesson | belief | after evidence threshold |
| friction | event | never directly injected |
| open_loop | commitment | only while exact trigger is `pending` |
| business_candidate | none | never personal-fact write |

For `scope=global`, `scope_target=~`. Repository/project scope requires a valid decoded exact target. Missing/mismatched target is non-injectable.

For non-open-loop classes: `trigger_id=~;trigger_state=none`. Open loops require a stable machine-owned trigger ID and `pending|completed|cancelled`. Only `pending` is injectable. A terminal trigger writes a new canonical row with the same trigger ID and terminal state and supersedes the prior row; rebuild must preserve non-injectability.

Direct correction appends the corrected canonical row, supersedes the conflicting old row, reconciles the same brain/source index, and immediately excludes the old pointer. Two contradictory active rows are a failure.

## 9. Context request and deterministic normalization

```ts
interface LearningContextRequestV1 {
  schema_version: 1;
  run_id: string;
  provider: LearningProviderV1;
  provider_session_id: string;
  task_class: TaskClassV1;
  current_scope: {
    repository_target: string | null;
    project_target: string | null;
  };
  relevance_window: Array<{ role: 'user' | 'assistant'; text: string }>;
}
```

Before hashing/retrieval, the producer applies one canonical normalization algorithm:

1. preserve only the most recent four turns, keeping chronological order;
2. normalize each `text` to Unicode NFC;
3. normalize CRLF/CR to LF;
4. reject the request if the resulting concatenated role-tagged window exceeds **2,000 UTF-8 bytes**; do not truncate;
5. compute `request_hash` from the exact canonical normalized request payload.

An empty window is valid and may return only globally or otherwise unambiguously applicable context. Retrieval must not recover missing semantic or scope input from raw transcripts, cwd, mounts, ambient Git config, or another checkout.

Telemetry stores the request hash, task class, exact scope targets, turn/byte counts, selected pointers, rationales, and token estimate—never relevance-window text.

## 10. Context bundle and telemetry authority

```ts
interface LearningContextBundleV1 {
  schema_version: 1;
  run_id: string;
  provider_session_id: string;
  request_hash: string;
  max_items: 5;
  max_tokens: 800;
  items: Array<{
    pointer: MemoryPointerV1;
    statement: string;
    type: 'constraint' | 'preference' | 'goal' | 'lesson' | 'open_loop';
    scope: 'global' | 'repository' | 'project';
    scope_target: string | null;
    trigger: null | { id: string; state: 'pending' };
    rationale: string;
    authority: 'user_correction' | 'user_statement' | 'verified_outcome' | 'repeated_pattern';
  }>;
}
```

Ranking: applicable constraints, current goals, exact-scope proven lessons, relevant preferences, then at most one pending open loop. Maximum five items / 800 tokens.

The accepted `context_supplied` event is the authority for what was actually injected. It records `(run_id, provider_session_id, request_hash)` plus exact brain-qualified pointers and their reconstructed scope/trigger metadata. Outcome payloads cannot self-authorize a pointer as “supplied.”

## 11. Outcome evidence and replay

Each outcome has a producer-stable `outcome_id`, canonical `content_hash`, and evidence entries with producer-stable `evidence_id`.

Replay semantics:

- same outcome/evidence ID + identical canonical payload: idempotent;
- same ID + changed payload: diagnostic conflict; changed payload contributes nothing;
- reducers count each accepted evidence ID once.

Positive and negative evidence are typed. The only evidence that increments beneficial use is:

```ts
{
  kind: 'beneficial_use';
  evidence_id: string;
  pointer: MemoryPointerV1;
  strength: 'objective' | 'explicit_user';
  benefit:
    | 'avoided_known_failure'
    | 'avoided_repeated_instruction'
    | 'answered_without_reasking'
    | 'improved_task_execution';
  reference: string;
}
```

A beneficial use counts only when its pointer appears in the accepted `context_supplied` event for the same `run_id`, provider session, and `request_hash`. Generic `applied`, generic task success, corrections, errors, trigger transitions, or agent report never increment beneficial-use count. Count at most once per `(run_id, provider_session_id, pointer)`.

Material irrelevance likewise counts at most once per `(run_id, provider_session_id, supplied pointer)`, regardless of how many distinct evidence IDs report the same actual injection.

User correction, repeated-known-instruction, re-asked-known-answer, contradiction, and materially irrelevant injection are supervision/error evidence, not benefits.

Open-loop completion/cancellation uses typed evidence carrying exact pointer, exact trigger ID, and terminal state. Agent self-report cannot transition a trigger. Pointer/trigger mismatch fails closed without canonical mutation.

## 12. Authoritative settlement barrier

Settlement cannot self-declare an arbitrary “complete outcome list.” Completeness is derived from an authoritative close manifest created when the session is accepted into the canary cohort.

For each counted session, GBrain records one immutable `SessionCloseManifestV1` containing the session identity and the exact required close-time obligations for that session:

- whether an outcome submission is required;
- the expected stable `outcome_id` when required;
- the exact canonical memory mutations/trigger transitions that must be acknowledged before settlement, if any.

The manifest is created by GBrain from accepted session/context state, not supplied later by the adapter.

`session_settled` may be accepted only when every obligation in that immutable manifest is satisfied and reduced. If no outcome is required, the manifest explicitly records that at creation time. A delayed or omitted required outcome cannot be bypassed by an empty settlement. Evidence arriving after accepted settlement is diagnostic only and cannot mutate the run verdict.

A run may finalize only when:

1. the cohort contains exactly the frozen target of 10 eligible sessions; and
2. all 10 accepted cohort sessions are settled against their immutable manifests.

Session 10 completion alone never finalizes the run.

## 13. Correction-propagation gate

If `require_correction_propagation=false`, this gate is ignored.

If it is `true`:

- **no direct user correction occurred during the run:** the gate passes vacuously;
- **one or more direct user corrections occurred:** every corrected pointer must have a successful canonical supersession event, the old pointer must be absent from every later accepted `context_supplied` event, and a full-rebuild verification for the corrected brain/source must resolve only the replacement active row. Any failure forces `repair`.

This definition is deterministic from accepted run events plus the explicit rebuild-verification event.

## 14. Event ledger

Local append-only ledger:

```text
$GBRAIN_HOME/learning-loop/events-v1.jsonl
```

Run/state event types include at least:

- `canary_armed`
- `session_completed`
- `session_rejected`
- `session_close_manifest`
- `observation_recorded`
- `memory_activated`
- `memory_superseded`
- `context_supplied`
- `session_outcome`
- `session_settled`
- `rebuild_verified`
- `canary_finalized`
- `canary_aborted`
- `diagnostic`

Every state-affecting line carries schema version, timestamp, event ID, and `run_id`; provider session identity is included when relevant. The complete immutable `CanaryRunV1` is persisted on `canary_armed`.

Malformed lines do not corrupt valid prior state. Same-session replay conflicts, outcome replay conflicts, and cohort-overflow deliveries cannot advance the run.

## 15. Deterministic verdict

First compute supervision errors for the canary cohort:

```text
canary_error_count =
  repeated_known_instruction_count +
  reasked_known_answer_count +
  user_correction_count

canary_error_rate = canary_error_count / 10
```

For a non-null baseline:

```text
baseline_error_count =
  baseline.repeated_known_instruction_count +
  baseline.reasked_known_answer_count +
  baseline.user_correction_count

baseline_error_rate = baseline_error_count / baseline.eligible_sessions
```

`broaden` requires all of:

1. cohort is exactly 10 and all 10 sessions are authoritatively settled;
2. no hard failure;
3. at least frozen `min_strong_beneficial_uses` accepted beneficial uses;
4. no more than frozen `max_materially_irrelevant_injections` semantic irrelevant injections;
5. correction-propagation gate passes;
6. frozen baseline is non-null;
7. `canary_error_rate < baseline_error_rate`;
8. Sawyer has no recurring maintenance obligation.

`repair` overrides all other outcomes when any trust-critical capture, routing, identity, canonical correction, scope/trigger encoding, settlement, run-scoping, frozen-input, privacy, or measurement rule is violated. Name one smallest component to repair.

Otherwise return `keep`.

A healthy no-baseline run therefore returns `keep`, never `broaden`.

## 16. Hard failures

These force `repair` for the active run:

- corrected old memory supplied again;
- memory operation routes to a brain/source other than its frozen destination/pointer;
- scoped memory injected without exact request-target match;
- completed/cancelled/triggerless/malformed open loop injected;
- unsupported high-impact inference causes action;
- Seascape canon or external write occurs through V1;
- duplicate/conflicting session or outcome advances metrics;
- cohort exceeds 10 or a post-seal session changes cohort membership;
- settlement is accepted without satisfying the immutable close manifest;
- run state leaks across `run_id`s;
- reducer substitutes mutable current version/thresholds;
- historical evidence must be deleted to rerun;
- Sawyer must remember or manually advance the canary;
- injection materially blocks ordinary work;
- finalization happens before all 10 settlements or occurs more than once;
- correction-propagation gate fails when required.

## 17. Lifecycle, activation, and rollback

```text
off
  -> explicit arm -> run A: armed/running -> finalized(keep|repair|broaden)
                                      \
                                       -> canary_aborted

repair/abort -> bounded fix -> explicit fresh arm -> run B
```

Configuration:

```text
learning_loop.mode = off | capture | canary
```

Default is `off`. Merge never activates V1.

Arming refuses while a nonterminal run exists, freezes the complete run payload, and appends one `canary_armed`.

Rollback from a nonterminal run first appends terminal `canary_aborted`, then changes mode to `capture` or `off`. Aborted runs cannot later `keep` or `broaden`, cannot advance, and do not block a fresh explicitly armed run. History remains append-only.

## 18. Delivery sequence

Only one implementation PR may be actively mutated at a time.

### PR 0 — this contract

Documentation only. Freeze the architecture and contracts. No runtime/config activation.

### PR 1 — run/session/event foundation

GBrain-owned provider/session types, frozen run payload, append-only ledger, one-active-run invariant, session uniqueness, frozen 10-session cohort admission/seal, immutable close manifest, deterministic eligibility, default-off mode resolver, and trusted-local capture seam. No distillation or injection.

### PR 2 — canonical activation/correction

Learning-class mapping, canonical discriminator encoding, forge-qualified scope targets, trigger state, explicit brain/source routing, activation thresholds, direct correction/supersession, rebuild verification, and Seascape boundary. No injection.

### PR 3 — context request/bundle/telemetry

Canonical relevance-window normalization/rejection, explicit scope request, precision-biased retrieval, class/scope/trigger reconstruction, exact scope matching, five-item/800-token caps, exact accepted `context_supplied` telemetry, and empty-context fail-open behavior.

### PR 4 — thin Codex adapter

Bootstrap submits the explicit normalized request. Close submits the completed session and stable outcome IDs/evidence. Adapter owns no routing, memory, scoring, settlement, or verdict logic. No live activation in PR.

### PR 5 — outcome/settlement/finalization

Outcome/evidence replay semantics, context-telemetry binding, semantic benefit/irrelevance dedupe, typed trigger transitions, authoritative close-manifest settlement, correction-propagation reducer, normalized baseline rates, abort behavior, deterministic verdict, and plain-English terminal output.

### PR 6 — cleanup only after successful canary

After `keep` or `broaden`, remove displaced manual memory-promotion/session-summary/reminder/bootstrap machinery. No research/skills/business expansion.

## 19. Required regression matrix

Implementation must prove at minimum:

- Codex/Claude representable, V1 arming Codex-only;
- session same-hash retry idempotent; changed-hash conflict fail-closed;
- exactly 10 admitted cohort sessions; session 11 cannot change cohort while settlement is pending;
- old terminal run cannot contaminate a fresh run;
- rollback abort permits a fresh run without history deletion;
- frozen config/version/baseline remain unchanged during reduction;
- brain/source ambient mount cannot redirect memory operations;
- every active Loop class round-trips through the fact fence/discriminator;
- base64url/null sentinel round-trips literal `-`, `~`, Unicode, and delimiter-like values;
- repository identity distinguishes identical paths on different forges;
- missing/mismatched scope fails closed;
- pending open loop injects; terminal/triggerless/malformed loop does not after rebuild;
- canonical relevance normalization is NFC + LF, most-recent-four-turns, reject >2,000 UTF-8 bytes, never truncate;
- context request hash is stable for canonical-equivalent input;
- retrieval never reconstructs missing request scope/window from ambient state;
- outcome/evidence replay is idempotent and changed-payload conflict fail-closed;
- beneficial use requires matching accepted `context_supplied` run/session/request/pointer;
- beneficial and irrelevant metrics count at most once per run/session/pointer;
- immutable close manifest prevents empty/incomplete settlement from bypassing delayed required outcomes;
- session 10 cannot finalize before every cohort session settles;
- no-correction propagation passes vacuously; correction case requires supersession + later exclusion + rebuild verification;
- normalized baseline rate rejects false improvement from unequal cohort sizes;
- no baseline cannot broaden;
- hard failure always returns repair;
- capture/retrieval failure does not block ordinary work;
- Seascape business candidate cannot enter personal writer;
- no activation occurs merely from merge.

## 20. PR 1 handoff

Implement PR 1 from this exact merged document only. Scope: provider/session/run/event contracts, frozen run payload, global session uniqueness, sealed 10-session cohort, immutable close manifest, one-active-run invariant, append-only ledger/reducer, deterministic eligibility, default-off mode resolver, and trusted-local capture seam with hermetic replay/cross-run tests. Reuse existing GBrain transcript discovery and brain/source routing. Do not implement canonical distillation, context injection, hooks, outcome scoring, settlement reduction, Claude ingestion, skills, research, Sawyer Hub runtime dependency, Seascape writes, activation, scheduling, merge, or deployment.

## 21. Provenance

- Base branch: `master`
- Base SHA at PR creation: `cfc90a15cbbb50058be79b414be3e57a353552f8`
- This contract is documentation-only.
- Merge, install, schedule, and runtime activation remain separate actions.

The implementation must remain smaller than the system it replaces.