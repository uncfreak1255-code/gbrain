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
  -> typed objective outcome/user correction
  -> deterministic canary verdict
```

V1 evaluates exactly **10 eligible Codex sessions** in one explicitly armed `run_id` and ends with exactly one terminal disposition:

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
5. **Fail open for work, fail closed for learning.** Capture/retrieval/telemetry faults cannot block ordinary Codex work. Ambiguous routing, malformed state, replay conflicts, unverifiable scope, invalid trigger state, incomplete settlement, or contradictory canonical knowledge suppress learning/injection or terminate the active run as `repair`.
6. **No silent inference promotion.** Direct user correction outranks all other evidence. Single-session agent inference is candidate-only.
7. **Canonical rebuildability.** Any active scoped/open-loop fact retains enough information in canonical Markdown to remain correctly injectable or non-injectable after a full index rebuild.
8. **Hard failure is immediately terminal.** Any hard failure defined by this contract immediately appends `canary_aborted` with `disposition='repair'`, disables further injection/counting for that run, and leaves historical evidence append-only. It does not wait for cohort completion or settlement.

## 5. Provider, session, and cohort contracts

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

### 5.1 Session uniqueness

Global session uniqueness is `(provider, provider_session_id)`:

- first pair: accept with its `content_hash`;
- same pair + same hash: idempotent retry, no second completion/count;
- same pair + different hash: diagnostic conflict, no learning/counting.

Eligibility is evaluated only after uniqueness and active-run provider checks. Interrupted/abandoned/empty/login-only/simple lookup/generated-housekeeping sessions do not count.

### 5.2 Frozen cohort admission

Once the active run has accepted its frozen `target_eligible_sessions` (10), the cohort is sealed. Later unique eligible sessions are non-counting diagnostics/capture evidence until the run becomes terminal; they cannot increase or replace cohort membership. The original 10 remain allowed to submit their required outcome envelopes and settle.

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

## 8. Durable memory identity and canonical encoding

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

## 9. Context request and exact request-hash bytes

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
3. normalize CRLF and lone CR to LF;
4. build the exact byte encoding defined below;
5. reject the request if the encoded relevance-window portion exceeds **2,000 UTF-8 text bytes**; never truncate;
6. compute `request_hash = lowercase_hex(SHA-256(exact_request_bytes))`.

### 9.1 Exact binary encoding

All integers are unsigned 32-bit big-endian. `utf8(s)` means UTF-8 bytes after the string normalization above. `lp(s)` means `uint32be(byte_length(utf8(s))) || utf8(s)`. Nullable strings encode as `0xffffffff` for null, otherwise `lp(s)`; therefore null and empty string are distinct.

`exact_request_bytes` is the concatenation, with no separators other than the defined length prefixes:

```text
ASCII("SLLREQ1\0")
lp(run_id)
lp(provider)
lp(provider_session_id)
lp(task_class)
nullable(repository_target)
nullable(project_target)
uint32be(turn_count)
for each normalized turn in chronological order:
  one byte 0x01 for user or 0x02 for assistant
  lp(text)
```

The 2,000-byte relevance limit is the sum of `byte_length(utf8(text))` across the retained turns, after NFC/newline normalization and before length-prefix overhead. This same exact encoding is used by every adapter and by tests; no JSON serialization, alternate delimiter, field reordering, or platform-native string encoding is allowed.

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

The accepted `context_supplied` event is the authority for what was actually injected. It records `(run_id, provider, provider_session_id, request_hash)` plus exact brain-qualified pointers and reconstructed scope/trigger metadata. Outcome payloads cannot self-authorize a pointer as supplied.

## 11. Complete typed outcome contract

Every **counted cohort session requires exactly one outcome envelope**, even when its `evidence` array is empty. Therefore outcome completeness is never inferred from adapter silence.

The GBrain-owned deterministic outcome ID is:

```text
outcome_id = lowercase_hex(SHA-256(
  ASCII("SLLOUT1\0") ||
  lp(run_id) ||
  lp(provider) ||
  lp(provider_session_id)
))
```

where `lp` is the exact length-prefix function from section 9.1.

```ts
type EvidenceStrengthV1 = 'objective' | 'explicit_user' | 'agent_report';

