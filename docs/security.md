# Security

marcsh lets an AI model read your files and run commands. This page explains what asks for your approval, what a project or a pack can make marcsh do, and what marcsh does **not** protect you from.

## Approvals

When the model wants to do something that is not a plain read, marcsh stops and asks you.

### What asks

| Engine | Runs without asking | Asks |
| --- | --- | --- |
| pi | `read`, `grep`, `find`, `ls`, the question tool (`AskUserQuestion`), and `Task` (the subagent it starts asks for its own tool calls) | Every other tool: running commands, writing and editing files, MCP tools, tools added by extensions |
| Claude | What Claude Code's default permission mode allows without asking | The rest. marcsh shows Claude's question |

On Claude, Claude Code's own settings still apply. marcsh lets it read your user, project and local settings, so permission rules in them count.

The prompt shows the tool and what it will do: the command, the file, the URL. Long text is wrapped and capped. Text the model or a tool supplies is escaped, with control characters made visible, and shown behind a `┊` mark, so it cannot pass for part of marcsh's own prompt. The first row of a labelled line (`Allow …?`, `Reason:`, `Path:`) starts with marcsh's own label instead.

### Outside the project folder

The agent starts in your project folder, but the folder is not a limit. The agent can reach outside it. The approval prompt shows what it will touch. Reads on pi run without a prompt (see the table above), so read the prompt of every write and command.

### Answer a prompt

