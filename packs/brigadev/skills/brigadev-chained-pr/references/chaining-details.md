# Chained PR details

## Feature branch chain

```text
<default branch>
 └── feat/my-feature              ← tracker (draft, do not merge until the chain is done)
      └── feat/my-feature-01-core       PR #1 → base feat/my-feature
           └── feat/my-feature-02-api   PR #2 → base feat/my-feature-01-core
```

1. Create the tracker branch from the verified default branch; open a draft tracker PR to the default branch.
2. PR #1 targets the tracker; each later child targets its immediate parent.
3. Merge children in order; merge the tracker last.

## Stacked to the default branch

```text
<default branch> ← PR 1: foundation
                    └── PR 2: built on PR 1
                         └── PR 3: built on PR 2
```

PR #1 targets the default branch; each later PR targets its parent until the parent merges, then rebase or retarget so only the current slice shows.

## Expand–contract (wide refactors)

Use it when one mechanical change (rename, retype a shared symbol, move an API) fans across many call sites and cannot be split by disjoint surfaces, because any single edit breaks callers in every slice.

```text
PR 1 expand    add the new form beside the old; nothing breaks
PR 2..N migrate  move callers in batches (per package or directory); the old form still exists, so each batch is green
PR last contract delete the old form once no caller remains
```

1. Expand: add the new form next to the old, with its tests. Old callers still work.
2. Migrate: one slice per batch, sized by blast radius and the ~400-line budget, each depending on the expand. Check each batch against the old and new forms.
3. Contract: remove the old form only after a search shows no caller left. This slice depends on every migrate batch and is the hardest to undo; verify it with the full suite.
4. If the batches cannot stay green alone, put them on a shared integration branch and promise a green build only on the final integrate slice, which depends on all of them. Say so in the Chain Context.

In the feature chain strategy the slices are the chain; stacked, each lands on the default branch in order, which is why every step before the contract must keep the old form working.

## Chain Context section

Append to each child PR body (never for a single PR):

```markdown
## Chain Context

| Field | Value |
| --- | --- |
| Chain | <feature name> |
| Position | <N of total> |
| Base | `<target branch>` |
| Depends on | <PR or "None"> |
| Follow-up | <next PR or "None"> |
| Review budget | <changed lines> / 400 |

```text
<default branch>
 └── #NNN Previous PR
      └── 📍 #NNN This PR
           └── #NNN Next PR
```

### Scope
- Includes: <this unit>
- Excludes: <deferred work>
```

## Commands

```bash
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
gh pr view <N> --json additions,deletions,changedFiles,baseRefName
gh pr create --repo <owner/repo> --base <parent-branch> --title "<title>" --body-file <file>
gh pr edit <N> --base <new-base>   # retarget after a parent merges
```
