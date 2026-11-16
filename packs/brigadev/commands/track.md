---
description: "Track this work as a large ODD task (feature document + task list)"
argument-hint: "<what to build>"
agent: brigadev
---
Treat this as a large ODD task and track it: load the `brigadev-odd-tracking` skill, explore first, then create the feature document (in the repo docs folder `${BRIGADEV_HOME:-$HOME/.brigadev}/<repo>/tasks/`, not in the project) and the task list (`todo` on pi, `TodoWrite` on Claude, when available) before the first source write.

If the request below is empty, ask what to build with `AskUserQuestion` and stop.

Request (quote it verbatim as L1 in the feature document's Log):

$ARGUMENTS
