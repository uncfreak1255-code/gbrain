# Source-Recovery Legacy Slug Identity Plan

**Status:** implemented; awaiting final closeout
**Date:** 2026-08-02
**Issue:** #3772

## Goal

Make a complete, source-scoped recovery export round-trip through the supported
sync flow without changing the active `(source_id, slug)` set. A recovery
bundle may preserve a historical slug that current path slugification would
otherwise normalize into a second page.

## Constraints

- Keep normal `frontmatter.slug` mismatch rejection unchanged for ordinary,
  untrusted files.
- Only a complete source-scoped export manifest for the same source may enable
  recovery identity handling.
- The manifest may preserve only the identity literally represented by its own
  `slug + '.md'` path; it must never authorize an arbitrary path to claim a
  different page.
- Verify each manifest-listed Markdown file against its recorded SHA-256
  before using that recovery identity. A malformed or mismatched recovery
  receipt fails closed for the affected file.
- Use generic test data and do not put any local corpus content in this public
  repository.

## Implementation Steps

### 1. Freeze the red integration regression

**Files:** `test/export-sync-slug-roundtrip.test.ts`

- Seed one generic active page whose stored slug contains a legacy
  noncanonical character that changes under `slugifyPath`.
- Export exactly that source, commit the recovery checkout, and run the
  isolated source sync.
- Assert that the active slug set and count remain exactly the original set;
  the path-derived duplicate must not exist.
- Add the negative companion: a normal checkout without a verified recovery
  manifest still records a `SLUG_MISMATCH` instead of honoring a mismatched
  frontmatter slug.

Run: `bun test test/export-sync-slug-roundtrip.test.ts`

### 2. Add a confined recovery-manifest verifier

**Files:** new `src/core/source-recovery-manifest.ts`; focused regression suite

- Read only the root `.gbrain-export-manifest.json` for a source checkout.
- Accept the current complete source-export schema only when its `source_id`,
  counts, per-page slug, deterministic relative path, and Markdown digest are
  valid.
- Build a read-only `relativePath -> storedSlug` map only for verified files.
- Treat an invalid same-source recovery manifest or digest mismatch as a
  fail-closed recovery error before an identity override is issued, never as
  an authority downgrade.

Run the new focused parser/verification test file.

### 3. Thread verified recovery identity through both sync paths

**Files:** `src/commands/sync.ts`, `src/commands/import.ts`,
`src/core/import-file.ts`

- Load the verifier once after sync resolves the source checkout.
- Pass the map into both incremental sync and full import; first recovery sync
  must not bypass the fix.
- Let `importFromFile` use a recovery slug only when it received the
  verifier's runtime source/path-bound capability. With no recovery identity,
  retain the existing path-authoritative behavior byte-for-byte.
- In recovery mode, accept an absent slug field or one equal to the stored
  recovery slug; reject any other explicit frontmatter slug.

### 4. Verify the boundary, not just the happy path

- Run the new round-trip regression.
- Run the adjacent import and source-export suites.
- Run `bun run ci:local:diff` when Docker is available.
- Review the diff specifically for a path that lets `notes/random.md` claim an
  unrelated existing slug. If found, keep the anti-spoof rejection and revise
  the recovery proof rather than widening trust.

## Completion Gate

The change is ready for review only when the source-scoped recovery fixture
retains one exact active slug set, the ordinary spoof fixture remains rejected,
and the focused plus diff-aware CI checks pass. This plan does not authorize a
release, push, or production recovery export.
