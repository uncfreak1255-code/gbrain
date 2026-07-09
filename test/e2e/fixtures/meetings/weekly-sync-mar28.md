---
type: meeting
title: 'Weekly Sync — March 28, 2025'
date: '2025-03-28T00:00:00.000Z'
ingested_at: '2026-07-03T11:53:35.574Z'
source_kind: put_page
ingested_via: put_page
tags:
  - internal
  - weekly
---

# Weekly Sync — March 28, 2025

Date: March 28, 2025
Format: Internal weekly sync
Duration: 45 minutes

## Topics Covered

### NovaMind Follow-Up

[[sarah-chen|Sarah Chen]] confirmed the seed round closed today. $4M led by [[threshold-ventures|Threshold Ventures]] with
[[marcus-reid|Marcus Reid]] taking a board seat. She is moving to hiring mode immediately. Discussed
potential introductions to senior engineers in our network with distributed systems
backgrounds.

[[novamind|NovaMind]] is on track for Q3 2025 launch with 2 enterprise design partners already
signed in procurement vertical. The 94% task completion rate from Demo Day has held up
in continued testing.

### Threshold Ventures Partnership

[[marcus-reid|Marcus Reid]] has been responsive and collaborative. He expressed interest in seeing
other AI infrastructure companies. [[threshold-ventures|Threshold Ventures]]' thesis around agent-native enterprise
software aligns well with several companies in the current YC batch and recent alumni.

### GBrain Search Quality

Current keyword-only search is missing relevant results when queries use different
terminology than stored documents. Example: searching "autonomous agents" does not
surface pages about "AI agents" or "agentic systems." Need semantic similarity via
vector embeddings.

Discussed hybrid search approach: combine vector similarity search with keyword
full-text search using Reciprocal Rank Fusion (RRF). This would handle both exact
keyword matches and semantic near-matches. [[priya-patel|Priya Patel]]'s [[novamind|NovaMind]] architecture is a
good case study — searching for "multi-agent coordination" should surface her page
even if those exact words are not in every mention.

## Transcript Highlights

**Sarah Chen:** The seed is closed and we are moving straight into hiring mode.
**Marcus Reid:** Threshold wants to see more agent-native infrastructure companies with real reliability metrics.
**Priya Patel:** Hybrid search matters because the same concept appears as autonomous agents, AI agents, and agentic systems.
**Sarah Chen:** NovaMind is holding the Demo Day task completion rate in continued testing, which gives us room to push on design partners.

## Key Decisions

- Ship hybrid search in GBrain v0.3. This is the highest priority feature.
- Use pgvector for embeddings, stored alongside content in Postgres.
- Adopt Reciprocal Rank Fusion to merge vector and keyword result sets.
- Continue tracking NovaMind progress for potential deeper engagement.

## Action Items

- [ ] Implement pgvector extension and embedding storage in GBrain schema
- [ ] Build hybrid search with RRF scoring in GBrain v0.3
- [x] Follow up with [[sarah-chen|Sarah Chen]] on seed round status — confirmed closed
- [ ] Send [[marcus-reid|Marcus Reid]] list of AI infrastructure companies from recent batches
- [ ] Write compiled-truth page for hybrid search concept
- [ ] Schedule technical deep dive with [[priya-patel|Priya Patel]] on multi-agent systems

<!-- timeline -->

## Timeline

### 2025-03-28 — Meeting Notes

Productive sync. The GBrain search discussion was the most substantive — we identified
clear failure cases with keyword-only search and agreed on the hybrid approach. The
[[novamind|NovaMind]] seed closing is good news and validates the W25 batch quality. [[marcus-reid|Marcus Reid]]
continues to be a strong partner in the AI investment ecosystem. Next weekly sync
scheduled for April 4.
