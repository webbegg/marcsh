---
description: "File a GitHub issue from evidence, after a duplicate search"
argument-hint: "<summary and details; bug, feature or chore; repo>"
agent: brigadev
questions:
  - id: type
    label: "What kind of issue is it?"
    kind: choice
    options: ["Bug", "Feature", "Chore"]
    default: "Bug"
  - id: summary
    label: "Summary"
    kind: text
    required: true
  - id: details
    label: "Details"
    kind: long
    required: true
  - id: repo
    label: "Target repository"
    kind: text
    default: "origin"
---
Issue request. Use the `brigadev-issue-creation` skill: search for duplicates first, then create the issue from the evidence below.

- Type: {{type}}
- Summary: {{summary}}
- Details: {{details}}
- Target repository: {{repo}}

"origin" means the repository behind this checkout's `origin` remote. Show the issue text before creating it.
