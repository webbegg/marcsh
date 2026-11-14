# Commands

Type `/` in the prompt to run a command. This page lists every marcsh command, how to write your own, the commands that ship with marcsh, how other `/name` input is handled, and the keyboard shortcuts.

## Using the command menu

### Run a command

- Type `/` at the start of the prompt. The menu opens as soon as the text starts with `/` and has no space yet.
- Press `Up` and `Down` to move the highlight. Press `Enter` or click a row to run it. `Enter` runs the highlighted row, not the exact text you typed: `/mod` and `Enter` runs `/models`.
- Press `Esc` to close the menu. Your text stays.

Picking a command that is not one of marcsh's own (for example one from the engine) puts `/name ` in the prompt. Add what it needs and press `Enter`.

`/agents`, `/rename` and `/export` take arguments. For the other commands, text after the name is ignored.

The commands that work on the open session (`/rename`, `/fork`, `/export`, `/undo`, `/redo`, `/diff`, `/compact` and `/copy`) are listed in the menu only inside a session. Typed on the home screen they say "/name works inside a session. Open one first." and nothing is sent.

`Ctrl+P` opens the command palette, a searchable list of every command, and `Ctrl+X` followed by a key runs a command without it. Both can be changed. See [Keybinds](keybinds.md).

Most commands open a dialog. In a dialog, type to search, use `Up` and `Down` to move, `Enter` to choose and `Esc` to close.

### How the menu filters

- Keep typing to filter. The letters you type must appear in the command name in that order, so `/mo` finds `/models` and `/ss` finds `/sessions`. Case does not matter. Better matches come first.
- With nothing after the `/`, marcsh's own commands come first, then the engine's commands sorted by name.
- The menu shows at most 10 rows and scrolls.
- The right-hand column shows where a command comes from: `claude` for the Claude engine's commands and for the bundled `marcsh:` entries on Claude, `extension`, `prompt` or `skill` on pi. your own [custom commands](#custom-commands) show `personal` or `project`. marcsh's own commands have no tag.
- When nothing matches, the menu says "No matching commands". `Enter` then sends your text as typed.

## marcsh commands

### /new

Start a new conversation.

```
/new
```