type SessionEvidenceV1 =
  | {
      kind: 'beneficial_use';
      evidence_id: string;
      pointer: MemoryPointerV1;
      request_hash: string;
      strength: 'objective' | 'explicit_user';
      benefit:
        | 'avoided_known_failure'
        | 'avoided_repeated_instruction'
        | 'answered_without_reasking'
        | 'improved_task_execution';
      reference: string;
    }
  | {
      kind: 'materially_irrelevant';
      evidence_id: string;
      pointer: MemoryPointerV1;
      request_hash: string;
      strength: 'objective' | 'explicit_user';
      reference: string;
    }
  | {
      kind: 'user_repeated_known_instruction';
      evidence_id: string;
      pointer: MemoryPointerV1;
      request_hash: string;
      strength: 'explicit_user';
      reference: string;
    }
  | {
      kind: 'agent_reasked_known_answer';
      evidence_id: string;
      pointer: MemoryPointerV1;
      request_hash: string;
      strength: 'objective' | 'explicit_user';
      reference: string;
    }
  | {
      kind: 'user_correction';
      evidence_id: string;
      pointer: MemoryPointerV1;
      request_hash: string | null;
      strength: 'explicit_user';
      reference: string;
    }
  | {
      kind: 'contradicted';
      evidence_id: string;
      pointer: MemoryPointerV1;
      request_hash: string | null;
      strength: 'objective' | 'explicit_user';
      reference: string;
    }
  | {
      kind: 'open_loop_trigger_transition';
      evidence_id: string;
      pointer: MemoryPointerV1;
      trigger_id: string;
      terminal_state: 'completed' | 'cancelled';
      strength: 'objective' | 'explicit_user';
      reference: string;
    };

