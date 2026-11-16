---
name: brigadev-skill-creator
description: "Trigger: create skill, update skill, new SKILL.md. Create or update concise LLM-first skills with valid frontmatter for a marcsh pack."
---

## When to use

Creating or updating a reusable skill: a workflow or convention reused across sessions, project-specific constraints on generic behavior, or a decision tree that helps the agent choose safely. Not for one-off tasks or rules that belong in code or tests.

## Rules

- A skill is a runtime contract for the model, not human docs. Imperative instructions, concrete gates, no tutorials.
- Keep `SKILL.md` short: target 180–450 tokens, at most ~1000.
- `name`: lowercase letters, digits, and single hyphens; at most 64 characters; matches the directory name.
- `description`: one line, trigger words first, then what it does. At most 1024 characters. This is what routes the model to the skill. Quote it when it contains `: ` (YAML would otherwise fail and a pack install is rejected).
- Frontmatter holds `name` and `description` only. A pack is rejected when a skill declares `hooks` or has a line that is only `...` in its frontmatter; avoid `allowed-tools` (it pre-approves tools and is flagged in the install preview).
- Templates and schemas go in `assets/`; long rationale and edge cases in `references/`, linked by relative path. No symlinks, and no file over 1 MB.
- A pack's skills load only while one of the pack's agents is selected: add the new skill, with its trigger, to that agent's prompt (`agents/<agent>.md`). Update an existing skill instead of creating an overlapping one.

## Placement

| Scope | Location |
| --- | --- |
| This pack | `packs/brigadev/skills/<name>/SKILL.md` |
| Another pack | `skills/<name>/SKILL.md` in that pack's repository |
| Personal | the engine's own personal skills folder (not loaded through a pack) |

## Template

```markdown
---
name: <skill-name>
description: "Trigger: <phrases users will say>. <What the skill does>."
---

## When to use
## Rules
## Execution
## Output
```

## Finish

Check before reporting: the frontmatter opens and closes with a bare `---` line and parses as YAML, the name matches the folder, and the owning agent's prompt names the skill. To try it, push a branch and `/agents install owner/repo@branch` (or `/agents update owner/repo`), select the pack's agent, and ask for something that matches the trigger. Report the files created or changed.
