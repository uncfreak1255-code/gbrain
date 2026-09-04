# GBrain memory-engine boundary

Status: proposed architecture boundary

## Decision

GBrain is a replaceable memory engine, not the Seascape Company Brain and not a required source of live business truth.

The Seascape Company Brain is the larger closed-loop business system that connects current evidence, deterministic business logic, historical context, recommendations, approved actions, measured outcomes, and durable learning.

The relationship is therefore:

```text
Seascape Intelligence / Company Learning System
  ├─ structured truth: Analytics / Hostaway / operational systems
  ├─ historical context: GBrain, when useful and available
  ├─ actions: Ops and explicitly authorized adapters
  └─ outcome ledger: intervention -> result -> learning
```

GBrain may improve a business decision by supplying relevant historical or unstructured context. It must not determine current availability, reservation state, revenue truth, financial truth, action authority, whether an external action occurred, or whether a business intervention succeeded.

## Product direction

Company-brain work must not wait for GBrain to be "finished." Business loops should be built from their required sources and deterministic logic first. GBrain is integrated only where an observed business requirement proves that historical/unstructured context improves the decision.

Initial relationship:

```text
Track A: Personal Learning Loop
  prove automatic durable personal context reduces Sawyer supervision

Track B: Seascape Intelligence Loop 001
  prove property-level loss -> evidence -> recommendation -> intervention -> outcome

Integrate only when Track B has a demonstrated context need that GBrain can satisfy reliably.
```

Seascape Intelligence is therefore a consumer of GBrain. GBrain development must not push speculative memory features into the business architecture.

## GBrain work filter

A new GBrain change must name one of these consumers:

1. the bounded Personal Learning Loop experiment;
2. an existing GBrain retrieval/reliability requirement;
3. a demonstrated Seascape Intelligence requirement; or
4. a concrete downstream consumer already in use.

"Could be useful for the future Company Brain" is not sufficient justification.

### Keep / prioritize

Work that makes GBrain a reliable low-maintenance memory component, including:

- retrieval correctness and availability;
- source citations and provenance;
- temporal correctness;
- correction and reversal;
- scope isolation;
- bounded context delivery;
- cost controls;
- cross-session/provider access;
- automatic qualified learning, only if it reduces Sawyer maintenance.

### Experiment

The Personal Learning Loop remains a bounded experiment. Its purpose is to prove that useful durable knowledge can be learned and supplied later without Sawyer filing notes, choosing storage locations, promoting canon, or grooming memory.

Its success condition is reduced Sawyer supervision, not architectural completeness.

### Do not broaden without a proven consumer

Do not add generic dashboards, broad autonomous enrichment, speculative graph features, additional administration surfaces, generic orchestration, or other memory machinery merely because it may become useful later.

## Dependency rule

Fresh agent work and Seascape Intelligence must fail open with respect to GBrain availability: required work still succeeds when GBrain is unavailable. GBrain may add context; it does not become a hidden prerequisite until a separate acceptance decision explicitly promotes it after proof.

Memory never outranks current evidence. Repository/runtime truth and current business-system truth remain authoritative over recalled knowledge.

## Personal Learning Loop status at this decision

GitHub `master` is `f1d2a2cd13505d799daf1465c8b5c634deaf06a8`, which includes PR #121 canonical scope-identity hardening.

Roadmap state:

- PR1: done.
- PR2 and hardening: done.
- PR3: draft PR #122, bounded context retrieval; not merged.
- PR4: not started.
- PR5: not started.
- Canary: not armed; blocked on PR3-PR5 prerequisites and explicit activation.
- PR6: blocked until a successful keep/broaden canary.

The local `128d49631f981b08b717c5df0e3a65d25a06a020` source-qualified page-lock backport is not a merged or released commit and must not be treated as Learning Loop activation or as the canonical install candidate.

No runtime switch or executable installation is authorized by this document. `learning_loop.mode` remains effectively off unless separately activated under the existing ADR.

## First Seascape consumer

The first Company Brain experiment should be Seascape Intelligence Loop 001: property-level sellable-night / booking-gap loss.

It must work without GBrain and should establish the core business loop:

```text
current source evidence
  -> deterministic finding
  -> explanation / competing hypotheses
  -> recommended intervention
  -> approved action
  -> measured outcome
  -> durable learning
```

After the loop works, evaluate what contextual information was missing. Integrate GBrain only for needs it can answer reliably. This keeps the proprietary asset in the property ontology, evidence lineage, interventions, outcomes, and accumulated operating intelligence rather than in any one memory implementation.

## Replaceability test

If a better memory layer becomes available from OpenAI, Anthropic, an open-source project, or another provider, Seascape Intelligence must be able to replace GBrain without losing its canonical business truth, action history, or outcome ledger.

That replaceability is intentional, not a migration failure.
