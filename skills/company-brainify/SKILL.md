---
name: company-brainify
version: 1.0.0
description: >
  Extract a sanitized shared team/company brain from a personal brain.
  Strips internal ratings, compensation, performance assessments, retention
  and political dynamics from pages, takes, and facts across the full scan
  scope (people, companies, meetings, dailies, cross-references — not just
  people/), verifies with grep + retrieval passes, and purges sensitive git
  history behind the data-loss-gate confirmation card. Also runs as a
  report-only re-audit on an existing shared brain.
triggers:
  - "company brain"
  - "team brain"
  - "brainify"
  - "sanitize the brain"
  - "share my brain with the team"
  - "strip sensitive data from the brain"
  - "scrub employee data"
  - "audit the shared brain"
  - "make the brain safe to share"
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - meetings/
  - daily/
  - projects/
  - analysis/
upstream: company-brainify@fc834ee
---

# company-brainify — Personal → Team-Brain Sanitization

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) —
> discovery runs through the brain's own retrieval, not filesystem guesswork.
> The grep pipelines below TRIAGE; `gbrain query` finds what keyword patterns miss.
>
> **Convention:** see [conventions/test-before-bulk.md](../conventions/test-before-bulk.md) —
> sanitize 3-5 files, read the output yourself, then ramp. A bad bulk
> sanitization pass is worse than none: it looks done and isn't.
>
> **Convention:** see [conventions/regex-discipline.md](../conventions/regex-discipline.md) —
> "is this sensitive?" is a judgment call, so the model decides per file. The
> grep patterns are earned triage/verification tools, never the judge.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) —
> edits stay in the page's existing directory; the deletion log files
> date-keyed under `daily/`.

## The Problem

Personal brains accumulate everything — company knowledge, meeting notes,
internal assessments, compensation details, management strategy, candid
opinions about the people you work with. When you stand up a shared team
brain from that personal brain (see `docs/architecture/brains-and-sources.md`
for the team-mount topology), all of that has to go. The knowledge is
valuable; the sensitive metadata is a liability.

Clean working-tree files alone are NOT enough: git history still carries every
pre-sanitization version, and gbrain takes/facts carry evaluative claims
outside the page prose. This skill handles all three surfaces — pages,
takes/facts, and history.

## When to Use

- Standing up a shared company brain from a founder/exec's personal brain
- Auditing an existing shared brain for sensitive content that shouldn't be there
- Onboarding new team members to a brain repo that must be verified clean first
- Periodic hygiene pass on a shared brain that re-accumulates sensitive data

## What Gets Removed

### Always strip (non-negotiable)

| Category | Examples |
|----------|----------|
| **Internal scores/ratings** | `score:`, `rating:`, `skill:`, or any vertical-specific `*_score:` frontmatter field; any numeric rating of a person |
| **Compensation** | Salary, equity, carry, option grants, comp changes, retention packages |
| **Performance assessments** | Strengths/weaknesses sections about employees, "at risk" flags, underperformance mentions, "picking up slack" references |
| **Departure/retention** | Who's considering leaving, who was convinced to stay, departure rumors, retention conversations |
| **Management strategy** | How-to-manage-someone sections, "the hard conversation" notes, scope/title management plans |
| **Internal political dynamics** | Who doesn't like whom, who's nervous about whom, adversarial relationships, power dynamics |
| **Personal PII** | Phone numbers, personal email addresses, home addresses, family or medical details, personal legal matters, personal-life details |
| **Takes/facts** | Any take or fact referencing the above categories — performance, comp, retention, weakness, management risk. Fact rows are DELETED from the page's Facts fence, never merely expired with `gbrain forget` |

### Always keep

| Category | Examples |
|----------|----------|
| **Professional identity** | Name, role, title, work email, LinkedIn |
| **What they're building** | Current projects, product work, technical contributions |
| **Career arc** | Prior companies, education, professional background (public info) |
| **Professional beliefs** | Their views on technology, strategy, product philosophy |
| **Timeline of work** | Meeting attendance, project milestones, launches (factual, not evaluative) |
| **Skills/expertise** | Technical capabilities, domain knowledge |

## Scan Scope — Wider Than people/

Sensitive content leaks far beyond people pages. The scan scope is:

- `people/` — the primary surface (frontmatter fields, assessment sections)
- `meetings/` — transcripts and minutes with candid assessments
- `daily/` — daily notes referencing comp/performance/retention conversations
- `companies/`, `projects/`, `analysis/` — cross-references to removed content
- **Takes** — evaluative claims in page takes fences (`gbrain takes search`)
- **Facts** — hot-memory facts (`gbrain recall --grep`)
- **Back-links** — after edits, `gbrain check-backlinks check` confirms no page
  still points at removed sections

A pass that only covers `people/` will certify a brain that still leaks.

## Procedure

All paths below are relative to the explicitly selected checkout:

```bash
# For a NEW team export, this is the personal source being copied into staging.
# For an EXISTING team re-audit, it MUST be the shared checkout — never infer it
# from sync.repo_path. Confirm the registered source and path before discovery;
# every retrieval below is scoped to this source.
BRAIN="<absolute path to the checkout being sanitized>"
PERSONAL="$(gbrain config get sync.repo_path)"
[ -d "$BRAIN/.git" ] \
  || { echo "selected checkout is not a git repo — ABORT" >&2; exit 1; }
cd "$BRAIN"
gbrain sources current --json  # must identify the source whose local_path is $BRAIN
BRAIN_SOURCE_ID="<registered source id whose local_path is exactly $BRAIN>"
[ -n "$BRAIN_SOURCE_ID" ] \
  || { echo "selected checkout is not registered — ABORT" >&2; exit 1; }
```