Press `y` to allow once, `a` to always allow, or `n` to deny. [The screen](screen.md#approving-tool-calls) lists the keys. [Typing protection](screen.md#typing-protection) lists the messages the prompt shows while you type.

- **Typing is protected.** The keys do nothing until the keyboard has been quiet for a moment. If the prompt appears while you are writing a message, it stays locked until you press `Down`. This stops a stray `y` from answering.
- **Some prompts need two steps.** When Claude flags a request as risky, `y` is followed by `Enter`, and there is no `a`.

### What "always allow" covers

What `a` does depends on the engine.

**On pi**, `a` is remembered per project folder:

- For a command tool (`bash`), it covers **that exact command** only.
- For any other tool (for example editing files, or an MCP tool), it covers **that tool** in that project, for every future call.

marcsh has no command to undo it. Think before you press `a` for a tool like that. It is a standing permission for the tool, not for one file.

**On Claude**, `a` applies the permission rule that Claude Code suggests for that call. marcsh does not show the rule or store it. Claude Code decides how far it reaches and where it is saved, so do not assume it covers one command or one folder.

There is no `a` on prompts that are flagged as risky, such as the git guard's questions below.

### Git guard

For commands the model runs, marcsh adds a guard on both engines:

- `git commit` on the default branch is **blocked**: `marcsh: commits on main are blocked; create a branch first (git switch -c <type>/<description>)`. The default branch is the one `origin` points at, or `main` or `master` when that is unknown.
- `git push`, `gh pr create`, `gh pr merge`, and `npm`, `pnpm`, `yarn` or `bun` `publish` **always ask**, with a reason such as `marcsh: git push needs your approval`. On pi you cannot always-allow them. On Claude, your own Claude settings (allow rules and permission mode) can still change what a prompt offers.

This is a safety net, not a wall:

- It does not follow indirection such as `bash -c "git push"`, `eval`, git aliases or scripts.
- It checks the built-in shell tool only.
- If git cannot run, or the folder is not a repository, the guard decides nothing and the normal approval applies.

### Plan is read-only

The Plan agent, and any agent with `permission: read-only`, cannot change anything:

- On pi it is only given the read tools, the question tool and `Task`, so it cannot write files or run commands. A saved "always allow" does not change this.
- On Claude it runs in Claude Code's plan mode.

An agent's `tools` field can only take tools away. It never adds any. See [Agents](agents.md#limit-tools).

## Project trust

Project trust applies to the **pi** engine.

A project can carry its own pi files. They are code that runs with your permissions. Until you trust the project, pi ignores them:

- the `.pi/` folder: settings, extensions, skills, prompt templates, themes, system prompt files, and `.pi/mcp.json` with the project's MCP servers;
- `.agents/skills` in the project or in a parent folder.

`AGENTS.md` and `CLAUDE.md` are not part of this. pi reads them as context without asking.

### The first time

On the first pi turn in a project that has such files, before pi loads anything of the project, marcsh shows a full-screen question: `Trust this project's pi files?`

It lists everything pi would load or run, most dangerous first: MCP servers with their command, arguments and environment, settings that run or install things, extensions, then skills, prompt templates, themes and system prompt files. Files that a setting points to elsewhere are listed too.

| Key | What it does |
| --- | --- |
| `t`, then `Enter` | Trust the project. Works only after you scrolled to the end of the list, in a terminal tall enough to read it. |
| `d` | Don't trust. marcsh remembers and does not ask again. |
| `Esc` | Not now. This turn runs without the project's files, and nothing is remembered. |

Scroll with `Up`, `Down`, `PageUp`, `PageDown` or the mouse wheel. The same typing protection as in approvals applies.

If marcsh cannot read one of the entries, it cannot show you what trusting would run. Those entries are listed first with the reason, and trusting is not offered. A terminal that is too small says `Terminal too small to review the list: make it taller to trust.`

### When the files change

Trust is tied to what you reviewed. If a file is added, changed or removed afterwards, marcsh asks again with the title `This project's pi files changed since you trusted them. Trust them again?` Each entry is marked `[added]`, `[changed]` or `[unchanged]`, and files that are gone are listed as `[removed]`.

### Change a decision: /trust

`/trust` opens `Project Trust` for the current folder. It shows `Now: trusted`, `Now: not trusted` or `Now: not decided yet`, and how many pi files it found. The choices are:

- **Don't trust**: pi ignores this project's files.
- **Trust**: opens the same list as the first-time question. Nothing is saved until you answer `t` and `Enter`.
- **Forget**: ask again at the next pi turn that needs it.

A change applies from the next turn. If a project has no pi files, there is nothing to trust and `/trust` says so. If marcsh cannot read one of the files, **Trust** is not offered either, and the dialog lists the unreadable files. A trust you gave earlier stops applying when the files change after your review. Review them again.

### On Claude

marcsh does not ask about project files on the Claude engine. Claude Code reads the project's settings (`.claude/settings.json` and `.claude/settings.local.json`) by its own rules, without the `/trust` prompt.

## How marcsh starts

The `marcsh` command starts Bun so that it does **not** read a `.env` file or a `bunfig.toml` from the folder you run it in. A repository you open cannot change how marcsh starts by adding either file. Environment variables you set in your shell still count.

## Packs

[Packs](packs.md) are third-party content. marcsh limits what they can do:

- **Public repositories only.** marcsh turns off Git's credential helpers and password prompts, and allows only HTTPS, so SSH keys are never used. Git still reads your normal Git configuration, so anything in it that attaches credentials to `https://github.com` requests (for example a `.netrc` entry or an `http.extraHeader`) can still be sent.
- **Nothing runs at install.** Git runs without hooks, submodules or large-file downloads. The pack is read, not executed.
- **You see it first.** The preview lists agents, skills, commands and what is not used. The install is pinned to the commit you saw. Updates never happen by themselves.
- **Size limits.** 100 MB download, 5,000 files and folders, 50 MB of files, 1 MB for a skill or command file, 256 KB for an agent file.
- **No links out.** A symlink that points outside the pack rejects it.
- **No MCP servers.** marcsh never runs MCP servers from a pack.
- **Per agent.** A pack's skills and commands are loaded only while one of its agents is selected.
- **Only what you saw is loaded.** marcsh copies the skills and commands it scanned into its own folder. The engine loads that copy, not the repository.
- **Safe text.** Names and descriptions from a pack are cleaned of control characters before they reach your screen.

### Hooks

[Pack hooks](pack-hooks.md) are the one part of a pack that runs commands. They are off until you review the exact commands and files and enable them. Consent is tied to one commit and to every file in the pack's `hooks/`, `skills/` and `commands/` folders. An update, or any change to those files, turns them off. Hooks can block a call. They cannot approve one or change what the model asked for, so your approval prompts stay in charge.

## What marcsh does not protect against

- **Commands you approve.** marcsh shows you the command. It does not sandbox it. An approved command can do anything your user account can do. Read prompts before you press `y`.
- **Broad "always allow".** On pi, after `a` on a tool like editing, that tool no longer asks in that project. On Claude, the rule that `a` applies is chosen by Claude Code, and marcsh does not control how far it reaches.
- **Hooks.** Hooks you enable run with your permissions. They can read and change any of your files, including marcsh's own files and Claude's settings. Only enable hooks from authors you trust.
- **Pack prompts and skills.** A pack's agent prompt and skills are instructions for the model. They can lead it to run scripts that ship with the pack. Those calls still go through approvals, but a pack agent can ask for many of them. Read what a pack contains before you install it.
- **Project instructions.** `AGENTS.md`, `CLAUDE.md` and any file the model reads can contain instructions that steer the model. This is true for web pages on Claude too.
- **MCP servers you configure.** An MCP server is a program that runs with your permissions. Its tools ask like any other tool, but marcsh cannot tell you what the server does inside.
- **A trusted project that you changed yourself.** Trust follows the files you reviewed. If you review carelessly, marcsh cannot help.
- **The git guard on indirect commands.** It reads the command text. It cannot see what a script does.
- **Your data going to the model provider.** What you and the model read and write is sent to the provider of the model you use.
- **Other software on your computer.** marcsh does not defend against a program that already runs as you.

## Your logins

On pi, `/login` stores provider logins in `~/.marcsh/agent`. marcsh makes that folder readable only by you. That holds for the default folder. A custom `MARCSH_AGENT_DIR` is yours to protect (see [Configuration](configuration.md#environment-variables)). `/logout` removes a login. See [Engines and models](engines-and-models.md).

## Next

- How agents and tool limits work: [Agents](agents.md).
- Install packs: [Packs](packs.md).
- Hooks: [Pack hooks](pack-hooks.md).
- Settings and paths: [Configuration](configuration.md).
