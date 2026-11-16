---
description: "A large feature: tracked in a feature document, planned and approved before any code"
argument-hint: "<what to build; acceptance criteria, ticket, constraints>"
agent: brigadev
---
Big feature request. Track it as Large with the `brigadev-odd-tracking` skill: explore first, then create the feature document with this request quoted verbatim as L1, the requirements as specs, and the tasks. Show the plan and stop for the user's approval before the first source write. Once approved, follow the normal ODD flow, resumable from the document. When the forecast or running count exceeds ~400 changed lines, split delivery with the `brigadev-chained-pr` skill.

Request: $ARGUMENTS

If what to build is missing, ask with `AskUserQuestion` and stop. Acceptance criteria, ticket or link, and constraints (deadlines, what not to touch) are optional: use what the request gives, and ask for the acceptance criteria only if they are not derivable.
