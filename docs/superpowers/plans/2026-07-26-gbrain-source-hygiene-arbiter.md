# GBrain Source Hygiene Arbiter Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect the database-only default corpus, make source-path failures consistent across Doctor/Planner/Advisor, and give the existing maintenance workflow evidence-based investigator, adversarial-review, and executor gates.

**Architecture:** Add source-scoped export and a deterministic source-hygiene inspector as the shared evidence layer. Local CLI surfaces may inspect filesystem paths; remote/MCP surfaces remain database-only and never walk stored paths. Doctor and Advisor surface the same findings, while the local remediation planner blocks unrelated paid work until source-path failures are resolved. Extend the existing `maintain` skill instead of creating a new agent control plane.

**Tech Stack:** TypeScript, Bun, PGLite/Postgres `BrainEngine`, existing `gbrain sources` lifecycle commands, repo-local Markdown skills.

---

## Chunk 1: Source-scoped recovery export

### Task 1: Add the failing source-isolation export tests

**Files:**
- Modify: `test/storage-export.test.ts`

- [ ] Seed two sources with the same slug but different body, tags, and raw-data rows.
- [ ] Assert `runExport(..., ['--source', 'default'])` exports only the default page.
- [ ] Assert tags and raw data are read with `{ sourceId }`, so the neighboring source cannot leak into the export.
- [ ] Assert a source-scoped manifest records source id, page count, per-page content hash, Markdown hash, and raw-sidecar count without printing private page content.
- [ ] Assert an unknown source exits loudly instead of producing an empty success.
- [ ] Assert missing `--source` values, traversal-shaped legacy slugs, and `--source` combined with `--restore-only` fail before any write.
- [ ] Assert both source directions for a shared slug and preserve legacy no-source behavior.

Run: `bun test test/storage-export.test.ts`
Expected: FAIL because `--source` and the manifest do not exist yet.

### Task 2: Implement source-scoped export and manifest receipts

**Files:**
- Modify: `src/commands/export.ts`
- Modify: `src/cli.ts`

- [ ] Parse `--source <id>` and verify the active source exists.
- [ ] Pass `sourceId` through `PageFilters`, `getTags`, and `getRawData`.
- [ ] Sort scoped pages by slug and confine every generated path beneath the output directory.
- [ ] Reject `--source` with `--restore-only` for v1.
- [ ] For source-scoped exports, write `.gbrain-export-manifest.json` only after all writes succeed. The canonical newline-terminated JSON has no timestamp and contains `schema_version`, `source_id`, `source_page_count`, `page_count`, `raw_sidecar_count`, and per-page `slug`, nullable `db_content_hash`, `markdown_sha256`, nullable `raw_sidecar_sha256`, and `raw_record_count`. Reject filters, paginate the full active source, and fail closed unless `source_page_count === page_count`.
- [ ] Print the final manifest SHA-256 without embedding a self-referential checksum; never echo page bodies.
- [ ] Keep legacy all-source behavior unchanged and preserve `--restore-only` guards.
- [ ] Document that legacy all-source output is not collision-safe when sources share a slug; this feature is a recovery projection, not a full relational database restore.
- [ ] Update CLI help with the new flag and receipt behavior.

Run: `bun test test/storage-export.test.ts`
Expected: PASS.

## Chunk 2: Shared source-hygiene evidence

### Task 3: Add pure classification and engine-backed inspection tests

**Files:**
- Create: `test/source-hygiene.test.ts`

- [ ] Cover `healthy`, `archive_candidate`, `recovery_required`, and `not_applicable` classifications.
- [ ] Require `archive_candidate` to be non-default with a missing path, zero source-owned dependent data, no remote/managed recovery metadata, no configured-default reference, no nonterminal source work of any status, and no live lock; unknown work states fail closed.
- [ ] Require every populated missing-path source, especially `default`, to be `recovery_required`; deletion and sync-from-empty are prohibited.
- [ ] Allow only a managed clone with trusted remote metadata to classify as auto-recoverable via the existing sync path; user-owned/no-remote paths remain recovery-required.
- [ ] Cover shared legacy paths, archived rows, remote/no-filesystem mode, and generic placeholder fixtures only.

