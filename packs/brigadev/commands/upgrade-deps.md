---
description: "Upgrade packages within a version range and verify the result"
argument-hint: "[packages or all; patch, minor or major; verification command]"
agent: brigadev
---
Dependency upgrade request. Follow the normal ODD flow: read the current versions and the changelogs of what will change before touching anything. Dependency commands ask for approval; run only the ones this request needs.

Request: $ARGUMENTS

The request may name the packages (default: all outdated packages), the allowed version range (patch, minor, or major; default minor), and how to verify the upgrade (default: the project's test script). If the packages or range cannot be told apart from the request, ask with `AskUserQuestion` and stop.

Stay inside the allowed range: "patch" means patch releases only, "minor" means minor and patch, "major" allows breaking releases. A group is one package together with its peer and type packages (for example `react`, `react-dom`, and `@types/react`), or one ecosystem family. State your grouping before starting, then upgrade one group at a time, whatever the range. Run the verification after each group and stop at the first failure, reporting which package caused it. Commit by work unit, following the `brigadev-work-unit-commits` skill.

Dependency changes are high-risk item 5: end with `Risk: item 5 (dependency changes)`, so an independent `brigadev-verify` runs after the change's own checks.
