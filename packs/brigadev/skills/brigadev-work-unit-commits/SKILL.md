---
name: brigadev-work-unit-commits
description: "Trigger: commit, split commits, prepare commits. Commits as work units with their tests and docs."
---

## When to use

Load before deciding what goes into each commit or PR: committing ODD work, splitting a feature into reviewable commits, or preparing chained PRs.

## Rules

| Rule | Requirement |
| --- | --- |
| Commit by work unit | One commit = one deliverable behavior, fix, migration, or docs unit. |
| Not by file type | Never `models`, then `services`, then `tests` when none works alone. |
| Tests with code | Tests go in the same commit as the behavior they verify. |
| Docs with the change | Docs go with the user-visible change they explain. |
| High risk alone | A unit whose Risk line names a high-risk item gets its own commit. |
| Story | A reviewer understands why the commit exists from its diff and message. |
| Budget is not code-golf | Never delete comments, blank lines, docs, or tests, or compress code, to fit ~400 lines. Slice by unit or report the overage. |

## Branch and automation

- An authorized change on the default branch first starts a `type/description` branch (naming in `brigadev-branch-pr`); never commit authorized work to the default branch.
- Commit each finished work unit automatically, with its tests and docs, without asking. A commit on a feature branch is routine; on the default branch or a detached HEAD, stop and ask first. If the evidence gate (pack hooks, when enabled) blocks the commit because no passing test run is recorded on the current tree, run the tests, do not bypass it.
- Push, PR, and merge stay the user's decisions.

## Checklist before each commit

- [ ] One clear purpose.
- [ ] The repo builds and tests pass with only this commit applied.
- [ ] Tests and docs for this unit are included when relevant.
- [ ] Rolling it back does not revert unrelated work.
- [ ] The message explains the outcome, not the file list.

## Message format

Conventional Commits: `type(scope): description`, with `type` in `feat | fix | docs | refactor | perf | test | build | ci | chore | style | revert` and `!` for breaking changes. No `Co-Authored-By` trailers unless the user asks.

| Weak | Better |
| --- | --- |
| `add models` | `feat(auth): add token validation model and tests` |
| `add tests` | tests included with each behavior commit |

## ODD relationship

- Slices of about 400 authored changed lines hold one or more whole tasks with their tests and docs.
- Record the commit that holds each task in the feature document's `## Tasks`.
- When the running count passes ~400 lines, load `brigadev-chained-pr`.

## Commands

```bash
git diff --stat
git diff --cached --stat
git log --oneline -5   # match the repository's message style
```
