# Command line

marcsh starts the interface, runs one turn without it, or does one job and exits. `marcsh --version` prints the version and `marcsh --help` lists the commands and options. Neither starts marcsh or touches `~/.marcsh`. `marcsh <command> --help` prints the help of one command.

```
marcsh [dir] [options]
marcsh run [message...] [options]
marcsh session list|delete|export ...
marcsh models [--engine claude|pi]
marcsh mcp list|add ...
marcsh stats [--days N] [--json]
marcsh upgrade [--version vX]
```

A wrong option or value prints the error with the usage and exits with code `2`. `run`, `session`, `models`, `mcp`, `stats` and `upgrade` are commands only as the first word; to start the interface in a folder with one of these names, write `marcsh ./models`. `--` ends the options, so what follows is plain words.

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

- **It always runs in `normal` [permission mode](security.md#permission-modes).** `marcsh run` does not read the `approvalMode` you saved with `/permissions default`, so a saved `auto` or `yolo` never lets an unattended run edit files or commit without approval. The mode line is not added to the agent's prompt either. Only the interface starts in your saved mode.

A headless run denies *asks*; it does not turn off rules you already granted. A pi "always allow" rule and a Claude settings allow rule still apply, so a headless turn can use a tool you allowed before. Check what you allowed before you run `marcsh run` on a project you do not know.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The turn ended well. |
| `1` | The turn failed (an error from the engine or the model, an unknown engine in the session, or the session could not be saved). |
| `2` | Wrong usage: an unknown option or value, no message, an unknown session or agent. Nothing was started. |
| `130` | `Ctrl+C` (or `SIGINT`) stopped the turn. marcsh saves what was said, with tools still running marked as interrupted, and prints no reply. `SIGTERM` and `SIGHUP` do the same with `143` and `129`. |

## Sessions: `marcsh session`

The saved sessions (the ones `/sessions` lists), from the shell. They use the same database as the interface, which `MARCSH_DB_PATH` moves (see [Configuration](configuration.md)).

```
marcsh session list [--json]
marcsh session delete <id>
marcsh session export <id> [--format md|json] [-o file] [--force]
```

- **`list`** prints one line per session, newest first: the id, the time of the last update, the project folder and the title. `--json` prints an array of `{ id, title, cwd, createdAt, updatedAt }` with ISO dates instead. With no session it prints `No sessions.` (or `[]`).
- **`delete <id>`** deletes that one session for good, without asking. Its trust decisions and permission rules stay. An id nobody has prints `marcsh: no session with id "<id>"` and exits with `1`.
- **`export <id>`** prints the session as a transcript on standard output: markdown by default, or `--format json`. It is the same transcript as `/export`: thinking is left out and tool calls are summarized. An unknown id exits with `1`.
  - `-o <file>`, `--output <file>` writes it to a file and prints `Wrote <file>` instead. If the file exists, marcsh refuses and exits with `1`; `--force` replaces it. If `-o` names a folder, the file inside it is called `marcsh-<first 8 characters of the id>-<date>.<md|json>`.

Ids must be written in full, as `list` prints them.

## Models: `marcsh models`

`marcsh models` lists the models you can choose, by engine.

```
marcsh models [--engine claude|pi]
```

- **Claude** has three aliases: `opus`, `sonnet` and `haiku`.
- **pi** has the models of its catalogue and your `models.json`, as `provider/id` followed by the name. A `*` marks the models whose provider has credentials (a login made with `/login`, or an environment variable); the model dialog in the interface lists only those. See [Engines and models](engines-and-models.md).

With `--engine` only that engine is listed, one model per line. Without it both are, under their names. If pi's models cannot be read, marcsh prints why on standard error, still lists the Claude models and exits with `1`.

## MCP servers: `marcsh mcp`

The MCP servers of the pi engine (see [Configuration](configuration.md#mcp-servers)). marcsh does not configure MCP servers for Claude.

```
marcsh mcp list
marcsh mcp add <name> [--force] -- <command...>
```

- **`list`** prints the servers of `~/.marcsh/agent/mcp.json` (or `$MARCSH_AGENT_DIR/mcp.json`), then, when the current folder has a `.pi/mcp.json`, the servers of that file under the label `project`, with `trusted` or `not trusted: pi does not load it`: pi reads a project's file only for a project you trusted (see [Security](security.md)). Each server shows the command with its arguments, or its address, and `(disabled)` when it is turned off. Environment variables, headers, and the user name, password and query of an address are not shown. A file that cannot be read is reported on standard error and `list` exits with `1`.
- **`add <name> -- <command...>`** adds a local server to the global file, creating the file and its folder when needed. Everything after `--` is the command and its arguments, so `marcsh mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .` writes `{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }`. The other servers and settings in the file are kept, and so are its indentation and permissions (a new file is readable by you only). The file is replaced in one step, so an interrupted `add` leaves the old file. The name takes letters, digits, `_` and `-`. A name that is already there prints an error and exits with `1`; `--force` replaces that server. A name that differs from another only in `-` and `_` is refused, because their tools would share a name. A file that is not valid JSON is not changed.

The change applies from the next message in a pi session. To add a remote server or set `env`, `exposure` and the other settings, edit the file as described in [Configuration](configuration.md#mcp-servers).

## Usage: `marcsh stats`

`marcsh stats` adds up what your sessions used, per model.

```
marcsh stats [--days N] [--json]
```

It prints one row per model and a `Total` row: the sessions that used the model, the messages sent to it and its replies, the input and output tokens, the cache tokens (read and write) and the cost. A cost of `-` means no reply reported one. A message counts for the model it names, and messages that name none count as `unknown`. A session that used two models is in both rows and counted once in the total. Tokens and cost are what the engines reported, so sessions from before they were recorded show none.

| Option | What it does |
| --- | --- |
| `--days <N>` | Only sessions updated in the last `N` days (a whole number above 0). Without it, every session. |
| `--json` | Prints `{ "days", "models": [...], "totals": {...} }` instead of the table. Each row has `sessions`, `messages`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` and `costUsd` (`null` when unknown); the model rows also have `model`. |

## Update: `marcsh upgrade`

`marcsh upgrade` runs the official installer again, which installs the latest release over the current one.

```
marcsh upgrade [--version vX]
```

marcsh downloads `https://raw.githubusercontent.com/webbegg/marcsh/main/install.sh` to a temporary file, prints the address, and runs it with `bash` in your terminal, so you see its output. The installer's exit code is the exit code of `marcsh upgrade`. Nothing from the network is piped into a shell: the whole file is downloaded first and must start with `#!` and be under 1 MiB, and the file is removed afterwards. The installer is the same one the [getting started](getting-started.md) page describes; it checks the download of the release itself before it unpacks it.

| Option | What it does |
| --- | --- |
| `--version <vX>` | Installs that release (for example `v0.2.0` or `0.2.0`) instead of the latest, by setting `MARCSH_VERSION` for the installer. Here `--version` takes a value; it does not print marcsh's version. |

`MARCSH_INSTALLER_URL` replaces the address (for a mirror or a test). It must be `https://`; plain `http://` is accepted only for `127.0.0.1` and `localhost`. A download that fails (a network error, an HTTP error, something that is not a script) prints the reason and exits with `1` without running anything. `MARCSH_VERSION` and `MARCSH_INSTALL_BASE_URL` in your environment reach the installer too.
