---
description: "A small change, done inline: test first, one work unit, no plan"
argument-hint: "<what should change; area or files>"
agent: brigadev
---
Quick change request. This is a Small task: work inline, test first when a deterministic test applies, in one work unit and its commit, and never create a feature document or a plan.

Request: $ARGUMENTS

If what should change is missing, ask with `AskUserQuestion` and stop. The area or files are optional.

If the change turns out to need more than that (several work units, a contract change, a decision for the user, or more than a few files), stop and say so instead of growing it.
