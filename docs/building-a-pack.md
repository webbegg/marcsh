# Building a pack

A pack is a public GitHub repository with agents, and optionally skills, commands and hooks. This page shows the layout, how to test it, how to publish it, and what marcsh refuses.

Start with a [personal agent](agents.md#write-a-personal-agent). Turn it into a pack only when you want to share it, or to bundle skills and commands with it.

## Get help from marcsh

marcsh ships with a skill called `agent-workflows` that helps you write an agent or a pack. It follows the same rules as this page.

Ask in plain words:

```
Help me create a marcsh agent that reviews pull requests
```

Or call the skill by name:

```
/marcsh:agent-workflows
```

It asks what the agent should do and not do, drafts the prompt with you, writes the file in `~/.marcsh/agents/`, and helps you test it. If you want to share it, it sets up the pack layout and runs a checklist. It never pushes to GitHub for you.

## Layout

```
my-pack/
  agents/
    reviewer.md             required: at least one agent you can select
  skills/
    tdd/SKILL.md            a skill in a folder
    quick-note.md           a skill can also be a single file
  commands/
    ship.md                 a slash command
  hooks/
    hooks.json              optional: hooks (off until the user enables them)
    check.sh                a file a hook runs
  .claude-plugin/
    plugin.json             optional manifest
```

| Path | What it is |
| --- | --- |
| `agents/*.md` | Agents. You need at least one that users can select. |
| `skills/<name>/SKILL.md` | Skills in the Claude format, with `name` and `description` in the frontmatter. |
| `skills/*.md` | A skill can be a single file. |
| `commands/*.md` | Slash commands. A command in a subfolder is named by its path. |
| `hooks/hooks.json` | Hooks, plus the files its commands run. See [Hooks](#hooks). |
| `.claude-plugin/plugin.json` | Optional manifest. Its `hooks` and `mcpServers` entries are ignored. |

marcsh never runs MCP servers from a pack, so do not depend on `.mcp.json`.

## Write the agents

An agent in a pack is the same file as a [personal agent](agents.md): the same fields, the same `tools` field, the same rules. The body is added to the engine's prompt and never replaces it.

```markdown
---
name: Reviewer
description: Reads the diff and reports risks; changes nothing
permission: read-only
tools: Read, Grep, Glob
---
You are the Reviewer. Read the change and report what could break.

Use the tdd skill when the change has no tests.
```

Tips:

- Say in the prompt **when to use which skill or command**. A pack's skills and commands load only while one of its agents is selected, so the agent prompt is how the model learns about them.
- Give each agent a `name`, a `description` and a `permission`. Use `read-only` if it must never change anything.
- Do not name an agent Build or Plan. Those names stay with the built-in agents.
- Leave `model` out unless the role needs one. A name that only fits one engine is ignored, with a warning, on the other. See [Agents](agents.md#model-and-fallback).
- Keep to the fields `name`, `description`, `mode`, `permission`, `model` and `tools`. Other fields are ignored with a warning when someone selects the agent.

The menus show each agent's `name`. When two agents share a name, a pack agent is shown as `owner/repo/Name` so people can tell them apart.

## Test it before you publish

marcsh installs only from GitHub. It cannot install from a folder on your disk: `/agents install ./my-pack` is refused with `Cannot install "./my-pack": the owner or repository name has characters GitHub does not allow. Use owner/repo, owner/repo@ref or https://github.com/owner/repo`.

Test in two steps.

**1. Try the agent as a personal agent.** Copy the file:

```sh
mkdir -p ~/.marcsh/agents
cp agents/reviewer.md ~/.marcsh/agents/
```

Open `/agents`, select it, and run real requests. A warning toast when you select it means a field was ignored. Fix it. This tests the prompt, the permission and the tools. It does not load the pack's skills and commands, because personal agents never get them.

**2. Test the skills and commands from a branch.** Push a branch to a **public** repository, then install it by branch name:

```
/agents install owner/repo@my-branch
```

Read the preview. It shows the agents, skills and commands marcsh found, what it does not use, and any `Check:` lines. Install it, select the agent, and try the skills and commands. After you push a change:

```
/agents update owner/repo
```

When you are done, run `/agents remove owner/repo`. Do not put anything private in the repository. Anyone can read a public one.

## Publish

1. Push the pack to a public GitHub repository. The pack ID is `owner/repo`, in lowercase.
2. Tell people to install it:

   ```
   /agents install owner/repo
   ```

   Without a ref, they get the default branch at the moment they install.
3. For versions, tag releases and tell people to install a tag:

   ```sh
   git tag v1.0.0
   git push origin v1.0.0
   ```

   ```
   /agents install owner/repo@v1.0.0
   ```

   marcsh pins every install to the exact commit the user saw in the preview. People move to a newer commit only when they run `/agents update owner/repo` and accept the new preview. An install pinned to a tag follows that tag; one pinned to a commit never moves. To pin a commit, use its full 40-character hash.

Keep the repository small. The download limit counts the Git data of the one commit marcsh fetches plus the checked-out files. See [Packs](packs.md#limits).

## What marcsh rejects

When a pack breaks one of these rules, the install stops with a message that starts with `Pack rejected:` and nothing is kept.

- A symlink that points outside the pack, anywhere in it: `Pack rejected: x is a symlink that points outside the pack`.
- Any symlink in `skills/` or `commands/`, or a symlinked `agents/` folder. Use real folders and regular files. (A symlinked file inside `agents/` does not reject the pack, but marcsh never loads it.)
- A file in `skills/` or `commands/` over 1 MB.
- An agent file over 256 KB: `Pack rejected: agents/x.md is larger than 256 KB`.
- A repository over 5,000 files and folders, or over 50 MB of files (`.git` is not counted): `Pack rejected: the repository is larger than marcsh accepts (… files / … MB)`.
- A download over 100 MB, `.git` included. It counts the Git data of the one commit marcsh fetches plus the checked-out files, so keep the files well under 50 MB: `Pack rejected: the download is larger than marcsh accepts (over 100 MB)`.
- An agent file whose frontmatter is never closed: an opening `---` with no closing `---`.
- No agent that users can select in `agents/*.md`: `Pack rejected: it has no primary agent in agents/*.md`.
- `hooks` in the frontmatter of any skill or command, in any spelling: quoted, indented, in upper case, in `{ }`, or nested. The message is `Pack rejected: skills/x/SKILL.md declares hooks, which marcsh never runs from a skill or command; declare them in hooks/hooks.json, where they stay off until you enable them with /agents hooks`.
- A line that is only `...` inside the frontmatter of a skill or command.
- Frontmatter in a skill or command that marcsh cannot read without doubt: an opening or closing `---` line with other text on it, no closing `---`, or YAML that does not parse. The message is `Pack rejected: the frontmatter of x cannot be read unambiguously (…)`. Quote a `description` that contains `: `.

Not rejected, but shown as a `Check:` line in the preview: `allowed-tools` in a skill or command. It pre-approves tools. Remove it unless the skill needs it.

## Hooks

Hooks are optional and opt-in. Nothing in `hooks/` runs when someone installs or updates your pack. The user reads the commands and enables them. See [Pack hooks](pack-hooks.md) for what they see.

This example blocks any `Bash` call whose command contains `rm -rf`. Put the hook in `hooks/hooks.json`, in Claude's plugin format, next to the file its command runs:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "sh \"${CLAUDE_PLUGIN_ROOT}/hooks/check.sh\"", "timeout": 10 }]
      }
    ]
  }
}
```

And `hooks/check.sh`:

```sh
#!/bin/sh
# The call arrives as JSON on the input. Exit code 2 blocks it; what you print to the error output is the reason.
if grep -q 'rm -rf'; then
  echo "rm -rf is blocked by this pack" >&2
  exit 2
