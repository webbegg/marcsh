# Agents

An agent is a role for marcsh: a permission level, an optional prompt, and optionally a model and a tool list. You switch agents with `Tab` or `/agents`, and you can write your own as a short Markdown file.

## Built-in agents

marcsh starts with two agents. You cannot change or remove them.

| Agent | What it does |
| --- | --- |
| Build | Edits files and runs commands, asking first. |
| Plan | Reads and plans; changes nothing. |

Build is the default. Plan can read your project but cannot write files or run commands. See [Security](security.md) for how approvals work.

## Switch agents

- Press `Tab` in the input. It moves to the next agent and wraps around after the last one.
- Or type `/agents`, pick an agent, and press `Enter`. Type to search the list.

The status line shows the selected agent on the left, before the model and the engine.

The order is Build, Plan, your personal agents (sorted by file name), then agents from installed [packs](packs.md).

Good to know:

- A switch applies from your **next message**. A reply that is already running keeps the agent it started with.
- marcsh remembers your choice and selects the same agent the next time you start. If that agent no longer exists, marcsh selects Build.
- When you select an agent that marcsh cannot apply in full, a toast starts with `Warning:` and says what is ignored. See [Warnings](#warnings).
- `/agents` shows a tag after each name: `(read-only)` for agents that cannot change anything, `(build)` for build agents that come from a pack, `(limited tools)` when the agent has a `tools` field that takes tools away, and `(hooks on)` or `(hooks changed — off)` for [pack hooks](pack-hooks.md).
- The same dialog has rows to install, update and remove packs. See [Packs](packs.md).

## Write a personal agent

A personal agent is one Markdown file in `~/.marcsh/agents/`. It is global: it works in every project. marcsh never loads agents from a project folder.

Create the folder and the file:

```sh
mkdir -p ~/.marcsh/agents
```

Save this as `~/.marcsh/agents/reviewer.md`:

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

Open `/agents`. It reads the folder again, so the new agent is in the list without a restart. Select it. Run a real request, then adjust the prompt. After you edit the file, open `/agents` again so marcsh reads it; the change applies from your next message.

To give the agent its own model, add a `model` line. See [Model](#model-and-fallback).

Only files that end in `.md` directly inside the folder are read. Files that cannot be read are skipped without a message. If two file names turn into the same agent ID (for example `My Agent.md` and `my-agent.md`), only the first one in alphabetical order is listed.

## The prompt

Everything after the closing `---` is the agent's prompt. marcsh **adds it to the engine's own system prompt**. It never replaces it. Write only the role. Do not repeat what the engine already knows.

A file with no frontmatter works too: the whole file is the prompt, the name is the file name, and the agent is a build agent.

## Frontmatter fields

Frontmatter is flat `key: value` lines between two `---` lines. Quoted values work. A multi-line value can use `|` or `>`. The `tools` field can also be a short indented block (see [Limit tools](#limit-tools)).

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `name` | text | the file name without `.md` | Shown in the status line and in `/agents`. |
| `description` | text | none | One line shown after the name in `/agents`. |
| `mode` | `primary` or `all` | selectable | Both make the agent selectable and work the same. Values marcsh does not recognize are ignored with a warning. |
| `permission` | `read-only` or `build` | `build` | `read-only` behaves like Plan. `build` behaves like Build: it asks before it writes or runs. Any other value is ignored with a warning, and the agent is a build agent. |
| `model` | a model name | the session model | See [Model](#model-and-fallback). |
| `tools` | a map or a list | all of the engine's tools | Takes tools away. See [Limit tools](#limit-tools). |

Any other field (for example `temperature`) is read but not applied. When you select the agent, marcsh shows a warning that names it. An OpenCode-style `permission` map with nested lines is not supported either: use `read-only` or `build`.

A file that opens with `---` but never closes it is not treated as frontmatter. The whole file becomes the prompt of a build agent, and the warning says `ignored frontmatter`.

## Limit tools

`tools` takes tools away from an agent. Use it for agents that should only read, or should not browse the web. This line keeps reading and searching and takes every other group away:

```yaml
tools: Read, Grep
```

Naming one tool keeps its whole group, so `Read, Grep` keeps the `read` group. See the [group table](#groups).

It **only narrows**:

- It never adds a tool. A `read-only` agent that lists `bash: true` still cannot run commands.
- Plan and `read-only` agents stay read-only.
- Narrowing never turns off an approval: a tool that asked before still asks. A tool that ran without asking still does. On pi these are `read`, `grep`, `find`, `ls`, the question tool and `Task`. On Claude it is whatever its permission mode allows.
- The question tool (`AskUserQuestion`) is always kept, because marcsh asks you questions with it.
- Tools that belong to none of the groups below are not touched. This includes tools that a pi extension adds.

### Two forms

The Claude Code list. Only the groups you name are kept, as in the example above. `[Read, Grep]` and a block of `- Read` lines work too.

The OpenCode map. `false` takes a group away. `true` changes nothing on its own.

```yaml
tools:
  bash: false
  webfetch: false
```

The `"*"` key sets every group first, wherever you write it. Use it to start from nothing and give some groups back:

```yaml
tools:
  "*": false
  read: true
```

Here `"*": false` removes every group, then `read: true` gives `read` back. A flow map on one line works as well: `tools: { bash: false }`.

If you write both forms in one field, the map wins and the list names are reported as unknown.

A permission scope such as `Bash(git:*)` is read as the name `Bash`. It keeps the whole `bash` group and does not limit which commands run.

### Reference

#### Groups

Names are not case-sensitive. Naming one tool takes or keeps its whole group. The group names themselves also work as names.

| Group | Names that map to it | What it covers |
| --- | --- | --- |
| `read` | read, grep, glob, find, ls, list, notebookread | Reading and searching files. |
| `edit` | edit, write, patch, multiedit, notebookedit | Changing files. |
| `bash` | bash, shell, powershell | Running commands. |
| `web` | webfetch, websearch, web, fetch | Fetching pages and searching the web. |
| `task` | task, agent, subagent | Starting subagents. On Claude this also covers the workflow tool. |
| `ask` | askuserquestion, question, ask_user, ask | The question tool. Never removed. |
| `mcp` | mcp, `mcp__server__tool`, any name that starts with `mcp_` or ends with `_*` | Tools from MCP servers, and the tools that list and read a server's resources. |

#### What marcsh keeps anyway

- `ask: false` is kept. The warning says `ask: the question tool is always kept`.
- If your entries would take away everything else, marcsh keeps `read` so the agent can still work.
- A name that matches no group is ignored and listed in the warning as `unknown tools`. If no name in the field is known, the agent has no restriction.
- A `tools` field with no names at all is ignored, and the warning says `ignored tools`.
- In the map, a value other than `true` or `false` makes that name unknown.

## Engine differences

Agents work on both engines. A few details differ:

- **Web tools.** Claude has web tools, so `web: false` takes them away. pi has none, so there is nothing to remove. If you write `web: false` by name, marcsh warns that it changes nothing on pi. It does not warn when `web` is removed by a list or by `"*"`.
- **Models.** Each engine takes its own kind of model name. See [Model](#model-and-fallback).
- **Pack hooks.** Only some hook events run on pi. See [Pack hooks](pack-hooks.md).
- **Subagent time limit.** On pi, a subagent started with `Task` is stopped after 3 minutes. The model gets an error that says so and suggests `background: true` for longer work.

See [Engines and models](engines-and-models.md) for the engines themselves.

## Model and fallback

`model` asks for a model for this agent only. Leave it out to use the session model.

| Engine | What `model` accepts |
| --- | --- |
| pi | `provider/id`: the provider's name, a slash, then the model ID. |
| Claude | A name that starts with `claude`, or one of the aliases `default`, `opus`, `sonnet`, `haiku`, `opusplan`. An alias can have a suffix like `sonnet[1m]`. |

If the name does not fit the engine you are using, marcsh ignores it, uses the session model, and warns. For example, `gpt-4o` is not a Claude model, and `sonnet` is not a pi model.

On pi there is one more case. If the name has the right shape but you have no login for that provider, marcsh uses the session model without a warning. This way an agent from someone else does not stop working just because you use another provider. Use `/login` to add a provider. See [Engines and models](engines-and-models.md).

## Warnings

When you select an agent, marcsh checks what the current engine can apply. If something is ignored, a toast starts with `Warning:`. Several warnings are joined with `; `. The agent still works.

In the table, `Name` is the agent's name.

| Warning | What it means |
| --- | --- |
| `Name: ignored temperature, permission` | These fields are not known, or their values are not valid. `frontmatter` in the list means the frontmatter was never closed. |
| `Name: unknown tools x, y` | These names in `tools` match no group. |
| `Name: ask: the question tool is always kept` | You asked to remove `ask`. |
| `Name: read: read tools are kept so the agent can work` | Your entries would have removed every group. |
| ``Name: web tools are not available on pi, so `web: false` changes nothing`` | You wrote `web: false` and the engine is pi. |
| `Name: model "x" is ignored on pi; the session model is used` | The model name does not fit the engine. |
| `owner/repo: hooks for Stop run on Claude only` | A pack agent whose hooks are on, with events that pi does not run. |
| `owner/repo: hooks are off because their files changed since you approved them; review them with /agents hooks owner/repo` | The pack's hooks were turned off. See [Pack hooks](pack-hooks.md). |

The warning for an entry that marcsh kept can start with the entry as you wrote it, for example `*:` or `ask:`.

## Names and labels

The status line and `/agents` show the agent's `name`. If two agents have the same name (in any letter case), marcsh adds a prefix so you can tell them apart:

- A personal agent shows as `user/Name`.
- A pack agent shows as `owner/repo/Name`.

Build and Plan always keep their short names. A file named `Build.md` or `Plan.md` does not replace them. It shows up as an extra agent, `user/Build`.

## Next

- Share an agent or bundle skills with it: [Packs](packs.md) and [Building a pack](building-a-pack.md).
- Ask marcsh to write an agent with you: see [Building a pack](building-a-pack.md#get-help-from-marcsh).
- All commands: [Commands](commands.md).
