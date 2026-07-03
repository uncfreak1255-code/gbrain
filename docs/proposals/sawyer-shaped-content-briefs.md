# Sawyer-Shaped Content Briefs

## Goal

Build a bounded `gbrain corpus` lane that turns a large public corpus into a source-backed briefing for Sawyer. The output is not a transcript dump. The output answers what is worth his time, what to skip, why it matters now, which exact source moments support that judgment, and what decision or action might change.

## Ownership

GBrain owns corpus capture, source-backed item pages, retrieval, synthesis, ranking context, and durable provenance. Sawyer Hub should only receive the clean front-door result: the recommended brief, open follow-ups, and links back to GBrain pages. It should not become a transcript archive, embedding layer, or parallel retrieval system.

## V1 Shape

Layer 1 is corpus capture. Inputs start with a YouTube playlist URL or a local transcript directory. The read-only gate is:

```bash
gbrain corpus inspect <url-or-path> --json
```

The inspection result records the corpus id, title, item list, canonical URLs when known, local transcript paths when present, duration when known, extraction method, ingest timestamp for later write steps, and a content hash for local transcript files.

The deterministic local-directory ingest gate is:

```bash
gbrain corpus ingest <local-transcript-dir> --source <source-id> --out <dir> --json
```

It writes a corpus manifest, transcript copies, and draft review pages under the output directory. It does not mutate the live brain and does not call an LLM.

Layer 2 is source-backed review pages. The intended page path is:

```text
media/conferences/<corpus-slug>/<item-slug>.md
```

Each page should include a summary, key ideas, best segment with timestamp, caveats, who should care, tags/topics, source URL, transcript excerpt pointers, and corpus metadata in frontmatter. Large transcript walls should stay as raw files or excerpt pointers unless the excerpt itself is needed as evidence.

Layer 3 is the Sawyer brief:

```text
analysis/content-briefs/<corpus-slug>-sawyer.md
```

Required sections:

- Best use of your time
- Watch/read first
- Skip or skim
- Relevant to Seascape
- Relevant to GBrain / agents
- Relevant to Sawyer operating system
- Strong claims worth testing
- Caveats / likely hype
- Source gaps
- Next actions

The brief must rank items. It should not summarize every item equally.

## Personalization Rule

The ranking step should retrieve Sawyer context from GBrain instead of hardcoding prompt lore. It should query for current projects, active Seascape priorities, GBrain/runtime work, open loops, recent decisions, and preferences around proof, spend, and bounded experiments.

The generated brief must label the reason for each recommendation:

- Relevant because GBrain found related context
- Inference from the source plus current context
- Interesting but not actionable

## Command Contract

Reserved v1 command shape:

```bash
gbrain corpus inspect <url-or-path> --json
gbrain corpus ingest <url-or-path> --source <source-id> --out <dir> --json
gbrain corpus review <corpus-id> --source <source-id> --json
gbrain corpus brief <corpus-id> --profile sawyer --json
```

`inspect` is implemented for local transcript directories and YouTube playlist metadata. `ingest` is implemented for local transcript directories only. `review` and `brief` must fail loudly until they have real citation, spend, personalization, and eval gates.

## Proof Gates

Inspect:

- local transcript directory test with stable hashes
- YouTube playlist metadata test with a mocked `yt-dlp` runner
- CLI help/readback test that does not require a configured brain

Future ingest:

- writes draft review pages into a source-like output tree
- preserves raw transcript/source files
- records source id, corpus id, content hash, extraction method, and source URL
- future live-brain promotion should rerun `gbrain sync`/extract as needed so search and graph hooks see the pages

Future brief:

- uses `gbrain search`/`gbrain think` style retrieval with citations
- includes source gaps and caveats
- runs a fixture eval that verifies ranking is selective, cited, and not just a uniform summary