Run: `bun test test/source-hygiene.test.ts`
Expected: FAIL because the inspector does not exist yet.

### Task 4: Implement the source-hygiene inspector

**Files:**
- Create: `src/core/source-hygiene.ts`
- Modify: `docs/architecture/KEY_FILES.md`

- [ ] Reuse `loadAllSources`, repo-state/owned-clone helpers, and live sync-lock state; query active source metadata plus bounded aggregate counts without reading page bodies.
- [ ] Inspect filesystem paths only when the trusted local caller opts in.
- [ ] Return a schema-versioned decision packet with evidence, classification, proposed command, veto reasons, and `safe_for_agent_review`.
- [ ] Keep execution outside the pure inspector; existing `sources archive/restore` remain lifecycle authority.

Run: `bun test test/source-hygiene.test.ts`
Expected: PASS.

### Task 4A: Exclude archived sources from path routing

**Files:**
- Modify: `src/core/source-resolver.ts`
- Modify: `test/source-resolver.test.ts`
- Modify: `test/source-resolver-with-tier.test.ts`

- [ ] Add `archived = false` to both path-based source resolver queries.
- [ ] Prove an archived source sharing the active source's exact path cannot win either resolver.

Run: `bun test test/source-resolver.test.ts test/source-resolver-with-tier.test.ts`
Expected: PASS.

## Chunk 3: Align Doctor, Planner, and Advisor

### Task 5: Add failing cross-surface regression tests

**Files:**
- Modify: `test/doctor.test.ts`
- Create: `test/advisor-source-hygiene.test.ts`
- Modify: `test/brain-score-recommendations.test.ts`

- [ ] Reproduce a healthy configured repo plus two other sources sharing a missing path: one empty and one populated/protected.
- [ ] Assert Doctor names `source_path_health` as the root issue and recommends sync only for a missing GBrain-managed clone with trusted remote metadata.
- [ ] Assert the local planner includes source-specific blocked reasons and suppresses paid/protected atom work while the root source-path failure remains.
- [ ] Assert Advisor reports the same source findings at warn/critical severity rather than returning an info-only all-clear.
- [ ] Assert remote/MCP paths never call filesystem probes.

Run: `bun test test/doctor.test.ts test/advisor-source-hygiene.test.ts test/brain-score-recommendations.test.ts`
Expected: FAIL before integration.

### Task 6: Wire the shared evidence into the three surfaces

**Files:**
- Modify: `src/commands/doctor.ts`
- Modify: `src/core/doctor-categories.ts`
- Modify: `src/core/doctor-action-tiers.ts`
- Modify: `src/core/doctor-cause-rank.ts`
- Modify: `src/core/remediation/types.ts`
- Modify: `src/core/remediation/context.ts`
- Modify: `src/core/remediation/plan.ts`
- Modify: `src/core/remediation/run.ts`
- Modify: `src/core/brain-score-recommendations.ts`
- Modify: `src/commands/onboard.ts`
- Modify: `src/commands/autopilot.ts`
- Modify: `src/commands/jobs.ts`
- Create: `src/core/advisor/collect-source-hygiene.ts`
- Modify: `src/core/advisor/run.ts`
- Modify: `skills/gbrain-advisor/SKILL.md`

- [ ] Register the trusted-local Doctor check and preserve remote trust boundaries.
- [ ] Add an explicit local-inspection option to remediation planning; CLI Doctor uses it, onboard/MCP defaults do not.
- [ ] Thread trusted-local inspection through the initial plan, every D7 remediation recheck, and local onboard; MCP defaults remain DB-only.
- [ ] Add per-source blocked reasons and remove protected/cost-bearing steps while a root source recovery is unresolved.
- [ ] Gate autopilot's independent protected atom-drain submitter on the same source-hygiene result so it cannot spend around the planner.
- [ ] Re-read source health in the atom-drain job handler immediately before spend, closing the queue-time/execution-time race.
- [ ] Replace the generic `sync_freshness` “run sync” hint for a missing directory with the source-hygiene recovery/archive direction.
- [ ] Add the Advisor collector and mark deterministic archive candidates as agent-reviewable rather than Sawyer-choice items.
- [ ] Keep credentials, paid work, customer impact, and ambiguous populated-source recovery as escalation boundaries.

