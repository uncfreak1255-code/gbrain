# Repo-Local Loop Routing

These are the repo-local loop defaults for repeated `gbrain` tasks. They do
not replace the normal skill or GStack spine. They narrow recurring work to a
small proof gate, one bounded action, and a clean stop path.

## Doctor Health Loop

Adapted from the published production error sweep loop.

Use when:
- `gbrain doctor --json` reports warnings or failures
- a health automation or operator asks whether the brain is healthy
- remediation is being considered

Read fresh state:
- `gbrain doctor --json`
- `gbrain doctor --remediation-plan --json`

Proof gate:
- parsed doctor status, score, and remediation-plan readback

Act:
- if the plan is cheap, routine, and approved, run one bounded maintenance pass
- otherwise classify the next move without mutating anything else

Stop:
- clean no-op
- one verified improvement
- blocked
- approval-required
- spend-required
- no progress after the bounded pass

## Docs And LLMS Loop

Adapted from the published docs sweep loop.

Use when:
- docs may be stale versus implementation
- `AGENTS.md`, `CLAUDE.md`, or reference docs changed
- `llms.txt` or `llms-full.txt` may need regeneration

Read fresh state:
- inspect the implementation or diff first
- identify only provably stale docs

Proof gate:
- `bun run build:llms`
- `bun run check:doc-history`
- the relevant focused tests for the touched surface

Act:
- patch only the stale docs
- regenerate `llms` artifacts in the same pass

Stop:
- PR-ready verified diff
- clean no-op
- blocked proof gap

## Dream Value Loop

Adapted from the published self-improving champion loop.

Use when:
- tuning Dream models, caps, or source scope
- deciding whether Dream synthesis is actually helping
- widening a bounded Dream run

Read fresh state:
- current Dream config
- the latest `dream-cycle-summaries/*`
- `gbrain eval dream-quality` receipts
- autopilot state before manual bounded runs

Proof gate:
- the same fixed `gbrain eval dream-quality` receipt set improves without worse
  failures or spend

Act:
- keep autopilot enabled as the normal background mode; pause it only before a
  manual `gbrain dream` run that writes or spends, verify it is stopped, and
  restore it after scoring; read-only or dry inspection paths that avoid
  spend-capable phases can run while autopilot is alive, but dry synthesize/atom
  synthesis still needs the pause because it can spend or cache verdicts
- for the bounded nightly wrapper, classify outcomes explicitly: no written
  artifacts is a clean `skipped` run; a passing quality receipt makes an
  artifact `review_eligible`; a valid failed or inconclusive receipt makes it
  `quarantined`; child-limit, timeout, cleanup, or missing-quality-receipt
  failures remain failed runs
- a quality pass permits human review only. It does not write to an owning repo
  or promote Dream material into canon
- change one Dream parameter at a time
- use `dream.synthesize.max_children_per_cycle` for a hard per-run child
  budget: synthesize skips an entire transcript before any of its chunks are
  enqueued when it cannot fit, returns a failed receipt, and leaves the
  cooldown unstamped. A wrapper's post-run child-count check is defense in
  depth, not the pre-submit guard.
- keep `zai:glm-5.2` for synth and
  `anthropic:claude-haiku-4-5-20251001` for verdicts unless new proof says
  otherwise

Stop:
- clear holdout win
- no progress
- dead children
- receipt failure
- approval-needed scope expansion

## Fresh Clone Loop

Adapted from the published fresh-clone loop.

Use when:
- testing whether setup docs still work
- verifying the install promise for a new operator or agent
- a setup or onboarding path feels fragile

Read fresh state:
- the current install docs
- the actual setup path
- any existing fresh-user harness

Proof gate:
- one uninterrupted clean install reaches the documented ready state using only
  the documented path

Act:
- fix the first real missing step or hidden assumption
- retry from a disposable environment

Stop:
- clean end-to-end success
- blocked credentials or environment
- no progress after the next bounded doc or setup fix

## Already Present

The propagation-compliance loop is already effectively adopted here through the
fork tracking policy and readback commands in
`docs/operations/fork-upstream-policy.md`. Do not add a second competing fork
tracking loop unless the existing one proves insufficient.
