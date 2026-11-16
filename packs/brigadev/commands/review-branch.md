---
description: "Risk-scoped 4R review of a branch or a pull request"
argument-hint: "[branch, PR number or URL; focus lens; notes]"
agent: brigadev
---
Review request. Use the `brigadev-review` skill: review one frozen change with the 4R lenses that fit its risk, and save the ledger to the `reviews/` folder of the repo docs folder. This is a review only; do not change the code.

Request: $ARGUMENTS

The request may name the target (a branch, a PR number, or a PR URL), a lens to weigh first (Risk, Reliability, Readability, Resilience; default: all fitting lenses), and notes on what to pay attention to.

When no target is given, review the current branch against the repository's default branch. "All fitting lenses" means let the risk of the change pick the lenses; any other focus names the lens to weigh first.
