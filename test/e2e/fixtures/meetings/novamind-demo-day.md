---
type: meeting
title: NovaMind — YC W25 Demo Day
date: '2025-03-15T00:00:00.000Z'
ingested_at: '2026-07-03T11:53:33.869Z'
source_kind: put_page
ingested_via: put_page
tags:
  - demo-day
  - yc-w25
---

# NovaMind — YC W25 Demo Day

Date: March 15, 2025
Location: YC HQ, San Francisco
Format: W25 batch Demo Day presentations + 1:1 meetings

## Attendees

- [[sarah-chen|Sarah Chen]] ([[novamind|NovaMind]] CEO, presenter)
- [[priya-patel|Priya Patel]] ([[novamind|NovaMind]] CTO, in audience)
- [[marcus-reid|Marcus Reid]] ([[threshold-ventures|Threshold Ventures]] GP)
- ~200 investors in main audience
- Full W25 batch presenting

## Summary

[[sarah-chen|Sarah Chen]] presented [[novamind|NovaMind]]'s autonomous agent platform. The live demo was the
highlight of the batch: an AI agent completed a 47-step procurement workflow in under
4 minutes with zero human intervention. Steps included vendor discovery, RFQ
generation, bid comparison across 5 vendors, approval chain routing, and PO creation.

The agent handled two deliberate failure injections during the demo — a vendor API
timeout and a budget threshold violation — recovering gracefully both times through
the supervisor agent re-planning mechanism.

## 1:1 After Presentation

Had a 20-minute 1:1 with Sarah after the main presentations. Key discussion points:

- She described their architecture as "compiled procedures" rather than prompt chains.
  Agents learn reusable sub-routines from successful task completions.
- The multi-agent coordination layer was designed by [[priya-patel|Priya Patel]] based on her Stanford
  PhD research on emergent communication.
- Current team is 4 people. Looking to hire 3-4 senior engineers post-fundraise.
- Go-to-market is vertical-first: procurement and supply chain initially.

## Transcript Highlights

**Sarah Chen:** We think of these workflows as compiled procedures rather than prompt chains.
**Sarah Chen:** The goal is to let agents learn reusable sub-routines from successful task completions.
**Priya Patel:** The coordination layer matters because agents need to hand off state without brittle graphs.
**Marcus Reid:** The recovery behavior on the failure injections is what made NovaMind feel investable immediately.

## Key Decisions

- Follow up with [[sarah-chen|Sarah Chen]] for a deeper technical dive on the agent architecture.
- Intro [[marcus-reid|Marcus Reid]] ([[threshold-ventures|Threshold Ventures]]) to Sarah if he has not already connected — he focuses
  on AI/ML investments and this is squarely in his thesis.
- Track [[novamind|NovaMind]] as a potential portfolio company or collaboration partner.

## Action Items

- [ ] Schedule follow-up call with [[sarah-chen|Sarah Chen]] for architecture deep dive
- [ ] Send [[marcus-reid|Marcus Reid]] intro email if needed
- [ ] Research procurement automation market size for context
- [ ] Revisit agent memory architecture discussion (ran out of time)

<!-- timeline -->

## Timeline

### 2025-03-15 — Event Notes

Arrived at YC HQ at 9am. NovaMind presented in the second block around 10:30am. Sarah
was polished and the demo worked flawlessly. The failure injection moments drew audible
reactions from the audience when the agent recovered. [[marcus-reid|Marcus Reid]] approached Sarah
immediately after the presentations. Had my 1:1 around 11:15am in the side room. Sarah
was energetic but focused — she clearly had a plan and knew exactly what she wanted
from the fundraise.