fi
```

The check is crude: it looks for the text anywhere in the call. Any other exit code lets the call go on to the usual approval prompt.

### Hard limits

If anything here is broken, the pack still installs but its hooks are **unusable**. The preview says `hooks: present but unusable (reason); they can never be enabled`.

| Part | Limit |
| --- | --- |
| Hook type | Only `"type": "command"`. Any other type, key or shape makes the hooks unusable. |
| Keys | The file: `hooks` and `description`. A group: `matcher` and `hooks`. A hook: `type`, `command` and `timeout`. |
| `command` | One line of at most 2,000 characters, with no control or invisible characters. This includes line and paragraph separators, non-ASCII spaces and look-alike blank letters. |
| `timeout` | A number of seconds above 0 and up to 600. |
| Events and commands | At most 30 events and 100 commands. |
| `matcher` | At most 200 characters. Empty, `*`, or tool names separated by a vertical bar. |
| `hooks/` folder | No symlinks or special files. Each file at most 1 MB, the folder at most 5 MB and 500 entries. File names may not contain control or invisible characters. |
| `hooks/hooks.json` | Must exist and declare at least one command. A `hooks/` folder without a valid `hooks/hooks.json` makes the hooks unusable. The name `.marcsh-commands.json` is marcsh's own and cannot be used. |

In a `matcher`, write names with letters, digits, `_`, `.` and `-`, and at most one `*` (or `.*`) in each. Examples: `Bash`, `Edit|Write`, `mcp__memory__.*`. Regular expressions make the hooks unusable.

### What your hook gets

- `${CLAUDE_PLUGIN_ROOT}` is a copy of the pack that marcsh makes, with its `skills/`, `commands/` and `hooks/` folders. Hooks may run any file of it, so the user's consent covers all of it.
- Each command runs with `sh -c` in the user's project folder, with `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR` set.
- `PreToolUse`, `PostToolUse` and `PostToolUseFailure` run on Claude and pi. Every other event runs on Claude only, and pi users get a warning.
- A hook gets JSON on its input: `session_id`, `cwd`, `hook_event_name`, `tool_name` and `tool_input`, and also `tool_response` for `PostToolUse` or `error` for `PostToolUseFailure`. On pi, tools have Claude's names (`Bash`, `Edit`, `Write`, `Read`, `Grep`, `Glob`, `LS`, `Agent`, `mcp__server__tool`), and Read, Edit and Write get a `file_path` as well as a `path`. `Task` and `Agent` name the same tool in a matcher.
- Exit code 2 blocks a call, and what you print to the error output is the reason. `{"decision": "block", "reason": "…"}` and `permissionDecision: "deny"` block too. Approvals (`allow`, `ask`, `approve`) and changed input have no effect: hooks only narrow.
- `PostToolUse` runs only for a call that worked. A call that failed runs `PostToolUseFailure`, if you declared one.
- Default time is 60 seconds on pi. A `PreToolUse` hook that times out blocks the call there.
- Keep hooks short. Whatever a hook leaves running in the background is stopped when it finishes.

Do not make your workflow depend on hooks. Users can leave them off, and a change to any of the pack's files turns them off until they review them again.

## Check before you publish

- [ ] `agents/` has at least one agent, and every agent file is under 256 KB.
- [ ] Every file with frontmatter opens and closes it with a bare `---` line.
- [ ] Each agent has `name`, `description` and `permission`, and no field outside the six listed above.
- [ ] `model`, if present, fits the engine: `provider/id` for pi, a `claude` name or alias for Claude.
- [ ] No symlink anywhere. `find . -type l -not -path './.git/*'` prints nothing.
- [ ] No file in `skills/` or `commands/` over 1 MB, and the repository is under 5,000 entries and 50 MB of files, so that the download stays under 100 MB.
- [ ] No `hooks` key and no `...` line in the frontmatter of a skill or command.
- [ ] `tools`, if present, uses only the group names. Selecting the agent shows no `unknown tools` warning.
- [ ] No `allowed-tools`, unless you know why it is there.
- [ ] Each agent prompt names the skills and commands it should use.
- [ ] If you ship hooks, `hooks/hooks.json` has only `command` hooks, and you know what each one does.
- [ ] The workflow still works with hooks off and without MCP servers.

## A real example

[webbegg/marcsh-rsc](https://github.com/webbegg/marcsh-rsc) is a pack built for marcsh. Install it and read its preview, then read its files to see how a real pack is laid out:

```
/agents install webbegg/marcsh-rsc
```

## Next

- Everything about agent files: [Agents](agents.md).
- How users install and update: [Packs](packs.md).
- The hooks users see: [Pack hooks](pack-hooks.md).