interface SessionOutcomeV1 {
  schema_version: 1;
  run_id: string;
  provider: LearningProviderV1;
  provider_session_id: string;
  outcome_id: string; // must equal the GBrain-owned deterministic ID above
  content_hash: string;
  observed_at: string;
  evidence: SessionEvidenceV1[];
}
```

### 11.1 Outcome canonicalization, identity, and replay

Before hashing, recursively NFC-normalize every string and CRLF/CR->LF. Serialize the outcome **excluding `content_hash`** using deterministic JSON with these rules: UTF-8; no insignificant whitespace; object keys sorted by Unicode code-point order at every depth; array order preserved; JSON string escaping exactly per RFC 8259 with required escaping only for quotation mark, reverse solidus, and U+0000-U+001F; `/` is not escaped; all schema numbers are integers rendered in base-10 with no leading zero. Then:

```text
content_hash = lowercase_hex(SHA-256(canonical_json_bytes))
```

Identity/replay boundaries:

- outcome uniqueness key: `(run_id, provider, provider_session_id, outcome_id)`;
- `outcome_id` must equal the deterministic value derived above; mismatch is rejected;
- same uniqueness key + same `content_hash`: idempotent retry;
- same uniqueness key + different `content_hash`: diagnostic replay conflict; changed payload contributes nothing;
- evidence uniqueness key: `(run_id, provider, provider_session_id, evidence_id)`;
- duplicate evidence ID with identical canonical evidence payload is idempotent;
- duplicate evidence ID with changed payload is a diagnostic conflict and contributes nothing.

Agent-report evidence is not accepted for any verdict-affecting evidence variant in V1.

### 11.2 Telemetry binding and semantic deduplication

`beneficial_use`, `materially_irrelevant`, `user_repeated_known_instruction`, and `agent_reasked_known_answer` require their pointer to appear in the accepted `context_supplied` event for the same `(run_id, provider, provider_session_id, request_hash)`. If no such telemetry exists, that evidence is rejected for verdict purposes.

A beneficial use counts at most once per `(run_id, provider, provider_session_id, pointer)`. Generic task success, corrections, contradiction, trigger transitions, or agent self-report never increment beneficial-use count.

Material irrelevance counts at most once per `(run_id, provider, provider_session_id, pointer)`, regardless of distinct evidence IDs describing the same injection.

Repeated-known-instruction and re-asked-known-answer are supervision errors, never benefits.

A `user_correction` may refer to a canonical pointer that was not injected in that same session; it still requires an exact pointer and explicit-user evidence. Correction propagation is evaluated under section 13.

Open-loop transition evidence requires exact pointer and exact trigger ID. Agent self-report cannot transition a trigger. Pointer/trigger mismatch fails closed without canonical mutation.

## 12. Deterministic close manifest and settlement barrier

Every counted cohort session requires exactly one deterministic `SessionOutcomeV1`, so GBrain can derive the outcome obligation at admission without relying on a future producer declaration.

When a session is admitted into the cohort, GBrain appends one immutable `session_close_manifest` containing:

```ts
interface SessionCloseManifestV1 {
  schema_version: 1;
  run_id: string;
  provider: LearningProviderV1;
  provider_session_id: string;
  expected_outcome_id: string; // deterministic formula in section 11
}
```

There is no `outcome_required=false` state for counted sessions.

Settlement is reducer-owned, not adapter-declared. A cohort session becomes settled only after:

1. its exact expected outcome ID has been accepted and reduced (an empty `evidence` array is still an explicit accepted outcome);
2. every accepted evidence item that requires a canonical mutation—correction supersession or trigger transition—has either completed successfully with its corresponding canonical event or caused immediate hard-failure abort;
3. all replay/identity conflicts for that session have been reduced to their fail-closed result.

Only then may GBrain append `session_settled`. A delayed or omitted outcome cannot be bypassed by an empty settlement declaration because adapters do not declare settlement.

A run may normally finalize only when its sealed cohort contains exactly 10 eligible sessions and all 10 are settled. Session 10 completion alone never finalizes the run. Hard failure uses the immediate abort path in section 16 and does not wait for settlement.

## 13. Correction-propagation gate

If `require_correction_propagation=false`, this gate is ignored.

If it is `true`:

- **no direct user correction occurred during the run:** the gate passes vacuously;
- **one or more direct user corrections occurred:** every corrected pointer must have a successful canonical supersession event, the old pointer must be absent from every later accepted `context_supplied` event, and a full-rebuild verification for the corrected brain/source must resolve only the replacement active row. Any failure immediately aborts the run as `repair`.

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

Every state-affecting line carries schema version, timestamp, event ID, and `run_id`; provider/session identity is included when relevant. The complete immutable `CanaryRunV1` is persisted on `canary_armed`.

Malformed lines do not corrupt valid prior state. Same-session replay conflicts, outcome/evidence replay conflicts, and cohort-overflow deliveries cannot advance the run.

## 15. Deterministic verdict

For the sealed canary cohort:

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

1. cohort is exactly 10 and all 10 sessions are settled;
2. no hard failure/abort;
3. at least frozen `min_strong_beneficial_uses` accepted beneficial uses;
4. no more than frozen `max_materially_irrelevant_injections` semantic irrelevant injections;
5. correction-propagation gate passes;
6. frozen baseline is non-null;
7. `canary_error_rate < baseline_error_rate`;
8. Sawyer has no recurring maintenance obligation.

If all normal-finalization prerequisites are met and there is no hard failure but any broaden-only requirement is unmet, result is `keep`.

`repair` is represented by immediate `canary_aborted(disposition='repair')` when a hard failure occurs, or by normal terminal `canary_finalized(disposition='repair')` only for a trust defect discovered during final reduction after all sessions are settled. `repair` always overrides `keep`/`broaden`.

A healthy no-baseline run returns `keep`, never `broaden`.

## 16. Hard failures and immediate terminal transition

These are hard failures:

- corrected old memory supplied again;
- memory operation routes to a brain/source other than its frozen destination/pointer;
- scoped memory injected without exact request-target match;
- completed/cancelled/triggerless/malformed open loop injected;
- unsupported high-impact inference causes action;
- Seascape canon or external write occurs through V1;
- duplicate/conflicting session, outcome, or evidence advances metrics;
- cohort exceeds 10 or a post-seal session changes cohort membership;
- settlement is appended before its deterministic outcome/mutations are fully reduced;
- run state leaks across `run_id`s;
- reducer substitutes mutable current version/thresholds;
- historical evidence must be deleted to rerun;
- Sawyer must remember or manually advance the canary;
- injection materially blocks ordinary work;
- finalization happens before all 10 settlements or occurs more than once;
- correction-propagation gate fails when required;
- trust/privacy-critical event state is malformed or contradictory such that safe reduction is impossible.

On first hard failure, GBrain atomically performs the state transition:

```text
append canary_aborted {
  run_id,
  disposition: "repair",
  reason_code,
  triggering_event_id
}
```

After `canary_aborted` is durable, that run accepts no further injection, cohort admission, counting, verdict evidence, canonical activation, or settlement mutation. Later deliveries for the aborted run are diagnostics only. Ordinary Codex work continues. A fresh run may be armed after the bounded fix without deleting prior evidence.

## 17. Learning-loop mode semantics

```text
learning_loop.mode = off | capture | canary
```

Default is `off`. Merge never changes the live mode.

- **`off`**: no Learning Loop session capture, distillation/activation, context retrieval/injection, outcome reduction, or canary counting. Existing unrelated GBrain behavior remains unchanged.
- **`capture`**: accept local completed-session/evidence capture and may perform candidate distillation/diagnostics, but **no context injection**, **no active canary cohort admission/counting**, **no canary verdict advancement**, and no automatic canonical activation that depends on canary authority. This mode is for smoke/rollback observation only.
- **`canary`**: only an explicitly armed nonterminal run may admit/count its sealed cohort, retrieve/inject bounded context, activate/correct under this contract, reduce typed outcomes, settle sessions, and finalize/abort.

Changing `canary -> capture|off` while a run is nonterminal first appends terminal `canary_aborted(disposition='repair', reason_code='operator_rollback')`, then changes mode. The mode change alone never silently abandons a run.

## 18. Lifecycle and activation

```text
off
  -> capture smoke (optional)
  -> explicit canary arm -> run A: armed/running
                         -> finalized(keep|repair|broaden)
                         -> aborted(repair)