- Goes back to the home screen. Your next message starts a new session.
- The conversation you left is kept. Open it again with [/sessions](#sessions).

### /agents

Switch agents, and install, update or remove packs.

```
/agents
/agents install <owner/repo[@ref]>
/agents update [<owner/repo>]
/agents remove <owner/repo>
/agents hooks [<owner/repo> [off]]
```

- `/agents` opens "Select Agent". It lists Build, Plan, your own agents and the agents of installed packs. The current one has a bullet. Choose one to switch. The list is read again each time, so an agent you just added shows up without a restart.
- The last rows of the dialog do the same as the subcommands: "Install from GitHub…", "Update packs…", "Remove a pack…" and "Pack hooks…".
- `/agents install owner/repo` fetches a pack from GitHub and shows what it holds before anything is installed. Add `@ref` to follow a branch or tag.
- `/agents update` lets you pick a pack. `/agents update owner/repo` updates that one.
- `/agents remove owner/repo` removes a pack.
- `/agents hooks` lets you pick a pack and review its hooks. `/agents hooks owner/repo` reviews that pack. `/agents hooks owner/repo off` turns its hooks off without asking.
- `update`, `remove` and `hooks` take `owner/repo` without `@ref`. A pack that is not installed gives "owner/repo is not installed". A pack without hooks gives "owner/repo has no hooks".
- A typo in the subcommand, a missing or extra word, or an invalid `owner/repo` shows this line. For an invalid `owner/repo`, the reason comes first:

```
Usage: /agents install <owner/repo[@ref]> | update [<owner/repo>] | remove <owner/repo> | hooks [<owner/repo> [off]]
```

You can also switch agents with `Tab`. See [Packs](packs.md) for installing and updating, [Pack hooks](pack-hooks.md) for hooks, and [Agents](agents.md) for writing your own.

### /models

Select the AI model.

```
/models
```

- The list depends on the engine of the current session, or of new sessions on the home screen.
- On Claude it offers `opus`, `sonnet` and `haiku`. The default is `opus`. The choice is used for your next messages and is not kept after you quit.
- On pi it lists the models of providers you have signed in to, as `provider/id`. After you choose, marcsh shows "pi will use provider/id" and remembers the choice.
- On pi with no login, you see "No pi model is available yet. Run /login to sign in to a provider."

See [Engines and models](engines-and-models.md).

### /login

Sign in to a pi provider with a subscription or an API key.

```
/login
```

- Opens "Log in" with the list of providers. A check mark shows the ones you are already signed in to.
- Choose a provider and follow the steps in the dialog. Depending on the provider, you open a link, enter a code, or paste an API key. Pasted keys and codes show as dots.
- A subscription sign-in reminds you to check your plan's terms. See [Engines and models](engines-and-models.md#pi-login).
- `Esc` cancels the login and shows "Login to NAME cancelled".
- On success you see "Logged in to NAME" or "Saved API key for NAME".
- `/login` works from a Claude session too. It manages the logins that pi uses.

### /logout

Remove a pi provider login.

```
/logout
```

- Lists the logins you made with `/login`. Choose one to remove it.
- Environment variables are not touched. A subscription login shows "Logged out of NAME", and an API key login shows "Removed stored API key for NAME. Environment variables are unchanged." With no stored login you see "No pi logins to remove. /logout only removes logins made with /login; environment variables are unchanged."

### /trust

Trust or distrust this project's pi files.

```
/trust
```

- Opens "Project Trust" with three choices: "Don't trust", "Trust" and "Forget".
- A change applies from the next turn.

See [Security](security.md#change-a-decision-trust) for what each choice does, the review list and the keys, and for what trusting a project allows.

### /engine

Choose the engine for new sessions.

```
/engine
```

- Opens "Select Engine" with `Claude (Agent SDK)` and `pi`. The current one has a bullet.
- After you choose, marcsh shows "New sessions will use Claude (Agent SDK)" or "New sessions will use pi" and remembers the choice.
- Sessions that already exist keep the engine they started with.

See [Engines and models](engines-and-models.md).

### /sessions

Browse past sessions.

```
/sessions
```

- Opens "Sessions" with your past sessions. Type to filter by title. Each row shows the clock time of its last update, without a date.
- Choose one to open it.
- `Ctrl+D` deletes the highlighted session, after a question that names it. The first answer, "Keep it", is the one selected. Deleting the session you have open takes you home.

See [Sessions](sessions.md).

### /rename

Rename this session.

```
/rename <title>
```

- Sets the title shown in [/sessions](#sessions). Runs of spaces become one space, and terminal control characters are removed.
- Without a title you see "Usage: /rename <title>". The session keeps its place in the recent list.

### /fork

Continue in a copy of this session.

```
/fork
```

- Creates a new session titled "<title> (fork)" with the messages saved so far, and opens it at once. The original is untouched.
- The copy does not carry the engine's own reference to the conversation, so its first turn starts a fresh engine conversation. The engine is told the earlier messages as a transcript. See [Sessions](sessions.md#rename-fork-export-and-delete).
- Not available while a turn is running.

### /export

Save this session as a file.

```
/export [md|json] [path]
```

- With no arguments, writes markdown to `marcsh-<first 8 characters of the session id>-<YYYY-MM-DD>.md` in the session's project folder.
- `md` writes a readable transcript, `json` a structured one (`version`, `session`, `messages`). Reasoning is left out of both.
- A relative path is relative to the session's project folder, and `~/` is your home folder. The folder must exist.
- An export never overwrites: when the file exists, `-1`, `-2`, … is added before the extension. The toast says where it was written ("Exported to …").

### /undo

Put back the files the last turn changed.

```
/undo
```

- Restores, to how they were before the turn, only the files that the newest turn with a snapshot that is not yet undone changed, and deletes the ones that turn created. Repeat it to go back one turn at a time.
- The conversation is not rewound: the engine's history cannot be cut, so the model still remembers what it did. A line is added to the chat that names the restored and deleted files.
- If you changed one of those files after the turn, marcsh lists them and asks before overwriting. "Keep my changes" is the first, selected answer.
- A turn that changed no files is passed over and the one before it is undone; the chat line says how many were passed.
- It says why when it cannot help: no git ("File undo is unavailable: …"), a snapshot that failed or took too long, or a session with no snapshots.
- Not available while a turn is running. A failure (a path marcsh refuses to write, a disk error) is an error toast; the turn is then not marked undone.

See [Undo, redo and diff](sessions.md#undo-redo-and-diff) for how snapshots work.

### /redo

Re-apply the file changes `/undo` took back.

```
/redo
```

- Writes the turn's files as the turn left them, starting with the turn that was undone last.
- Starting a new turn after an undo ends the redo for the turns that were undone: they stay undone.
- Like `/undo`, it asks before overwriting a file you changed since.

### /diff

Show the files changed in this session.

```
/diff
```

- Opens a scrollable dialog with the changes between the project as it was before the session's first snapshotted turn and the files now, as unified diffs. Each file has a header (path, new file, deleted or modified, and the number of added and removed lines). Added lines are green, removed lines red.
- It compares with the files as they are now, so changes you made yourself are included, and an undone turn no longer shows.
- Scroll with `Up`, `Down`, `PageUp`, `PageDown`, `Home` and `End`. Past 3000 rows the rest is counted, not drawn.
- With nothing changed you see "No file changes since this session's first turn".

### /compact

Compact this session's context.

```
/compact
```

- On Claude it runs a turn whose prompt is `/compact`, which Claude Code handles itself.
- On pi it asks pi to summarize the older part of the conversation. The session is busy meanwhile (`Esc` cancels). The toast reports the tokens before and after, and the status line shows the smaller context until the next reply. No pi extension, skill or MCP server is loaded for this.
- A session with no conversation yet says "Nothing to compact yet". An engine that cannot compact says so.

### /copy

Copy the last reply to the clipboard.

```
/copy
```

- Copies the text of the last reply that has any (its text parts, one blank line apart; tool calls and reasoning are left out).
- On macOS it uses `pbcopy`. Anywhere else, or if `pbcopy` fails, it sends an OSC 52 sequence to the terminal; the toast then says so, because marcsh cannot tell whether your terminal allowed it (it works over SSH where the terminal supports it).

### /ps

Show this session's background terminals.

```
/ps
```

- On pi the agent can start a shell command that keeps running in the background, such as a dev server or a watcher. `/ps` lists them, newest first, with their status (`running`, `done`, `failed` or `killed`), title, command and runtime.
- `Up` and `Down` move. `Enter` opens the selected terminal's output. It is read-only and follows new output. `t` switches between stdout and stderr. `Left` goes back to the list.
- `x` kills the selected terminal, in the list and in the output view. The agent is told it was killed.
- The output view strips colors and other terminal codes. It shows the last 3000 lines; the full log file is named at the top.
- Background terminals stop when you leave the session or quit marcsh. On Claude, `/ps` says they run in pi sessions only.

### /subagents

Show this session's background subagents.

```
/subagents
```

- On pi the agent can start a subagent that keeps working in the background, with `Task` and `background: true`. `/subagents` lists them, newest first, with their status (`running`, `completed`, `failed` or `stopped`), description, tokens and cost, and runtime.
- `Up` and `Down` move. `Enter` opens the selected subagent's transcript: its prompt, then what it has said and done so far. It is read-only and follows the subagent live. `Up` and `Down` scroll. `Left` goes back to the list.
- `x` cancels the selected subagent, in the list and in the transcript. The agent gets its result as stopped.
- Background subagents stop when you leave the session or quit marcsh. On Claude, `/subagents` says they run in pi sessions only.

### /theme

Change the color theme.

```
/theme
```

- Opens "Select Theme". Moving the highlight previews each theme.
- `Enter` keeps the theme and remembers it. `Esc` goes back to the theme you had.

### /exit

Quit marcsh.

```
/exit
```

- Stops any running turn first, then quits. `Ctrl+C` quits the same way when nothing else is open.

## While a turn is running

### /queue

Queue a message to send after the current turn.

```
/queue <text>
```

- Works on pi, while a turn is running. Pressing `Alt+Enter` (`Option+Enter` on a Mac) does the same.
- Plain `Enter` while a turn runs sends the text as a steer, which reaches the running turn. The status line shows "enter steers · alt+enter queues".
- Queued messages show as "queued" and steers as "↳ steer · pending" until pi takes them.
- While the turn is still starting or ending, the text stays in the prompt and nothing is sent.
- When no turn is running, `/queue` is not a command. The text is sent as an ordinary message.
- A Claude session does not take input during a turn. Use `Esc` to interrupt it.

See [Typing while the agent works](screen.md#typing-while-the-agent-works) for the details, including the macOS Terminal setting that makes `Option+Enter` work.

## Other `/name` input

Any text that starts with `/` and is not one of the commands above is sent as your message, exactly as you typed it, with its arguments.

- On Claude it goes to Claude, which runs its own commands and skills.
- On pi it goes to pi, which expands its prompt templates and skills and runs its extension commands.

The `/` menu lists the commands and skills of the engine you are on. The list is read when you open the menu.

marcsh's own names always win. An engine command with the same name as one of the commands above does not appear in the menu.

Your [custom commands](#custom-commands) are the exception: marcsh expands them itself before sending.

## Custom commands

A custom command is a Markdown file. Its name becomes a `/name` command, and its text is the prompt that is sent.

| Where | Name of the command | Works in |
|---|---|---|
| `~/.marcsh/commands/review.md` | `/review` | every project |
| `<project>/.marcsh/commands/review.md` | `/review` | that project, once you trust it |

Save this as `~/.marcsh/commands/review.md`:

```markdown
---
description: Review a file for bugs
agent: reviewer
model: sonnet
---
Review $1 for bugs and unclear names.
Pay special attention to: $ARGUMENTS
```

Then type:

```
/review src/app.ts error handling
```

The chat shows the expanded prompt as your message, and that is what the engine receives:

```
Review src/app.ts for bugs and unclear names.
Pay special attention to: src/app.ts error handling
```

### The file

- The name is the file name without `.md`. It must match `[a-z0-9][a-z0-9-_:]*` (lowercase letters, digits, `-`, `_` and `:`, starting with a letter or digit). A file with any other name is skipped.
- The text after the frontmatter is the prompt. A file with no prompt is skipped. Files over 256 KB are skipped.
- Frontmatter is optional. These fields are read:
  - `description`: the text in the `/` menu. Without it, the first line of the prompt is shown.
  - `agent`: the agent to run the turn as, by ID (`user/reviewer`, `plan`) or by name. An unknown agent is reported and the selected agent is used.
  - `model`: the model for the turn. If the engine cannot use it (a pi model such as `openai/gpt-5` on Claude, or the reverse), it is reported and the session model is used.
- `agent` and `model` apply to that turn only. The next message runs as the selected agent on the session model.

### Arguments

| Placeholder | Becomes |
|---|---|
| `$ARGUMENTS` | everything you typed after the command name |
| `$1` to `$9` | the first to ninth word of it, split on spaces; empty when you gave fewer |

- Arguments are used only where the file names them. A file with no placeholder sends the prompt as written.
- Text inside your arguments is never expanded again, so an argument that contains `$1` stays as typed.
- `$0`, `$10` and a lone `$` are plain text (`$10` is `$1` followed by `0`).

### Where they show and which one wins

- They appear in the `/` menu with the tag `personal` or `project`. The files are read when the menu opens, so a new file shows up without a restart. Picking one puts `/name ` in the prompt; add the arguments and press `Enter`.
- marcsh's own commands win a name clash: a `new.md` file is ignored. A command of yours also replaces an engine command with the same name.
- A project command replaces a personal one with the same name.
- To change where personal commands are read from, set `MARCSH_COMMANDS_DIR`.

### Project commands and trust

A project's commands are text from that project, so they are loaded only when you have trusted the project (see [`/trust`](#trust) and [Security](security.md#change-a-decision-trust)). In a project you have not trusted, or have not decided about, only your personal commands load, and a typed `/name` that matches only a project command is sent as typed.

Messages typed while a turn is running (steers and `/queue`) are sent as typed and do not expand custom commands.

## Bundled commands and skills

marcsh ships a small plugin. Its entries show in the `/` menu on both engines, with the prefix `marcsh:`. Type the full name, then your request:

```
/marcsh:feature my-feature
/marcsh:workflow add a retry to the upload step
/marcsh:agent-workflows help me write a reviewer agent
```

These entries are available whichever agent is selected.

### /marcsh:feature

Create or resume the feature doc for a large change.

```
/marcsh:feature <feature-name>
```

- A feature doc is a plain Markdown file that keeps the specs, tasks and log of a change, so you can resume after a long pause.
- The doc lives at `~/.marcsh/work/<project>/<feature-name>.md`, outside your repository on purpose. `<project>` is the name of the Git repository folder, or of the current folder when there is no repository.
- If the doc does not exist, marcsh creates it with the sections Specs, Tasks and Log, quoting your words in the first spec. It shows you the path and the specs and waits for your go-ahead before writing code.
- If the doc exists, marcsh reads it, tells you where things stand, and continues with the next unfinished task.
- With no name, it asks for one (short, kebab-case).

### /marcsh:workflow

Pick the right lane for a code change and prove it works.

```
/marcsh:workflow <what you want changed>
```

For example, ask for a change like this and marcsh picks the lane:

```
/marcsh:workflow add a retry to the upload step
```

- For a change that is clear and small, the lane is "small": work inline, write a failing test first when one applies, run the tests, and end with a one-line risk note.
- For a change that spans sessions, has open decisions or ships in parts, the lane is "large": it starts with `/marcsh:feature` and does not mark a task done without observed proof.
- Its description tells the model to use it for any request to change code, so you do not have to type the command.
- Commits, pushes and publishes are guarded. See [Security](security.md#git-guard).

### /marcsh:agent-workflows

Create, edit, share or install your own agent or workflow.

```
/marcsh:agent-workflows <what you want>
```

- Helps you write an agent file (a role prompt and a permission level) that you select with `Tab` or `/agents`.
- Walks through drafting the prompt, saving it as a personal agent in `~/.marcsh/agents/`, testing it, and optionally turning it into a pack on GitHub that others install with `/agents install`.
- Ends with a checklist before you share a pack.

See [Agents](agents.md) and [Building a pack](building-a-pack.md) for the details the skill follows.

## Keyboard shortcuts

| Keys | What they do |
| --- | --- |
| `Enter` | Send the message. In a menu, choose the highlighted row. During a pi turn, steer the turn. |
| `Shift+Enter` | Add a new line. |
| `Alt+Enter` (`Option+Enter` on a Mac) | During a pi turn, queue the message. Same as `/queue`. |
| `Tab` | Switch to the next agent: Build, Plan, your own agents, then agents from installed packs, then back to Build. |
| `Esc` | Close a menu or dialog. Stop a running reply. This also declines an approval prompt or question that is waiting, except in a question's free-text field (it only closes the field) and on the project-trust question (it means "not now"). |
| `Ctrl+C` | Close the open menu or dialog. If there is none, clear the text in the prompt. If the prompt is empty, quit: marcsh stops any running reply first and waits a few seconds for it to finish. |
| `Ctrl+P` | Open the command palette. See [Keybinds](keybinds.md). |
| `Ctrl+X`, then a key | Run a command (`Ctrl+X` `n` is `/new`). The status line shows the leader is waiting; it ends after 2 seconds. See [Keybinds](keybinds.md). |
| `@` | Mention a file or folder. See below. |
| `Up` / `Down` | Move the highlight in the command menu, the `@` menu and dialogs. |
| `Ctrl+D` | In the `/sessions` dialog, delete the highlighted session after a confirmation. |

The keys for approval prompts (`y`, `a`, `n`) are in [The screen](screen.md#approving-tool-calls). The keys for the trust list (`t`, `d`) are in [Security](security.md#project-trust).

### Mentioning files with `@`

Type `@` and the start of a path to list files and folders of the project.

- In the folder you are typing in, folders are listed before files. Hidden files show only when the name you type starts with a dot.
- `Up` and `Down` move, `Enter` inserts the highlighted path, `Esc` closes the menu. You can also click a row.
- A folder is inserted with a trailing `/` so you can keep going inside it. A file is inserted followed by a space.
- If nothing in the project folder starts with what you typed, marcsh looks in subfolders (skipping `node_modules`) and shows up to 32 matches, sorted by path.
- The menu can only complete names made of letters, digits, `.`, `_`, `-` and `/`. A name with a space or a non-ASCII character cannot be picked from the menu.
- With no match, the menu says "No matching files or folders".
- An `@` right after a letter, digit or path character (as in an email address) does not open the menu.
- Only paths inside the project folder are offered. The path is inserted into your message as text.

### Attaching files and images

Paste or drop a file into the prompt of a session and it goes with your next message. Terminals paste a dropped file as its path; marcsh accepts it plain, in quotes, with `\ ` escapes for spaces, or as a `file://` address. You can paste several files at once (up to 32).

- **Images** (PNG, JPEG, GIF, WebP) and **PDFs** show above the prompt as `[image: name.png]` or `[pdf: name.pdf]`. They are sent with the next message and shown under it in the chat. They can be up to 20 MB each.
- **Other files** are inserted into the prompt as an `@path` mention (the same form the `@` menu inserts), relative to the project folder when the file is inside it.
- **Send** with `Enter`. A message can be only attachments, with no text. After it is sent the chips are cleared.
- **Remove** the last chip with `Backspace` when the prompt is empty. `Ctrl+C` on an empty prompt clears all of them.
- Text that is not a path, or a path that does not exist, is pasted as ordinary text. A bare name such as `package.json` is also ordinary text; write `./package.json` or paste the full path to attach it. Relative image and PDF names (`shot.png`) are looked up in the project folder.
- An image or PDF over 20 MB, or one that cannot be read, is not attached, and a message says why ("shot.png is larger than 20 MB, so it was not attached."). The file is read when you send, not when you paste. If it has gone by then, it is sent as an `@path` mention and a message says so.

How each engine takes them:

| Engine | Images | PDFs |
| --- | --- | --- |
| Claude | Sent as image input with your message. | Sent as a document with your message. |
| pi | Sent as image input when the model takes images. Otherwise sent as an `@path` mention, with the message "This model cannot take images as input, so shot.png goes as an @path reference." | Sent as an `@path` mention, with the message "This engine cannot take PDFs as input, so spec.pdf goes as an @path reference." |

Attachments work inside a session. On the home screen a pasted path is ordinary text. Only the path, the type and the kind are saved with the session, never the file's contents, and `/export` lists them under your message.
