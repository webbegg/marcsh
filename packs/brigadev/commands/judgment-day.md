---
description: "Judgment Day: blind adversarial review by two judges, at most two scoped fix rounds"
argument-hint: "[commit range, PR, or empty for the uncommitted diff]"
agent: brigadev
---
The user explicitly asks for Judgment Day. Load the `brigadev-judgment-day` skill and run it on one exact target.

Target: $ARGUMENTS

If that is empty, use the uncommitted diff against HEAD; if the tree is clean, use the commits since the default branch. If the target is ambiguous, ask with `AskUserQuestion` and stop.
