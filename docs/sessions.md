# Sessions

A session is one conversation with an agent. marcsh saves every session, so you can leave and come back to it later, even after restarting.

## Start a new session

Type `/new`, or start marcsh. Both bring you to the home screen. Your first message creates the session:

- Its **title** is the first 100 characters of that message.
- Its **project folder** is the folder where you started marcsh.
- Its **engine** is the engine new sessions use at that moment. See [Engines and models](engines-and-models.md). The session keeps this engine for good.

## Find and resume a session

Type `/sessions`. The list shows your sessions, the most recently used first. Each row has the title and the clock time of the last activity. It shows no date.

- Type to search. The search matches the title.
- Use `Up` and `Down`, then `Enter` to open a session. You can also click one.
- `Ctrl+D` deletes the highlighted session (see [below](#rename-fork-export-and-delete)).
- `Esc` closes the list.

The list holds all your sessions, whatever folder they belong to.

Opening a session shows the whole conversation. When you send a message, marcsh continues it with the same engine and in the same folder it was started in, even if you launched marcsh somewhere else. The `@` file picker and the agent work in that folder.

The agent and the model are not saved with the session. A resumed session uses the agent and the model you have selected now.

If a session cannot be opened, marcsh shows `Could not load session: …` and takes you home. See [Troubleshooting](troubleshooting.md).

## What a session keeps

For each session marcsh saves:

- the title, the project folder and the engine
- every message you sent and every reply, with the tools the agent called
- for each reply, the agent that wrote it, the model it used, how long it took, and the project's file snapshots around its turn (see [below](#undo-redo-and-diff))
- the engine's own reference to the conversation, which is what lets Claude or pi pick up where they stopped

marcsh saves the conversation when a turn ends, and also when you stop it with `Esc`. If saving fails, an error `Could not save session: …` appears in the conversation.

Leaving a session while a reply is still running stops that reply.

## Where sessions are stored

Sessions live in `~/.marcsh/marcsh.db`, a SQLite file that only your user account can read. The same file holds your project trust decisions, the command list the `/` menu shows and, for pi sessions, your "always allow" answers. On Claude, "always allow" is stored by Claude Code, not by marcsh. pi also keeps its own session files inside `~/.marcsh/agent`. See [Configuration](configuration.md) to move the database.

## Rename, fork, export and delete

- `/rename <title>` changes the title. The session keeps its place in the list.
- `/fork` copies the messages saved so far into a new session titled "<title> (fork)" and opens it at once. The copy has the same project folder and engine. It does not have the engine's reference to the conversation, so its first message starts a new engine conversation. That message is sent with the transcript so far in front of it (the newest 40,000 characters), so the engine knows what was said; the chat shows only what you typed. A first message that is a `/command` is sent as typed, without the transcript. `/fork` is not available while a turn is running.
- `/export [md|json] [path]` writes the session to a file. Markdown is the default, and the default file is `marcsh-<first 8 characters of the id>-<YYYY-MM-DD>.md` in the project folder. An export never overwrites a file: `-1`, `-2`, … is added when the name is taken.
- To delete a session, open `/sessions`, highlight it and press `Ctrl+D`. marcsh names the session and asks first. The answer "Keep it" is selected, and `Esc` cancels. A delete removes that session and its messages for good, and nothing else: trust decisions, "always allow" answers, the command list, and the snapshots below stay. Deleting the session you have open takes you home.

## Undo, redo and diff

Before and after every turn marcsh takes a snapshot of your project's files. `/undo` puts back the files the last turn changed, `/redo` re-applies them, and `/diff` shows everything that changed since the session's first turn. See [/undo](commands.md#undo), [/redo](commands.md#redo) and [/diff](commands.md#diff) for the commands.

- Undo and redo change files only. The conversation is not rewound, because the engine's history cannot be cut. A line in the chat names the files restored and deleted. These lines are not saved with the session.
- Only the files that turn changed are written, and a file you changed after the turn is listed and needs your confirmation first.
- Each turn stores `{ before, after }` (two snapshot ids) on its last reply in the session's saved messages, plus whether it is undone. A new turn after an undo makes the undone turns final: `/redo` no longer reaches them.

### How snapshots are stored

- Snapshots live in a shadow git repository per project under `~/.marcsh/snapshots/<project-hash>`. The hash is taken from the project folder's real path. The repository has its own git directory with your project as its work tree. Your project's own `.git` is never read or changed, and nothing is committed.
- Your project's `.gitignore` is respected, and `.git` folders (also inside the project) are never included. Files that are ignored (such as `.env` and `node_modules`) are neither copied nor restored.
- The shadow repository holds a copy of every other file of the project, including each version a turn saved. This can be a lot of data and can include secrets in files that are not ignored. marcsh never removes it, and deleting a session does not either. Delete the `<project-hash>` folder to forget a project's snapshots.
- Snapshots need `git` on your `PATH`. Without it, or when a snapshot fails or takes longer than 10 seconds, the turn still runs and `/undo` says why it cannot help. After a snapshot times out, that session takes no more.
- Taking them costs time before and after each turn: on the marcsh repository, about 0.25 s for each snapshot after the first (0.65 s the first time).
- `MARCSH_SNAPSHOTS_DIR` moves the folder, and `MARCSH_SNAPSHOTS=off` turns snapshots off.

## Compaction and copying

`/compact` asks the engine to compact the session's context, and `/copy` puts the last reply on the clipboard. See [/compact](commands.md#compact) and [/copy](commands.md#copy).

The status line shows the tokens in context, the context as a percent of the model's window, and the session's cost, each when the engine reports it. Claude reports a running total of the cost that a resumed conversation continues from, so marcsh stores each reply's own cost (the difference) and the total beside it.

## Next

- [Commands](commands.md)
- [Configuration](configuration.md)
