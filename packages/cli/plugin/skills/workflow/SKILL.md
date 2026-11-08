---
name: workflow
description: Use this for any request to change code (a feature, a fix, a refactor, a rename, a config or test change). It picks the lane, small (work inline) or large (feature doc first), and sets how to prove the work is done.
---

# marcsh workflow

Pick the lane before touching code, and say which one you picked in one line.

## Small lane

Use it when all of these hold:

- the outcome and the location are known;
- there is no open decision for the user;
- the work can be resumed from the request and the diff alone.

Then work inline:

1. If a deterministic test applies, write it first and watch it fail for the right reason.
2. Make the smallest change that passes. No drive-by refactors.
3. Run the focused test, then the whole suite, and read the output.
4. End with a one-line risk note: what could still be wrong, or "none".

## Large lane

Use it when any of these hold:

- the work spans several sessions;
- there are open product decisions;
- the parts ship as separate deliveries;
- the requirements are something a context compaction could lose.

Before any code, create or resume the feature doc with `/marcsh:feature <name>`. Then keep it current as you go:

- **Specs**: what was asked, quoting the user verbatim; mark your own assumptions as assumptions.
- **Tasks**: each task names its specs, a status (`pending`, `in progress`, `done`, `blocked`) and its evidence.
- **Log**: the original request is L1; every later correction or decision from the user is appended verbatim.

Never mark a task `done` without observed proof: a command you ran and its output. If you cannot observe it, say so and leave the task open.

If scope grows while working, move the work to the large lane and write the doc then; do not continue silently.

## Guards

These run on every Bash call and you cannot skip them:

- `git commit` on the default branch (`main`/`master` when unknown) is blocked. Create a branch first: `git switch -c <type>/<description>`.
- `git push`, `gh pr create`, `gh pr merge` and package publishes always ask the user, even when settings allow them. Do not work around the prompt; ask for the action when it is the next step.
