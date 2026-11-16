---
name: brigadev-review
description: "Trigger: review, code review, 4R. Risk-scoped review of one frozen change with the 4R lenses."
---

## When to use

The user asks for a review, a work-unit commit carries a high-risk item, or `brigadev-branch-pr` is about to open a PR (review the branch first). Review is proportionate: never run all four lenses by default.

## Rules

- Review exactly one **frozen candidate**, never a moving working tree.
- Pick only the lenses that fit what changed, and state the reason for each.
- Reviewers are read-only subagents with no shell; you run git and the tests, and you own the ledger, deduplication, and every decision.
- A review never replaces functional checks and never authorizes push, PR, or merge.

## Lens selection

| Lens | Agent | Pick when the candidate touches |
| --- | --- | --- |
| R1 Risk | `review-risk` | auth, permissions, secrets, input handling, dependencies, data exposure |
| R2 Readability | `review-readability` | new modules, non-trivial logic, public APIs, large diffs |
| R3 Reliability | `review-reliability` | behavior changes, contracts, tests, edge-case-heavy logic |
| R4 Resilience | `review-resilience` | I/O, network, retries, migrations, long-running or concurrent code |

When the user asks for a full review, run all four.

## Execution

1. **Freeze** the candidate into a patch file outside the repository:

```bash
SCRATCH=$(mktemp -d) && echo "$SCRATCH"             # note the printed path for step 5
git diff <base>...HEAD > "$SCRATCH/candidate.patch"   # committed range
git diff HEAD > "$SCRATCH/candidate.patch"            # uncommitted work
git diff --stat <base>...HEAD
```

2. **Launch** the selected lenses in parallel: one `Task` per lens with `agent: <lens agent>` and `background: true` (on Claude, Claude's `Task` by that name), all in the same turn; collect them with `task_wait` on pi. Each task prompt names the patch path, the base, the touched files, the diff stat, and the feature document path if one exists. If a reviewer cannot read the patch path, paste a small patch into the prompt. State why each lens was picked.
3. **Ledger**: each lens replies in the findings shape its prompt defines (`findings`, `reviewed`). A failed or malformed lens run is never clean: relaunch it once, then report it as not reviewed. Merge the findings, dedupe by location and claim, and keep IDs. Classify:
   - **blocker**: `introduced` or `worsened` BLOCKER/CRITICAL with concrete evidence;
   - **follow-up**: `pre-existing` findings;
   - **advisory**: WARNING and SUGGESTION.
   Discard claims without evidence, and say so.
4. **Correct** (only when the user authorized changes): one correction batch for all blockers, then one re-review limited to those blocker IDs by the lens that raised them. Blockers still open after that become one **Needs your decision**.
5. **Save** the final ledger (the Output block) to `reviews/<branch with / as ->.md` in the repo docs folder (`${BRIGADEV_HOME:-$HOME/.brigadev}/<repo>/`, defined in the brigadev prompt), replacing the branch's earlier ledger, and show it. It lives outside the project; never write it into the repository. Before a PR, blockers still open mean asking the user before the PR is opened.
6. Remove the scratch directory when done, using the literal path `mktemp -d` printed (`rm -rf /var/folders/.../tmp.XXXX`), never `$(…)` or a variable.

## Output

```
Candidate: <base>..<head> (<files>, +<add>/-<del>)
Lenses: <lens — reason>
Blockers: <id, location, claim, evidence>
Follow-ups: ...
Advisories: ...
Verdict: clean | blockers fixed | needs your decision
```
