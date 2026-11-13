# Resume your work

Pick up where you left off.

marcsh saves every conversation. You can quit, restart your computer, and continue tomorrow.

The example: you are halfway through adding a login page. It is the end of the day. Tomorrow you want to continue the same conversation.

## Steps

1. **Finish for the day.** If a reply is still running, press `Esc` to stop it. marcsh saves the conversation when a turn ends, and also when you stop it with `Esc`.

2. **Quit.** Type `/exit`, or press `Ctrl+C` on an empty input. marcsh stops any running reply first and waits a few seconds for it to finish. The session stays saved.

3. **Come back.** Start `marcsh` again. You can start it in any folder. You land on the home screen.

4. **Open the session list.** Type `/sessions` and press `Enter`. A list opens with your past sessions, newest first. Each row has a title and the time of the last activity. The time has no date, so an older session can show a later time:

   ```
   Add a login page to the app            04:12 PM
   Why does the build fail on CI          05:40 PM
   ```

   The title is the first 100 characters of the first message you sent in that session. Find your session by its title.

5. **Narrow the list.** Type a word from the title, for example `login`. The list shows the matching titles. The search only looks at titles.

6. **Open it.** Use `Up` and `Down`, then press `Enter`. You can also click a row. The whole conversation appears, with the tools the agent called.

7. **Check the status line, then carry on.** Type your next message, for example `Now add the logout button`. marcsh continues the session with the same engine, and in the folder where you started it, even if you launched marcsh somewhere else. The agent remembers the earlier conversation.

8. **Start something else.** Type `/new` to go back to the home screen. Your next message there starts a new session. The old one stays in `/sessions`.

## What comes back, and what does not

A resumed session keeps your messages, the replies and the engine. It does not keep your choice of agent or model: it uses what the status line shows now. Check it before you send: press `Tab` to change the agent, `/models` to change the model. See [Sessions](../sessions.md#what-a-session-keeps) for everything a session saves.

Leaving a session while a reply is running stops that reply.

If a session cannot be opened, you see `Could not load session: …` and go back to the home screen. See [Troubleshooting](../troubleshooting.md#could-not-load-session-).

## Next

- [Sessions](../sessions.md#find-and-resume-a-session): the session list in full, and where sessions are stored.
- [Commands](../commands.md#sessions): `/sessions`, `/new` and `/exit`.
- [Switch engine or model](switch-engine-or-model.md): a session keeps its engine for good.
