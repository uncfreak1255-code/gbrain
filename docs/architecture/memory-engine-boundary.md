# GBrain memory-engine boundary and Seascape Intelligence relationship

Status: proposed architecture decision

## Decision

This document records the broader architecture agreed during Sawyer's AI operating-system and Seascape Intelligence planning work.

GBrain is a replaceable memory engine. It is not the Seascape Company Brain, not the business system of record, and not a prerequisite for Seascape Intelligence to function.

Seascape Intelligence is the larger company learning system. Its job is to connect current evidence, deterministic business logic, historical context, recommendations, approved actions, measured outcomes, and durable learning.

```text
                    SAWYER
                       │
              capital allocation
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
   Personal AI OS           Seascape Intelligence
   learns how to work       learns the business
          │                         │
          └────────────┬────────────┘
                       ▼
                  real action
                       ▼
                    outcome
                       ▼
                    learning
                       └──────────↺
```

The two systems reinforce each other but remain separable:

- Sawyer's Personal AI OS reduces the supervision required to plan, build, verify, and learn.
- Seascape Intelligence compounds business-specific operating intelligence.
- GBrain may serve both as a memory/context component, but neither system is allowed to depend on GBrain before it earns that role through proof.

## Seascape Intelligence architecture

```text
Seascape Intelligence / Company Learning System
  ├─ current structured truth: Analytics / Hostaway / operational systems
  ├─ deterministic business logic: metrics, contracts, rules, evidence
  ├─ historical/unstructured context: GBrain when useful and available
  ├─ actions: Ops and explicitly authorized adapters
  └─ outcome ledger: finding -> intervention -> result -> learning
```

GBrain may improve a decision by supplying relevant historical or unstructured context. It must not determine current availability, reservation state, revenue truth, financial truth, action authority, whether an external action occurred, or whether a business intervention succeeded.

Memory never outranks current evidence.

## Product direction

Company-brain work must not wait for GBrain to be "finished." Business loops should be built from their required data and deterministic logic first. GBrain is integrated only where an observed business requirement proves that historical or unstructured context improves the decision.

The first complete Seascape learning loop is intended to be property-level performance intelligence:

```text
current source evidence
  -> deterministic finding
  -> explanation / competing hypotheses
  -> recommended intervention
  -> approved action
  -> measured outcome
  -> durable learning
```

The initial wedge is the Property Loss Ledger / sellable-night and booking-gap loop. That loop must work without GBrain.

After it works, ask what context was missing. If GBrain can supply that context reliably and with less Sawyer supervision, integrate it. If not, do not force it into the business architecture.

## Applications built on the company learning system

The earlier product ideas are not separate random projects. They are applications over the same evidence -> action -> outcome substrate.

```text
               AI-NATIVE SEASCAPE
                       │
                COMPANY LEARNING
                       │
        evidence -> decision -> outcome
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
 PERFORMANCE       RELATIONSHIP       PHYSICAL
 INTELLIGENCE      INTELLIGENCE      INTELLIGENCE
       │               │                │
 Loss Ledger       Churn Radar       Property Passport
 Management Alpha  Owner Success     Maintenance intelligence
 Guest Friction    Contract Runtime  Future physical agents
```

The durable moat is not the chatbot or the memory engine. It is the proprietary relationship between property conditions, market conditions, operating decisions, interventions, and verified outcomes accumulated over time.

## GBrain's role

GBrain's job is narrower:

> What relevant things have we learned before that may improve the current decision?

Seascape Intelligence's job is broader:

> What is happening, why, what should we do, what happened afterward, and what did we learn?

Seascape Intelligence is therefore a consumer of GBrain. GBrain development must not push speculative memory features into the business architecture.

## GBrain work filter

A new GBrain change must name one of these consumers:

1. the bounded Personal Learning Loop experiment;
2. an existing retrieval/reliability requirement;
3. a demonstrated Seascape Intelligence requirement; or
4. a concrete downstream consumer already in use.

"Could be useful for the future Company Brain" is not sufficient justification.

### Keep / prioritize

Work that makes GBrain a reliable, low-maintenance memory component, including:

- retrieval correctness and availability;
- source citations and provenance;
- temporal correctness;
- correction and reversal;
- scope isolation;
- bounded context delivery;
- cost controls;
- cross-session/provider access;
- automatic qualified learning, only if it reduces Sawyer maintenance.

### Bounded experiment

The Personal Learning Loop remains a bounded experiment. Its purpose is to prove that useful durable knowledge can be learned and supplied later without Sawyer filing notes, choosing storage locations, promoting canon, or grooming memory.

Its success condition is reduced Sawyer supervision, not architectural completeness.

### Do not broaden without a proven consumer

Do not add generic dashboards, broad autonomous enrichment, speculative graph features, additional administration surfaces, generic orchestration, or other memory machinery merely because they may become useful later.

## Dependency and replaceability rules

Fresh agent work and Seascape Intelligence must continue to work when GBrain is unavailable. GBrain may add context; it does not become a hidden prerequisite until a separate acceptance decision explicitly promotes it after proof.

If OpenAI, Anthropic, an open-source system, or another provider later supplies a better memory layer, Seascape Intelligence must be able to replace GBrain without losing canonical business truth, action history, property ontology, or outcome history.

That replaceability is intentional.

## Current execution relationship

Run two fronts in parallel rather than serializing the company strategy behind memory work:

```text
Track A: Personal AI Runtime / GBrain Learning Loop
  Objective: reduce Sawyer supervision.
  GBrain is the challenger memory engine and must earn promotion.

Track B: Seascape Intelligence Loop 001
  Objective: prove property-level loss -> evidence -> intervention -> outcome.
  This work does not wait for Track A.
```

Company-brain requirements may later pull specific GBrain capabilities. GBrain capabilities do not get to push themselves into Company Brain work merely because they exist.

## Product investment rule

For each product idea, evaluate three separate questions:

1. Does it materially improve Seascape as an AI-native operator?
2. Does it create proprietary learning or outcome data that strengthens the company learning system?
3. Could it later stand alone as a product or managed service?

An idea can be valuable even if the answer to question 3 is no.

## Provenance note

At the time this decision was recorded, current Learning Loop implementation work was incomplete and activation remained separate. Transient PR, runtime, install, and canary status are operational provenance only; they are not the architectural decision recorded here.

No runtime switch, executable installation, Learning Loop activation, Seascape business write, or external action is authorized by this document.
