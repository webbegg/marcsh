---
description: "Restructure a component without changing what it does"
argument-hint: "<component path and goal; keep or change the public API; tests exist or add first>"
agent: brigadev
---
Refactor request. Follow the normal ODD flow: explore the component and its callers first. Behavior must stay the same in both cases below; refactor in small steps with the tests passing after each one.

Request: $ARGUMENTS

Needed: the component path and what the refactor should achieve. If either is missing, ask with `AskUserQuestion` and stop. Optional: constraints ("Keep the public API", the default, or "The public API may change") and test coverage ("Tests exist", the default, or "Add tests first").

"Add tests first" means write characterization tests that pass on the current code before any restructuring. With "Keep the public API", leave exports, signatures, and other contracts untouched. With "The public API may change", update every caller you find, name the API change as a contract change in the summary, and end with `Risk: item 3 (public API change)`, so an independent `brigadev-verify` runs after the change's own checks. Commit by work unit, following the `brigadev-work-unit-commits` skill.