repair/abort -> bounded fix -> explicit fresh arm -> run B
```

Arming refuses while a nonterminal run exists, resolves/fixes the brain/source destination, freezes the complete run payload, validates V1 provider allow-list is exactly `['codex']`, and appends one `canary_armed`.

Historical finalized/aborted runs remain immutable and do not make a fresh run terminal.

## 19. Delivery sequence

Only one implementation PR may be actively mutated at a time.

### PR 0 — this contract

Documentation only. Freeze the architecture and contracts. No runtime/config activation.

### PR 1 — run/session/event foundation

GBrain-owned provider/session types, frozen run payload, append-only ledger, one-active-run invariant, session uniqueness, sealed 10-session cohort admission, deterministic expected outcome ID and immutable close manifest, deterministic eligibility, default-off mode resolver, and trusted-local capture seam. PR 1 may define/store the outcome envelope type and expected ID but does not interpret distillation/injection/verdict evidence.

### PR 2 — canonical activation/correction

Learning-class mapping, canonical discriminator encoding, forge-qualified scope targets, trigger state, explicit brain/source routing, activation thresholds, direct correction/supersession, rebuild verification, and Seascape boundary. No injection.

### PR 3 — context request/bundle/telemetry

Exact request-byte codec, canonical relevance normalization/rejection, explicit scope request, precision-biased retrieval, class/scope/trigger reconstruction, exact scope matching, five-item/800-token caps, exact accepted `context_supplied` telemetry, and empty-context fail-open behavior.

### PR 4 — thin Codex adapter

Bootstrap submits the explicit normalized request. Close submits `CompletedSessionV1` plus the one deterministic `SessionOutcomeV1` for every counted session, including an explicit empty evidence array when there is no outcome evidence. Adapter owns no routing, memory, scoring, settlement, or verdict logic. No live activation in PR.

### PR 5 — outcome/settlement/finalization

Typed evidence validation, canonical outcome hashing/replay semantics, context-telemetry binding, semantic benefit/irrelevance dedupe, typed trigger transitions, reducer-owned deterministic settlement, correction-propagation reducer, normalized baseline rates, immediate abort behavior, deterministic verdict, and plain-English terminal output.

### PR 6 — cleanup only after successful canary

After `keep` or `broaden`, remove displaced manual memory-promotion/session-summary/reminder/bootstrap machinery. No research/skills/business expansion.

## 20. Required regression matrix

Implementation must prove at minimum:

- Codex/Claude representable, V1 arming Codex-only;
- session same-hash retry idempotent; changed-hash conflict fail-closed;
- exactly 10 admitted cohort sessions; session 11 cannot change cohort while settlement is pending;
- old terminal run cannot contaminate a fresh run;
- hard failure before session 10 immediately aborts, stops injection/counting, and permits fresh arm after repair;
- rollback abort permits a fresh run without history deletion;
- frozen config/version/baseline remain unchanged during reduction;
- brain/source ambient mount cannot redirect memory operations;
- every active Loop class round-trips through fact fence/discriminator;
- base64url/null sentinel round-trips literal `-`, `~`, Unicode, and delimiter-like values;
- repository identity distinguishes identical paths on different forges;
- missing/mismatched scope fails closed;
- pending open loop injects; terminal/triggerless/malformed loop does not after rebuild;
- request codec is NFC + LF, most-recent-four-turns, exact binary format, stable SHA-256 hash, reject >2,000 normalized text UTF-8 bytes, never truncate;
- canonical-equivalent request input yields identical request hash;
- retrieval never reconstructs missing request scope/window from ambient state;
- every counted session deterministically requires exactly one outcome ID; omitted outcome cannot settle;
- empty explicit outcome can settle when there are no mutation obligations;
- outcome/evidence same-payload replay is idempotent; changed-payload collision is fail-closed;
- every negative evidence variant round-trips with exact pointer/request/strength semantics;
- beneficial use requires matching accepted `context_supplied` run/provider/session/request/pointer;
- beneficial and irrelevant metrics count at most once per run/provider/session/pointer;
- trigger transition requires exact pointer+trigger ID and non-agent strength;
- session 10 cannot finalize before every cohort session settles;
- no-correction propagation passes vacuously; correction case requires supersession + later exclusion + rebuild verification;
- normalized baseline rate rejects false improvement from unequal cohort sizes;
- no baseline cannot broaden;
- `off`, `capture`, and `canary` behaviors are mutually distinct exactly as section 17 defines;
- hard failure always results in repair/abort even if broaden evidence otherwise passes;
- capture/retrieval failure does not block ordinary work;
- Seascape business candidate cannot enter personal writer;
- no activation occurs merely from merge.

## 21. PR 1 handoff

Implement PR 1 from this exact merged document only. Scope: provider/session/run/event contracts, frozen run payload, global session uniqueness, sealed 10-session cohort, deterministic outcome-ID derivation and immutable close manifest, one-active-run invariant, append-only ledger/reducer, deterministic eligibility, exact mode resolver defaulting off, and trusted-local capture seam with hermetic replay/cross-run tests. Reuse existing GBrain transcript discovery and brain/source routing. Do not implement canonical distillation, context injection, hooks, outcome evidence scoring, settlement reduction, Claude ingestion, skills, research, Sawyer Hub runtime dependency, Seascape writes, activation, scheduling, merge, or deployment.

## 22. Provenance

- Base branch: `master`
- Base SHA at PR creation: `cfc90a15cbbb50058be79b414be3e57a353552f8`
- This contract is documentation-only.
- Merge, install, schedule, and runtime activation remain separate actions.

The implementation must remain smaller than the system it replaces.