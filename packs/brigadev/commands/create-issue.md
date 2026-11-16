---
description: "File a GitHub issue from evidence, after a duplicate search"
argument-hint: "<summary and details; bug, feature or chore; repo>"
agent: brigadev
---
Issue request. Use the `brigadev-issue-creation` skill: search for duplicates first, then create the issue from the evidence below.

Request: $ARGUMENTS

Needed: a summary and the details. If either is missing, ask with `AskUserQuestion` and stop. Optional: the type (Bug, Feature, or Chore; default Bug) and the target repository (default `origin`, the repository behind this checkout's `origin` remote).

Show the issue text before creating it.
