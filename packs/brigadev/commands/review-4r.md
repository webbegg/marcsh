---
description: "brigadev 4R review of a frozen candidate"
argument-hint: "[base-ref or focus]"
agent: brigadev
---
Load the `brigadev-review` skill and review one frozen candidate.

Target and focus: $ARGUMENTS

If that is empty, review the uncommitted changes against HEAD; if the tree is clean, review the commits since the default branch.

Select only the lenses that fit what changed and state why. Do not change any code unless I authorize corrections.
