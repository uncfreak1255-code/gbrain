# Sawyer Learning Loop V1 — canonical contract

**Status:** implementation contract only; merge does not activate runtime behavior  
**Owner:** GBrain core plus one thin adapter in the existing owner of Codex session hooks  
**Decision:** reuse GBrain primitives; do not create a parallel memory product or supervision layer

## 1. Purpose and success condition

Sawyer Learning Loop V1 closes one bounded loop:

```text
completed Codex session
  -> deterministic local eligibility/capture
  -> qualified personal learning/correction
  -> canonical private GBrain fact
  -> thin relevant context on a later session
  -> typed objective outcome/user correction
  -> deterministic canary disposition
```

V1 evaluates exactly **10 eligible Codex sessions** in one explicitly armed `run_id` and ends with exactly one terminal disposition:

- `keep`: healthy/useful but not proven enough to broaden;
- `repair`: a trust-critical invariant failed; represented by terminal `canary_aborted`;
- `broaden`: every broaden gate passed; only then may a later change add a Claude adapter using these same contracts.

The user must not maintain a queue, advance counters, inspect Markdown receipts, remember an end date, or supervise routine progress.

## 2. Non-goals and authority boundaries

V1 does **not** add a dashboard, queue, agent hierarchy, new repository/database, generic knowledge graph, research ingestion, skill/config self-editing, PR/merge/deploy/install/send automation, scheduling, Claude ingestion, ChatGPT ingestion, or Seascape canon promotion.

Personal operating knowledge belongs only to the configured private GBrain destination. Seascape business knowledge remains a separate authority boundary. V1 may surface existing candidate-only business evidence but cannot write, promote, deploy, send, or mutate Seascape canon or any external system.

Raw transcripts remain local-only. Operational telemetry stores hashes, bounded opaque metadata references, IDs, and exact pointers—not conversation bodies, transcript excerpts, or verbatim user corrections.

## 3. Reused GBrain seams

V1 reuses existing transcript discovery/parsing, fact fences and fact extraction, classifier/supersession logic, brain/source routing, `context/volunteer` retrieval, context telemetry, friction evidence, AI-gateway privacy controls, and candidate-only Seascape writeback boundaries.

Markdown fact fences remain canonical. Database rows are rebuildable indexes, never the authoritative memory store.

## 4. Core invariants

1. **Brain-qualified identity.** Every durable personal destination and memory pointer includes `brain_id` and `source_id`. After arming, learning/retrieval/correction/outcome operations route explicitly to those identities; ambient mounts, cwd, or environment variables cannot redirect them.
2. **Run-scoped state.** Every canary has an immutable `run_id`. Run-affecting events carry it. Historical terminal runs never contaminate or block a later explicitly armed run.
3. **One active run.** At most one nonterminal run exists. A run is terminal after exactly one `canary_finalized` or `canary_aborted`.
4. **Frozen inputs.** Arming freezes contract version, GBrain version/commit, provider allow-list, target cohort size, thresholds, personal destination, eligibility-classifier version, and baseline object-or-null. Reducers never substitute mutable current config.
5. **Fail open for work, fail closed for learning.** Capture/retrieval/telemetry faults cannot block ordinary Codex work. Ambiguous routing, malformed state, replay conflicts, unverifiable scope, invalid trigger state, incomplete settlement, or contradictory canonical knowledge suppress learning/injection or terminate the active run as `repair`.
6. **No silent inference promotion.** Direct user correction outranks all other evidence. Single-session agent inference is candidate-only.
7. **Canonical rebuildability.** Any active scoped/open-loop fact retains enough information in canonical Markdown to remain correctly injectable or non-injectable after a full index rebuild.
8. **Hard failure is immediately terminal.** Any hard failure defined by this contract immediately appends `canary_aborted` with `disposition='repair'`, disables further injection/counting for that run, and leaves historical evidence append-only. There is no second repair-finalization path.
9. **No recurring user-maintenance gate.** The architecture itself guarantees no routine Sawyer maintenance. Any runtime condition that requires Sawyer to inspect a queue/receipt, advance a counter, or perform recurring canary upkeep is a hard failure and immediately aborts as `repair`; there is no subjective broaden-time maintenance judgment.

## 5. Provider, session, deterministic eligibility, and cohort contracts

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

### 5.2 GBrain-owned eligibility classifier

Eligibility is owned exclusively by **GBrain core**, never by an adapter. The run freezes `eligibility_classifier='sll-v1-structural'`.

