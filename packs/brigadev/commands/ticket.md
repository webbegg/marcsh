---
description: "Work on a pasted ticket: branch, commits, and PR carry the ticket key"
argument-hint: "<ticket key and pasted ticket text>"
agent: brigadev
questions:
  - id: key
    label: "Ticket key, e.g. PROJ-123"
    kind: text
    required: true
  - id: kind
    label: "What kind of ticket is it?"
    kind: choice
    options: ["Story or task", "Bug"]
    default: "Story or task"
  - id: text
    label: "Paste the ticket: title, description, acceptance criteria"
    kind: long
    required: true
  - id: design
    label: "Design or other link"
    kind: text
  - id: size
    label: "How big is it?"
    kind: choice
    options: ["Let the agent decide", "Quick change", "Big feature (plan first)"]
    default: "Let the agent decide"
---
Ticket request. The ticket below (key, kind, text, and link) is the requirement: quote it verbatim (as L1 in the feature document when one is created) and add nothing it does not ask for. Follow the normal ODD flow: explore first, then plan and implement.

- Ticket key: {{key}}
- Kind: {{kind}}
- Ticket text: {{text}}
- Design or other link: {{design}}
- Size: {{size}}

Normalize the key first: take the first match of `[A-Za-z][A-Za-z0-9]+-[0-9]+` in the ticket key answer (so a pasted ticket URL or a lowercase key works), uppercase it, and use that as <KEY> everywhere below. If there is no match, ask once for the key and stop.

"Bug" means follow the bug-fix flow: reproduce the problem, then fix the root cause. A Bug always starts with a failing test that reproduces it, whatever the size, and follows the `brigadev-diagnosis` skill. "Story or task" means the normal feature flow.

"Quick change" means a Small task: work inline, test first, one work unit and its commit, never a feature document or a plan; if it turns out to need more than that (several work units, a contract change, a decision for the user, or more than a few files), stop and say so instead of growing it. "Big feature (plan first)" means Large per `brigadev-odd-tracking`: feature document with the whole request above (key, kind, ticket text, and link) as L1 verbatim, and tasks, then show the plan and stop for the user's approval before the first source write; split delivery with `brigadev-chained-pr` when it exceeds ~400 lines. "Let the agent decide" means apply the usual size rules.

Ticket conventions: name the branch `feat/<KEY>-<short-slug>`, or `fix/<KEY>-<short-slug>` for a Bug; end every commit message with a `Refs: <KEY>` footer; end the PR title with `(<KEY>)`. Pushing and opening the PR still need the user's approval.
