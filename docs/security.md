# Security

marcsh lets an AI model read your files and run commands. This page explains what asks for your approval, what a project or a pack can make marcsh do, and what marcsh does **not** protect you from.

## Approvals

When the model wants to do something that is not a plain read, marcsh stops and asks you.

### What asks

| Engine | Runs without asking | Asks |
| --- | --- | --- |
| pi | `read`, `grep`, `find`, `ls`, the question tool (`AskUserQuestion`), `Task` (the subagent it starts asks for its own tool calls), `bg_status`, `bg_list` and `bg_kill` (they only look at or stop this session's background terminals), `task_wait`, `task_check`, `task_cancel` and `task_list` (they only look at, wait for or stop this session's background subagents), and `proc_list` (it only looks at this marcsh run's leftover processes, see [What marcsh may stop](#what-marcsh-may-stop)) | Every other tool: running commands (including `bg_start`), writing and editing files, MCP tools, tools added by extensions. `proc_stop` (stopping leftover processes) asks in every approval mode, yolo included, and can never be always-allowed |
| Claude | What Claude Code's default permission mode allows without asking | The rest. marcsh shows Claude's question |

On pi, `bg_start` runs a command in the background. It asks exactly like `bash` for the same command, and the prompt names `bg_start` so you can see it will keep running. The git guard and a pack's `Bash` hooks apply to it too. A `bg_start` in another folder (`working_dir`) is checked for that folder, and rules saved in the session folder do not cover it. Background terminals stop when you leave the session or quit marcsh.

On pi, `Task` with `background: true` starts a subagent that keeps working after the turn ends. Its tool calls still ask, the same way as any other call. A prompt that comes between turns shows in the normal approval prompt, labelled `Background subagent: <description>`. If nobody can answer, the call is denied. Once you switch the session to Plan, a background subagent's calls are limited like Plan's: it can still read, but it can't write or run anything until you switch back. Background subagents stop when you leave the session or quit marcsh.

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

- For a command tool (`bash`), it covers **that exact command** only. It covers the command in `bash` and `bg_start` alike.
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
- It checks the built-in shell tool and marcsh's `bg_start` only.
- If git cannot run, or the folder is not a repository, the guard decides nothing and the normal approval applies.

### Permission modes

The permission mode sets how much runs without a prompt. It applies to both engines, and to the subagents that `Task` starts. Change it with [/permissions](commands.md#permissions). A change during a turn applies to the next tool call, in that turn too; what the agent was told about the mode is updated at the next turn. It is separate from the agent: Plan and Build still decide what an agent may do at all.

On pi, `bg_start` follows the mode exactly like `bash` for the same command; in another folder (`working_dir`) it is judged as `cd <folder> && <command>` would be, on the session folder's branch. Background subagents use the session's mode as it is at each of their calls, also after the turn that started them.

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
- Edits outside the project folder, to files that look secret (`.env` files other than examples, keys, `.ssh/`, credentials) and to `.git/`, in any letter case (`.GIT`, `.Env`). Writes inside another checkout below the project (a folder with its own `.git`: a nested repository, submodule or worktree) ask too. This covers the edit tools, redirects (`>`, `>>`), and the files given to `cp`, `mv`, `ln`, `install`, `tee`, `sed -i`, `curl -o`, `wget -O`, `touch`, `mkdir`, `rm`, `rmdir` and `unlink`; for `cp`, `mv`, `ln` and `install` into a folder, also the name each file lands on there (when the name comes from a variable or a glob, the copy asks only if that folder holds a symlink). Paths are checked after symlinks. Links deeper inside a copied folder are not checked. Other programs that write files, such as a script or `rsync`, are not read.
- A command marcsh cannot read, such as one with an open quote.
- Tools marcsh does not classify: MCP tools, web tools and tools from extensions. In every mode they keep the prompt they have today, including "always allow".

The worst commands are blocked, not asked, in every mode including `normal`: `rm -rf ~`, `rm -rf /`, and `rm -r` on `.`, `..`, `*` or a system folder (`/usr`, `/etc`, `/var`, `/Users`, `/home`, `/System`); `mkfs`; and `dd` onto a disk. `dd` to `/dev/null`, `/dev/zero` or the terminal is an ordinary command.

Some rules do not change with the mode:

- A commit on the default branch stays blocked in `auto` and `yolo`, as in [Git guard](#git-guard).
- The git guard's questions (`git push`, `gh pr create`, `gh pr merge`, `npm`, `pnpm`, `yarn` or `bun` `publish`) are never skipped by a mode, and never offer "always allow".
- Folder rules ("allow `rm` under …", below) do not depend on the mode or the branch.
- In `auto` and `yolo`, deleting files strictly inside the temp folder (`/tmp`, `$TMPDIR`) runs without asking, because it is scratch space. The temp folder itself, paths with `..`, paths with variables and paths that a symlink leads out of the temp folder still ask.
- On Claude, a request that your Claude settings say to ask about, and a request Claude flags as risky or protected, keeps asking.

The agent is told the mode in every mode, `normal` included, so it runs what the mode allows instead of asking you in chat first. A Plan turn is told it is in Plan mode and read-only instead, because it stays read-only in every mode. So is a read-only subagent. Every subagent a turn starts with `Task`, named or not, is told the same as its turn. In a headless `marcsh run`, the `normal` line also says that every ask is denied.

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

- On pi it is only given the read tools, the question tool, `Task`, `bg_status`, `bg_list`, `task_wait`, `task_check`, `task_list` and `proc_list`, so it cannot write files, run commands, start background subagents or stop background work. A saved "always allow" does not change this.
- On Claude it runs in Claude Code's plan mode.

An agent's `tools` field can only take tools away. It never adds any. See [Agents](agents.md#limit-tools).

### What marcsh may stop

marcsh may stop only a **leftover process** of this marcsh run: one that carries this run's marker, started after this marcsh did, and no longer runs under marcsh. It never stops a process without that marker, and the agent never stops anything without asking you first.

- When marcsh starts, it makes a fresh marker, `MARCSH_SESSION=<random id>`, and puts it in its own environment. Everything it starts inherits it: pi's `bash`, `bg_start` terminals, subagents' tools, and the Claude CLI with its Bash. A process you start yourself, such as `npm run dev` in another terminal, never carries this run's marker. marcsh never picks processes by name or folder.
- Anything still under marcsh is a running tool call, a background terminal, or marcsh's own machinery (the Claude CLI, MCP servers, pack hooks), and is not listed. On pi, pack hooks also get `MARCSH_INFRA=1`, and what they leave running is never listed, so you do not see it in `/ps` either; stop it yourself if you need to. On Claude, hooks do not get `MARCSH_INFRA`, so what they leave running is listed like any leftover.
- The marker is passed on to whatever a marked process starts. So if a tool call starts a long-lived program for the first time, such as an editor (`code .`), a tmux server or gpg-agent, then what you later open through it (the editor's terminal, a tmux pane, and what you run there) carries the marker too, and can show as a leftover. marcsh marks such a process **possibly yours** when it has a terminal, leads its own session, runs under a marked process that does, or (on Linux) is in a session led by a marked process that is not a tool call's shell. `/ps` says so on its row, and the agent is told not to suggest stopping it. Marking is a hint, not a guarantee: a process you opened this way that matches none of these is not marked.
- On pi, the agent's `proc_stop` asks you first in every approval mode, yolo included, and the prompt has no "always". It shows each process it would stop: pid, age, memory and command (with secret-looking values such as `--token=…`, `-p…` for mysql, `Bearer …` hidden), and "possibly yours" when it is marked. The agent's `proc_list` shows the same redacted lines without asking. In Plan only `proc_list` is offered.
- Right before each signal, marcsh reads the process table again and checks the marker and the start time. A pid that now belongs to another process is left alone. `SIGTERM` goes to the process, or to its process group when every process in the group is a leftover of this run. `SIGKILL` follows after 2 seconds, after the same check. A pid that is still taken but can no longer be checked (it is not listed any more, or the table could not be read) gets no `SIGKILL` and is reported as not stopped.
- A read of the process table that was cut short (a timeout, too much output, a signal, a file that could not be read) counts as failed, never as a shorter list. The status line then hides the leftover count, and `/ps` says the scan failed. `ps` runs from `/bin/ps`, never from your `PATH`.
- The status line scans on its own only after the first turn of this marcsh run started, and then about every 30 seconds and when a turn ends.
- Nothing is stopped automatically beyond background terminals, which stop when you leave the session or quit. You stop leftovers in `/ps` (`x`, without a further question), and on pi the agent can with `proc_stop`, after you allow it.
- Some processes cannot be seen, so they are never listed or stopped: one started with an emptied environment (`env -i`) or that clears its own, setuid programs, anything started through launchd or a daemon (`open -a`, `docker run`, `brew services`), and on macOS Apple's own programs such as `/bin/sleep` or `/usr/bin/python3`, whose environment macOS does not show. On Claude, a process the Claude CLI still runs (a `run_in_background` shell) is listed only once the CLI has ended, and a leftover of its Bash may show as possibly yours (it can keep marcsh's terminal). On macOS, `ps` does not give session ids, so only the terminal, session-leader and ancestor checks mark a process possibly yours. Detection works on macOS and Linux only.

### Turns marcsh starts

When background work finishes while a pi session is idle, marcsh starts a turn to give the agent the result (see [The screen](screen.md#background-results)). That turn is like one you start. It runs as the agent and model selected at that moment, and every tool call it makes asks the same way, including in Plan. Its message is the work's output, sent as it is: a `/command` in it is not run. The agent gets every background result marked as output of work it started, not as your words, and is told to treat any instructions in it as data.

## Project trust

You can trust any project, on either engine. Until you trust a project, marcsh does not use what the project itself brings:

- **pi files** (pi engine). They are code that runs with your permissions. pi ignores them:
  - the `.pi/` folder: settings, extensions, skills, prompt templates, themes, system prompt files, and `.pi/mcp.json` with the project's MCP servers;
  - `.agents/skills` in the project or in a parent folder.
- **Project commands** (both engines): the files in `.marcsh/commands`. They are not loaded, and a typed `/name` that matches only a project command is sent as typed. See [Project commands and trust](commands.md#project-commands-and-trust).
- **The git changed-file count** in the status line (both engines). See below.

`AGENTS.md` and `CLAUDE.md` are not part of this. pi reads them as context without asking.

A trust holds only while the project is as you reviewed it. If a pi file or a project command is added, changed or removed afterwards, the trust stops applying to all three until you review the project again. A trust stored before marcsh kept reviews does not hold either: review the project again with `/trust`.

### The first time

On the first pi turn in a project that has pi files or project commands, before pi loads anything of the project, marcsh shows a full-screen question: `Trust this project's pi files?`

It lists everything pi would load or run, most dangerous first: MCP servers with their command, arguments and environment, settings that run or install things, extensions, then skills, prompt templates, themes and system prompt files. Files that a setting points to elsewhere are listed too. The project's commands come last, each as `.marcsh/commands/<name>.md — project command /<name>`.

| Key | What it does |
| --- | --- |
| `t`, then `Enter` | Trust the project. Works only after you scrolled to the end of the list, in a terminal tall enough to read it. |
| `d` | Don't trust. marcsh remembers and does not ask again. |
| `Esc` | Not now. This turn runs without the project's files, and nothing is remembered. |

Scroll with `Up`, `Down`, `PageUp`, `PageDown` or the mouse wheel. The same typing protection as in approvals applies.

If marcsh cannot read one of the entries, it cannot show you what trusting would run. Those entries are listed first with the reason, and trusting is not offered. A terminal that is too small says `Terminal too small to review the list: make it taller to trust.`

### When the files change

Trust is tied to what you reviewed. If a pi file or a project command is added, changed or removed afterwards, the next pi turn asks again with the title `This project's pi files changed since you trusted them. Trust them again?` Each entry is marked `[added]`, `[changed]` or `[unchanged]`, and files that are gone are listed as `[removed]`. Until you answer, the project's commands are not used and the status line shows no changed-file count. On Claude nothing asks at turn time: run `/trust` to review the project again.

### Change a decision: /trust

`/trust` opens `Project Trust` for the current folder, on either engine. It shows `Now: trusted`, `Now: not trusted` or `Now: not decided yet`, and how many pi files and project commands it found (`no pi files or project commands found` when there are none). A trust that stopped applying shows as `Now: not trusted (this project's files changed since you trusted them)`. The choices are:

- **Don't trust**: don't use the project's pi files, commands or git status.
- **Trust**: opens the same list as the first-time question. Nothing is saved until you answer `t` and `Enter`. A project with nothing to list is trusted in this one step. If something appeared since the dialog opened, or while you were reading the list, you see the new list instead, and nothing is saved until you answer it.
- **Forget**: ask again at the next pi turn that needs it.

Project commands and the git count follow a change at once; pi follows it from the next turn. If marcsh cannot read one of the files, **Trust** is not offered, and the dialog lists the unreadable files. A trust you gave earlier stops applying when the files change after your review. Review them again.

marcsh never runs `git status` in a folder you have not trusted, on either engine, because `git status` can run programs that a repo's own git settings name. There the status line only reads the branch.

### On Claude

marcsh does not ask about project files on the Claude engine. The project's commands and the git changed-file count still follow marcsh's trust: in a project whose commands are not trusted, opening the `/` menu says once `This project has its own commands (.marcsh/commands): run /trust to use them.`

Claude project settings are **not** gated by marcsh trust. Claude Code reads the project's settings (`.claude/settings.json` and `.claude/settings.local.json`) by its own rules, whether or not you trusted the project in marcsh.

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