### Phase 1: Identify scope (retrieval-first)

1. Retrieval discovery — hybrid search catches judgment-shaped content that no
   keyword pattern will:

   ```bash
   gbrain query "compensation, equity, or salary discussions about team members" --source-id "$BRAIN_SOURCE_ID" --limit 50
   gbrain query "performance concerns, underperformance, or who is struggling" --source-id "$BRAIN_SOURCE_ID" --limit 50
   gbrain query "considering leaving, retention conversations, departure rumors" --source-id "$BRAIN_SOURCE_ID" --limit 50
   gbrain call --source "$BRAIN_SOURCE_ID" takes_search '{"query":"performance","limit":50}'
   gbrain recall --source "$BRAIN_SOURCE_ID" --grep "salary"
   ```

   Collect every returned slug into the scope list.

2. Structural discovery — first enumerate the COMPLETE intended share corpus.
   This list is the shipping set; sensitivity hits only prioritize review and
   must never replace it. Enumerate every regular file, not just Markdown. The
   sanitizer and verification below are deliberately Markdown-only, so fail
   closed on attachments or other non-Markdown files: inspect each with a
   type-appropriate reader, then either extend the sanitizer and verification
   for that file type or route its exclusion/deletion through the
   [data-loss-gate](../data-loss-gate/SKILL.md). Never publish while this list
   contains an unreviewed file. If this is a company-specific export, remove
   unrelated files from this complete candidate list by explicit judgment,
   not by dropping files that lack sensitive keywords:

   ```bash
   find people/ meetings/ daily/ companies/ projects/ analysis/ \
     -type f -print 2>/dev/null | sort -u > /tmp/brainify-scope.txt

   find people/ meetings/ daily/ companies/ projects/ analysis/ \
     -type f ! -name '*.md' -print 2>/dev/null | sort -u > /tmp/brainify-nonmarkdown.txt
   if [ -s /tmp/brainify-nonmarkdown.txt ]; then
     echo "ABORT: non-Markdown files require type-aware review or gated exclusion" >&2
     exit 1
   fi

   # Sensitivity hits are a separate triage list, not the export scope.
   grep -rli 'company: *"acme-example"' people/ --include="*.md" | sort > /tmp/brainify-sensitive-hits.txt
   grep -rli -E 'salary|equity|carry|retention|underperform|performance review|hard conversation' \
     meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null >> /tmp/brainify-sensitive-hits.txt
   sort -u -o /tmp/brainify-sensitive-hits.txt /tmp/brainify-sensitive-hits.txt
   ```

3. Cross-reference against the company's public people page (website,
   LinkedIn) to catch files using different frontmatter conventions.

4. Count: `wc -l /tmp/brainify-scope.txt`

### Phase 2: Triage sensitivity

Prioritize by hit density (portable `grep -E`; no `\b` — BSD and GNU disagree):

```bash
while read -r f; do
  hits=$(grep -c -i -E 'carry|salary|equity|comp change|departure|considering leaving|retention|underperform|picking up slack|performance review|management risk|hard conversation|nervou|score: *[0-9]|firing|fired|pip|probation|weakness' "$f" 2>/dev/null || true)
  [ "${hits:-0}" -gt 0 ] && echo "$hits $f"
done < /tmp/brainify-scope.txt | sort -rn > /tmp/brainify-triage.txt
```

High-hit files need full judgment passes. Zero-hit files may only need
frontmatter field removal — but they still get read (regex triages, the model
judges).

### Phase 3: Sanitize (STAGING COPY preferred; test first, then parallel)

Phase 3 is destructive: it strips content across many files, removes takes,
and deletes fact rows. Two rules govern it.

**Choose the target FIRST — copy, don't mutate the personal brain.**

- **Standing up a NEW team brain (default, preferred):** sanitize a STAGING
  COPY of the scanned directories, never the personal brain in place. The
  founder's personal brain is SUPPOSED to keep comp, performance, and candid
  notes — stripping them from the personal working tree destroys valuable
  private data. Copy the Phase-1 scope into a durable staging dir and edit
  THAT; Phase 5 Step 0 exports from the staging copy. Blast radius: none on the
  personal brain.

  ```bash
  # Durable staging dir (NOT /tmp — same reasoning as the mirror backup).
  STAGING="$HOME/.gbrain/backups/brainify-staging-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$STAGING" && chmod 700 "$STAGING"
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    mkdir -p "$STAGING/$(dirname "$f")"
    rsync -a -- "$f" "$STAGING/$f"
  done < /tmp/brainify-scope.txt
  cd "$STAGING"   # all edits below happen here, not in sync.repo_path
  ```

- **Re-auditing an EXISTING shared brain:** the shared brain IS the target, so
  edits are in place on the SHARED repo (cd into the shared repo, never the
  personal `sync.repo_path`). Fact-row removal + re-sync applies to the shared
  source's DB.

**Fire the [data-loss-gate](../data-loss-gate/SKILL.md) confirmation card
BEFORE the bulk destructive edits begin.** Both targets are destructive (the
copy path removes content from the tree destined for the team; the in-place
path removes content from a live brain). Pre-filled for Phase 3:

