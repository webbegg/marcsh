---
description: "Build something new through the normal ODD flow; the agent picks the size"
argument-hint: "<what to build; area, acceptance criteria, ticket>"
agent: brigadev
---
Feature request. Follow the normal ODD flow: explore first, then plan and implement. Apply the usual size rules: a small change is done inline without a feature document; a large one is tracked with the `brigadev-odd-tracking` skill.

Request: $ARGUMENTS

If what to build is missing, ask with `AskUserQuestion` and stop. The area or files, acceptance criteria, and ticket or link are optional: use them when the request gives them, and do not ask for them.

When a feature document is created, quote the request above verbatim as L1.
