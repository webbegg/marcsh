# Command line

marcsh starts the interface, or runs one turn without it. `marcsh --version` prints the version and `marcsh --help` lists the commands and options. Neither starts marcsh or touches `~/.marcsh`.

```
marcsh [dir] [options]
marcsh run [message...] [options]
```

A wrong option or value prints the error with the usage and exits with code `2`. `run` is a command only as the first word; to start the interface in a folder named `run`, write `marcsh ./run`. `--` ends the options, so what follows is plain words.

## Start the interface

`marcsh [dir]` starts the interface in `dir`, or in the current folder. A relative `dir` is taken from where you ran the command. If `dir` is not a directory, marcsh prints `marcsh: "<dir>" is not a directory` and exits with `2`. The folder you start in is the project folder of new sessions, as described in [Sessions](sessions.md).

| Option | What it does |
| --- | --- |
| `-c`, `--continue` | Opens the most recent session of this folder (the one updated last). A folder with no session opens the home screen. |
| `-s <id>`, `--session <id>` | Opens the session with this id. An id nobody has prints `marcsh: no session with id "<id>"` and exits with `2`. |
| `--engine claude\|pi` | The engine new sessions use on this launch. It is not saved: the engine you chose with `/engine` stays as it was. Choosing an engine in the interface replaces it. An opened session keeps its own engine. |

`--continue` and `--session` cannot be used together. A session opened this way has the home screen behind it, so leaving it takes you home.

## Run one turn: `marcsh run`

`marcsh run [message...]` sends the message, waits for the turn to end, and prints the reply. The words after `run` are the message. They are joined with spaces, so quote anything the shell would change.

```
marcsh run explain the failing test
marcsh run --agent plan "what does src/index.tsx do?"
git diff | marcsh run "review this diff"
marcsh run -c "now fix it"
```

When standard input is not a terminal, its text is added to the message after a blank line. It can also be the whole message. If marcsh has no message at all, it prints `marcsh: no message: pass it as arguments or on standard input` and exits with `2`. A pipe that never closes makes `run` wait.

The session is saved like an interface session: it has a title (the first 100 characters of the message), the project folder you ran it in and an engine, and you can open it later with `/sessions`, `marcsh -c` or `marcsh -s <id>`.

| Option | What it does |
| --- | --- |
| `-c`, `--continue` | Continues the most recent session of this folder. A folder with no session starts a new one. |
| `-s <id>`, `--session <id>` | Continues the session with this id. An id nobody has is a usage error (exit `2`). |
| `-m <model>`, `--model <model>` | The model for this turn. Without it, the agent's own model is used when the engine can use it, else the model new sessions use (see [Engines and models](engines-and-models.md)). |
| `--agent <name>` | The agent, by its id or its name. Without it, the agent you selected in the interface. An unknown name is a usage error (exit `2`). |
| `--engine claude\|pi` | The engine of a new session; the default is the engine new sessions use. A session you continue keeps its own engine, and marcsh says on stderr that `--engine` was ignored. |
| `--format text\|json` | `text` (default) or `json`, below. |

### Output

With `--format text`, standard output holds the final text of the reply and a newline: what the agent said after its last tool call, without its thinking. Everything else goes to standard error: errors, notices from the engine and the denials below. A turn that said nothing prints nothing.

With `--format json`, standard output is JSON Lines: one object per engine event, then a last `result`. The events are:

| `type` | Fields |
| --- | --- |
| `session` | `ref`: the engine's reference to the conversation |
| `reply` | `parts`: the whole reply so far, as the message parts the interface shows (text, reasoning, tool and task parts) |
| `commands` | `commands`: the engine's command list |
| `error` | `message` |
| `queue`, `delivered`, `input-closed` | what the engine reports about queued messages |

The last line is `{"type":"result","ok":…,"exitCode":…,"sessionId":"…","text":"…"}`. `text` is the final text as above. A failed turn adds `error`, with the messages joined by newlines. Standard error carries the same diagnostics as in the text format.

### Permissions: nobody to approve

A headless turn has nobody to answer, so marcsh never asks:

- **Every permission ask is denied.** For each one, a line `marcsh: denied <tool> (headless runs cannot ask for approval)` goes to standard error. The agent is told the tool was denied and goes on.
- **Questions and dialogs are declined**, including the agent's questions to you and the dialogs of pi extensions.
- **Project trust answers "skip"**, so pi does not load a project's own pi files for this turn. A project you trusted before stays trusted.
- **Tools that do not ask still run.** Reads (and, on pi, `grep`, `find` and `ls`) need no approval. A command or a tool you chose to *always allow* in the interface is still allowed, because those decisions are checked before anything is asked; on Claude, Claude Code's own permission settings apply. The Plan agent only reads.

So a headless turn can read your project but cannot write files or run new commands unless a rule already allows them. There is no option yet that approves on its own.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The turn ended well. |
| `1` | The turn failed (an error from the engine or the model, an unknown engine in the session, or the session could not be saved). |
| `2` | Wrong usage: an unknown option or value, no message, an unknown session or agent. Nothing was started. |
| `130` | `Ctrl+C` (or `SIGINT`) stopped the turn. marcsh saves what was said, with tools still running marked as interrupted, and prints no reply. `SIGTERM` and `SIGHUP` do the same with `143` and `129`. |
