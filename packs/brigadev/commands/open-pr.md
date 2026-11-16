---
description: "Review the branch, then prepare and open its pull request"
argument-hint: "[base branch; ticket; notes for reviewers]"
agent: brigadev
questions:
  - id: base
    label: "Base branch"
    kind: text
    default: "{{defaultBranch}}"
  - id: ticket
    label: "Ticket or link"
    kind: text
  - id: notes
    label: "Notes for reviewers"
    kind: long
---
Open-a-PR request. Use the `brigadev-branch-pr` skill. Run the pre-PR review first: `brigadev-review` on the branch, with the ledger saved to the `reviews/` folder of the repo docs folder. Open the PR only after the review's findings are handled or reported; pushing and opening it still need the user's approval.

- Base branch: {{base}}
- Ticket or link: {{ticket}}
- Notes for reviewers: {{notes}}

When no base branch is given, use the repository's default branch. Follow the repository's PR template; add an issue link only if one is given above.
