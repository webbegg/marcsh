---
description: "Upgrade packages within a version range and verify the result"
argument-hint: "[packages or all; patch, minor or major; verification command]"
agent: brigadev
questions:
  - id: packages
    label: "Which packages? A list, or all outdated ones"
    kind: text
    default: "All outdated packages"
  - id: range
    label: "Allowed version range"
    kind: choice
    options: ["Patch", "Minor", "Major"]
    default: "Minor"
  - id: verify
    label: "How should the upgrade be verified?"
    kind: text
    default: "{{testScript}}"
---
Dependency upgrade request. Follow the normal ODD flow: read the current versions and the changelogs of what will change before touching anything. Dependency commands ask for approval; run only the ones this request needs.

- Packages: {{packages}}
- Allowed range: {{range}}
- Verification: {{verify}}

Stay inside the allowed range: "Patch" means patch releases only, "Minor" means minor and patch, "Major" allows breaking releases. A group is one package together with its peer and type packages (for example `react`, `react-dom`, and `@types/react`), or one ecosystem family. State your grouping before starting, then upgrade one group at a time, whatever the range. Run the verification after each group and stop at the first failure, reporting which package caused it. Commit by work unit, following the `brigadev-work-unit-commits` skill.

Dependency changes are high-risk item 5: end with `Risk: item 5 (dependency changes)`, so an independent `brigadev-verify` runs after the change's own checks.
