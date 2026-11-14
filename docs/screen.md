# The screen

This page describes what you see in marcsh and what each part does: the two screens, the input, the status line, toasts and the prompts that interrupt you. For your first task, see [Getting started](getting-started.md). For the full list of keys, see [Commands](commands.md#keyboard-shortcuts).

## The screens

**Home.** The first screen. It shows the marcsh logo, the input and a `tab agents` hint. Your first message starts a new session and opens the session screen.

**Session.** The conversation. Your messages and the agent's replies scroll above the input. The agent's replies show its thinking, the tools it calls and the text it writes. While a reply runs, the bottom line shows a spinner and `esc to interrupt`. Type `/new` to go back to the home screen, or `/sessions` to open an earlier conversation. See [Sessions](sessions.md).

## The input

| Key | What it does |
| --- | --- |
| `Enter` | Sends your message. In a menu, it picks the highlighted item. |
| `Shift+Enter` | Adds a new line. |
| `/` | Opens the command menu. Keep typing to filter it. |
| `@` | Opens the file picker. |

Type `/` at the start of the input to open the command menu. See [Commands](commands.md) for how it works and for the full list.

## File mentions

Type `@` followed by the start of a file or folder name, for example `@src/`. A list of matches appears. Use `Up` and `Down` and `Enter` to insert one, or `Esc` to close the list.

- Paths are relative to the project folder. Absolute paths and paths outside the folder find nothing.
- Folders end with `/`, so you can keep typing to go deeper.
- Hidden names (starting with `.`) only show up once you type the `.`.
- If nothing matches directly in the current folder, marcsh looks in subfolders, skipping `node_modules`.

marcsh puts the path in your message as text. The agent reads the file itself. See [Commands](commands.md#mentioning-files-with-) for more.

## Typing while the agent works

On a pi session you can keep typing while a reply runs. Say the agent is rewriting a file and you notice it should use a helper that already exists. Type `use the existing helper instead` and press `Enter`.

- `Enter` sends your text into the running turn. It shows as `↳ steer`, and the agent sees it before its next step.
- `Alt+Enter` (`Option+Enter` on a Mac) queues your text. It is sent as its own message when the agent has nothing else to do, and shows as `queued`.
- `/queue your text` does the same as `Alt+Enter`. Use it if your terminal cannot send `Alt+Enter`. On macOS Terminal, turn on "Use Option as Meta key" to make `Option+Enter` work.

The hint next to the status line tells you what the keys do right now, for example `enter steers · alt+enter queues`. If the turn is starting or ending, the hint says so and nothing is sent. The text stays in the input. Press `Enter` again when the hint is gone.

On a Claude session the input is off while a reply runs. Wait for the reply, or press `Esc` to stop it.

## Background results

On a pi session the agent can leave work running in the background, such as a shell command started with `bg_start` (a background terminal). `/ps` lists the background terminals and shows their output (see [Commands](commands.md#ps)). When the work finishes, its result goes to the agent once:

- If a reply is running, the result joins it. The agent sees it before its next step.
- If the session is idle, marcsh starts a turn for it, as the agent and model selected at that moment.

Either way the conversation shows one line per result, `[background] <title> finished`, marked `background`. The output itself goes to the agent, not to the screen. Results that finish together arrive as one message.

Text you typed or queued is never replaced: a result waits while an approval, a question or a compaction is open, or while a turn is starting. After you stop a reply with `Esc`, results wait too, until the next turn ends or another result finishes. If the agent already read a result with a tool, it is not sent again.

## Stopping and quitting

- `Esc` stops a running reply. It also declines an approval prompt or a question that is waiting. Two cases differ. In a question's free-text field, `Esc` only closes the field. On the project-trust question, `Esc` means "not now": the turn goes on without the project's files.
- `Ctrl+C` clears the input if it holds text, and closes a menu or dialog if one is open. On an empty input it quits marcsh. marcsh stops any running reply first and waits a few seconds for it to finish. When the input is off, `Ctrl+C` quits at once, even if text is typed. The input is off while a prompt waits, and on a Claude session while a reply runs.
- `/exit` also quits.

## The status line

The status line sits under the input:

```
Build › anthropic/claude-opus-5-5 · pi v1.5.0
```

It shows, from left to right:

- The agent you are using. Press `Tab` to change it. The order is Build, Plan, your own agents, then agents from installed packs, then back to Build. See [Agents](agents.md).
- The model. On Claude it is `opus`, `sonnet` or `haiku`. On pi it is `provider/model-id`.
- The engine: `claude`, or `pi` with its version.
- The usage, once the engine reports it: tokens in context, the share of the context window, the session cost, and the speed of the latest reply, for example `42.1k/200k (21%) · $0.34 · 42 tok/s`. The speed is the reply's average, so time spent in tools counts too.
- The git branch and how many files changed, for example `main · 3 files changed`. A detached HEAD shows its short commit SHA. marcsh checks about every 3 seconds and after each tool call. Outside a git repo nothing is shown.
- On pi, while background terminals run, how many, for example `2 background terminals running · /ps`.
- A hint, when the keys do something unusual right now.

When the line is too narrow, the background terminals go first, then the usage, then the git part. The engine always stays.

On pi it can also say:

- `no model · run /login`: no model has a sign-in yet. Run `/login`.
- `pi unavailable`: marcsh could not check pi's models. See [Troubleshooting](troubleshooting.md).

## Toasts

Short messages called toasts appear in the top right corner for a few seconds. They confirm something (`New sessions will use pi`), report an error, or warn you. Warnings start with `Warning:`. For example, selecting an agent that uses a feature your engine does not have shows a warning. See [Agents](agents.md).

## Approving tool calls

By default the Build agent asks before it edits files or runs commands. [Security](security.md#what-asks) lists what asks on each engine. A prompt appears above the input. It shows the tool and what it will do. Answer with one key:

| Key | Meaning |
| --- | --- |
| `y` | Allow this call once. |
| `a` | Always allow. What this covers depends on the engine, see [Security](security.md#what-always-allow-covers). |
| `n` | Deny it. The agent is told you said no. |
| `Esc` | Deny it and stop the reply. |

Some prompts are stricter and offer no `a`. If the prompt says `y allow once (then Enter)`, press `y`, then `Enter` to confirm.

The prompt waits until you stop typing, so a message you are writing cannot answer it by accident. See [Typing protection](#typing-protection).

## Typing protection

The approval prompt ignores your keys until you have stopped typing for a moment, and says `waiting for typing to stop…` meanwhile. This keeps a message you are typing from answering the prompt by accident. If the prompt opens while you are typing, it is locked. It says `you were typing: press ↓ to answer`. Press `Down`, then answer. The keys for the prompt are in [Approving tool calls](#approving-tool-calls).

## Questions

Sometimes the agent asks you a question with a few options. Press a number to pick an option. Press `o` to type your own answer, then `Enter` to send it (`Esc` goes back to the options). When a question allows several answers, the numbers toggle options and `Enter` confirms. `Esc` declines to answer and stops the reply.

## Themes

Type `/theme` to pick a color theme. The colors change as you move through the list. Press `Enter` to keep a theme, or `Esc` to go back to the one you had. marcsh remembers your choice.
