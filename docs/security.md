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

### Permission modes

The permission mode sets how much runs without a prompt. It applies to both engines, and to the subagents that `Task` starts. Change it with [/permissions](commands.md#permissions). It is separate from the agent: Plan and Build still decide what an agent may do at all.

| Mode | Runs without asking | Still asks |
| --- | --- | --- |
| `normal` | Reads, as before | Everything else, as described above. Nothing changes, except that the worst commands are blocked (below). |
| `auto` | On a feature branch: file edits inside the project and ordinary shell commands | Commits, anything remote, leaving the branch, and the list below |
| `yolo` | On a feature branch: everything `auto` runs, plus local commits | Anything remote, leaving the branch, and the list below |

`normal` is the mode every session starts in, unless you saved another one as the default.

#### The feature branch sandbox

`auto` and `yolo` relax only while the folder marcsh works in is on a feature branch. That is any branch except the default one: the branch `origin` points at, or `main` or `master` when that is unknown. marcsh reads the branch again for every tool call.

When the folder is on the default branch, on a detached HEAD, not a git repository, or marcsh cannot read the branch, the mode is paused. marcsh then asks exactly as in `normal`. Each prompt is your way to allow that one action. The agent is told the mode is paused and that it should start its work on a feature branch, preferably in a git worktree. A git lookup that fails never loosens anything.

A worktree gives each feature its own folder and branch. Start one with `git worktree add ../<repo>-worktrees/<slug> -b <type>/<slug>` (marcsh asks first), then open marcsh in that folder. A session stays in the folder it was opened in.

On a feature branch:

- Local commits: `auto` asks, `yolo` runs them. `git merge`, `git cherry-pick`, `git revert`, `git am` and `git pull` make commits, so they count as local commits.
- Anything remote always asks, in both modes: any `git push` (also `git send-pack`, `git subtree push`, `git svn dcommit` and `git p4 submit`), `gh pr` and `gh issue` writes (`create`, `comment`, `review`, `edit`, `close`, `reopen`), and `gh api` writes.
- Anything that leaves the branch always asks, in both modes: `git switch` and `git checkout` of a branch (also with `-c` or `-b`), git run in another directory (`git -C <dir>`, `--git-dir`, `--work-tree`, `-c core.worktree=…`, or `GIT_DIR=` and `GIT_WORK_TREE=` set on the command), `git worktree add` or `move`, and a `cd`, `pushd` or `popd` out of the checkout before a git command (into a nested repository or submodule too). Writing another branch counts as leaving it: a `git fetch` or `git pull` into a local branch (`git fetch origin main:main`), and `git branch -f` or `-C`. A commit made in another directory counts as leaving the branch, not as a local commit.
- A git alias set on the command line (`git -c alias.p=push p`) asks, since it can stand for any command. Aliases from your git config are not read: `auto` and `yolo` judge such a command by its alias name.

In every mode, these always ask. In `normal` the prompt is the one you already know, with "always allow" where it is offered today. In `auto` and `yolo` the prompt never offers "always allow" for them:

- Destructive commands: `rm -rf` on a folder, `git reset --hard`, a force push, `DROP TABLE`, rewriting refs.
- Publishing and merging: `npm publish`, `gh pr merge`, `gh release`. A merge done through `gh api` counts too: merging a pull request or a branch, enabling auto-merge, moving a branch ref, or committing a file through the contents API.
- Privileged commands: `sudo`, `curl … | sh`.
- Dependency changes: `npm install`, `pip install` and the like.
- Edits outside the project folder, to files that look secret (`.env` files other than examples, keys, `.ssh/`, credentials) and to `.git/`. This covers the edit tools, redirects (`>`, `>>`), and the files given to `cp`, `mv`, `ln`, `install`, `tee`, `sed -i`, `curl -o`, `wget -O`, `touch`, `mkdir`, `rm`, `rmdir` and `unlink`. Paths are checked after symlinks. Other programs that write files, such as a script or `rsync`, are not read.
- A command marcsh cannot read, such as one with an open quote.
- Tools marcsh does not classify: MCP tools, web tools and tools from extensions. In every mode they keep the prompt they have today, including "always allow".

The worst commands are blocked, not asked, in every mode including `normal`: `rm -rf ~`, `rm -rf /`, and `rm -r` on `.`, `..`, `*` or a system folder (`/usr`, `/etc`, `/var`, `/Users`, `/home`, `/System`); `mkfs`; and `dd` onto a disk. `dd` to `/dev/null`, `/dev/zero` or the terminal is an ordinary command.

Some rules do not change with the mode:

- A commit on the default branch stays blocked in `auto` and `yolo`, as in [Git guard](#git-guard).
- The git guard's questions (`git push`, `gh pr create`, `gh pr merge`, `npm`, `pnpm`, `yarn` or `bun` `publish`) are never skipped by a mode, and never offer "always allow".
- Folder rules ("allow `rm` under …", below) do not depend on the mode or the branch.
- In `auto` and `yolo`, deleting files strictly inside the temp folder (`/tmp`, `$TMPDIR`) runs without asking, because it is scratch space. The temp folder itself, paths with `..`, paths with variables and paths that a symlink leads out of the temp folder still ask.
- On Claude, a request that your Claude settings say to ask about, and a request Claude flags as risky or protected, keeps asking.

The agent is told the mode, so it runs what the mode allows instead of asking you in chat first. The Plan agent is not told: it stays read-only in every mode.

The classifier reads the command text. It is a best-effort check, not a sandbox. It cannot see what a script does, and `bash -c "…"` or an alias can hide a command from it. The branch limits what the modes relax, but it does not contain what a command does inside your folder. Use `yolo` only in a project you can afford to lose work in.

### Allow similar commands under a folder

When marcsh asks about a command that only works on paths, the prompt also offers `p`: ``allow `rm` under /tmp/x``. Press `Left` to widen the folder to its parent and `Right` to narrow it again, then `p`. The commands are `rm`, `rmdir`, `unlink`, `mv`, `cp`, `mkdir`, `touch` and `find <folder> … -delete`. It is offered in every mode, also on the asks that never offer "always allow", and on both engines. It is not offered on prompts that need `y` then `Enter`.

Later commands run without asking only when they match:

- Every command in the line is the same program, with nothing else in it: no `cd`, `sudo`, redirects, substitutions or nested shells.
- Every target is a literal path strictly inside the folder. Variables, `~`, `..` and `.git` do not match, and a glob (`*`, `?`) only in the last name.
- Every target is inside the folder after symlinks too. A link inside the folder that points out of it does not match, a glob only matches in a folder that holds no symlink, and `find -follow` does not match. A rule folder reached through a symlink you own (one the agent could repoint) matches nothing. Root-owned links such as `/tmp` on macOS are fine.
- The command is not one of the blocked ones (`rm -rf ~`, `rm -rf /`). A rule never overrides the git guard or Plan.

The rule is stored per project folder in marcsh's database, next to the pi "always allow" rules. There is no screen to list or revoke these rules yet. Symlinks are checked when marcsh decides, so a link changed by another process between that moment and the command running is not seen.

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
- **The permission modes.** In `auto` and `yolo`, on a feature branch, a command that the classifier takes for ordinary runs without a prompt. The classifier is not a sandbox, and a branch is not a container: a command can still change files in your folder.
- **Your data going to the model provider.** What you and the model read and write is sent to the provider of the model you use.
- **Other software on your computer.** marcsh does not defend against a program that already runs as you.

## Your logins

On pi, `/login` stores provider logins in `~/.marcsh/agent`. marcsh makes that folder readable only by you. That holds for the default folder. A custom `MARCSH_AGENT_DIR` is yours to protect (see [Configuration](configuration.md#environment-variables)). `/logout` removes a login. See [Engines and models](engines-and-models.md).

## Next

- How agents and tool limits work: [Agents](agents.md).
- Install packs: [Packs](packs.md).
- Hooks: [Pack hooks](pack-hooks.md).
- Settings and paths: [Configuration](configuration.md).
