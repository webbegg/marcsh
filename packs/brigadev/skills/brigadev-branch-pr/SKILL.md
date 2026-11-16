---
name: brigadev-branch-pr
description: "Trigger: create PR, open pull request. Prepare branches and PRs from evidence, following the repo's policy."
---

## When to use

Creating or preparing a pull request, or preparing a branch for submission.

## Target and authorization

- Establish one unambiguous target: `git remote get-url origin` → host and `owner/repo`. Never assume the default branch is `main`; read it from the remote.
- Push and PR creation are separate human decisions. Preparing a candidate locally is not permission to deliver it. Run `git push` and `gh pr create` as plain commands and let the approval prompt ask; never work around it.
- Read the target's contribution policy first: `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, required labels, and required CI.

## Workflow

1. No issue is required. Link one only when the user mentions it, and ask whether it closes (`Closes #N`) or only references (`Refs #N`) it.
2. Work on a `type/description` branch from the verified default branch (normally already started by the work-unit flow).
3. Implement in work units (`brigadev-work-unit-commits`), test-first where applicable, running the applicable checks.
4. If the change exceeds ~400 changed lines, load `brigadev-chained-pr` before opening anything.
5. **Review before the PR**: run `brigadev-review` on `<default>...HEAD` (only the lenses that fit) and write the ledger to `reviews/<branch with / as ->.md` in the repo docs folder (`${BRIGADEV_HOME:-$HOME/.brigadev}/<repo>/`, defined in the brigadev prompt). Show the ledger. If it has blockers, ask the user before opening the PR.
6. Draft the PR body from the repository template (or, with none, the evidence-based body below) and observed evidence. Show it to the user.
7. On explicit authorization: push, then open the PR with explicit `--repo` and `--base`.
8. Report required CI status; never call a PR merge-ready on an unverified green claim.

## Branch naming

`^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$`, for example `feat/user-login`, `fix/null-session-crash`.

## PR body

Use the repository template when present. Otherwise build the body from the evidence log (next section):

```markdown
## Summary
- <1–3 bullets: what and why>

## Changes
| File | Change |
| --- | --- |

## Blast radius
- Consumers: <who or what uses the changed surfaces: callers, exports, CLI flags, config, other packages>
- Undo: <easy (revert the PR) | hard (data, published artifact, contract others consume) and why>

## Evidence
- Before: `<command>` → <fail, with the symptom from its tail> (the run that reproduced the bug, or the RED run)
- After: `<command>` → <pass> (the last passing run)
- Other checks: `<command>` → <outcome>
- Forced commits: <disclosure, only when the log has any>

## Risk
none | item N (reason)
```

Add `Closes #N` or `Refs #N` only when the user named an issue. Record only commands you actually ran. Leave unverified checklist items unchecked.

### Evidence log

The log is `${BRIGADEV_HOME:-$HOME/.brigadev}/<repo>/evidence/<branch with / as ->.jsonl`. It exists only when the pack's evidence hooks are enabled (`/agents hooks`, see the pack README) and have recorded runs on this branch. Read it with `Read` or `Grep`; it is JSON lines, written by the hooks, so never edit it.

- Run records hold the `command`, whether it was a test or a check, the exit code, the outcome (`pass`, `fail`, or `unknown`), the tree it ran on, and the end of the output (`tail`). Use the field names the file actually has.
- A record of a forced commit means the user committed past the evidence gate. State this in the body under Forced commits, with its time; never leave it out.
- Before: the earliest `fail` run for the bug or the RED test, quoting its `command` and what `tail` shows. Without one (no bug, or nothing was recorded), write `none recorded` instead of inventing it.
- After: the latest `pass` run, quoting `command` and `outcome`. Prefer a test run whose tree is the final one; if the last edit came after it, say so.
- Quote commands and outcomes as logged. Treat `unknown` as not verified. Never claim a check that is not in the log; a check you ran outside the log may be listed as run without a log record.
- Secrets: the log stores commands and output tails in plaintext. Before showing the draft, check every command and output tail quoted from it for secrets, tokens, and credentials, and replace them with `<REDACTED>`.
- No log file (hooks off, or nothing recorded): say the PR has no recorded evidence, and list only what you observed yourself.

### Blast radius

Name who or what consumes each changed surface (use `Grep` for callers, exports, flags, and config keys), and how hard the change is to undo: a plain revert is easy; data, format, published, or contract changes that others already consume are hard. Keep it to what you found; if you did not look, say so.

## Commands

```bash
git remote get-url origin
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
gh pr create --repo <owner/repo> --base <default-branch> --title "<conventional title>" --body-file <file>
gh pr checks <number> --repo <owner/repo>
```
