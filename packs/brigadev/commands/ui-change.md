---
description: "Implement a UI change and verify it against the design"
argument-hint: "<design link or ticket, page or component, acceptance criteria>"
agent: brigadev
questions:
  - id: source
    label: "Design link, screenshot path, or ticket"
    kind: text
    required: true
  - id: target
    label: "Page or component"
    kind: text
    required: true
  - id: criteria
    label: "Acceptance criteria"
    kind: long
    required: true
  - id: states
    label: "States and breakpoints to cover"
    kind: text
  - id: components
    label: "Design system components or tokens to use"
    kind: text
  - id: accessibility
    label: "Accessibility and i18n requirements"
    kind: text
  - id: verify
    label: "How should it be verified?"
    kind: choice
    options: ["Tests", "Manual steps in the summary", "Both"]
    default: "Both"
---
UI change request. Follow the normal ODD flow: explore the existing component and its conventions first, implement the change, then verify it the way requested below.

- Design, screenshot, or ticket: {{source}}
- Page or component: {{target}}
- Acceptance criteria: {{criteria}}
- States and breakpoints to cover: {{states}}
- Design system components or tokens to use: {{components}}
- Accessibility and i18n requirements: {{accessibility}}
- Verification: {{verify}}

"Manual steps in the summary" means list the exact steps to check the change by hand in the final summary. If the design source cannot be opened, say so and ask rather than guess at it.
