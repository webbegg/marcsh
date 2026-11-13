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
- `Esc` closes the list.

The list holds all your sessions, whatever folder they belong to.

Opening a session shows the whole conversation. When you send a message, marcsh continues it with the same engine and in the same folder it was started in, even if you launched marcsh somewhere else. The `@` file picker and the agent work in that folder.

The agent and the model are not saved with the session. A resumed session uses the agent and the model you have selected now.

If a session cannot be opened, marcsh shows `Could not load session: …` and takes you home. See [Troubleshooting](troubleshooting.md).

## What a session keeps

For each session marcsh saves:

- the title, the project folder and the engine
- every message you sent and every reply, with the tools the agent called
- for each reply, the agent that wrote it, the model it used and how long it took
- the engine's own reference to the conversation, which is what lets Claude or pi pick up where they stopped

marcsh saves the conversation when a turn ends, and also when you stop it with `Esc`. If saving fails, an error `Could not save session: …` appears in the conversation.

Leaving a session while a reply is still running stops that reply.

## Where sessions are stored

Sessions live in `~/.marcsh/marcsh.db`, a SQLite file that only your user account can read. The same file holds your project trust decisions, the command list the `/` menu shows and, for pi sessions, your "always allow" answers. On Claude, "always allow" is stored by Claude Code, not by marcsh. pi also keeps its own session files inside `~/.marcsh/agent`. See [Configuration](configuration.md) to move the database.

marcsh has no command to delete or export a single session.

## Next

- [Commands](commands.md)
- [Configuration](configuration.md)