Run: `bun test test/source-hygiene.test.ts test/doctor.test.ts test/doctor-behavioral.test.ts test/doctor-categories.test.ts test/doctor-cause-rank.test.ts test/remediation-context.test.ts test/brain-score-recommendations.test.ts test/advisor-source-hygiene.test.ts test/advisor-op-gate.test.ts test/autopilot-auto-drain-wiring.test.ts test/extract-atoms-drain-handler.test.ts test/e2e/onboard-full-flow.test.ts`
Expected: PASS.

Run: `bun test test/doctor-report-remote.serial.test.ts`
Expected: PASS with zero local filesystem probes on the remote path.

## Chunk 4: Existing maintenance workflow, runtime recovery, and closeout

### Task 7: Extend the existing repo-local maintenance workflow

**Files:**
- Modify: `skills/maintain/SKILL.md`
- Modify: `docs/guides/loop-routing.md`
- Modify: `docs/architecture/KEY_FILES.md`
- Modify: `docs/TESTING.md`

- [ ] Add the source-hygiene loop: investigator receipt -> adversarial veto attempt -> at most one bounded lifecycle action -> fresh readback.
- [ ] Encode the autonomous rule for a zero-content missing source and the preserve/recover rule for populated sources.
- [ ] State that unrelated paid remediation cannot close a source-health failure.
- [ ] Never auto-remove or purge; state plainly that soft archive is reversible for only 72 hours.
- [ ] Keep the workflow repo-local; add no global skill, MCP, automation, or separate agent folder.

Run: `bun run check:resolver && bun run check:skill-brain-first`
Expected: PASS.

Run: `bun run build:llms && bun run check:doc-history`
Expected: PASS with regenerated documentation indexes tracked deliberately.

### Task 8: Protect and recover the current local runtime

**Runtime only; never commit private exports to the GBrain code repository or push them remotely. A private local recovery-repository commit is required. Current-turn authorization is the user's explicit “Do 1-5”; stop if live evidence no longer matches the approved zero-content/populated-source classification:**
- [ ] Freshly verify source counts, shared path, remote/config metadata, active jobs/locks, archive status, and target absence.
- [ ] Run the new source-scoped export for `default` into a new private directory on the same filesystem.
- [ ] Verify exactly 443 unique slugs, 443 Markdown files/hashes, zero missing files, and the manifest checksum; report nullable source hashes honestly.
- [ ] Initialize and commit the private recovery repository before archiving anything.
- [ ] Capture the full source row/config and an exact restore command for `brain-sync-remote-thbelj`, then soft-archive it; verify archived and active readbacks.
- [ ] Record that archive becomes destructive when its 72-hour purge window expires. Keep the duplicate archived and stop on any later recovery failure; restore before expiry only if the archive classification or archive action itself proves incorrect.
- [ ] Recheck target absence, then atomically rename the committed recovery repository to `/Users/sawbeck/.gstack-brain-worktree`; never overwrite an existing directory.
- [ ] Run `gbrain sync --source default --no-embed --no-extract` with a supported hard deadline and no concurrent source work.
- [ ] Export `default` again into a separate private directory and compare canonical per-slug Markdown/raw hashes; verify page count remains 443.
- [ ] Run fresh `sources status`, Doctor, remediation-plan, and Advisor readbacks.

Expected: the empty source is reversibly archived; all 443 pages remain retrievable and Git-backed; source-path failures clear; no paid job runs.

### Task 9: Adversarial review and verification

**Files:** all task diff files.

- [ ] Run a spec-compliance reviewer over the integrated diff.
- [ ] Run an adversarial reviewer focused on data loss, cross-source leakage, remote filesystem access, and false auto-approval.
- [ ] Apply the simplify checkpoint to the current diff only.
- [ ] Run focused tests and `bun run typecheck`.
- [ ] Run `bun run ci:local:diff` as the repository proof gate.
- [ ] Run the configured full-branch Codex autoreview before landing readiness.
- [ ] Recheck Git/worktree/branch/runtime residue and close out without pushing unrelated existing commits.

Expected: all checks pass, reviewers report no blocking findings, runtime receipts match, and private recovery artifacts remain outside Git.
