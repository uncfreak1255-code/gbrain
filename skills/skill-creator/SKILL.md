---
name: skill-creator
version: 1.0.0
description: |
  Create new skills following the GBrain conformance standard. Generates SKILL.md
  with frontmatter, Contract, Phases, Output Format, and Anti-Patterns. Checks
  MECE against existing skills. Updates manifest and resolver.
triggers:
  - "create a skill"
  - "new skill"
  - "extend this skill"
tools:
  - search
  - list_pages
mutating: true
---

# Skill Creator

## When NOT to use this skill

Three meta-skills share this space; route by intent:

- **skill-creator** (this skill) — a capability is missing, or an existing
  skill needs structural extension (new coverage, new phases, new triggers).
- **skill-optimizer** — an existing skill's *execution quality* should improve
  against a benchmark ("optimize this skill", "make the skill better",
  "run skillopt"). It never touches the routing surface.
- **skillify** — an existing *feature* needs the full conformance treatment
  ("skillify this", "make this proper"): 12-item checklist, cross-modal eval,
  tests.

## Contract

This skill guarantees:
- New skill follows conformance standard (frontmatter + required sections)
- MECE check: no overlap with existing skills' triggers
- Manifest.json updated
- RESOLVER.md updated with routing entry
- Skill passes conformance tests (`bun test test/skills-conformance.test.ts`)

## Phases

1. **Identify the gap.** What capability is missing? What user intent has no skill?
2. **MECE check.** Review `skills/manifest.json`, `skills/RESOLVER.md`, and the `triggers:` frontmatter of neighboring skills. Does any existing skill already cover this? If so, extend it instead of creating a new one. (Frontmatter `triggers:` are the canonical routing surface for downstream skillpack consumers per `_AGENT_README.md`; manifest.json and RESOLVER.md remain host-repo conformance surfaces read by `check-resolvable` and the conformance tests — update all three.)
3. **Create SKILL.md.** Use this template:

```yaml
---
name: {skill-name}
version: 1.0.0
description: |
  {One paragraph describing what the skill does and when to use it.}
triggers:
  - "{trigger phrase 1}"
  - "{trigger phrase 2}"
tools:
  - {tool1}
  - {tool2}
mutating: {true|false}
---

# {Skill Title}

## Contract
{What this skill guarantees — 3-5 bullet points}

## Phases
{Numbered workflow steps}

## Output Format
{What good output looks like}

## Anti-Patterns
{What NOT to do — 3-5 items}

## Tools Used
{GBrain operations used, with descriptions}
```

4. **Add to manifest.** Update `skills/manifest.json` with name, path, description.
5. **Add to resolver.** Update `skills/RESOLVER.md` with routing entry in the appropriate category.
6. **Verify.** Run `bun test test/skills-conformance.test.ts` to confirm the new skill passes.

## Output Format

New `skills/{name}/SKILL.md` file + updated manifest + updated resolver.

## Anti-Patterns

- Creating a skill that overlaps with an existing one (violates MECE)
- Skipping the MECE check against existing skills
- Creating a skill without triggers in frontmatter
- Not updating manifest.json and RESOLVER.md
- Creating a skill without an Anti-Patterns section