```
⚠️ DATA DELETION — Confirmation Required

What: strip sensitive content, remove takes, and delete fact rows across
      [N files] in [STAGING COPY at <path>  |  the SHARED brain in place]
Count: [N files edited; T takes removed; F fact rows removed]
Location: [staging path OR shared repo path] — NOT the personal sync.repo_path
          on the staging path

Why: preparing a sanitized tree for team access

Recoverable?
- [x] Personal brain untouched (staging-copy path) — re-copy to redo
- [ ] In-place shared-brain path: edits overwrite the live tree; git history is
      the recovery line until Phase 5 purges it

Proceed? (yes/no)
```

Require a typed "yes"/"do it" per data-loss-gate; "ok"/"sure" are not consent.

Per test-before-bulk: do 3-5 files first, read the results, then ramp. For
large sets (50+ files), batch into groups of 10-12 and spawn parallel
subagents. Per file:

1. Read the file completely
2. Remove all content matching the "Always strip" categories
3. Frontmatter: delete rating/comp field lines entirely
4. Sections: remove entire sections (assessment weaknesses, team dynamics,
   management strategy)
5. Takes and Facts fences: remove entire rows that reference sensitive
   categories — a take like "alice-example believes charlie-example is
   underperforming" reveals both the opinion and who holds it; remove the
   whole row, never just the attribution
6. Inline mentions: surgically edit sentences/paragraphs
7. Write the cleaned file back

**Decision rule:** use `Edit` for surgical removal when only a few sections
need it. Use `Write` to rewrite the entire file only when sensitive content is
deeply interwoven throughout.

**Facts: `forget` is NOT removal.** `gbrain forget <fact-id>` expires a fact
— the row stays on the page's Facts fence struck through, and the DB still
serves it via `--include-expired`. An expired fact is retained, not gone.
For sanitization, sensitive fact rows must be ACTUALLY REMOVED: find them
(`gbrain recall --grep`), then delete the row from the page's Facts fence
(step 5), exactly like a sensitive take. On an in-place shared brain, sync
the edited page and then explicitly reconcile the derived facts index for the
same source — page import alone does not remove a stale derived row:

```bash
SOURCE_ID="<shared-source-id>"
gbrain autopilot --status --json
# Record the installed target and the exact repository from the installed
# launcher/service BEFORE uninstalling. Do not infer the repository from
# sync.repo_path: a custom --repo install may point elsewhere.
AUTOPILOT_TARGET="<installed target from schedule.targets>"
AUTOPILOT_REPO="<exact --repo path from $HOME/.gbrain/autopilot-run.sh>"
AUTOPILOT_WAS_RUNNING="<true-or-false>"
if [ "$AUTOPILOT_WAS_RUNNING" = "true" ]; then
  gbrain autopilot --uninstall
  gbrain autopilot --status --json  # must report inactive/uninstalled
fi

gbrain sync --source "$SOURCE_ID"
gbrain dream --source "$SOURCE_ID" --phase extract_facts --json

# Only if the first status reported an active install:
if [ "$AUTOPILOT_WAS_RUNNING" = "true" ]; then
  gbrain autopilot --install --target "$AUTOPILOT_TARGET" --repo "$AUTOPILOT_REPO"
  gbrain autopilot --status --json  # must report active again
fi
```

Read the JSON result and resolve any `warn` or `fail` status before
certifying the brain. Then verify every removed fact text is absent from the
derived index, including expired rows:

```bash
REMOVED_FACT_TEXT="<distinct-removed-fact-text>"
gbrain recall --source "$SOURCE_ID" --grep "$REMOVED_FACT_TEXT" --include-expired --json
```

That readback must return zero rows. `forget` alone can never certify a brain
clean.

After edits: on the **staging-copy** path the fact rows are removed by editing
the copied markdown directly (there is no live DB to re-sync yet — the team DB
is built fresh when Phase 5 Step 0 turns the export into a source). On the
**in-place shared-brain** path, run the source-scoped `sync` plus
`dream --phase extract_facts` sequence above, then the `recall --include-expired`
readback. Either way, run `gbrain check-backlinks check` to catch pages still
pointing at removed content.

### Phase 4: Verify

Re-run the Phase 2 triage — the count of flagged files should drop to
(near-)zero. Then targeted greps:

```bash
# The Markdown checks below cannot certify attachments. Refuse to certify or
# ship while any non-Markdown file remains in the intended export set.
find people/ meetings/ daily/ companies/ projects/ analysis/ \
  -type f ! -name '*.md' -print 2>/dev/null | sort -u > /tmp/brainify-nonmarkdown-after.txt
[ ! -s /tmp/brainify-nonmarkdown-after.txt ] \
  || { echo "ABORT: non-Markdown file remains unreviewed" >&2; exit 1; }

# Rating fields remaining in frontmatter
grep -rn -E '^[a-z_]*(score|rating|skill)[a-z_]*: *[0-9]' people/ --include="*.md"

# Phone numbers
grep -rn -E '\+1[0-9]{10}|\([0-9]{3}\) [0-9]{3}-[0-9]{4}' people/ --include="*.md"

# Comp keywords (full scan scope, not just people/)
grep -rin -E 'carry|comp change|equity|salary' people/ meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null

# Management/performance
grep -rin -E 'considering leaving|departure rumor|underperform|picking up slack|hard conversation' people/ meetings/ daily/ companies/ projects/ analysis/ --include="*.md" 2>/dev/null
```

