# Troubleshooting

Common problems and what they mean. Each entry starts with the message you see.

## Starting marcsh

### An error from `env` about the `-S` option

The `marcsh` launcher uses `env -S` to pass options to Bun. On Linux this needs GNU coreutils 8.30 or newer. Update coreutils, or use a newer distribution. macOS needs no change.

### The `marcsh` command is not found

If you used the installer, check that `~/.local/bin` is on your `PATH`, or run the installer again with `--modify-path` (see the [README](../README.md#install)). The launcher also needs `bun` on your `PATH`.

If you installed from source, run `bun run link:cli` again from the repository. Check that Bun's global bin folder (usually `~/.bun/bin`) is on your `PATH`. You can also start marcsh with `packages/cli/bin/marcsh` from the repository.

## Models and signing in

### `no model · run /login` in the status line

pi has no model you can use, because no provider is signed in. Type `/login` and sign in to a provider. See [Engines and models](engines-and-models.md).

On the home screen, `Enter` then sends nothing and opens no session. marcsh keeps your text in the input and says `No model yet: type /login to sign in to a provider` until you change the input. A short card above the input says the same (`/login`, then `/models`), and names `/engine` for the Claude engine; it goes away once a model is available. While marcsh is still checking, or the check failed (`pi unavailable`), `Enter` is not blocked.

You may also see these messages, which mean the same thing:

- `No pi model is available yet. Run /login to sign in to a provider.` when you open `/models`.
- `No API key for <provider>. Run /login to sign in to a provider, or /models to pick a model that has one.` when a message fails. Sign in to that provider, or pick another model with `/models`.

### `pi unavailable` in the status line

marcsh could not check which pi models you can use, or the check took longer than 15 seconds. The status line checks again each time you open a pi session or send a message, so send a message. If it fails, the error in the conversation says what is missing. To keep working meanwhile, switch to Claude with `/engine`.

### `Unknown pi model "<model>". Use provider/model-id.`

The model name does not match any model pi knows. Type `/models` and pick one from the list.

### `Failed to log in to <provider>: …`

The sign-in did not finish. The text after the colon is the reason. Try `/login` again. `Login to <provider> cancelled` only means you closed the dialog.

### `Could not load pi models: …`, `Could not start pi login: …` or `Could not read pi logins: …`

marcsh could not start pi's model and login service. The text after the colon is the reason. If it keeps happening, check the folder pi uses: `~/.marcsh/agent`, or the one you set with `MARCSH_AGENT_DIR`.

### Claude fails to start a reply

If the conversation shows an error about signing in, remember that marcsh does not sign you in to Claude. The Claude engine uses the sign-in of your Claude setup. Make that work first, then try again. Until then, you can use pi (`/engine`). See [Engines and models](engines-and-models.md).

## Sessions

### `Could not load session: …`

marcsh could not read the session from its database, and took you back to the home screen. The text after the colon is the reason. If you see only `Failed to load session`, the session no longer exists. Open another one with `/sessions`. If `Could not load sessions: …` appears when you open `/sessions`, the database itself could not be read. Check the file `~/.marcsh/marcsh.db`, or the path in `MARCSH_DB_PATH`.

### `Could not save session: …`

marcsh could not write your conversation to the database. The reply you see on screen is fine, but it may be missing the next time you open the session. Check that the database file and its folder are writable. See [Sessions](sessions.md).

## The keyboard

### My keys do nothing on an approval prompt

The prompt ignores keys until you have stopped typing for a moment, and shows `waiting for typing to stop…`. If it shows `you were typing: press ↓ to answer`, press `Down` first. Prompts that say `y allow once (then Enter)` need `y` and then `Enter`. See [Typing protection](screen.md#typing-protection) and [Approving tool calls](screen.md#approving-tool-calls).

### `Alt+Enter` does nothing on a Mac

macOS Terminal sends `Alt+Enter` only when "Use Option as Meta key" is on in its settings. Turn it on, or type `/queue your text` instead. Both work on pi sessions while a reply is running. See [Typing while the agent works](screen.md#typing-while-the-agent-works).

### `Ctrl+V` says "Clipboard not available here"

marcsh reads the clipboard of the machine it runs on, through its terminal library (OpenTUI), with no extra tools to install. That works on macOS, and is meant to work on Linux with a Wayland or X11 desktop session. It does not work:

- **Over SSH.** The clipboard is on your own computer, not on the remote machine. Paste text with your terminal's paste key (`Cmd+V`, `Ctrl+Shift+V`). Images cannot be pasted over SSH; copy the file to the remote machine and paste its path instead.
- **On Linux without a desktop session** (a console, a container, no `WAYLAND_DISPLAY` or `DISPLAY`).
- **Where OpenTUI has no clipboard support for your system.** Windows is not tested.

Other messages: "Clipboard read timed out" (the clipboard owner did not answer within a second: try again), "Clipboard content is too large" (over 20 MB).

### `Cmd+V` pastes nothing when the clipboard holds an image

Terminals paste only text. Some send an empty paste when the clipboard holds an image, and marcsh then reads the image itself; others send nothing at all. Press `Ctrl+V` instead: marcsh reads the clipboard directly. See [Pasting](screen.md#pasting).

### `/copy` says "Sent the last reply to your terminal's clipboard"

marcsh could not reach this machine's clipboard (over SSH, for example) and asked the terminal to copy the text with OSC 52. Whether that works depends on the terminal: some need it turned on in their settings, macOS Terminal does not support it.

### I can't type while Claude is replying

On a Claude session the input is off until the reply ends. Press `Esc` to stop the reply. On pi you can type during a reply. See [Typing while the agent works](screen.md#typing-while-the-agent-works).

## Projects and trust

### The agent ignores my project's pi files

pi loads a project's own files only after you trust the project. Type `/trust` to review the project and trust it. See [Security](security.md#project-trust).

### A message about the trust list

- `Terminal too small to review the list: make it taller to trust.` Make the window taller and try again.
- `Could not read N of these files (listed first): trusting is not offered.` marcsh cannot show you what trusting would run. Make the listed files readable or remove them, then run `/trust` again.
- `Trusting lets the rest load and run with your permissions; the N unreadable stay off.` A project command or git settings file cannot be read. You can trust the rest; that part stays off until marcsh can read the file and you run `/trust` again.
- `This project's files changed while you were reviewing them, so nothing was saved: review the new list`. The list now shows what the project holds. Read it again and answer.
- `Could not save the decision: …`. The text after the colon is the reason. Check that `~/.marcsh/marcsh.db` is writable.

### My project commands stopped working, or the changed-file count is gone

Each part of a trust (pi files, project commands, git settings) stops applying on its own when something in it changes. marcsh says once per project per run which one:

- `This project has its own commands (.marcsh/commands): run /trust to use them.` You have not decided about the project yet. Run `/trust` to review it.
- `This project's commands changed since you trusted them: run /trust to use them.` A project command was added, changed or removed since your review. Run `/trust` and review the project again.
- `This project's git settings changed since you trusted them: run /trust to count its changed files.` The repo's filter drivers (its own git config and the files it includes), `.gitattributes` or `.git/info/attributes` changed since your review. Settings git writes itself, such as an upstream branch, do not count. Run `/trust` and review the project again.
- `marcsh now also reviews project commands and git settings: run /trust to use them.` You trusted the project with an earlier version of marcsh, which reviewed only the pi files. The pi files stay trusted; run `/trust` to review the rest.

### `marcsh run` or `marcsh mcp list` says the pi files changed

`marcsh: this project's pi files changed since you trusted them, so pi does not load them: run marcsh and /trust`. Nobody can be asked without the interface, so the run goes on without the project's pi files. Open marcsh in the project and run `/trust` (or answer the trust question of the next pi turn).

## Packs and agents

### `<url> was not found, or it is private: marcsh installs public repositories only`

A pack install failed because GitHub could not find the repository, or because it needs a login. marcsh installs public repositories only. Check the name of the repository, and that it is public. See [Packs](packs.md).

### `git could not run: …`

Installing a pack needs `git` on your `PATH`. Install `git` and try again.

### `Pack rejected: …`

The pack broke one of marcsh's rules and nothing was kept. The text after the colon says which one. See [What marcsh rejects](building-a-pack.md#what-marcsh-rejects). `Install cancelled` only means you pressed `Esc` while the pack downloaded.

### Hooks turned off after a change

When the files of a pack's hooks change, for example after an update, the hooks you approved before stop running until you approve them again. You can see these messages:

- `<pack>: hooks are off because their files changed since you approved them; review them with /agents hooks <pack>`
- `<pack>: hooks are off for this turn because their files no longer match what you approved. Review them with /agents hooks <pack>`
- `Hooks turned off; review them again with /agents hooks <pack>`, after you update a pack.

Run the `/agents hooks <pack>` command from the message, read the commands and enable the hooks again if you accept them. See [Pack hooks](pack-hooks.md).

### A toast that starts with `Warning:` when I select an agent

The agent still works, but marcsh skips something it can't apply. See [Agents → Warnings](agents.md#warnings) for what each message means.
