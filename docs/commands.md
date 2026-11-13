# Commands

Type `/` in the prompt to run a command. This page lists every marcsh command, the commands that ship with marcsh, how other `/name` input is handled, and the keyboard shortcuts.

## Using the command menu

### Run a command

- Type `/` at the start of the prompt. The menu opens as soon as the text starts with `/` and has no space yet.
- Press `Up` and `Down` to move the highlight. Press `Enter` or click a row to run it. `Enter` runs the highlighted row, not the exact text you typed: `/mod` and `Enter` runs `/models`.
- Press `Esc` to close the menu. Your text stays.

Picking a command that is not one of marcsh's own (for example one from the engine) puts `/name ` in the prompt. Add what it needs and press `Enter`.

Only `/agents` takes arguments. For the other commands, text after the name is ignored.

Most commands open a dialog. In a dialog, type to search, use `Up` and `Down` to move, `Enter` to choose and `Esc` to close.

### How the menu filters

- Keep typing to filter. The letters you type must appear in the command name in that order, so `/mo` finds `/models` and `/ss` finds `/sessions`. Case does not matter. Better matches come first.
- With nothing after the `/`, marcsh's own commands come first, then the engine's commands sorted by name.
- The menu shows at most 10 rows and scrolls.
- The right-hand column shows where a command comes from: `claude` for the Claude engine's commands and for the bundled `marcsh:` entries on Claude, `extension`, `prompt` or `skill` on pi. marcsh's own commands have no tag.
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

See [Sessions](sessions.md).

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

See [Typing while the agent works](getting-started.md#typing-while-the-agent-works) for the details, including the macOS Terminal setting that makes `Option+Enter` work.

## Other `/name` input

Any text that starts with `/` and is not one of the commands above is sent as your message, exactly as you typed it, with its arguments.

- On Claude it goes to Claude, which runs its own commands and skills.
- On pi it goes to pi, which expands its prompt templates and skills and runs its extension commands.

The `/` menu lists the commands and skills of the engine you are on. The list is read when you open the menu.

marcsh's own names always win. An engine command with the same name as one of the commands above does not appear in the menu.

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
| `Esc` | Close a menu or dialog. Stop a running reply. This also declines an approval prompt or question that is waiting. |
| `Ctrl+C` | Close the open menu or dialog. If there is none, clear the text in the prompt. If the prompt is empty, quit: marcsh stops any running reply first and waits a few seconds for it to finish. |
| `@` | Mention a file or folder. See below. |
| `Up` / `Down` | Move the highlight in the command menu, the `@` menu and dialogs. |

The keys for approval prompts (`y`, `a`, `n`) are in [Getting started](getting-started.md#approving-tool-calls). The keys for the trust list (`t`, `d`) are in [Security](security.md#project-trust).

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
