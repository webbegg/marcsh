# Changelog

Release notes for each version, newest first. Every release on GitHub also lists the pull requests it contains.

## 0.7.1

Cleaner text in the `/` menu.

### Fixes
- **The `/` menu and the palette clean the commands an engine or a project supplies.** A description or argument hint shows on one line, with control and format characters removed. This covers Claude's and pi's commands and skills, marcsh's bundled ones and a project's custom commands. An engine command whose name has such a character, or a space other than the ordinary one, is left out of the menu, because the name you would read is not the one that would run. Typing it still works: marcsh says it is not a known command, and a second `Enter` sends it. See [docs/commands.md](docs/commands.md#other-name-input).
- **The `/permissions` toast escapes the branch name** and the reason auto and yolo are paused, as the dialog row does.

## 0.7.0

The interface gets easier to use: no lost prompts or sessions, replies in markdown, diffs in the approval prompt, a help dialog, and session lists that say what each session is.

### Fewer traps
- **The model you chose is kept.** The model you picked last is kept between launches and `marcsh -c`, for each engine. A session you open again starts on the model it used last while that model is available, and leaving it goes back to your choice. See [docs/engines-and-models.md](docs/engines-and-models.md).
- **Ctrl+C asks twice.** On an empty prompt, `Ctrl+C` shows "ctrl+c again to quit", and a second press within about 1.5 seconds quits. Quitting from a session prints its id and `marcsh -c` to resume it. See [docs/keybinds.md](docs/keybinds.md).
- **A new line in tmux.** `Ctrl+J` types a new line, and inside tmux without extended keys (where Shift+Enter arrives as Enter) the hint under the prompt says so.
- **A first run with no model.** The home screen shows how to get one (`/login` for pi, `/engine` for Claude), and Enter sends nothing and creates no session until there is one.
- **Clear turn states.** A turn stopped with Esc says `interrupted` in its footer, also after a reload. While a Claude reply runs, the prompt says "reply running · esc to stop".

### The transcript
- **Markdown replies** with highlighted code blocks.
- **Diffs for edits.** Edit and Write show a coloured diff in the approval prompt, instead of the tool's raw input, and in the transcript afterwards. The prompt's diff is exactly what the tool will write; when marcsh cannot be sure, it shows the raw input and says why.
- **Tool output.** Tool calls show the last lines of their output, and errors in full. The output of a successful tool is saved with the session, through secret redaction and capped at about the last 200 lines or 16 KB. See [docs/security.md](docs/security.md).
- **Folded thinking.** A thinking block folds to one line with its duration, and an empty one is not shown. `/details` (`<leader>o`) and `/thinking` (`<leader>h`) show everything, for the current session.

### Finding things
- **`/help`, and `?` on an empty prompt,** list the keys you have now (a rebinding shows) and the commands. The footer shows `ctrl+p commands`.
- **Enter in the `/` menu runs what you typed:** an exact name, a unique prefix, or the row you moved to. `/he` never runs `/theme`. An unknown `/x` says so, and a second Enter sends it to the engine. See [docs/commands.md](docs/commands.md).
- **A grouped `/` menu** (marcsh, pack and engine commands), with `/login` and `/logout` hidden on Claude. The palette uses the width it has, and cut descriptions end with `…`.
- **Setting dialogs that say what they do.** `/permissions` shows when it is paused on the default branch, `/trust` marks the current state, and `/profile` without a profiles file offers to create a commented starter one (it never overwrites). Switching between Build and Plan says what the mode does.

### Sessions and the CLI
- **Session lists show the engine, the model, the message count and a relative time** ("3h ago"), in `marcsh session list` and in `/sessions`, in one time format. `--json` adds `engine`, `model` and `messageCount`. See [docs/sessions.md](docs/sessions.md).
- **`marcsh run --help`** prints run's own options and says that approval requests are denied in `run`. A usage error prints the error and `see marcsh --help`, not the whole help. See [docs/cli.md](docs/cli.md).

### Fixes
- `marcsh stats` counts the other sessions when one is damaged, instead of failing for all of them.
- Pack fetches no longer start git's background maintenance, which could keep writing into a staging folder after it was removed.

## 0.6.0

Commands that ask before they send, a task list, subagents held to the files they may change, model profiles with fallback chains, and the brigadev workflow as a pack.

### Commands
- **Commands can ask questions.** A custom or pack command can declare `questions` in its frontmatter (text, long or choice; required, options, defaults). marcsh asks them in a form, fills the `{{id}}` placeholders, and shows the request with Start, Edit answers and Cancel before it sends. Defaults can use the current branch, the default branch and the test script. Text typed after the command fills the first question. See [docs/commands.md](docs/commands.md).
- **`marcsh run "/name …"` runs your custom and pack commands** as the interface does, with the agent and model the command names. A command with questions takes the text after its name as its first answer and the defaults for the rest; a required answer nobody gave exits with `2` before anything is sent. Before, the typed `/name` reached the engine as it was. See [docs/cli.md](docs/cli.md).

### Agents and subagents
- **A task list.** On pi, the agent keeps a `todo` list (pending, in progress, done, blocked, dropped). It changes no files, so it never asks, also in Plan; only marcsh's own tool runs unasked. On Claude, Claude's own TodoWrite stays available.
- **Subagents held to the files they may change.** On pi, `Task` takes an `editSurfaces` list of paths or globs. Edits and writes outside it are denied without asking, literal shell writes outside it are blocked, other changes are flagged, and the Task result lists every file changed outside it, also when the subagent times out or fails. Writers running at the same time must have separate lists. See [docs/agents.md](docs/agents.md).

### Models
- **Model profiles.** `~/.marcsh/profiles.json` routes your agent's turn, each subagent (by name, prefix or `*`) to a model, a thinking level and a fallback chain. `/profile` shows the routing and where each value comes from, and switches profiles. Without the file nothing changes. See [docs/configuration.md](docs/configuration.md).
- **Fallback chains.** On pi, a turn that fails on quota, auth, a rate limit, a provider error, a timeout or the network moves to the next model in its chain, and the failed model rests (30 minutes after quota or auth, 2 minutes otherwise). A subagent restarts on the next model only if it had not run any tool yet, so nothing runs twice. On Claude, the first fallback becomes Claude's own fallback model.

### The brigadev pack
- **`packs/brigadev`** brings the brigadev ODD workflow: an orchestrator agent, explore, verify, worker, review and Judgment Day subagents, 11 skills and 16 commands (13 with question forms), and opt-in hooks that block `git commit` until a passing test run is recorded for the current files. It lives in this repository; `scripts/brigadev-pack-dev.sh` mirrors it for a local install. See [packs/brigadev/README.md](packs/brigadev/README.md).

## 0.5.0

Trust any project, with its commands and git settings in what you review.

### Project trust
- **`/trust` works for any project**, also one without pi files. A project with nothing to review says so, and trusting it takes `t` then Enter.
- **What you trust is reviewed in three parts**, and each one only counts while it is as you reviewed it:
  - **pi files**: pi loads them only while they match.
  - **Project commands** (`.marcsh/commands`): marcsh uses them only while they match. Adding, changing or removing one asks again; it does not affect pi. Each command is read once and used only if it is exactly what you reviewed.
  - **Git settings**: the repository's own filter drivers (including files its config includes) and its attribute files. The status line counts changed files with `git status` only while they match. Git's own writes (`git push -u`, `git remote add`, `core.*`) and your global `~/.gitconfig` never count as a change.
- **The list shows the parts.** Command rows show their `agent:` and `model:`, and the git row shows each filter driver's command.
- **When a part changes**, only that part stops, and a short notice says which one and what to do. The trust question reads "Trust this project's files?".
- **Upgrading from 0.4.0:** projects you trusted keep their pi trust, also in `marcsh run` and `marcsh mcp`. Their commands and the changed-file count wait for one `/trust`, with a note that says why. `marcsh run` and `marcsh mcp` print a note when a trusted project's pi files changed and nobody can be asked.
- On Claude, nothing asks at turn time: run `/trust`. Claude's own project settings are not gated by marcsh trust. See [docs/security.md](docs/security.md).

### Fixes
- A pack install that is cancelled, times out or goes over the download limit no longer leaves its staging folder behind.

## 0.4.0

Pasting anything into the prompt, packs that work closely with marcsh, and tracking of processes your tools leave running.

### Paste
- **Ctrl+V** reads the clipboard; you can rebind it with the `paste` action in `keybinds.json`.
  - A copied image or screenshot is attached as `[image: clipboard-N.png]`. It is saved privately (folder 0700, file 0600) under `~/.marcsh/attachments/<session>`, and deleted when you remove its chip or delete the session.
  - Terminals that send an empty paste when the clipboard holds an image get the same with Cmd+V.
- **Large pastes** (3 lines or more, or over 150 characters) show as `[Pasted ~N lines: <start>…]`.
  - The full text is what is sent, kept in history and kept as a draft.
  - Backspace, the arrows, selections and undo treat the placeholder as one piece.
  - `"paste": "full"` in preferences keeps full pastes. See [docs/screen.md](docs/screen.md).
- **Shift+arrow selections** in the prompt cover exactly what you moved over, in both directions.
- **`/copy`** writes to this machine's clipboard and to the terminal (OSC 52).

### Packs
- **Subagents:** an agent file with `mode: subagent` is a subagent.
  - The agent can start it by name: with `Task` and `agent` on pi, and through Claude's own subagents.
  - It runs with its own prompt, its pack's skills and its model. Its tools can only narrow the agent's, never widen them, and a read-only one never writes. See [docs/agents.md](docs/agents.md).
- **Commands:** a pack command can name its `agent` and an `argument-hint`, and runs that turn as that agent.
  - It never lifts Plan and never widens the tools of the agent you selected.
  - Commands of marcsh, the engine and your own win a name clash; the pack's then shows as `/<repo>:<name>`.
  - The install preview shows which agent each command runs as.
- **Mode line:** the model is always told the approval mode, including normal and Plan.
- **Hooks:** pack hooks on pi get `permission_mode` and `agent`, plus `MARCSH_APPROVAL_MODE` and `MARCSH_AGENT`. While auto or yolo is paused they are told `normal`. See [docs/pack-hooks.md](docs/pack-hooks.md).

### Leftover processes
- **Tracking:** marcsh marks every process its tools start, so it can show the ones still running after their tool call has ended.
  - `/ps` lists them, and `x` stops one. The status line counts them.
  - On pi the agent has `proc_list` and `proc_stop`.
- **Stopping:** `proc_stop` always asks, in every approval mode. A process that may be yours is flagged and never suggested.
- **Unattended:** nothing is stopped by itself.
- **Limit:** on macOS, Apple's own programs can't be seen. See [docs/security.md](docs/security.md).

### Status line
- **Paused mode:** a mode that is chosen but paused (auto or yolo on the default branch) is struck through, followed by a red `!`.
- **Worktree:** in a linked git worktree, the git part names the worktree.

### Under the hood
- **OpenTUI 0.9:** marcsh now runs on OpenTUI 0.9.0, and uses its native clipboard (on macOS no extra tools are needed). The spinner is marcsh's own, with the same look.
- **Wrapping:** text that fills a row exactly now stays on that line, so wrapped text can break one word later.
- **Notices:** see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for code ported from opencode and cli-spinners. OpenTUI's native packages include LGPL FFmpeg, installed from npm and not shipped in the release.

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