GBrain applies this exact classifier after transcript discovery/parser reuse and session uniqueness:

```ts
interface SessionEligibilityDecisionV1 {
  classifier: 'sll-v1-structural';
  eligible: boolean;
  reason:
    | 'eligible'
    | 'unsupported_provider'
    | 'not_completed'
    | 'transcript_too_small'
    | 'insufficient_conversation_turns';
  normalized_user_turns: number;
  normalized_assistant_turns: number;
  transcript_byte_length: number;
}
```

Deterministic algorithm:

1. If provider is not in the frozen active-run allow-list: ineligible `unsupported_provider`.
2. If `completion !== 'completed'`: ineligible `not_completed`.
3. If `transcript_ref.byte_length < 256`: ineligible `transcript_too_small`.
4. Reuse the existing conversation parser. For counting only, normalize each parsed user/assistant message to NFC, normalize CRLF/CR to LF, trim Unicode whitespace at both ends, and ignore a message whose normalized UTF-8 text is empty.
5. Count normalized messages by role. Require at least **2 user turns and 2 assistant turns**. Otherwise ineligible `insufficient_conversation_turns`.
6. Otherwise eligible.

No lexical concepts such as “simple lookup,” “housekeeping,” “material,” or “substantive” participate in V1 admission. `task_class` is telemetry/retrieval input only and cannot change eligibility. The exact `SessionEligibilityDecisionV1` is appended to the ledger before cohort admission, so the same accepted transcript/parser result always produces the same admission decision.

### 5.3 Frozen cohort admission

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
  reference: EvidenceReferenceV1;
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
  eligibility_classifier: 'sll-v1-structural';
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

Direct correction is performed through the authoritative GBrain correction operation defined in section 12; the ledger stores pointers/event IDs, not the corrected conversational text.

## 9. Metadata-only evidence references

No outcome/baseline reference field accepts free-form prose.

```ts
interface EvidenceReferenceV1 {
  kind:
    | 'event_id'
    | 'receipt_id'
    | 'commit_sha'
    | 'review_id'
    | 'test_run_id'
    | 'local_sha256';
  value: string;
}
```

Validation rules:

- `value` is 1–160 ASCII bytes only;
- allowed bytes are `[A-Za-z0-9._:/@+-]`;
- no whitespace, newline, quote, backtick, percent-escape, or non-ASCII byte is permitted;
- `local_sha256` requires exactly 64 lowercase hex characters;
- `commit_sha` requires 40 or 64 lowercase hex characters;
- adapters must use an opaque ID/hash for local evidence, never a transcript excerpt, user quote, correction wording, prompt, or conversation body;
- an invalid reference rejects that evidence item for learning/verdict use and emits a diagnostic; privacy-critical attempted body persistence is a hard failure.

## 10. Context request and exact request-hash bytes

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
5. reject the request if the retained normalized texts total more than **2,000 UTF-8 bytes**; never truncate;
6. compute `request_hash = lowercase_hex(SHA-256(exact_request_bytes))`.

### 10.1 Exact binary encoding

All integers are unsigned 32-bit big-endian. `utf8(s)` means UTF-8 bytes after normalization. `lp(s)` means `uint32be(byte_length(utf8(s))) || utf8(s)`. Nullable strings encode as `0xffffffff` for null, otherwise `lp(s)`; null and empty string are distinct.

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

The 2,000-byte relevance limit is the sum of `byte_length(utf8(text))` across retained turns after normalization and before prefix overhead. Every adapter/test uses this exact encoding; JSON serialization, alternate delimiters, field reordering, and platform-native encodings are forbidden.

An empty window is valid and may return only globally or otherwise unambiguously applicable context. Retrieval must not recover missing semantic/scope input from raw transcripts, cwd, mounts, ambient Git config, or another checkout.

Telemetry stores the request hash, task class, exact scope targets, turn/byte counts, selected pointers, rationales, and token estimate—never relevance-window text.

## 11. Context bundle and telemetry authority

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

## 12. Authoritative correction operation

A direct user correction never carries corrected prose inside `session_outcome`. Instead, GBrain core owns one correction operation that writes canonical knowledge first and returns an authoritative event linkage:

```ts
interface CorrectionResultV1 {
  correction_event_id: string;
  run_id: string;
  old_pointer: MemoryPointerV1;
  replacement_pointer: MemoryPointerV1;
}
```

The correction operation must, atomically for learning purposes:

1. route using `old_pointer.brain_id/source_id` and the frozen personal destination;
2. append the corrected canonical fact row in Markdown using the complete Loop discriminator;
3. supersede the old canonical row through the existing renderer;
4. reconcile the same brain/source derived index;
5. append `memory_superseded` containing `correction_event_id`, old pointer, replacement pointer, and active `run_id`;
6. return `CorrectionResultV1`.

The actual corrected claim exists only in canonical private Markdown, not in the event ledger/outcome payload.

`user_correction` outcome evidence must carry the exact `correction_event_id`, `old_pointer`, and `replacement_pointer`. The reducer accepts it only if a matching authoritative `memory_superseded` event already exists for the same run and exact pointers. Otherwise the evidence cannot settle and the mismatch is a hard failure.

## 13. Complete typed outcome contract

Every **counted cohort session requires exactly one outcome envelope**, even when its `evidence` array is empty. Outcome completeness is never inferred from adapter silence.

The GBrain-owned deterministic outcome ID is:

```text
outcome_id = lowercase_hex(SHA-256(
  ASCII("SLLOUT1\0") ||
  lp(run_id) ||
  lp(provider) ||
  lp(provider_session_id)
))
```

where `lp` is section 10.1's length-prefix function.

```ts
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
      reference: EvidenceReferenceV1;
    }
  | {
      kind: 'materially_irrelevant';
      evidence_id: string;
      pointer: MemoryPointerV1;
      request_hash: string;
      strength: 'objective' | 'explicit_user';
      reference: EvidenceReferenceV1;
    }
  | {
      kind: 'user_repeated_known_instruction';
      evidence_id: string;
      pointer: MemoryPointerV1;
      request_hash: string;
      strength: 'explicit_user';
      reference: EvidenceReferenceV1;
    }
  | {
      kind: 'agent_reasked_known_answer';
      evidence_id: string;
      pointer: MemoryPointerV1;
      request_hash: string;
      strength: 'objective' | 'explicit_user';
      reference: EvidenceReferenceV1;
    }
  | {
      kind: 'user_correction';
      evidence_id: string;
      correction_event_id: string;
      old_pointer: MemoryPointerV1;
      replacement_pointer: MemoryPointerV1;
      strength: 'explicit_user';
      reference: EvidenceReferenceV1;
    }
  | {
      kind: 'contradicted';
      evidence_id: string;
      pointer: MemoryPointerV1;
      request_hash: string | null;
      strength: 'objective' | 'explicit_user';
      reference: EvidenceReferenceV1;
    }
  | {
      kind: 'open_loop_trigger_transition';
      evidence_id: string;
      pointer: MemoryPointerV1;
      trigger_id: string;
      terminal_state: 'completed' | 'cancelled';
      strength: 'objective' | 'explicit_user';
      reference: EvidenceReferenceV1;
    };

interface SessionOutcomeV1 {
  schema_version: 1;
  run_id: string;
  provider: LearningProviderV1;
  provider_session_id: string;
  outcome_id: string;
  content_hash: string;
  observed_at: string;
  evidence: SessionEvidenceV1[];
}
```

### 13.1 Outcome canonicalization, identity, and replay

Before hashing, NFC-normalize every string and normalize CRLF/CR to LF. Serialize the outcome **excluding `content_hash`** using **RFC 8785 JSON Canonicalization Scheme (JCS)** exactly. `content_hash = lowercase_hex(SHA-256(JCS_UTF8_bytes))`.

V1 payloads contain only JSON-safe integers within the exact-safe integer range, booleans/null when defined, strings, arrays, and objects. No non-finite number is permitted. RFC 8785 is the sole serializer: implementations must not invent alternate escape spellings, key order, whitespace, or numeric rendering.

Identity/replay boundaries:

- outcome uniqueness: `(run_id, provider, provider_session_id, outcome_id)`;
- `outcome_id` must equal the deterministic value in section 13; mismatch is rejected;
- same outcome key + same `content_hash`: idempotent retry;
- same outcome key + different hash: diagnostic replay conflict; changed payload contributes nothing;
- evidence uniqueness: `(run_id, provider, provider_session_id, evidence_id)`;
- duplicate evidence ID + identical RFC-8785 canonical evidence bytes: idempotent;
- duplicate evidence ID + changed canonical evidence bytes: diagnostic conflict and contributes nothing.

Agent-report evidence is not accepted for any verdict-affecting evidence variant in V1.

