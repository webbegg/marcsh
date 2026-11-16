---
description: "Implement a UI change and verify it against the design"
argument-hint: "<design link or ticket, page or component, acceptance criteria>"
agent: brigadev
---
UI change request. Follow the normal ODD flow: explore the existing component and its conventions first, implement the change, then verify it the way requested below.

Request: $ARGUMENTS

Needed: the design link, screenshot path, or ticket; the page or component; and the acceptance criteria. If any is missing, ask with `AskUserQuestion` and stop. Optional: states and breakpoints to cover, design system components or tokens to use, accessibility and i18n requirements, and how to verify (tests, manual steps in the summary, or both; default both).

"Manual steps in the summary" means list the exact steps to check the change by hand in the final summary. If the design source cannot be opened, say so and ask rather than guess at it.