False positives (e.g. "carry the torch") are fine — manually confirm each
remaining hit rather than tightening the pattern (regex-discipline).

**Verify the tree that ships.** On the staging-copy path, these greps run
against the sanitized `$STAGING` tree (which Phase 5 Step 0 turns into the
export) — the personal working tree is not what ships, so certifying it proves
nothing. For an in-place shared-brain re-audit, the shared repo's tree is the
shipped tree and this pass stands as-is.

Then the strongest check — the retrieval the team will actually use. Against
the sanitized brain/source (scope with `--source <team-source-id>` when the
shared source is mounted alongside personal content):

```bash
# A staging directory is not a source merely because the shell is in it. Build
# an isolated, non-federated source over the exact sanitized tree, then sync it
# before retrieval; otherwise the commands can read the host/default source.
VERIFY_SOURCE_ID="$BRAIN_SOURCE_ID"
if [ -n "${STAGING:-}" ]; then
  git -C "$STAGING" init -b main
  git -C "$STAGING" add -A
  git -C "$STAGING" diff --cached --quiet \
    || git -C "$STAGING" commit -m "Sanitized verification snapshot"
  STAGING_SOURCE_ID="<fresh isolated staging source id>"
  gbrain sources add "$STAGING_SOURCE_ID" --path "$STAGING" --no-federated
  gbrain sync --source "$STAGING_SOURCE_ID"
  VERIFY_SOURCE_ID="$STAGING_SOURCE_ID"
fi

gbrain query "what is alice-example's compensation" --source-id "$VERIFY_SOURCE_ID" --limit 10
gbrain query "who is underperforming or at risk of leaving" --source-id "$VERIFY_SOURCE_ID" --limit 10
gbrain call --source "$VERIFY_SOURCE_ID" takes_search '{"query":"weakness","limit":20}'
```

Every one of these must come back empty or with only keep-category content.

### Phase 5: Commit and purge history — GATED

Clean files aren't enough if the repo has history: old commits still contain
the sensitive versions.

**Step 0 — preferred alternative (non-destructive).** When standing up a NEW
team repo, skip history rewriting entirely: the sanitized STAGING tree from
Phase 3 becomes a fresh repo with fresh history. The personal repo keeps its
full history AND its full working tree, untouched.

**Export rule: nothing unscanned ships.** Because Phase 3 copied ONLY the
scanned directories into `$STAGING`, the staging tree contains nothing the
sanitization pass didn't read — the include-only rule holds by construction.
Never copy extra directories in: everything outside the scan scope
(`conversations/`, `originals/`, `sources/`, `inbox/`) stays out. A whole-repo
copy is the classic leak — it ships raw transcripts, originals, and inbox
captures no pass ever read. To ship a new directory, add it to the scan scope
first (Phases 1-4) so it lands in `$STAGING` sanitized.

```bash
# The sanitized staging tree IS the export.
cd "$STAGING"

# Re-run the Phase 4 verification greps + retrieval checks INSIDE $STAGING —
# the staging tree is what ships, and it is the tree that must certify clean.
# ... Phase 4 greps against $STAGING ...

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git init -b main
git add -A
git diff --cached --quiet || git commit -m "Initial import — sanitized team brain"
git branch -M main
git remote add origin <TEAM_REPO_URL>
git push -u origin main
```

Only when a shared repo ALREADY exists with sensitive history in it do you
need the purge below.

**Step 1 — carry the sanitized tree into the SHARED purge clone, then mirror-clone.**
The purge operates on the SHARED repo, NEVER on `sync.repo_path` (the personal
brain) — Step 0's guarantee that the personal repo keeps full history depends
on it. Freeze an explicit carrier from the sanitized staging tree or the
in-place shared checkout **before** cloning. This is what prevents the
in-place path (where `STAGING` is unset) from silently copying nothing into
the purge checkout. Then clone the shared repo to a durable work dir, stay
there for every step below, and assert the target is not the personal repo
before touching anything.

