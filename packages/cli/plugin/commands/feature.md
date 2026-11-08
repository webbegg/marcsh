---
description: Create or resume the feature doc for a large change
argument-hint: <feature-name>
---

Create or resume the feature doc named `$ARGUMENTS`.

If `$ARGUMENTS` is empty, ask the user for a feature name (short, kebab-case) and stop.

## Locate the doc

1. The project name is the basename of `git rev-parse --show-toplevel`; if that fails, the basename of the current directory.
2. The doc is `~/.marcsh/work/<project>/<feature-name>.md`. The feature name is `$ARGUMENTS` in kebab-case. Create the directory if it does not exist. Feature docs live outside the repository on purpose: never put one inside it.

## If the doc does not exist: create it

Write it with these sections in this exact order:

```
# <Feature title>
Objective: <one sentence>
Branch: <current branch, or the branch to create>
Test command: <the command that runs the suite>

## Specs
- S1: "<the user's words, verbatim>"

## Tasks
- T1 [S1] <task> — status: pending — evidence: none yet

## Log
- L1 (<YYYY-MM-DD>): <the user's original request, verbatim>
```

Fill the header and S1 from the request in this conversation. Quote the user; do not paraphrase. If the objective or the test command is unknown, write `unknown` and ask the user instead of guessing. Show the user the doc path and the specs, and wait for their go-ahead before writing code.

## If the doc exists: resume it

1. Read the whole doc, the Log first: later entries correct earlier specs.
2. Say in two lines where things stand: what is done (with its evidence) and the next unfinished task.
3. Continue with that task. Append new user corrections to the Log verbatim, update task status and evidence as you go, and never mark a task `done` without observed proof.
