---
name: brigadev-chained-pr
description: "Trigger: PR over 400 lines, stacked or chained PRs. Split oversized changes into reviewable PR slices."
---

## When to use

A planned PR may exceed ~400 changed lines (additions + deletions, generated files excluded), an ODD feature's running count passes ~400, or the user asks for stacked or chained PRs.

## Rules

- Recommend slicing above ~400 changed lines; follow the user's choice and the target repository's size policy.
- The budget shapes the slicing, never the code. Never delete comments, docs, or tests, or compress code, to fit.
- One honest slicing pass. If no cohesive split fits, keep the best one and report the count and why.
- A wide refactor that disjoint surfaces cannot split (one mechanical change across many callers) is sliced as expand–contract: add the new form, migrate callers in batches that stay green, then delete the old form. See `references/chaining-details.md` in this skill's folder.
- Each PR is reviewable in about 60 minutes and holds one deliverable unit with its tests and docs.
- Verify the default branch before creating branches; never assume `main`.
- A polluted diff (changes from another slice) is a base bug: retarget or rebase until only this slice shows.
- Do not mix strategies once the user chooses one.

## Oversized delivery menu

Ask once with `AskUserQuestion` (in the user's language), with exactly these options in this order:

1. **Feature branch chain**: a draft tracker PR to the default branch; child PRs target the tracker (first) or their parent (later). Nothing lands until the chain completes.
2. **Stacked to the default branch**: each slice lands on the default branch in order. Partial behavior may land.
3. **One single PR (least recommended)**: no chain artifacts; higher reviewer load and coupled rollback.

Record the choice in the feature document header as the delivery strategy. A choice does not authorize push, PR creation, or merge.

## Execution

1. Estimate changed lines and identify independent work units.
2. Ask the menu above (skip if the feature already recorded a strategy).
3. Create branches per the strategy; see `references/chaining-details.md`.
4. Add the Chain Context section to each child PR (not for a single PR).
5. Verify each PR independently: CI, tests, clean diff, rollback scope.

## Output

Chosen strategy, PR order, current PR boundary, changed-line count per PR, dependency diagram, and verification plan.
