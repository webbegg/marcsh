# Changelog

Release notes for each version, newest first. Every release on GitHub also lists the pull requests it contains.

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
