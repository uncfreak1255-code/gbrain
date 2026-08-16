# Handoff to Codex — is the file-memory → GBrain sync contract real or vacuous?

**Date:** 2026-08-15
**Requested by:** Sawyer
**Written by:** Claude (closeout session `aa0db62a`)
**Asked of Codex:** adversarial review of the problem statement below — **the shape first, the fix second**

---

## VERDICT — Codex, 2026-08-15. Review closed.

| # | Codex finding | Disposition |
|---|---|---|
| 1 | **High.** Core finding valid: file-memory is not a registered source, so `brain-sync` cannot make it searchable. The contract is false and can trigger unrelated all-source synchronization. | **Fixed.** sawyer-skills PR #91 |
| 2 | **High.** Observation 4 incomplete: the recovery repo holds 37 pages against a live source of 38, and the backup preserves the same incomplete snapshot. A manifest-recovery blocker, not a deletion risk. | **Blocker cleared.** See "Finding 2 resolved" |
| 3 | **Medium.** "One manual sync run" not proven — the timestamps show batch activity; autopilot produces the same pattern. | **Retracted.** Observation 2 downgraded to "batch activity of unknown origin" |
| 4 | **Medium.** The `file_upload` trust boundary is irrelevant here; normal source sync reads registered `local_path` roots directly. | **Retracted.** Struck from the questions section |

**Decision: do not create a file-memory source or scheduler.** Correct the owning
sawyer-skills closeout language instead —

- remove "GBrain searches the above";
- remove the automatic GBrain sync after file-memory writes;
- `session-closeout-save` remains the routing authority;
- keep explicit "save to GBrain" and session-bridge capture as separate paths.

Shipped in [sawyer-skills PR #91](https://github.com/uncfreak1255-code/sawyer-skills/pull/91)
(founder-kit 1.7.2 → 1.7.3; `scripts/test.sh` 22/22 groups OK, hygiene clean).

**For `sawyer-brain`:** decide whether to retain the 38th incident page, then
build and verify a complete sealed 38-page export **before** changing the
registered path or restarting autopilot.

### New evidence found while closing the verdict

`mcp__gbrain__sources_status --id sawyer-brain` returns:

```
page_count:   38
last_commit:  82ef05f673bdbe132f5aabe1893f93b94c095978
clone_state:  "corrupted"
```

GBrain's own per-source diagnostic already classifies this clone as **not
syncable**. That is consistent with finding 2 and sharpens it: the 37/38 gap is
not merely a stale export, it is an export GBrain will not re-sync from in its
current state. The 38 pages themselves are intact in the database and covered by
`com.gbrain.postgres-backup`. The disk copy is the broken half.

Anyone picking up finding 2 should start here, not from the filesystem.

### Finding 2 resolved — the 38th page, and a sealed export

`gbrain export --source sawyer-brain --dir <path>` reads the **database**, not
the clone, so it succeeds despite `clone_state: "corrupted"`. Diffing its
manifest against the 2026-08-11 snapshot isolates the gap to exactly one slug:

```
+ dream-cycle-summaries/2026-08-11
```

The page is 196 bytes in full:

> **Children:** 1 completed, 0 not successful.
> **Pages written:** 0.

An auto-generated null receipt for a nightly dream cycle that produced nothing.
Codex's phrase "the 38th incident page" was a reasonable guess and is wrong —
there is no incident, and no retain/discard judgment worth Sawyer's attention.

**Sealed export, verified:** `~/.gbrain/backups/sawyer-brain-export-20260815-complete/`

| Check | Result |
|---|---|
| `source_page_count` / `page_count` / pages listed | 38 / 38 / 38 |
| `markdown_sha256` recomputed and matched | 38 |
| Mismatched | 0 |
| Missing on disk | 0 |
| Manifest sha256 | `e1601f2ea97d490da5215ed02f77fa9c159c1273115683a25f032fc0a768259f` |

Codex's precondition — "build and verify a complete sealed 38-page export before
changing its registered path or restarting autopilot" — is **satisfied**. Both
of those remain undone and are deliberately left to Sawyer: they are live
runtime changes, not review outcomes.

The earlier 37-page backup at `~/.gbrain/backups/sawyer-brain-source-20260815/`
is now superseded. It is kept, not deleted, because it preserves the original
`recovery/sawyer-brain-20260811` git history that the fresh export does not
carry.

---

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
window four days ago.

> **Downgraded 2026-08-15 (Codex finding 3).** I called this "the signature of
> one manual `gbrain sync` run." Not proven — the timestamps establish batch
> activity, and autopilot produces the same pattern. The staleness stands; the
> attribution does not.

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
observation 3?

> **Struck 2026-08-15 (Codex finding 4).** This question originally invoked the
> `file_upload` confinement contract in `src/core/operations.ts`. Irrelevant:
> normal source sync reads registered `local_path` roots directly and never
> crosses that boundary. Answered moot anyway — the shape was ruled wrong.

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
