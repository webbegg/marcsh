---
name: agent-workflows
description: Use this when the user wants to create, edit, share or install their own agent or workflow for marcsh (a custom role selectable with Tab or /agents), as a personal file or as a GitHub pack.
---

# Author an agent workflow

An agent is a markdown file: a role prompt plus a permission level. The user picks it with Tab or `/agents`. Build and Plan are built in and cannot be overridden or removed.

## Two levels

- **Personal agent**: one file in `~/.marcsh/agents/<name>.md`. Global, instant, nothing to install. Start here.
- **Pack**: a GitHub repo with agents, and optionally skills and commands, that others install with `/agents install owner/repo[@ref]`. Promote a personal agent to a pack only when the user wants to share it or bundle skills with it.

Agents load from `~/.marcsh` only, never from the project.

## The agent file

```markdown
---
name: Reviewer
description: Reads the diff and reports risks; changes nothing
mode: primary
permission: read-only
tools: Read, Grep, Glob
---
You are the Reviewer. Your lane is review: read the change and report what could break.

- Read the diff and the code around it before judging.
- Report findings as a list: file, line, the risk, a suggested fix.
- Never edit files or run commands that change anything.
- End with one line: the riskiest item, or "no findings".
```

Frontmatter (flat `key: value` lines; `tools` may also be a small block, see below):

| Field | Values | Notes |
| --- | --- | --- |
| `name` | text | Shown in the status line and menus. Defaults to the file name. |
| `description` | text | One line shown in `/agents`. |
| `mode` | `primary` or `all` | Selectable. `subagent` is never selectable: the file is skipped. Omitted means selectable. |
| `permission` | `read-only` or `build` | `read-only` behaves like Plan (reads, changes nothing). `build` behaves like Build (asks before writing or running). Omitted means `build`. |
| `model` | optional | pi takes `provider/id`. Claude takes `claude-*` names or the aliases `default`, `opus`, `sonnet`, `haiku`, `opusplan` (optionally with a suffix like `sonnet[1m]`); a name like `gpt-4o` is not one. A model the engine cannot use is ignored with a warning and the session model is used. Leave it out unless the role needs one. |
| `tools` | optional | Takes tools away from this agent (see below). Leave it out for the engine's normal tools. |

The body is appended to the engine's own system prompt, never in place of it. Write only the role: do not repeat what the engine already knows.

Any other field (`temperature`, ...) is read but not applied; selecting the agent shows a one-line warning. A value that is not valid for `mode` or `permission` is ignored the same way. A file that opens with `---` but never closes it loads as a Build agent with the frontmatter in its prompt, and warns the same way.

### Limiting tools

`tools` narrows what the agent can use. It only removes tools and never adds any: a `read-only` agent that lists `bash: true` still cannot run bash. Narrowing never turns off an approval: a tool that asked before still asks. On pi, read, grep, find, ls, the question tool and Task run without asking, with or without `tools`; on Claude, so does whatever its permission mode allows. Two forms work:

```yaml
tools:            # OpenCode map: false removes the group, true changes nothing
  bash: false
  webfetch: false
```

```yaml
tools:            # "*" is set first: "*": false removes every group, then read: true gives read back
  "*": false
  read: true
```

```yaml
tools: Read, Grep   # Claude Code list: only these groups are kept (also `[Read, Grep]` or `- Read` lines)
```

Names are not case-sensitive and map onto groups; naming one tool takes or keeps its whole group:

| Group | Names |
| --- | --- |
| `read` | read, grep, glob, find, ls, list, notebookread |
| `edit` | edit, write, patch, multiedit, notebookedit |
| `bash` | bash, shell, powershell |
| `web` | webfetch, websearch, web, fetch |
| `task` | task, agent, subagent (the subagent tool, and on Claude the workflow tool, which starts subagents) |
| `ask` | askuserquestion, question, ask_user, ask |
| `mcp` | mcp, `mcp__server__tool`, any name that starts with `mcp_` or ends with `_*` (and the tools that list and read a server's resources) |

`ask` is never removed, because marcsh asks its questions with it: an `ask: false` entry is kept, and selecting the agent warns `ask: the question tool is always kept`. If everything else would be removed, `read` is kept and selecting the agent warns `read: read tools are kept so the agent can work`. A name in no group is unknown: it is ignored and selecting the agent warns `unknown tools x, y`. Tools that belong to none of the seven groups (for example Claude's worktree, cron and skill tools, or a pi extension's own tools) are not touched by either form. On pi the `web` group has nothing to remove (pi has no web tools): selecting the agent says that `web: false` changes nothing, but only when `web` is denied by name in the map, not by a list or `"*"`.

## Pack layout

```
agents/*.md                     required: at least one selectable agent
skills/<name>/SKILL.md          skills, in the Claude format (name, description)
skills/*.md                     a skill can also be a single file
commands/*.md                   slash commands
.claude-plugin/plugin.json      optional manifest
```

- Skills and commands load only while one of the pack's agents is selected. Build and Plan keep marcsh's own plugin. So a skill must be reachable from the agent prompt: say in the prompt when to use which skill.
- MCP servers (`.mcp.json`, `mcpServers`) are never run, and `hooks` in `plugin.json` is ignored. Hooks go in `hooks/hooks.json` and are opt-in (see Hooks below). Do not rely on either for the workflow to work.
- `hooks/` (optional): `hooks/hooks.json` plus the files its commands run. Off until the user enables it.
- Agent IDs are `owner/repo/<file stem>` (personal agents: `user/<file stem>`). The menus show the short `name`; when two agents share a name (any case) they show `owner/repo/Name`. Built-in names always stay short, so avoid naming an agent Build or Plan.
- Pack IDs are lowercase `owner/repo`.

### What makes marcsh reject a pack

- A symlink pointing outside the pack, anywhere.
- Any symlink in `skills/` or `commands/`, or a symlinked `agents/` folder. Only real folders and regular files. (A symlinked file inside `agents/` is not rejected but is silently never loaded.)
- A file in `skills/` or `commands/` over 1 MB.
- An agent file over 256 KB.
- A repository over 5,000 entries (files and folders) or 50 MB of files, counted on the checked-out tree without `.git`. Keep a pack to prompts, skills and commands; do not commit assets, binaries or `node_modules`.
- A download over 100 MB, `.git` included. marcsh watches the size while git downloads and stops it as soon as it passes the cap, so a huge repository is rejected before it finishes arriving, with "Pack rejected: the download is larger than marcsh accepts (over 100 MB)". marcsh fetches one commit, so deleted history does not count, but the Git data of that commit and the checked-out files both do: keep the files well under 50 MB.
- An agent file whose frontmatter is never closed (an opening `---` with no closing `---`).
- No primary agent in `agents/*.md` (only subagents, or none).
- `hooks` in the frontmatter of any skill or command, in any spelling (quoted, indented, upper case, inside `{ }`, nested). Declare hooks in `hooks/hooks.json` instead: that is the supported way, and it is opt-in (see Hooks below).
- A `...` line inside a skill or command frontmatter.
- Frontmatter that is not clean: an opening or closing `---` line with other text on it, no closing `---`, or YAML that does not parse (quote a `description` that contains `: `).

Not a rejection, but shown as a warning in the preview: `allowed-tools` in a skill or command frontmatter pre-approves tools. Remove it unless the skill needs it.

## Hooks (opt-in)

A pack can ship hooks, but they are opt-in and off by default. Nothing in `hooks/` runs when a pack is installed or updated: the preview only says `hooks: present, off`. Ship them as `hooks/hooks.json` (Claude's plugin format) plus the regular files its commands run:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "sh \"${CLAUDE_PLUGIN_ROOT}/hooks/check.sh\"", "timeout": 10 }] }
    ]
  }
}
```

- Only `"type": "command"` hooks are supported, each `command` on one line of at most 2,000 characters with no control or invisible characters (line and paragraph separators, non-ASCII spaces, lone surrogates and blank-looking letters such as U+3164 or U+2800 count). Any other hook type, key or shape makes the hooks unusable: the pack still installs, the preview says so, and they can never be enabled.
- Limits of `hooks/`: no symlinks or special files, each file at most 1 MB, 5 MB in total, and file names with the same kind of characters are refused. A folder over a limit is unusable too. The name `.marcsh-commands.json` is marcsh's own and cannot be used.
- More limits that make the hooks unusable: more than 30 events or 100 commands, more than 500 entries under `hooks/`, a `timeout` that is not a number of seconds above 0 and up to 600, and a `matcher` over 200 characters. Without a `hooks/` folder there are no hooks. A `hooks/` folder without a valid `hooks/hooks.json`, or one with no command in it, makes the hooks unusable.
- `matcher` is empty, `*`, or tool names separated by `|` written with letters, digits, `_`, `.` and `-`, each with at most one `*` (or `.*`) wildcard (`Bash`, `Edit|Write`, `mcp__memory__.*`). Anything else, regular expressions included, makes the hooks unusable. `Task` and `Agent` name the same tool on pi, so a matcher written for either one matches.
- PreToolUse, PostToolUse and PostToolUseFailure run on Claude and pi. All other events (SessionStart, Stop...) run on Claude only; selecting the agent on pi warns about them.
- Hooks may run any file of this pack (`${CLAUDE_PLUGIN_ROOT}` is the pack's generated view with its skills, commands and `hooks/`), so the consent covers the whole pack, not only `hooks/`.
- Hooks run only while one of the pack's agents is selected, never for Build, Plan or personal agents.

**Enabling.** `/agents hooks owner/repo` (or the "Pack hooks…" row of `/agents`) shows the commit, every event with its matcher and the exact command, the files under `hooks/` with sizes, which events run on which engine, and the line that these commands run on the user's machine with their permissions. The choices are Cancel (the default) and Enable. `/agents hooks owner/repo off` turns them off without asking.

**Re-consent.** Consent is pinned to the pack commit and to a digest of every file a hook can reach: all files under `hooks/`, `skills/` and `commands/`. An update that moves the commit turns hooks off ("Hooks turned off; review them again with /agents hooks owner/repo"), and any of those files that changes on disk after enabling (in the clone or in the generated view) turns the hooks off for the turn with a warning; `/agents` then says "hooks changed — off" and the user has to review them again. Limit: an edit to the generated view in the middle of a turn is not noticed until the next turn.

**On Claude** marcsh does not hand the pack's `hooks.json` to Claude. The view's `hooks/hooks.json` is generated: every command is a call to marcsh's filter, which runs the original command (same shell, directory, environment and stdin, same timeout and exit code) and lets only what narrows a call through: exit 2, `decision: "block"`, `continue: false` and `permissionDecision: "deny"` survive; `allow`, `ask`, `approve` and `updatedInput` are dropped. So a hook can block a call but never approve it or change what the model asked, on Claude as on pi.

**On pi** marcsh runs PreToolUse, PostToolUse and PostToolUseFailure itself, with Claude's contract: `sh -c <command>` in the project directory, `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR` set, JSON on stdin (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, plus `tool_response` for PostToolUse and `error` for PostToolUseFailure) and Claude's current tool names (Bash, Edit, Write, Read, Grep, Glob, LS, Agent for Task, `mcp__server__tool`). PostToolUse runs only for a call that succeeded; a call that failed runs the PostToolUseFailure hooks, if the pack declares any, and nothing otherwise.

- Exit code 2 blocks the call and stderr is the reason. `{"decision": "block", "reason": ...}` or `hookSpecificOutput.permissionDecision: "deny"` block too. A blocked call never asks.
- `allow`, `ask` and `updatedInput` have no effect: hooks can only narrow, and marcsh's approval still asks about the model's own call.
- Other exit codes do not block; stderr is shown as a notice. A PostToolUse exit 2 reaches the model as feedback next to the tool's result.
- Each hook has a timeout of 60 s unless its `timeout` (seconds) says otherwise, and its whole process group is killed. A PreToolUse hook that times out blocks the call (fail closed; Claude lets the call go on).
- Hooks must be short-lived: a check, not a daemon. Whatever a hook leaves running in the background (`watcher &`) is stopped when the hook finishes on pi, and when the filter ends on Claude.

## Workflow with the user

1. **Draft the prompt together.** Ask for the lane or role (what the agent does and does not do), the permission (`read-only` if it must never change anything, otherwise `build`), the steps it follows, and which skill to use when. Propose a draft; do not invent requirements.
2. **Write the file** to `~/.marcsh/agents/<name>.md` (lowercase file name, no spaces). Keep the prompt short and imperative.
3. **Test it.** Tell the user to open `/agents` (it reads the files again, so no restart) and select the agent. A warning toast on selection means a field was ignored: fix it. Run a real request, then adjust the prompt. After an edit, open `/agents` again so marcsh reads the file; the change applies from the next message.
4. **Iterate** until the agent behaves. Stop here if the user only needs it for themselves.
5. **Promote to a pack (optional).** Create a repo with `agents/<name>.md` and any `skills/` and `commands/`. Run the checklist below. The user commits and pushes it to GitHub; do not push for them.
6. **Install.** `/agents install owner/repo[@ref]` (or `https://github.com/owner/repo`). marcsh fetches it, shows a preview (agents, skills, commands, what is not used, warnings), and installs only after the user accepts. The pack is pinned to the commit they saw. Esc cancels the install while it is fetching and stops git; nothing is kept.
7. **Update.** After pushing changes, `/agents update owner/repo` (or `/agents update` to pick one). It shows old → new commit and the new contents, and swaps only on accept. Updates are never automatic. With `@ref` the pack follows that branch or tag; a commit ref never moves.
8. **Remove.** `/agents remove owner/repo` deletes the pack and its entry after confirmation. Personal agents are removed by deleting the file.