### 13.2 Telemetry binding and semantic deduplication

`beneficial_use`, `materially_irrelevant`, `user_repeated_known_instruction`, and `agent_reasked_known_answer` require their pointer to appear in the accepted `context_supplied` event for the same `(run_id, provider, provider_session_id, request_hash)`. If no such telemetry exists, that evidence is rejected for verdict purposes.

A beneficial use counts at most once per `(run_id, provider, provider_session_id, pointer)`. Generic task success, corrections, contradiction, trigger transitions, or agent self-report never increment beneficial-use count.

Material irrelevance counts at most once per `(run_id, provider, provider_session_id, pointer)`, regardless of distinct evidence IDs describing the same injection.

Repeated-known-instruction and re-asked-known-answer are supervision errors, never benefits.

`user_correction` is accepted only through the authoritative correction linkage in section 12.

Open-loop transition evidence requires exact pointer and exact trigger ID. Agent self-report cannot transition a trigger. Pointer/trigger mismatch fails closed without canonical mutation.

## 14. Deterministic close manifest and settlement barrier

Every counted cohort session requires exactly one deterministic `SessionOutcomeV1`, so GBrain derives the obligation at admission without relying on a future producer declaration.

When a session is admitted, GBrain appends:

```ts
interface SessionCloseManifestV1 {
  schema_version: 1;
  run_id: string;
  provider: LearningProviderV1;
  provider_session_id: string;
  expected_outcome_id: string;
}
```

There is no `outcome_required=false` state for counted sessions.

Settlement is reducer-owned, not adapter-declared. A cohort session becomes settled only after:

1. its exact expected outcome ID has been accepted and reduced (empty evidence is still an explicit outcome);
2. every accepted correction/trigger-transition evidence has its required authoritative canonical mutation event completed successfully, otherwise the run has already aborted;
3. all session replay/identity conflicts have been reduced to their fail-closed result.

Only then may GBrain append `session_settled`. A delayed/omitted outcome cannot be bypassed because adapters do not declare settlement.

Normal finalization requires exactly 10 sealed cohort sessions and all 10 settlements. Session 10 completion alone never finalizes. Hard failure follows immediate abort and does not wait for settlement.

## 15. Correction-propagation gate

If `require_correction_propagation=false`, this gate is ignored.

If true:

- no accepted direct user correction in the run: passes vacuously;
- one or more accepted corrections: every correction's `memory_superseded` linkage must exist, every old pointer must be absent from every later accepted `context_supplied`, and a full rebuild verification for the corrected brain/source must resolve only the replacement active row. Any failure is a hard failure and immediately aborts as `repair`.

## 16. Event ledger

Local append-only ledger:

```text
$GBRAIN_HOME/learning-loop/events-v1.jsonl
```

Run/state event types include at least:

- `canary_armed`
- `session_completed`
- `session_eligibility_decided`
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

## 17. Deterministic terminal reduction

For the sealed cohort:

```text
canary_error_count =
  repeated_known_instruction_count +
  reasked_known_answer_count +
  user_correction_count

canary_error_rate = canary_error_count / 10
```

For non-null baseline:

```text
baseline_error_count =
  baseline.repeated_known_instruction_count +
  baseline.reasked_known_answer_count +
  baseline.user_correction_count

baseline_error_rate = baseline_error_count / baseline.eligible_sessions
```

`broaden` requires all of:

1. cohort is exactly 10 and all 10 sessions are settled;
2. no `canary_aborted`/hard failure;
3. at least frozen `min_strong_beneficial_uses` accepted beneficial uses;
4. no more than frozen `max_materially_irrelevant_injections` semantic irrelevant injections;
5. correction-propagation gate passes;
6. frozen baseline is non-null;
7. `canary_error_rate < baseline_error_rate`.

If all normal-finalization prerequisites are met, no hard failure occurred, but any broaden-only requirement is unmet, append `canary_finalized(disposition='keep')`.

If every broaden requirement passes, append `canary_finalized(disposition='broaden')`.

**There is no `canary_finalized(disposition='repair')`.** Every trust-critical defect, including one first discovered during final reduction, is a hard failure and appends `canary_aborted(disposition='repair')` exactly once. Thus identical ledgers cannot choose between two repair terminal event types.

A healthy no-baseline run returns `keep`, never `broaden`.

## 18. Hard failures and immediate terminal transition

Hard failures include:

