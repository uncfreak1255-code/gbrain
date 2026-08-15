# Handoff to Codex — is the file-memory → GBrain sync contract real or vacuous?

**Date:** 2026-08-15
**Requested by:** Sawyer
**Written by:** Claude (closeout session `aa0db62a`)
**Asked of Codex:** adversarial review of the problem statement below — **the shape first, the fix second**

---

## Why this exists

During a routine closeout I wrote a lesson to file-memory and then reported that
the follow-on GBrain re-sync had not run. Checking *why* turned up something
larger than a skipped step: the sync the contract asks for may have nowhere to
read from. Before anyone builds a sync path, someone independent should decide
whether the contract itself is wrong.

**Do not start by hardening a sync mechanism.** The first question is whether
file-memory belongs in GBrain at all. If the answer is no, the correct change is
a two-line deletion in a skill, not a new source.

---

## The contract as written

`founder-kit:closeout` Phase 3 routes harvested lessons to one of four layers.
Its routing table names GBrain as the INDEX layer — "searches the above",
"AUTO re-sync, never authored to" — and closes with:

> After any write — file-memory or hub write that lands → trigger GBrain re-sync
> (brain-sync / sync-gbrain) so the new knowledge becomes searchable. Never
> author to GBrain directly.

So the stated invariant is: **anything written to file-memory becomes
searchable in GBrain.**

---

## Four verified observations

All gathered 2026-08-15 via `mcp__gbrain__sources_list`, `launchctl list`, and
the filesystem. Each is a fact, not an inference. Attack them.

### 1. No registered source covers file-memory

`sources_list` returns 13 sources. Their `local_path` values:

| Source | local_path | federated | pages |
|---|---|---|---|
| default | `~/.gstack-brain-worktree` | false | 496 |
| codex-quality-lab | `~/Projects/codex-quality-lab` | false | 101 |
| gbrain | `~/gbrain` | false | 513 |
| gstack-code-8398a87d-843587 | `~/Projects/seascape-analytics` | false | 11 |
| gstack-code-hub-ae4800f6-9c4839 | `~/Projects/seascape-hub` | false | 713 |
| gstack-code-site-d109433f-660feb | `~/Projects/seascape-vacations-site` | false | 164 |
| hermes-agent | `~/Projects/hermes-agent` | false | 546 |
| sawyer-brain | `~/.codex/worktrees/brain-gbrain-structure-pass` | **true** | 38 |
| sawyer-hub | `~/Projects/sawyer-hub` | true | 386 |
| seascape-ops | `~/Projects/seascape-ops` | true | 118 |
| seascape-property-docs | `~/.gbrain/sources/seascape-property-docs` | true | 11 |
| seascape-rollups | `~/.gbrain/sources/seascape-rollups` | true | 26 |
| session-briefs | `~/.gbrain/sources/session-briefs` | true | 13 |

**None covers `~/.claude/projects/*/memory/`.** That is where the closeout skill
auto-writes memories and maintains `MEMORY.md`. There is no source to sync, so
the "becomes searchable" clause has never been satisfiable for this layer.

*Falsify this by:* finding an ingestion path that reaches file-memory without a
registered source — a `put_page` caller, a dream-cycle scrape, an inbox watcher,
anything under `sources/` or `workflows/`. If one exists, observation 1 is wrong
and most of this document collapses. **Look for that first.**

### 2. Every source is four days stale, with a uniform timestamp

All 13 `last_sync_at` values fall in `2026-08-11T18:49Z`–`18:59Z` — a ten-minute
window four days ago. That is the signature of one manual `gbrain sync` run, not
a cadence.

### 3. No scheduled job runs a source sync

Loaded gbrain launchd agents: `com.gbrain.cost-receipt`,
`com.gbrain.postgres-backup`, `com.guardrail.gbrain-health-watchdog`.
Present but **not** loaded: `nightly-dream-synth`, `safe-maintenance`,
`reranker`, `autopilot` (`.bak`).

None invokes `gbrain sync`. Freshness depends entirely on an agent choosing to
run `brain-sync` mid-session — which is exactly the step that was skipped, and
which observation 2 says has been skipped for four days.

