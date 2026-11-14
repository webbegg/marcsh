# Changelog

Release notes for each version, newest first. Every release on GitHub also lists the pull requests it contains.

## 0.3.0

Background work on the pi engine, and a richer status line.

### Background terminals
- The agent can start long commands in the background with `bg_start`, and check, list or stop them with `bg_status`, `bg_list` and `bg_kill`. Up to 8 run at once. Each runs in its own process group with no input, and its output is kept in memory and in a private log that is deleted when you leave the session or quit.
- `bg_start` asks exactly like `bash` for the same command, in every approval mode. A command run in another folder is checked for that folder, and rules saved in the session folder don't cover it. Plan mode offers only `bg_status` and `bg_list`.
- `/ps` lists the terminals, shows their output (`t` switches between stdout and stderr) and stops them with `x`. The status line shows how many are running. See [docs/commands.md](docs/commands.md).

### Background subagents
- `Task` takes `background: true`: the subagent keeps working after the turn, and `task_wait`, `task_check`, `task_cancel` and `task_list` collect, peek at, stop and list them. Up to 4 run at once.
- A background subagent's tool calls still ask for approval, labelled `Background subagent: <description>`, also between turns. They follow the session's current approval mode and Plan mode, and are denied when nobody can answer.
- `/subagents` lists them with a live, read-only transcript, and `x` cancels one.

### Results
- When background work finishes, its result reaches the agent once: inside the running turn, or in a turn marcsh starts with a `[background] <title> finished` notice. Results that finish together arrive as one. marcsh does not start a turn right after you press Esc.
- Results are given to the agent marked as program output, not as your words. See [docs/security.md](docs/security.md).

### Time limit
- On pi, a foreground `bash` or `Task` call that runs longer than 3 minutes is stopped, and the agent is told how to run the work longer or in the background. A command that sets its own `timeout` keeps it. Time a subagent spends waiting for your approval doesn't count.

### Status line
- The git branch (or a short commit SHA when detached), and the latest reply's speed in tokens per second next to the cost.
- The number of changed files, only in a project you have trusted. marcsh never runs `git status` in a folder you haven't trusted, because a repository's own settings could make it run a program. See [docs/screen.md](docs/screen.md).

### Notices
- Parts of the background terminal and subagent code are ported from davi7's pi setup (MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## 0.2.0

Daily-use features, and approval modes.

### Command line
- `marcsh run [message...]` runs one turn without the TUI. It reads stdin when that isn't a terminal and accepts `-c`, `-s <id>`, `-m`, `--agent`, `--engine` and `--format text|json`. A headless run has nobody to approve, so it denies every approval and always runs in the `normal` approval mode. See [docs/cli.md](docs/cli.md).
- `marcsh [dir] [-c] [-s id] [--engine e]` opens marcsh in a folder, in the folder's latest session, or in a given session.
- New subcommands:
  - `marcsh session list|delete|export`
  - `marcsh models`
  - `marcsh mcp list|add`
  - `marcsh stats`
  - `marcsh upgrade`

### Sessions
- `/rename`, `/fork` and `/export md|json`. Delete a session from the sessions dialog with Ctrl+D.
- `/undo` and `/redo` restore the files a turn changed, and `/diff` shows what the session changed. marcsh snapshots the project before and after each turn into its own git repo under `~/.marcsh/snapshots`, and never touches the project's `.git`. There are no snapshots in your home folder or in `/`. See [docs/sessions.md](docs/sessions.md).
- `/compact` compacts the engine's context. The status line shows the context used and the session cost.
- `/copy` copies the last reply.

### Input
- Up and Down walk the prompts you sent before.
- An unsent draft now stays with its own session and comes back when you return. Before 0.2.0 it moved to the next input you opened.
- Pasting or dropping the path of an image or a PDF (up to 20 MB) attaches it to the next message. Other files become `@path` mentions.

### Commands and keys
- Custom commands come from markdown files in `~/.marcsh/commands` and, once you trust a project, in its `.marcsh/commands`. See [docs/commands.md](docs/commands.md).
- Ctrl+P opens the command palette. `ctrl+x` followed by a key runs a bound command. Keys can be changed in `~/.marcsh/keybinds.json`. See [docs/keybinds.md](docs/keybinds.md).
- The model dialogs list favorites (Ctrl+F) and recent models first. F2 switches to the next recent model.
- marcsh rings the terminal bell when a turn ends. `notify: system` shows a macOS notification instead, and `notify: off` turns it off.

### Approval modes
- `/permissions normal|auto|yolo` sets how much runs without asking. The status line shows the mode.
- Destructive, publishing, privileged and dependency commands always ask, and catastrophic commands are blocked. See [docs/security.md](docs/security.md).

## 0.1.0

First release: the TUI on the pi and Claude engines, agents and agent packs, project trust, MCP on pi, and the one-command installer for macOS.