- corrected old memory supplied again;
- memory operation routes to a brain/source other than its frozen destination/pointer;
- scoped memory injected without exact request-target match;
- completed/cancelled/triggerless/malformed open loop injected;
- unsupported high-impact inference causes action;
- Seascape canon or external write occurs through V1;
- duplicate/conflicting session, outcome, or evidence advances metrics;
- cohort exceeds 10 or a post-seal session changes cohort membership;
- settlement is appended before deterministic outcome/mutations are fully reduced;
- run state leaks across `run_id`s;
- reducer substitutes mutable current version/thresholds/classifier;
- historical evidence must be deleted to rerun;
- runtime requires Sawyer to inspect a queue/receipt, advance a counter, remember an end date, or perform recurring canary upkeep;
- injection materially blocks ordinary work;
- finalization happens before all 10 settlements or occurs more than once;
- correction-propagation gate fails when required;
- privacy-critical evidence attempts to persist conversation body/verbatim text;
- trust/privacy-critical event state is malformed or contradictory such that safe reduction is impossible.

On first hard failure, GBrain atomically appends:

```text
canary_aborted {
  run_id,
  disposition: "repair",
  reason_code,
  triggering_event_id
}
```

After this is durable, that run accepts no further injection, cohort admission, counting, verdict evidence, canonical activation, or settlement mutation. Later deliveries are diagnostics only. Ordinary Codex work continues. A fresh run may be armed after the bounded fix without deleting prior evidence.

## 19. Learning-loop mode semantics

```text
learning_loop.mode = off | capture | canary
```

Default is `off`. Merge never changes live mode.

- **`off`**: no Learning Loop session capture, distillation/activation, context retrieval/injection, outcome reduction, or canary counting. Existing unrelated GBrain behavior is unchanged.
- **`capture`**: accept local completed-session/evidence capture and may perform candidate distillation/diagnostics, but **no context injection**, **no active canary cohort admission/counting**, **no canary verdict advancement**, and no automatic canonical activation that depends on canary authority. Smoke/rollback observation only.
- **`canary`**: only an explicitly armed nonterminal run may admit/count its sealed cohort, retrieve/inject bounded context, activate/correct under this contract, reduce typed outcomes, settle sessions, and finalize/abort.

Changing `canary -> capture|off` while a run is nonterminal first appends `canary_aborted(disposition='repair', reason_code='operator_rollback')`, then changes mode. Mode change alone never silently abandons a run.

## 20. Lifecycle and activation

```text
off
  -> capture smoke (optional)
  -> explicit canary arm -> run A: armed/running
                         -> finalized(keep|broaden)
                         -> aborted(repair)

repair/abort -> bounded fix -> explicit fresh arm -> run B
```

Arming refuses while a nonterminal run exists, resolves/freezes brain/source destination, freezes the complete run payload including classifier version, validates V1 provider allow-list is exactly `['codex']`, and appends one `canary_armed`.

Historical finalized/aborted runs remain immutable and do not make a fresh run terminal.

## 21. Delivery sequence

Only one implementation PR may be actively mutated at a time.

### PR 0 — this contract

Documentation only. Freeze architecture/contracts. No runtime/config activation.

### PR 1 — run/session/event foundation

GBrain-owned provider/session types, frozen run payload/classifier, append-only ledger, one-active-run invariant, session uniqueness, deterministic structural eligibility, sealed 10-session cohort admission, deterministic expected outcome ID and immutable close manifest, exact mode resolver defaulting off, and trusted-local capture seam. PR 1 may define/store outcome envelope type/expected ID but does not interpret verdict evidence.

### PR 2 — canonical activation/correction

Learning-class mapping, canonical discriminator encoding, forge-qualified scope targets, trigger state, explicit brain/source routing, activation thresholds, authoritative correction operation + supersession linkage, rebuild verification, and Seascape boundary. No injection.

### PR 3 — context request/bundle/telemetry

Exact request-byte codec, canonical relevance normalization/rejection, explicit scope request, precision-biased retrieval, class/scope/trigger reconstruction, exact scope matching, five-item/800-token caps, accepted `context_supplied` telemetry, empty-context fail-open.

### PR 4 — thin Codex adapter

Bootstrap submits explicit normalized request. Close submits `CompletedSessionV1` plus the one deterministic `SessionOutcomeV1` for every counted session, including explicit empty evidence when needed. Adapter owns no eligibility decision, routing, memory, scoring, settlement, or verdict logic. No live activation.

### PR 5 — outcome/settlement/finalization

