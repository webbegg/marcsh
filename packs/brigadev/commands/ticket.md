---
description: "Work on a pasted ticket: branch, commits, and PR carry the ticket key"
argument-hint: "<ticket key and pasted ticket text>"
agent: brigadev
---
Ticket request. The ticket below (key, kind, text, and link) is the requirement: quote it verbatim (as L1 in the feature document when one is created) and add nothing it does not ask for. Follow the normal ODD flow: explore first, then plan and implement.

Ticket: $ARGUMENTS

Needed: the ticket key (for example PROJ-123) and the ticket text (title, description, acceptance criteria). If either is missing, ask with `AskUserQuestion` and stop. Optional: the kind (story or task, or bug), a design or other link, and the size (quick change, big feature, or let the agent decide; default: decide).

Normalize the key first: take the first match of `[A-Za-z][A-Za-z0-9]+-[0-9]+` in the text above (so a pasted ticket URL or a lowercase key works), uppercase it, and use that as <KEY> everywhere below. If there is no match, ask once for the key and stop.

A bug follows the bug-fix flow: reproduce the problem, then fix the root cause. A bug always starts with a failing test that reproduces it, whatever the size, and follows the `brigadev-diagnosis` skill. A story or task follows the normal feature flow.

"Quick change" means a Small task: work inline, test first, one work unit and its commit, never a feature document or a plan; if it turns out to need more than that (several work units, a contract change, a decision for the user, or more than a few files), stop and say so instead of growing it. "Big feature" means Large per `brigadev-odd-tracking`: feature document with the whole request above (key, kind, ticket text, and link) as L1 verbatim, and tasks, then show the plan and stop for the user's approval before the first source write; split delivery with `brigadev-chained-pr` when it exceeds ~400 lines. Otherwise apply the usual size rules.

Ticket conventions: name the branch `feat/<KEY>-<short-slug>`, or `fix/<KEY>-<short-slug>` for a bug; end every commit message with a `Refs: <KEY>` footer; end the PR title with `(<KEY>)`. Pushing and opening the PR still need the user's approval.
