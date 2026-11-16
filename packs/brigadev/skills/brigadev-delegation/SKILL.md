---
name: brigadev-delegation
description: "Trigger: launch a writer, writer returns, verification rule. Delegation to subagents and independent verification of high-risk changes."
---

# brigadev: delegation and verification

Parent session only. Load when a writer is about to launch, a writer returns, or the verification rule fires.

## Subagents

Start one with `Task` and `agent: <name>` (on Claude, Claude's `Task` by that name). A subagent sees only its task prompt, never this conversation.

| Agent | Role | Tools | Admission |
| --- | --- | --- | --- |
| `brigadev-explore` | Read-only mapping, ≤ ~2k token handoff | read-only | evidence budget |
| `brigadev-worker` | Bounded writer, no commits | read, edit, bash | the task lists its allowed files |
| `brigadev-verify` | Independent spec-derived verification | read, bash (scratch copy only) | `Risk: item N` in the task |
| `review-*` | 4R lenses (via `brigadev-review`) | read-only | review request |
| `jd-*` | Judgment Day (via `brigadev-judgment-day`) | judges read-only, `jd-fix` writes | explicit request |

`/agents` lists the pack's subagents. On pi a foreground `Task` is stopped after 3 minutes and at most 4 background tasks run at once.

## Writer launch

- A unit is one independent behavior with its code, tests, and docs. Never split one behavior into test, docs, and code writers. A unit that depends on another still in progress is not independent.
- Units of ~100 changed lines or less run inline; starting a worker costs more than writing them.
- Launch all independent units in ONE turn: one `Task` per unit with `agent: brigadev-worker` and `background: true` on pi. If they cannot launch together, work inline.
- Collect with `task_wait` before acting on a result; an uncollected result arrives by itself when you are idle. Never edit a running writer's files.
- Each writer prompt names the existing helpers it must reuse for shared state (records, lists, settings other commands also touch) and the invariants they keep. Parallel writers cannot see each other; this is the only place they learn them.
- Pass the test-first policy and the exact test commands under a `Verification` heading in the task.
- Pass the feature document as its absolute path in the repo docs folder (`${BRIGADEV_HOME:-$HOME/.brigadev}/<repo>/tasks/<name>.md`). Writers read it; only the parent updates it. Name the skills they must load under `Skills to load before work`.

## Allowed edit surfaces

Derive the surfaces yourself; never ask the human to author paths. List the files the unit must touch plus directories where it may create files, as narrow repository-relative paths or globs. Never `.`, the repository root, absolute paths, or `..`. A surface wider than the task is a defect, and overlapping surfaces between parallel writers are not allowed.

- **pi:** pass the list as `editSurfaces` in `Task` (an array of strings), and also under `Allowed edit surfaces` in the task prompt so the writer sees it. The runtime denies the writer's `Edit`/`Write` outside the list, blocks `Bash` writes to literal paths outside it, flags files `Bash` changed outside it (in a git repository), rejects a launch whose surfaces overlap a running writer's, and ends the `Task` result with a warning that lists files changed outside the list. It reverts nothing. Invalid surfaces (`.`, root, absolute, `..`, empty) are rejected with the entry named.
- **Claude:** `Task` has no such parameter and nothing enforces the list. Put it under `Allowed edit surfaces` in the task prompt, and after each writer returns run `git diff --stat` and compare it with the list.

A change outside the list is a defect: report it, and revert it only with the user's approval.

If a writer returns `interaction_required` for a path, present its derived candidate paths to the user with `AskUserQuestion` as an approve/decline choice.

## After a writer returns

1. Read its report: covered `S#`, commands run with observed results, open items.
2. Spot-check: re-run one reported command yourself, and check for changes outside the surfaces as above (the `Task` result's warning on pi, `git diff --stat` on Claude).
3. After parallel units finish, run one inline full-suite command to catch seams between units.
4. Decide the Risk line from the actual diff, not the writer's summary.

## Verification rule

| Risk | Verification |
| --- | --- |
| none | writer or parent self-verification plus the parent spot check |
| named high-risk item | self-verification, then one `brigadev-verify` with `Risk: item N (why)` in its task |

Verifier handoff, in its task prompt: the feature document path, the unit and linked `S#`, the baseline commit, and the exact test/CLI/typecheck command forms it may run. It probes in a `mktemp -d` scratch copy, never the workspace, and replies with verdicts per `S#`, blockers and advisories with reproductions, regression tests, the scratch directories it created (you remove them), and unverified checks.

Corrections are bounded: one correction batch that fixes every reported blocker, then one recheck limited to those blockers. The recheck is a new `brigadev-verify` launch with the blocker IDs and reproductions in its task; your own re-run of the tests is not a recheck. A second correction only when the recheck shows the same blocker still failing; never for a new finding. Anything still open becomes one **Needs your decision**. Advisories never start a correction.

If verifier setup fails once, stop with **Needs your decision** naming the missing prerequisite and the unrun checks. Do not loop on repairing helpers.