### 4. A federated source is backed by a single-copy, unbacked-up local repo

> **Corrected 2026-08-15 after first publication.** The original text claimed a
> `worktree-janitor` prune would delete this directory. That was wrong and is
> retracted: `scripts/run-worktree-janitor.sh` scopes to
> `SEASCAPE_PRIMARY_RUNTIME_REPO` (seascape-ops) only and never walks
> `~/.codex/worktrees/`. The path is also **not** a dangling git worktree — it
> is a standalone repository with its own `.git` directory. The durability
> concern below survives that correction; the imminence does not.

`sawyer-brain` (federated, 38 pages) points at
`~/.codex/worktrees/brain-gbrain-structure-pass`. That path is:

- a **standalone git repo**, branch `recovery/sawyer-brain-20260811`, one commit
  (`82ef05f recovery: preserve source snapshot`), working tree clean;
- **remote-less** — `git remote -v` is empty, so the only copy of that history
  is this disk;
- 37 markdown files plus `.gbrain-export-manifest.json`, 572K;
- sited under a directory named `worktrees/`, which Codex creates and reaps
  routinely, and which reads as scratch space to any human or agent doing
  cleanup.

The name says "recovery snapshot" and it was made 2026-08-11 — the same day as
the last sync of every source. Whatever incident produced it, the artifact
preserving the result is single-copy and lives somewhere disposable.

*What I could NOT prove:* that anything actively deletes this path today. I
checked the one janitor I knew about and it does not. Codex should either find a
reaper that does reach `~/.codex/worktrees/` — Codex's own worktree lifecycle is
the obvious candidate and I did not audit it — or downgrade this to
"unbacked-up, not endangered."

**Mitigation already applied 2026-08-15:** a verified copy now exists at
`~/.gbrain/backups/sawyer-brain-source-20260815/` (37/37 files, `git fsck`
clean, same commit). It is a backup only — inert, deliberately NOT placed under
`~/.gbrain/sources/` so it cannot be mistaken for or auto-registered as a
source. The live source registration is unchanged and still points at the
original path.

---

## The question, in order

**First — is the shape right?** Should file-memory be a GBrain source at all?

Arguments that it should not, which I hold weakly and want attacked:
- `MEMORY.md` is already an index, loaded into context every session. GBrain
  search may be redundant for a corpus of ~15 short files.
- File-memory is per-project (`~/.claude/projects/<slug>/memory/`). Registering
  it as one source flattens a deliberate scoping boundary.
- Memories are point-in-time and go stale; GBrain surfacing a stale memory as a
  retrieval hit is arguably worse than not surfacing it. The existing memory
  header already warns readers about staleness — search results carry no such
  warning.

Arguments that it should:
- The closeout contract already promises it, and agents act on the promise.
- Recall across projects is the actual use case: a lesson learned in
  `seascape-ops` should surface while working in `sawyer-skills`.

**Second — if the shape is right,** what is the minimum correct mechanism?
Register a source, or ingest via an existing path? What owns freshness given
observation 3? Note the trust boundary in `AGENTS.md`: file-memory lives
outside every current source root, so anything reading it touches the
`file_upload` confinement contract in `src/core/operations.ts`.

**Third — regardless of the above,** is observation 4 a live data-loss risk,
and what is the smallest fix?

---

## What I did not do

- No source was registered, changed, or removed.
- No sync was run.
- Nothing in `~/.claude` or any brain was written from this investigation.
- The only filesystem change is the additive backup named in observation 4.
  Nothing was moved or deleted.
- I did not read `src/` to trace ingestion paths — that is the falsification
  work asked for in observation 1, and I deliberately left it for a reviewer
  who has not already committed to a conclusion.

## Bias disclosure

I found this while explaining why I skipped a step in my own closeout. That is a
motive to inflate a skipped chore into a structural defect. Weigh observation 1
accordingly, and treat "the contract is fine, Claude just didn't run the sync"
as a live verdict — it would make this document mostly noise, and that outcome
is fine.