```bash
PERSONAL="$(gbrain config get sync.repo_path)"
mkdir -p "$HOME/.gbrain/backups" && chmod 700 "$HOME/.gbrain/backups"
WORK="$HOME/.gbrain/backups/brainify-purge-$(date +%Y%m%d-%H%M%S)"

# Capture the actual sanitized source before changing directories. STAGING is
# set for a new-team export; for an existing shared-brain re-audit, the
# sanitized checkout is the current git worktree instead.
SANITIZED_TREE="${STAGING:-$(git rev-parse --show-toplevel)}"
[ -d "$SANITIZED_TREE" ] \
  || { echo "sanitized tree missing — ABORT"; exit 1; }
[ "$SANITIZED_TREE" != "$PERSONAL" ] \
  || { echo "sanitized tree IS sync.repo_path (personal brain) — ABORT"; exit 1; }

# Durable carrier: the purge clone must consume this exact sanitized tree,
# including the in-place path's uncommitted edits. Do this before cloning.
SANITIZED_CARRIER="$WORK/sanitized-tree"
mkdir -p "$SANITIZED_CARRIER"
for d in people meetings daily companies projects analysis; do
  [ -d "$SANITIZED_TREE/$d" ] || continue
  mkdir -p "$SANITIZED_CARRIER/$d"
  rsync -a "$SANITIZED_TREE/$d/" "$SANITIZED_CARRIER/$d/"
done

git clone <SHARED_REPO_URL> "$WORK/shared"
cd "$WORK/shared"
[ "$(git rev-parse --show-toplevel)" != "$PERSONAL" ] \
  || { echo "target IS sync.repo_path (personal brain) — ABORT"; exit 1; }

# Materialize every remote branch locally before filter-repo. A normal clone
# checks out only the default branch; pushing refs/heads/* from that clone would
# otherwise prune every other remote branch instead of rewriting it.
git fetch origin \
  '+refs/heads/*:refs/remotes/origin/*' \
  '+refs/tags/*:refs/tags/*'
DEFAULT_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
[ -n "$DEFAULT_BRANCH" ] \
  || { echo "remote default branch not found — ABORT"; exit 1; }
while IFS= read -r branch; do
  [ "$branch" = "HEAD" ] && continue
  git show-ref --verify --quiet "refs/heads/$branch" \
    || git branch "$branch" "refs/remotes/origin/$branch"
done < <(git for-each-ref --format='%(refname:strip=3)' refs/remotes/origin/)
git show-ref --verify --quiet "refs/heads/$DEFAULT_BRANCH" \
  || { echo "default branch was not materialized — ABORT"; exit 1; }

# This procedure has one sanitized working-tree carrier, so it cannot safely
# reconstruct branch-specific content under a purged directory. Do not silently
# replace a feature branch with the default branch's sanitized snapshot: stop
# before filter-repo and require a separate sanitized carrier for every branch
# (or a single-branch purge run).
BRANCHES_BEFORE_FILTER="$WORK/branches-before-filter.txt"
git for-each-ref --format='%(refname:strip=2)' refs/heads/ > "$BRANCHES_BEFORE_FILTER"
NONDEFAULT_BRANCH="$(grep -Fxv "$DEFAULT_BRANCH" "$BRANCHES_BEFORE_FILTER" | head -n1 || true)"
[ -z "$NONDEFAULT_BRANCH" ] \
  || { echo "ABORT: non-default branch $NONDEFAULT_BRANCH needs its own sanitized carrier; do not purge or force-push"; exit 1; }

# Apply the carried sanitized tree, then COMMIT it BEFORE the mirror clone. A
# mirror captures COMMITTED state only; the carrier makes this safe for both
# staging and in-place edits without requiring a live push before the gate.
for d in people meetings daily companies projects analysis; do
  if [ -d "$SANITIZED_CARRIER/$d" ]; then
    mkdir -p "./$d"
    rsync -a --delete "$SANITIZED_CARRIER/$d/" "./$d/"
  else
    git rm -r --ignore-unmatch -- "$d"
  fi
done
git add -A && git commit -m "Sanitize: strip sensitive content before history purge"

# Mirror-clone backup = the recoverability line on the card. Capture the path
# in a variable NOW and reuse it verbatim at purge time — a run crossing
# midnight must NOT recompute $(date) and false-abort on a mismatched name.
BACKUP_PATH="$HOME/.gbrain/backups/shared-brain-history-backup-$(date +%Y%m%d-%H%M%S).git"
git clone --mirror "$WORK/shared" "$BACKUP_PATH"
git -C "$BACKUP_PATH" log -1 >/dev/null || { echo "backup unreadable — ABORT"; exit 1; }
BACKUP_PATH_FILE="$HOME/.gbrain/backups/brainify-backup-path.txt"
printf '%s\n' "$BACKUP_PATH" > "$BACKUP_PATH_FILE"
chmod 600 "$BACKUP_PATH_FILE"
```

Verify the mirror exists and reads before presenting the card — it is the
card's recoverability line.

**Step 2 — STOP. Present the [data-loss-gate](../data-loss-gate/SKILL.md)
confirmation card and wait.** History rewrite + force-push is the most
destructive operation in this skill: it permanently discards every prior
version of the purged paths from the remote. Never run it without the card
answered. Pre-filled for this operation:

```
⚠️ DATA DELETION — Confirmation Required

What: rewrite git history to remove all prior versions of [purged paths]
      from the SHARED repo, then force-push to [remote/branch]
Count: [N commits rewritten; M files with history purged]
Size: [repo size before → expected after]
Location: [SHARED repo work dir; remote URL; branch]
Target check: this is the SHARED repo, verified ≠ personal sync.repo_path
      ($PERSONAL) — the personal brain's history is never rewritten

Why: prior commits contain pre-sanitization versions of pages that were
     just cleaned — team access to the repo means team access to history

Recoverable?
- [x] Mirror-clone backup at $BACKUP_PATH
      (verified: exists, `git -C "$BACKUP_PATH" log` works)
- [ ] NOT recoverable from the rewritten remote — old SHAs become unreachable

What we'd lose:
- all pre-sanitization history for the purged paths (edit trail, blame,
  old versions)
- every existing clone breaks — all collaborators must re-clone

Alternative to deletion:
- fresh-history export to a NEW team repo (Step 0) — personal repo untouched

Proceed? (yes/no)
```

Per data-loss-gate: require a typed **"yes"** or **"do it"** — "ok", "sure",
"go ahead" are not consent. If the user asks a question, answer and re-present
the card. This gate is a routing convention, not a runtime enforcement —
nothing in gbrain mechanically blocks `git filter-repo` — which is exactly why
the agent following this skill must not skip it.

