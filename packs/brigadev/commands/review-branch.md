---
description: "Risk-scoped 4R review of a branch or a pull request"
argument-hint: "[branch, PR number or URL; focus lens; notes]"
agent: brigadev
questions:
  - id: target
    label: "What should be reviewed? A branch, a PR number, or a PR URL"
    kind: text
    default: "{{currentBranch}} against {{defaultBranch}}"
  - id: focus
    label: "Which lens matters most?"
    kind: choice
    options: ["All fitting lenses", "Risk", "Reliability", "Readability", "Resilience"]
    default: "All fitting lenses"
  - id: notes
    label: "Anything to pay attention to?"
    kind: long
---
Review request. Use the `brigadev-review` skill: review one frozen change with the 4R lenses that fit its risk, and save the ledger to the `reviews/` folder of the repo docs folder. This is a review only; do not change the code.

- Target: {{target}}
- Focus: {{focus}}
- Pay attention to: {{notes}}

When no target is given, review the current branch against the repository's default branch. "All fitting lenses" means let the risk of the change pick the lenses; any other focus names the lens to weigh first.
