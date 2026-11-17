---
description: "Work through the review comments on one of your pull requests"
argument-hint: "[PR number or URL; unresolved or all; fix or drafts only]"
agent: brigadev
questions:
  - id: pr
    label: "PR number or URL (empty: pick from a list)"
    kind: text
  - id: which
    label: "Which comments?"
    kind: choice
    options: ["Unresolved comments only", "All comments"]
    default: "Unresolved comments only"
  - id: mode
    label: "What should happen with them?"
    kind: choice
    options: ["Fix and draft replies", "Draft replies only"]
    default: "Fix and draft replies"
---
PR feedback request. Read the comments on the pull request, then handle them one by one. Write every reply with the `brigadev-comment-writer` skill: short, warm, direct.

- Pull request: {{pr}}
- Comments to handle: {{which}}
- Mode: {{mode}}

When no pull request is given, run `gh pr list --author @me --state open --json number,title,url,updatedAt,reviewDecision` and show the list. If the list is empty, say so and ask for a PR number in your reply, then stop. With 1 to 5 PRs, call `AskUserQuestion` with one option per PR (`#number title`) and free text for another PR; with only 1 PR, add the option "Another PR". With more than 5, offer the 5 most recently updated plus free text.

"Fix and draft replies" means: before changing code, if the chosen PR is not the current branch, switch to its branch only when the working tree is clean (otherwise stop and say so), and stop if the PR's head is in another repository (a fork; check with `gh pr view <number> --json headRefName,isCrossRepository`). Then make the requested changes as work units with their tests, committed by the usual rules, and draft a reply to each comment. "Draft replies only" means change no code and post nothing: show the drafted replies for approval. Replies are drafts until the user approves them; pushing and posting replies need their approval.
