---
type: source
title: Systematicls on agentic loops and verification
reader: agent-reach bird CLI
source_url: 'https://x.com/systematicls/status/2072975573287379194'
captured_at: '2026-07-03T15:16:32Z'
captured_by: codex
captured_via: gbrain
trust_status: 'external source; use as evidence, not canon'
source_author: sysls (@systematicls)
source_platform: x
source_created_at: '2026-07-03T09:27:45Z'
ingested_via: capture-cli
ingested_at: '2026-07-03T15:17:02.940Z'
source_kind: capture-cli
source_uri: stdin
tags:
  - agentic-engineering
  - gstack
  - loops
  - rubrics
  - sawyer-doctrine
  - verification
---

# Systematicls on agentic loops and verification

Source: https://x.com/systematicls/status/2072975573287379194

Author/date: sysls (@systematicls), posted 2026-07-03 09:27:45 UTC.

Capture note: this is a summarized source note, not a verbatim archive of the article. Use the source link for the original text.

## Core Claim

Agentic loops are useful because strong work often needs repeated passes, but naive long-running loops drift, compound early mistakes, and produce weak output when there is no independent verification target.

## Main Points

- More thinking budget can improve hard agentic work by widening the search space and letting the agent reason across more dimensions, but raw token spend alone is not enough.
- Dumb loops fail because early mistakes get carried forward, self-review in the same context gives shallow iteration, and the work can lose its original goal after compaction.
- The author treats verification as the practical fix: use a fresh verifier with separate context, run verification early and often, feed findings back into implementation, and keep the loop aimed at the original goal.
- Good verification needs explicit rubrics. The verifier should score against meaningful dimensions, including at least one dimension tied directly to the project/spec, not only generic code quality.
- Loops need stop rules. Examples include fixed score thresholds, improvement thresholds, and early stopping after repeated non-improvement.
- The canonical loop is: define rubrics and a quality threshold, implement, verify, feed back if not passing, stop when the verification condition is satisfied.

## Sawyer Relevance

This is directly aligned with Sawyer's existing preference for proof gates, bounded loops, fresh review context, and residue-aware closeout. It is especially relevant to:

- GStack review/QA loops: verifier context should be separate from the implementation context.
- Loop Library patterns: every useful loop should name the goal, proof surface, progress signal, budget, and stop path.
- Autoreview and verification-before-completion: rubrics should be explicit enough that review is not just a stylistic pass.
- Agent-surface changes: new agents/skills/hooks should be justified by a real verifier role or proof gap, not by adding more process for its own sake.

## Practical Doctrine To Reuse

When a task is hard enough to loop, make the loop contract explicit before spending the extra passes:

1. What is the desired outcome?
2. What proof would show the work is good?
3. What rubric will the verifier use?
4. What fresh context or independent lane will verify it?
5. What budget and stopping rule prevents drift?
6. What residue should be reported instead of hidden?

## Promotion Guidance

Do not promote this source directly into canon by itself. Use it as supporting evidence when refining Loop Library, GStack review, or Sawyer-facing workflow doctrine. If promoted, the maintained rule should be Sawyer's plain-language version: hard work needs an early independent check, a clear scorecard, and a stop rule.
