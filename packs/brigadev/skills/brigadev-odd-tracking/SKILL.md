---
name: brigadev-odd-tracking
description: "Trigger: large task, track this, feature document, resume. Feature document and task list for multi-session ODD work."
---

# brigadev: ODD tracking

Parent session only. Load when a task is large (its resume test fails) or the user asks to track it. Small tasks never create these artifacts.

## Feature document

For large authorized work, create `tasks/<feature-name>.md` in the repo docs folder (`${BRIGADEV_HOME:-$HOME/.brigadev}/<repo>/`, defined in the brigadev prompt; never inside the project) right after exploration, without asking permission. Use a descriptive, filename-safe name; reuse it on resume; never overwrite another feature's document. It is the spec subagents read by path (put the absolute path in their `Task` prompt), so keep this fixed order (stable content first, growing log last):

1. **Header** (2–3 lines): objective, branch, delivery strategy, test runner.
2. `## Specs`: numbered `S1..Sn` requirements, constraints, and acceptance criteria with their checks. Quote the user's exact strings, error messages, commands, and examples verbatim, in the user's language. Never add requirements the user did not ask for; mark assumptions as assumptions.
3. `## Tasks`: one line per task with a stable ID, linked `S#`, route (inline or delegated + trigger), status, and commit or RED/GREEN evidence.
4. `## Log`: `L1` is the user's original request verbatim. Later user corrections are logged verbatim with their date. Then analysis, rationale for accepted changes, verification evidence, progress, and next step. Keep it brief.

Template:

```markdown
# <Feature title>
Objective: <one line>. Branch: `<branch>`. Delivery: ask-on-risk. Tests: `<runner command>`.

## Specs
- S1: <requirement, quoting the user verbatim>. Check: <how it is verified>.

## Tasks
- T1 [S1] inline — pending

## Log
- L1 (<date>): "<original request, verbatim>"
```

Rules:

- Update with targeted edits; never rewrite the whole file to change one line.
- A requirement change appends its verbatim `## Log` entry, rewrites only the affected `S#`, and reopens only its linked tasks.
- Check off only observed outcomes with proof. Record failed, skipped, or pending checks honestly.
- Obsolete tasks become `dropped` with the reason in `## Log`; never mark them done. Tasks waiting on something outside the list become `blocked` with a note naming what unblocks them.
- If a memory tool (for example `mem_save`) is available, mirror the full document under topic `odd/<feature-name>` after each update. If not, the file alone is the authority.

## Task list projection

When the `todo` tool (pi) or `TodoWrite` (Claude) is available, it is the visible view of `## Tasks`, not a second authority. After writing the document, set the list with the same IDs before the first source write (statuses `pending`, `in_progress`, `done`, `blocked`, `dropped`). Update both in the same turn on every task transition. Without either tool, `## Tasks` is the only list.

## Resume

Read the feature document (and memory mirror, if any). Reconcile requirements, code, and proof before continuing the next unfinished task. Reproduce a reported failure by running it; reading code is not reproduction.

## Close gate

Before the final answer, if any tracked task is still pending, continue it or quote the user sentence that orders the stop. A single **Needs your decision** result naming the open blockers is also a valid stop.

## Delivery

- Work on a `type/description` feature branch (start one first when on the default branch). Commit each finished work unit automatically (load `brigadev-work-unit-commits`): one deliverable behavior with its tests and docs per commit. A high-risk unit gets its own commit.
- Use ~400 authored changed lines per PR slice as a planning heuristic, never a hard cap. Never shrink code, delete comments, or drop tests to fit it.
- When the forecast or running count exceeds ~400 lines, load `brigadev-chained-pr` and apply the feature's delivery strategy (`ask-on-risk` by default). Record slice boundaries in the document.
- Push, PR creation, and merge remain human decisions.