**Step 3 — purge (only after the explicit typed yes).** Requires
`git filter-repo` (not bundled with git; install separately). **Run this ONLY
in the shared-repo work dir from Step 1 (`cd "$WORK/shared"`). NEVER run
`git filter-repo` or `git push --force` in `sync.repo_path` — the personal
brain's history must stay intact.** The commands below reuse `$WORK` and
`$BACKUP_PATH` from Step 1; they never recompute a date-stamped path.

```bash
cd "$WORK/shared"
[ "$(git rev-parse --show-toplevel)" != "$PERSONAL" ] \
  || { echo "target IS sync.repo_path — ABORT, do not filter-repo"; exit 1; }

# Step 1 may have run in a different shell before the confirmation card. Read
# the durable pointer again instead of relying on an ephemeral BACKUP_PATH.
BACKUP_PATH_FILE="$HOME/.gbrain/backups/brainify-backup-path.txt"
[ -r "$BACKUP_PATH_FILE" ] \
  || { echo "backup pointer missing — ABORT, do not filter-repo"; exit 1; }
BACKUP_PATH="$(<"$BACKUP_PATH_FILE")"
case "$BACKUP_PATH" in
  "$HOME/.gbrain/backups/"*.git) ;;
  *) echo "backup pointer escapes ~/.gbrain/backups — ABORT"; exit 1 ;;
esac

# The purge list derives from the COMPLETE set of sanitized paths — the same
# directories Phases 1-4 scanned. A filter list narrower than the scan
# (people/ + meetings/ only) leaves pre-sanitization history alive for every
# other scanned directory. The restore carrier below MUST match this same
# list — backed-up set, filtered set, and re-added set are identical.
PURGE_DIRS="people meetings daily companies projects analysis"

# Back up the clean working tree of every purged path to a DURABLE carrier
# (under $WORK in ~/.gbrain/backups — never /tmp, which can vanish mid-rewrite).
CLEAN="$WORK/clean"
mkdir -p "$CLEAN"
for d in $PURGE_DIRS; do
  [ -d "$d" ] || continue
  mkdir -p "$CLEAN/$d" && cp -r "$d/." "$CLEAN/$d/"
done

# Rewrite history: one --path per purged directory, derived from $PURGE_DIRS
rm -rf .git/filter-repo
git filter-repo --invert-paths $(for d in $PURGE_DIRS; do printf -- '--path %s/ ' "$d"; done) --force

# Restore clean files and re-commit on EVERY surviving local branch. A single
# checkout/commit only repairs the default branch; the other materialized
# branches would otherwise be pushed with the purged directories still absent.
BRANCHES_AFTER_FILTER="$WORK/branches-after-filter.txt"
git for-each-ref --format='%(refname:strip=2)' refs/heads/ > "$BRANCHES_AFTER_FILTER"
CLEAN_READD_COMMITS="$WORK/clean-readd-commits.txt"
: > "$CLEAN_READD_COMMITS"
while IFS= read -r branch; do
  [ -n "$branch" ] || continue
  git checkout --force "$branch"
  for d in $PURGE_DIRS; do
    [ -d "$CLEAN/$d" ] || continue
    mkdir -p "$d" && cp -r "$CLEAN/$d/." "$d/"
    git add "$d/"
  done
  if ! git diff --cached --quiet; then
    git commit -m "Re-add sanitized directories"
    git rev-parse HEAD >> "$CLEAN_READD_COMMITS"
  fi
done < "$BRANCHES_AFTER_FILTER"
git checkout --force "$DEFAULT_BRANCH"
git remote add origin <SHARED_REPO_URL>   # filter-repo removes remotes

# VERIFY RESTORE COMPLETENESS before the irreversible push — a partial restore
# would ship a smaller tree than was sanitized. Compare file counts (and, for
# extra safety, checksums) between the carrier and the restored tree.
before=$(find "$CLEAN" -type f | wc -l | tr -d ' ')
after=$(for d in $PURGE_DIRS; do [ -d "$d" ] && find "$d" -type f; done | wc -l | tr -d ' ')
[ "$before" = "$after" ] \
  || { echo "restore incomplete ($before → $after files) — ABORT, do not force-push"; exit 1; }
# Optional stronger check: diff -r "$CLEAN/<d>" "<d>" for each purged dir.

# RE-VERIFY the backup immediately before the irreversible step — card-time
# verification is not enough; time has passed and the rewrite could have gone
# sideways. Reuse $BACKUP_PATH (do NOT recompute $(date)); abort if unreadable.
git -C "$BACKUP_PATH" log -1 >/dev/null \
  || { echo "backup missing/unreadable — ABORT, do not force-push"; exit 1; }

# Update EVERY shared branch and tag, and prune remote refs that no longer
# exist locally. Pushing only `main` leaves an old branch or tag able to serve
# the pre-sanitization history.
git push --force --prune origin \
  'refs/heads/*:refs/heads/*' \
  'refs/tags/*:refs/tags/*'

# Verify remote readback matches the rewritten local refs, then inspect every
# surviving ref (including remote-tracking refs) for purged-path history. Each
# purged directory may appear only in the single clean re-add commit; any
# additional commit means a branch or tag still retains old history — ABORT.
REMOTE_REFS_AFTER="$WORK/remote-refs-after.txt"
git fetch --prune origin \
  '+refs/heads/*:refs/remotes/origin/*' \
  '+refs/tags/*:refs/tags/*'
git ls-remote --refs origin 'refs/heads/*' 'refs/tags/*' > "$REMOTE_REFS_AFTER"
while read -r remote_sha ref; do
  [ -z "$ref" ] && continue
  local_sha="$(git rev-parse --verify "$ref" 2>/dev/null || true)"
  [ "$local_sha" = "$remote_sha" ] \
    || { echo "remote ref mismatch: $ref — ABORT"; exit 1; }
done < "$REMOTE_REFS_AFTER"
for d in $PURGE_DIRS; do
  [ -d "$d" ] || continue
  path_commits="$(git log --all --format=%H -- "$d" | sort -u)"
  while IFS= read -r path_commit; do
    [ -n "$path_commit" ] || continue
    grep -Fxq "$path_commit" "$CLEAN_READD_COMMITS" \
      || { echo "purged-path history remains for $d — ABORT"; exit 1; }
  done <<< "$path_commits"
done
```

