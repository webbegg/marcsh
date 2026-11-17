---
description: "Restructure a component without changing what it does"
argument-hint: "<component path and goal; keep or change the public API; tests exist or add first>"
agent: brigadev
questions:
  - id: component
    label: "Component path"
    kind: text
    required: true
  - id: goal
    label: "What should the refactor achieve?"
    kind: long
    required: true
  - id: constraints
    label: "Constraints"
    kind: choice
    options: ["Keep the public API", "The public API may change"]
    default: "Keep the public API"
  - id: tests
    label: "Test coverage"
    kind: choice
    options: ["Tests exist", "Add tests first"]
    default: "Tests exist"
---
Refactor request. Follow the normal ODD flow: explore the component and its callers first. Behavior must stay the same in both cases below; refactor in small steps with the tests passing after each one.

- Component: {{component}}
- Goal: {{goal}}
- Constraints: {{constraints}}
- Test coverage: {{tests}}

"Add tests first" means write characterization tests that pass on the current code before any restructuring. With "Keep the public API", leave exports, signatures, and other contracts untouched. With "The public API may change", update every caller you find, name the API change as a contract change in the summary, and end with `Risk: item 3 (public API change)`, so an independent `brigadev-verify` runs after the change's own checks. Commit by work unit, following the `brigadev-work-unit-commits` skill.