Typed evidence/reference validation, RFC-8785 outcome hashing/replay, context-telemetry binding, semantic benefit/irrelevance dedupe, correction/trigger linkage, reducer-owned settlement, correction propagation, normalized baseline rates, immediate abort, deterministic keep/broaden finalization, plain-English terminal output.

### PR 6 — cleanup only after successful canary

After `keep` or `broaden`, remove displaced manual memory-promotion/session-summary/reminder/bootstrap machinery. No research/skills/business expansion.

## 22. Required regression matrix

Implementation must prove at minimum:

- Codex/Claude representable, V1 arming Codex-only;
- session same-hash retry idempotent; changed-hash conflict fail-closed;
- eligibility classifier is GBrain-owned, frozen by version, and identical transcript/parser results yield identical decisions;
- exact structural eligibility boundaries at 255/256 bytes and 1/2 user/assistant normalized turns;
- task class/adapters cannot override eligibility;
- exactly 10 admitted cohort sessions; session 11 cannot change cohort while settlement pending;
- old terminal run cannot contaminate fresh run;
- hard failure before session 10 immediately aborts/stops injection/counting and permits fresh arm after repair;
- final-reduction trust failure uses the same `canary_aborted(repair)` path, never a second repair event type;
- rollback abort permits fresh run without history deletion;
- frozen config/version/baseline/classifier remain unchanged during reduction;
- ambient mount cannot redirect brain/source operations;
- every active Loop class round-trips through fact fence/discriminator;
- base64url/null sentinel round-trips literal `-`, `~`, Unicode, delimiters;
- repository identity distinguishes same path on different forges;
- missing/mismatched scope fails closed;
- pending open loop injects; terminal/triggerless/malformed loop does not after rebuild;
- request codec is NFC + LF, most-recent-four-turns, exact binary format, stable SHA-256, reject >2,000 normalized text UTF-8 bytes, never truncate;
- canonical-equivalent request input yields identical hash;
- retrieval never reconstructs missing request scope/window from ambient state;
- evidence references reject whitespace/body text and accept only bounded typed metadata;
- correction evidence requires exact authoritative correction event + old/replacement pointers, and corrected prose is absent from ledger;
- every counted session deterministically requires exactly one outcome ID; omitted outcome cannot settle;
- explicit empty outcome can settle when no mutation obligations exist;
- outcome hash is RFC 8785 JCS and cross-implementation control-character strings hash identically;
- outcome/evidence same-payload replay idempotent; changed-payload collision fail-closed;
- every negative evidence variant round-trips exact pointer/request/strength/reference semantics;
- beneficial use requires matching accepted context run/provider/session/request/pointer;
- beneficial and irrelevant metrics count at most once per run/provider/session/pointer;
- trigger transition requires exact pointer+trigger ID and non-agent strength;
- session 10 cannot finalize before every cohort session settles;
- no-correction propagation passes vacuously; correction case requires authoritative supersession + later exclusion + rebuild verification;
- normalized baseline rate rejects false improvement from unequal cohort sizes;
- no baseline cannot broaden;
- `off`, `capture`, `canary` are mutually distinct exactly as section 19 defines;
- any discovered need for recurring Sawyer canary maintenance is a hard failure, not a subjective broaden gate;
- hard failure always terminates as repair/abort even if broaden evidence otherwise passes;
- capture/retrieval failure does not block ordinary work;
- Seascape business candidate cannot enter personal writer;
- merge alone never activates V1.

## 23. PR 1 handoff

Implement PR 1 from this exact merged document only. Scope: provider/session/run/event contracts, frozen run payload/classifier, global session uniqueness, GBrain-owned structural eligibility, sealed 10-session cohort, deterministic outcome-ID derivation and immutable close manifest, one-active-run invariant, append-only ledger/reducer, exact mode resolver defaulting off, and trusted-local capture seam with hermetic replay/cross-run tests. Reuse existing GBrain transcript discovery/parser and brain/source routing. Do not implement canonical distillation, context injection, hooks, evidence scoring, settlement reduction, Claude ingestion, skills, research, Sawyer Hub runtime dependency, Seascape writes, activation, scheduling, merge, or deployment.

## 24. Provenance

- Base branch: `master`
- Base SHA at PR creation: `cfc90a15cbbb50058be79b414be3e57a353552f8`
- This contract is documentation-only.
- Merge, install, schedule, and runtime activation remain separate actions.

The implementation must remain smaller than the system it replaces.