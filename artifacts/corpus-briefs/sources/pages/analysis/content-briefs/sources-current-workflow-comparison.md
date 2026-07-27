---
type: analysis
title: Systematicls Loop Source - Current Workflow Comparison
corpus_id: 'local:sources:36435e536d33'
corpus_slug: sources
source_id: gbrain
profile: sawyer
comparison_method: repo-readback
tags:
  - content-brief
  - sawyer
  - loops
  - workflow-comparison
---

# Systematicls Loop Source - Current Workflow Comparison

## Decision

Do not promote the source directly into canon. Use it as support for one narrow workflow improvement: when a task is hard enough to loop, the verifier should have an explicit rubric with at least one task-specific dimension, not only generic code quality.

## What Already Matches

- Current repo-local loop guidance already requires a small proof gate, one bounded action, and a clean stop path.
- The corpus brief itself keeps deterministic inference separate from GBrain-backed personalization.
- The source note's practical doctrine lines up with existing proof-gate, bounded-loop, and residue-aware closeout habits.

## Real Gap

The source's strongest point is rubric specificity. Existing workflow language is strong on proof and stop rules, but the reusable rule worth testing is: a verifier should name what quality means for this task.

Plain version: before spending more loop passes, write the scorecard.

## Residue Readback

- Missing timestamped segments are expected for this captured Markdown source. The better UI is to call the fallback a best excerpt, not a best segment.
- Sawyer-memory retrieval has not run. That is a v1 boundary, not a failed deterministic brief.

## Recommended Next Patch

If this comparison gets promoted, patch the owning workflow surface with one sentence:

> For non-trivial loops, name the verifier rubric before the second pass; include at least one task-specific dimension and a stop threshold.

Keep that promotion out of GBrain corpus code unless the command grows a model-backed review mode.

## Proof Pointers

- Source note: `sources/x-systematicls-agentic-loops-2026-07-03.md`
- Generated Sawyer brief: `artifacts/corpus-briefs/sources/pages/analysis/content-briefs/sources-sawyer.md`
- Repo loop guidance: `docs/guides/loop-routing.md`
- Corpus proposal: `docs/proposals/sawyer-shaped-content-briefs.md`
