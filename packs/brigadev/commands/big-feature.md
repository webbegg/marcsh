---
description: "A large feature: tracked in a feature document, planned and approved before any code"
argument-hint: "<what to build; acceptance criteria, ticket, constraints>"
agent: brigadev
questions:
  - id: what
    label: "What should be built?"
    kind: long
    required: true
  - id: criteria
    label: "Acceptance criteria"
    kind: long
  - id: ticket
    label: "Ticket or link"
    kind: text
  - id: constraints
    label: "Constraints (deadlines, what not to touch)"
    kind: long
---
Big feature request. Track it as Large with the `brigadev-odd-tracking` skill: explore first, then create the feature document with this request quoted verbatim as L1, the requirements as specs, and the tasks. Show the plan and stop for the user's approval before the first source write. Once approved, follow the normal ODD flow, resumable from the document. When the forecast or running count exceeds ~400 changed lines, split delivery with the `brigadev-chained-pr` skill.

- What to build: {{what}}
- Acceptance criteria: {{criteria}}
- Ticket or link: {{ticket}}
- Constraints: {{constraints}}