**Step 4 — log it (to the PERSONAL brain, NEVER the shared repo).** Per
data-loss-gate, append the deletion under `## Data Deletions` — but write it to
the PERSONAL brain's `$PERSONAL/daily/notes/YYYY-MM-DD.md` (or a local ops
log), never into the shared repo. The log names the purged paths AND the
backup location; in the shared repo those two facts would tell every team
member exactly which paths held sensitive content and where the
pre-sanitization backup lives — the audit trail becomes a treasure map.
Record: timestamp, purged paths, commit counts, and `$BACKUP_PATH` as the
recovery line.

**After the force push:**

- All existing clones must re-clone
- Hosting providers may cache unreachable commits for a time (on the order of
  months); for immediate removal use the provider's sensitive-data removal
  process. For private/internal repos, the SHA being unreachable from any ref
  is usually sufficient
- The sync cursor may reference a rewritten-away SHA; if the next
  `gbrain sync` errors or falls back to a full rescan, that is the cursor
  recovering — run `gbrain doctor` if it doesn't settle
- **Backup retention:** once the rewrite is verified good (team has
  re-cloned, sync settled, no missing content reported), keep the
  mirror-clone backup in `~/.gbrain/backups/` for a retention window
  (~30 days is a sane default), then delete it — it contains the
  pre-sanitization history and should not accumulate indefinitely:
  read the persisted path from the literal pointer
  `"$HOME/.gbrain/backups/brainify-backup-path.txt"` (reassign the pointer
  variable in the later shell if desired), verify it is an absolute path under
  `~/.gbrain/backups/`, then run
  `BACKUP_PATH="$(<"$HOME/.gbrain/backups/brainify-backup-path.txt")"; rm -rf -- "$BACKUP_PATH"`.
- If the repo carries push hooks or auto-hardening wiring, re-verify remotes
  and hooks survived the rewrite before handing the repo to the team

### Phase 6: Ongoing hygiene — periodic re-audit

Sensitive data re-accumulates through meeting-transcript ingestion (candid
assessments), enrichment pipelines pulling internal data, and manual writes
during candid conversations. One clean pass is a snapshot, not a state.

**Recommendation:** schedule a monthly re-audit (weekly for high-ingest
brains) that re-runs Phases 1, 2, and 4 in report-only mode — scan and flag,
no edits — and surfaces new hits for human review before they reach the
shared repo. Wire it per
[conventions/cron-via-minions.md](../conventions/cron-via-minions.md): the
cron slot submits a background job (`gbrain jobs submit`), scheduling
guidance in `skills/cron-scheduler/SKILL.md`, job-lane routing in
`skills/minion-orchestrator/SKILL.md`. The report-only run writes its
findings summary; a human (or a gated follow-up run) does the removal.

## Scaling Notes

- **< 20 files:** process sequentially in one pass
- **20-50 files:** 2-3 parallel subagents
- **50-150 files:** 8-12 parallel subagents, batches of 10-15
- **150+ files:** scripted pattern removal for the rote cases only
  (frontmatter fields, phone numbers — machine-emitted shapes, per
  regex-discipline) + subagents for everything needing judgment

## Edge Cases

- **Founders vs. employees:** founder/exec pages often carry the most
  sensitive content (board dynamics, investor relationships, assessments of
  their own team). These need the most careful review.
- **Meeting notes:** meeting pages referencing employee performance need the
  same treatment as people pages — they are in scope, not an afterthought.
- **Cross-references:** after sanitizing people pages, check that no other
  page (meetings, companies, dailies) still references the removed content;
  `gbrain check-backlinks check` plus a grep for the removed section titles.
- **Takes with attribution:** a take like "the user believes
  charlie-example is underperforming" reveals both the opinion and who holds
  it. Remove the entire take, not just the attribution.
- **Aliases and nicknames:** grep for the person's short name and initials,
  not just the slug — candid content rarely uses full names.

## Dedup (sharp boundaries)

- **[data-loss-gate](../data-loss-gate/SKILL.md)** — supplies the
  confirmation-card mechanics and the explicit-yes discipline; company-brainify
  is a specialized caller of it at BOTH destructive steps: Phase 3 (bulk strip
  + take/fact removal) and Phase 5 (history purge + force-push), each with a
  pre-filled card. A standalone "delete/purge/clean up X" intent routes to
  data-loss-gate; the personal→team sanitization WORKFLOW routes here.
- **[publish](../publish/SKILL.md)** — outbound sharing of ONE page as
  encrypted self-contained HTML. company-brainify is whole-brain inbound team
  access. "Share this page" → publish; "share my brain with the team" → here.
