---
description: "Review the branch, then prepare and open its pull request"
argument-hint: "[base branch; ticket; notes for reviewers]"
agent: brigadev
---
Open-a-PR request. Use the `brigadev-branch-pr` skill. Run the pre-PR review first: `brigadev-review` on the branch, with the ledger saved to the `reviews/` folder of the repo docs folder. Open the PR only after the review's findings are handled or reported; pushing and opening it still need the user's approval.

Request: $ARGUMENTS

The request may name the base branch, a ticket or link, and notes for reviewers. When no base branch is given, use the repository's default branch. Follow the repository's PR template; add an issue link only if one is given above.
