---
description: "Review a teammate's PR read-only and draft the review comments"
argument-hint: "[PR number or URL; focus lens; notes]"
agent: brigadev
---
Team PR review request. Use the `brigadev-review` skill: review one frozen change with the 4R lenses that fit its risk, and save the ledger as `reviews/pr-<number>.md` in the repo docs folder (not under a branch name, which could collide with your own review of that branch).

Request: $ARGUMENTS

The request may name a pull request (number or URL), a lens to weigh first (Risk, Reliability, Readability, Resilience; default: all fitting lenses), and notes on what to pay attention to.

When no pull request is given, run `gh pr list --search "review-requested:@me" --state open --json number,title,url,updatedAt` and show the list. With no PR, say so and ask for a PR number in your reply, then stop. With 1 to 5 PRs, call `AskUserQuestion` with one option per PR (`#number title`) and free text for another PR; with only 1 PR, add the option "Another PR". With more than 5, offer the 5 most recently updated plus free text.

Review read-only: never run `gh pr checkout` and never switch or touch the user's working tree, and never change the author's branch or the code. Read the PR with `gh pr view`. Freeze the candidate with `gh pr diff <number> > "$SCRATCH/candidate.patch"`; this replaces the review skill's `git diff` freeze step. When the reviewers need the files, fetch the PR head into a detached worktree under the project's `.worktrees/` (`git fetch origin pull/<number>/head`, then `git worktree add --detach .worktrees/review-pr-<number> FETCH_HEAD`; first add `.worktrees/` to `.git/info/exclude` when it is not ignored yet, so the user's tree shows no new files) and remove it after the review.

"All fitting lenses" means let the risk of the change pick the lenses. Any other focus means review with that lens only, unless the change carries a high-risk item: then add the lens that covers it and say so.

Then draft the review comments with the `brigadev-comment-writer` skill, each tied to a `path:line`, and show them. Post nothing unless the user asks; posting needs their approval.
