# GBrain memory-engine boundary and Seascape Intelligence relationship

Status: proposed architecture decision

## Decision

This document records the broader architecture agreed during Sawyer's AI operating-system and Seascape Intelligence planning work.

GBrain is a replaceable memory engine. It is not the Seascape Company Brain, not the business system of record, and not a prerequisite for Seascape Intelligence to function.

Seascape Intelligence is the larger company learning system. Its job is to connect current evidence, deterministic business logic, historical context, recommendations, approved actions, costs, measured outcomes, and durable learning.

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
  └─ operating episodes: evidence -> authority -> decision -> action -> cost -> outcome -> learning
```

GBrain may improve a decision by supplying relevant historical or unstructured context. It must not determine current availability, reservation state, revenue truth, financial truth, action authority, whether an external action occurred, or whether a business intervention succeeded.

Memory never outranks current evidence.

## First Seascape proof: Operating Episodes

Company-brain work must not wait for GBrain to be "finished." It must also not begin by building a broad Company Brain platform, dashboard, or new manual knowledge-maintenance workflow.

The first proof is a bounded Operating Episode program: assemble ten completed or decision-ready operating cases from evidence already produced by the business. Begin with the current launch-readiness and unit-economics decision for 813 38th St W, then choose additional cases with meaningful actions, costs, or observable outcomes.

Each episode should connect:

```text
property and time period
  -> current source evidence
  -> applicable constraint and decision authority
  -> decision
  -> action or deliberate no-action
  -> direct cost and Sawyer time
  -> immediate result
  -> later business outcome
  -> causal confidence
  -> reusable learning
```

The episode program must be assembled by agents from operating evidence. Sawyer must not become responsible for filing every case, choosing a storage path, refreshing a projection, or maintaining a new canon.

The initial ten cases are an evidence program, not a software-product commitment. Sellable-night and booking-gap loss is one eligible episode class; it is not a prerequisite, mandatory first product, or reason to delay a stronger current operating case.

After the first ten episodes, repeated evidence determines which product or capability view earns investment. Do not select the first product only because its concept sounds compelling.

## Applications built on the same learning substrate

The earlier product ideas are not separate random projects. They are possible views over the same evidence -> action -> outcome history.

```text
               AI-NATIVE SEASCAPE
                       │
                OPERATING EPISODES
                       │
 evidence -> authority -> decision -> cost -> outcome
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

Examples of evidence selecting a product view:

- repeated sellability, pricing, or restriction losses may justify Property Loss Ledger;
- repeated owner expectations, concerns, and interventions may justify Owner Churn Radar;
- repeated evidence-backed value creation may justify Management Alpha;
- repeated asset failures and repair histories may justify Property Passport;
- repeated preventable guest questions may justify Guest Friction;
- repeated agreement/authority mismatches may justify Contract Runtime.

The durable moat is not the chatbot or the memory engine. It is the proprietary relationship between property conditions, market conditions, operating decisions, interventions, costs, and verified outcomes accumulated over time.

## GBrain's role

GBrain's job is narrower:

> What relevant things have we learned before that may improve the current decision?

Seascape Intelligence's job is broader:

> What is happening, what authority and constraints apply, what should we do, what did it cost, what happened afterward, and what should the company learn?

Seascape Intelligence is therefore a consumer of GBrain. Business requirements may pull specific GBrain capabilities. GBrain development must not push speculative memory features into the business architecture.

## GBrain work filter

A new GBrain change must name one of these consumers:

1. the bounded Personal Learning Loop experiment;
2. an existing retrieval/reliability requirement;
3. a demonstrated Seascape Intelligence requirement arising from real operating episodes; or
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

The Personal Learning Loop remains a bounded challenger experiment. Its purpose is to prove that useful durable knowledge can be learned and supplied later without Sawyer filing notes, choosing storage locations, promoting canon, or grooming memory.

Its success condition is a material measured reduction in Sawyer corrections or supervision, without weakening accuracy or making fresh-session work depend on GBrain.

The roadmap is not an obligation to complete PR4, PR5, a canary, or cleanup merely because those stages were previously designed. Each next stage requires a separate evidence-based decision.

### Do not broaden without a proven consumer

Do not add generic dashboards, broad autonomous enrichment, speculative graph features, additional administration surfaces, generic orchestration, or other memory machinery merely because they may become useful later.

## Dependency and replaceability rules

Fresh agent work and Seascape Intelligence must continue to work when GBrain is unavailable. GBrain may add context; it does not become a hidden prerequisite until a separate acceptance decision explicitly promotes it after proof.

If OpenAI, Anthropic, a native platform, an open-source system, or another provider later supplies a better memory layer, Seascape Intelligence must be able to replace GBrain without losing canonical business truth, action history, property ontology, operating episodes, or outcome history.

That replaceability is intentional.

## Current execution relationship

Run two bounded fronts in parallel rather than serializing the business strategy behind memory work:

```text
Track A: Personal Agent Runtime / GBrain challenger
  Objective: reduce Sawyer supervision.
  Required work must succeed without GBrain.
  Do not broaden the Learning Loop roadmap without a separate decision.

Track B: Seascape Operating Episode program
  Objective: assemble ten evidence-backed operating cases.
  Begin with the 813 38th St W launch-readiness and economics decision.
  Let repeated cases determine the first product view.
  This work does not wait for Track A.
```

## Product investment rule

For each possible product idea, evaluate three separate questions:

1. Does it materially improve Seascape as an AI-native operator?
2. Does it create proprietary learning or outcome data that strengthens the company learning system?
3. Could it later stand alone as a product or managed service with paying and renewing customers?

An idea can be valuable even if the answer to question 3 is no. A software product does not earn broad investment without repeated operating evidence and customer proof.

## Provenance note

At the time this decision was recorded, current Learning Loop implementation work was incomplete and activation remained separate. Transient PR, runtime, install, and canary status are operational provenance only; they are not the architectural decision recorded here.

No merge, runtime switch, executable installation, Learning Loop activation, Seascape business write, guest or owner communication, payment, or external action is authorized by this document.