- **[maintain](../maintain/SKILL.md)** — structural health (orphans,
  backlinks, stale pages). maintain checks whether the brain is HEALTHY;
  company-brainify checks whether it is SAFE TO SHARE. "Check brain health"
  routes to maintain.
- **frontmatter-guard (host-side)** — validates frontmatter SHAPE.
  company-brainify strips sensitive frontmatter FIELDS; run
  frontmatter-guard after a large pass to confirm what remains still
  parses.

## Contract

This skill guarantees:

- Both destructive steps fire the data-loss-gate confirmation card and wait for
  an explicit typed "yes"/"do it" BEFORE running: Phase 3 (bulk strip + take/
  fact removal) and Phase 5 (history purge + force-push). This is a routing
  convention the agent must follow — nothing in the runtime mechanically blocks
  a skipped gate, which is why skipping it is the cardinal violation of this
  skill.
- Phase 3 defaults to sanitizing a STAGING COPY of the scanned scope, leaving
  the personal brain's working tree untouched; in-place edits are reserved for
  re-auditing an existing shared brain.
- The Phase 5 history purge (Steps 3+) runs only on the SHARED repo cloned to a
  work dir — never `sync.repo_path` — after (a) a mirror-clone backup exists and
  is verified, and (b) a restore-completeness check passes before the
  force-push. The personal brain's history is never rewritten.
- The deletion log is written to the PERSONAL brain (`daily/`) or a local ops
  log, never into the shared repo.
- The scan covers the full scope (people, meetings, dailies, companies,
  projects, analysis, takes, facts, back-links), never `people/` alone.
- Nothing unscanned ships: the fresh-export path includes ONLY directories
  covered by the sanitization scan; everything else is excluded by default,
  and the Phase 4 verification greps run against the exported tree before
  the first push.
- Sensitive fact rows are deleted from the page's Facts fence and re-synced,
  never merely expired — `gbrain forget` retains the row (struck through,
  served via `--include-expired`) and can never certify clean.
- The history-purge filter list and its restore manifest both derive from
  the COMPLETE set of sanitized paths, never a subset.
- Every strip decision is a per-file model judgment grounded in a full read;
  grep output is triage and verification only.
- A verification pass (Phase 4 greps + retrieval checks) runs before any
  commit is pushed to the shared repo.
- Confirmed purges are logged to `daily/notes/YYYY-MM-DD.md` under
  `## Data Deletions` with the backup path as the recovery line.
- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (edits in
  place, plus the daily/ deletion log).
- Privacy contract preserved: no real names, no fork-specific filesystem path
  literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this
section exists for the conformance test.

## Output Format

Three artifacts:

1. **The sanitization report** (every run, including report-only re-audits):

```markdown
## Brainify Report — YYYY-MM-DD

- Scope: [N files scanned across people/, meetings/, daily/, ...]
- Flagged: [M files with hits] (triage list attached)
- Edited: [K files sanitized; T takes removed; F fact rows removed + re-synced]
- Verification: [grep residuals: 0 confirmed-sensitive; retrieval checks: clean]
- History: [not purged | fresh-export | purged after confirmed gate — backup at <path>]
- Next re-audit: [date / cron slot]
```

2. **The confirmation card** (Phases 3 and 5) — the pre-filled fenced card,
   presented before the bulk destructive edits (Phase 3) and before any history
   rewrite (Phase 5); the turn stops until the user answers.
3. **The deletion log entry** (post-purge only) — appended to the PERSONAL
   brain's `daily/notes/YYYY-MM-DD.md` (never the shared repo) per
   data-loss-gate Step 4.

## Anti-Patterns

- ❌ Scanning only `people/` — meetings, dailies, and cross-references leak
  the same content
- ❌ Sanitizing working-tree files and calling it done — history still carries
  every sensitive version
- ❌ Exporting the whole repo into the team brain — the export ships ONLY
  scanned directories; nothing unscanned ships
- ❌ Using `gbrain forget` as sanitization — forget expires (struck-through
  row retained, served via `--include-expired`); delete the fence row and
  re-sync instead
- ❌ Purging history for a subset of the sanitized paths — the filter list
  derives from the complete scan scope, not just `people/` + `meetings/`
- ❌ Running `git filter-repo` / force-push without the mirror-clone backup
  and the typed confirmation — the card comes BEFORE the rewrite, always
- ❌ Running `git filter-repo` / force-push in `sync.repo_path` — the purge
  targets the SHARED repo cloned to a work dir; the personal brain's history is
  never rewritten
- ❌ Stripping the personal brain in place when standing up a NEW team brain —
  sanitize a staging copy; the founder's private comp/performance notes stay
- ❌ Bulk-editing files and removing takes/facts without the Phase 3
  data-loss-gate card — destructive edits are gated too, not just the purge
- ❌ Writing the deletion log into the shared repo — it names the sensitive
  paths and the backup location; log it to the PERSONAL brain
- ❌ Treating grep as the sensitivity judge — patterns triage, the model
  reads and decides (regex-discipline)
- ❌ Removing the attribution but keeping the take — the claim itself is the
  leak; remove the whole row
- ❌ Bulk-editing 150 files without a 3-5 file test first (test-before-bulk)
- ❌ Tightening grep patterns to eliminate false positives — confirm the hits
  manually instead; a "clean" scan from an over-fitted pattern is a false
  certificate
- ❌ One clean pass with no re-audit — ingestion and enrichment re-accumulate
  sensitive content; schedule Phase 6
