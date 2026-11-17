# brigadev for marcsh

brigadev is an opinionated workflow for working with a coding agent, called **ODD**. The agent explores before it asks, classifies each task by size and risk, changes code test-first, commits by work unit, and delegates only when a trigger fires. High-risk changes get an independent verifier, and reviews are scoped to the risk of the change.

This pack is the marcsh port of brigadev-harness, the same author's harness for pi (MIT). The orchestrator prompt, roles, skills, and workflows come from it, adapted to marcsh's tools (`Task` with `agent`, `AskUserQuestion`, `todo`/`TodoWrite`, command question forms).

## Install

marcsh installs packs from GitHub. Once this folder is published as its own repository:

```
/agents install owner/repo
```

Then select the `brigadev` agent with `Tab` or `/agents`. Pack skills and commands load only while it is selected, or when a pack command runs a turn as it. Turn the hooks on with `/agents hooks` (see [hooks/README.md](hooks/README.md)).

### Try it from this checkout

`scripts/brigadev-pack-dev.sh` (at the marcsh repository root) mirrors `packs/brigadev`, including uncommitted changes, into a local git repository, and marcsh fetches it from there:

```sh
scripts/brigadev-pack-dev.sh            # mirrors to /tmp/marcsh-pack-dev/local/brigadev
MARCSH_PACK_URL_BASE=file:///tmp/marcsh-pack-dev marcsh
```

Then `/agents install local/brigadev`. After you change the pack, run the script again and `/agents update local/brigadev` (a changed hook file turns the hooks off until you review them again). `MARCSH_PACK_URL_BASE` replaces `https://github.com` for every install in that marcsh process, so start marcsh without it for normal use.

## What is in it

**Agent** (selectable)

- `brigadev`: the orchestrator. Its prompt says when to use each skill, subagent, and command.

**Subagents** (started by `brigadev` with `Task` and `agent: <name>`)

| Name | Permission | Role |
| --- | --- | --- |
| `brigadev-explore` | read-only | Maps the code; returns a ≤2k-token handoff with `path:line` evidence. |
| `brigadev-verify` | build, `Read` + `Bash` | Independent verifier for high-risk changes; probes in a `mktemp -d` scratch copy and never edits the workspace. |
| `brigadev-worker` | build | Bounded writer; no commits. |
| `review-risk`, `review-readability`, `review-reliability`, `review-resilience` | read-only | The 4R review lenses. |
| `jd-judge-a`, `jd-judge-b` | read-only | Blind judges for Judgment Day. |
| `jd-fix` | build | Fixes only the frozen findings of a Judgment Day round. |

**Skills**: `brigadev-odd-tracking` (feature document and task list), `brigadev-delegation`, `brigadev-diagnosis` (bug loop), `brigadev-review` (4R), `brigadev-judgment-day`, `brigadev-work-unit-commits`, `brigadev-branch-pr`, `brigadev-chained-pr`, `brigadev-issue-creation`, `brigadev-comment-writer`, `brigadev-skill-creator`.

**Commands** (each runs as `brigadev`; 13 of the 16 ask their questions in marcsh's question form before they send, and the text after the command name answers the first one; `/track`, `/review-4r`, and `/judgment-day` take free text as `$ARGUMENTS`)

| Command | Use |
| --- | --- |
| `/feature`, `/quick-change`, `/big-feature`, `/ticket` | Build something: normal flow, small inline change, planned large feature, ticket-keyed work. |
| `/bug-fix`, `/refactor`, `/ui-change`, `/upgrade-deps` | Fix, restructure, change UI against a design, upgrade dependencies. |
| `/review-branch`, `/review-4r`, `/team-review`, `/judgment-day` | Review a branch or PR (4R), a frozen candidate, a teammate's PR (read-only, with drafted comments), or run an adversarial dual review. |
| `/open-pr`, `/pr-feedback`, `/create-issue` | Review and open a PR, work through PR comments, file an issue. |
| `/track` | Track a request as a large task (feature document plus task list). |

## Where its files go

Feature documents and review ledgers live outside the project, in `~/.brigadev/<repo>/` (`tasks/`, `reviews/`, `evidence/`). `<repo>` is the basename of the main worktree root. Set `BRIGADEV_HOME` to use another folder than `~/.brigadev`.

## Hooks

The pack's optional evidence-gate hooks are described in `hooks/README.md`. They stay off until you enable them with `/agents hooks`.

## Provided by marcsh

The pack relies on these marcsh features, which the original harness had to build itself:

- **Question forms** on commands (`questions` in the command's frontmatter), see marcsh docs/commands.md, "Questions".
- **Task list**: the `todo` tool on pi, Claude's own `TodoWrite` on Claude (see "Task list" under Engine differences in marcsh docs/agents.md). Without either, the feature document's `## Tasks` is the only list.
- **Edit surfaces** (pi only): `Task` takes `editSurfaces` and marcsh enforces it for writers; see "Limit where a subagent writes" in marcsh docs/agents.md. On Claude nothing enforces it, so the orchestrator lists the allowed files in the task prompt and checks `git diff --stat` either way.
- **Model profiles and fallback chains**: a profile routes each agent to a model, with fallback on quota and outages; see "Model profiles" in marcsh docs/configuration.md.

## Not ported

- **Dashboard, footer, phase label**: pi UI calls that marcsh does not render (no-ops there).
- **`/brigadev:*` commands and Pi-only extensions**: the pack is declarative (agents, skills, commands, hooks), so brigadev's own pi extensions and its `/brigadev:*` commands do not come with it; the pack's commands are the ones above.
- **Structured outputs** (`*.schema.json`): marcsh has no equivalent, so the reviewers, judges, and verifier return the same fields as plain text in a shape their prompts define.
- **Read-only shell for the judges and verifier**: reviewers and judges have no shell (the orchestrator runs git and the tests for them); the verifier has `Bash` but is told to work only in a scratch copy.

## Credit and license

Ported from brigadev-harness (v0.16.0) by Marcos Juan (MIT), the same author as this pack.