## Checklist before saying a pack is ready

Check each item on the files; report any that fails and fix it first.

- [ ] `agents/` has at least one agent without `mode: subagent`, and each agent file is under 256 KB.
- [ ] Each agent file opens and closes its frontmatter with a bare `---` line.
- [ ] Each agent has `name`, `description`, `permission`, and no field outside `name`, `description`, `mode`, `permission`, `model`, `tools`.
- [ ] `model`, if present, fits the engine: `provider/id` for pi, a `claude-*` name or alias (`opus`, `sonnet`, `haiku`...) for Claude.
- [ ] No symlink anywhere (`find . -type l -not -path './.git/*'` prints nothing).
- [ ] No file in `skills/` or `commands/` over 1 MB, and the whole repo is under 5,000 entries and 50 MB (`find . -path ./.git -prune -o -print | wc -l` counts the entries), with the files well under 50 MB, so that the download (`du -sh .git`, plus the files) stays under 100 MB.
- [ ] No `hooks` key in any skill or command frontmatter, and no `...` line inside one.
- [ ] Every frontmatter opens and closes with a bare `---` line and parses as YAML.
- [ ] `tools`, if present, names only the groups above (selecting the agent shows no `unknown tools` warning).
- [ ] No `allowed-tools`, or the user knows why it is there.
- [ ] Each agent prompt names the skills and commands it expects to use.
- [ ] If the pack ships hooks: `hooks/hooks.json` has only `"type": "command"` hooks, nothing under `hooks/` is a symlink or over 1 MB (5 MB in all), and the user knows what each command does.
- [ ] The workflow does not depend on hooks or MCP servers (hooks are opt-in, MCP servers are never run).
