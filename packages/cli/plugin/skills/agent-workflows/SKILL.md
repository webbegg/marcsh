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

`tools` narrows what the agent can use. It only removes tools and never adds any: a `read-only` agent that lists `bash: true` still cannot run bash, and every tool that is left still asks before it runs. Two forms work:

```yaml
tools:            # OpenCode map: false removes the group, true changes nothing
  bash: false
  webfetch: false
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
| `web` | webfetch, websearch, fetch |
| `task` | task, agent, subagent (the subagent tool) |
| `ask` | askuserquestion, question, ask_user |
| `mcp` | mcp, `mcp__server__tool`, `server_*` |

`ask` is never removed, because marcsh asks its questions with it. If a list would leave nothing but `ask`, `read` is kept. A name in no group is unknown: it is ignored and selecting the agent warns `unknown tools x, y`. On pi the `web` group has nothing to remove (pi has no web tools) and selecting the agent says so.

## Pack layout

```
agents/*.md                     required: at least one selectable agent
skills/<name>/SKILL.md          skills, in the Claude format (name, description)
skills/*.md                     a skill can also be a single file
commands/*.md                   slash commands
.claude-plugin/plugin.json      optional manifest
```

- Skills and commands load only while one of the pack's agents is selected. Build and Plan keep marcsh's own plugin. So a skill must be reachable from the agent prompt: say in the prompt when to use which skill.
- marcsh never runs hooks (`hooks/`, or `hooks` in `plugin.json`) or MCP servers (`.mcp.json`, `mcpServers`). Do not rely on them.
- Agent IDs are `owner/repo/<file stem>` (personal agents: `user/<file stem>`). The menus show the short `name`; when two agents share a name (any case) they show `owner/repo/Name`. Built-in names always stay short, so avoid naming an agent Build or Plan.
- Pack IDs are lowercase `owner/repo`.

### What makes marcsh reject a pack

- A symlink pointing outside the pack, anywhere.
- Any symlink in `skills/` or `commands/`, or a symlinked `agents/` folder. Only real folders and regular files. (A symlinked file inside `agents/` is not rejected but is silently never loaded.)
- A file in `skills/` or `commands/` over 1 MB.
- An agent file over 256 KB.
- A repository over 5,000 entries (files and folders) or 50 MB of files, counted on the checked-out tree without `.git`. Keep a pack to prompts, skills and commands; do not commit assets, binaries or `node_modules`.
- An agent file whose frontmatter is never closed (an opening `---` with no closing `---`).
- No primary agent in `agents/*.md` (only subagents, or none).
- `hooks` in the frontmatter of any skill or command, in any spelling (quoted, indented, upper case, inside `{ }`, nested).
- A `...` line inside a skill or command frontmatter.
- Frontmatter that is not clean: an opening or closing `---` line with other text on it, no closing `---`, or YAML that does not parse (quote a `description` that contains `: `).

Not a rejection, but shown as a warning in the preview: `allowed-tools` in a skill or command frontmatter pre-approves tools. Remove it unless the skill needs it.

## Workflow with the user

1. **Draft the prompt together.** Ask for the lane or role (what the agent does and does not do), the permission (`read-only` if it must never change anything, otherwise `build`), the steps it follows, and which skill to use when. Propose a draft; do not invent requirements.
2. **Write the file** to `~/.marcsh/agents/<name>.md` (lowercase file name, no spaces). Keep the prompt short and imperative.
3. **Test it.** Tell the user to press Tab or open `/agents` (it reads the files again, so no restart) and select the agent. A warning toast on selection means a field was ignored: fix it. Run a real request, then adjust the prompt. An edit applies from the next turn of the same conversation.
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
- [ ] No file in `skills/` or `commands/` over 1 MB, and the whole repo is under 5,000 entries and 50 MB (`find . -path ./.git -prune -o -print | wc -l` counts the entries).
- [ ] No `hooks` key in any skill or command frontmatter, and no `...` line inside one.
- [ ] Every frontmatter opens and closes with a bare `---` line and parses as YAML.
- [ ] `tools`, if present, names only the groups above (selecting the agent shows no `unknown tools` warning).
- [ ] No `allowed-tools`, or the user knows why it is there.
- [ ] Each agent prompt names the skills and commands it expects to use.
- [ ] No hooks or MCP servers are needed for the workflow to work.
