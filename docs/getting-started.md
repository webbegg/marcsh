# Getting started

This page takes you through your first task: start marcsh, sign in, ask for something, approve a change and quit. It takes about five minutes. To learn what each part of the screen does, see [The screen](screen.md).

## 1. Start marcsh

Go to the folder you want to work on and start `marcsh` (see the [README](../README.md) for installing):

```
cd ~/projects/my-app
marcsh
```

That is your project folder. marcsh opens an assistant (the *agent*) in that folder. You see the home screen with an input box.

## 2. Sign in

marcsh needs a model to talk to. With no model, the home screen shows a short card, and the status line under the input says `no model · run /login`. Type `/login`, pick a provider and follow the steps: a sign-in link or code for a subscription, or a pasted API key. Then type `/models` to pick one of that provider's models. (A Claude Code user can use the Claude engine instead, with `/engine`: see [The Claude engine](engines-and-models.md#the-claude-engine).)

Until a model is available, `Enter` does not send your message and no session is created: marcsh keeps what you typed and says `No model yet: /login (pi) or /engine (Claude)` under the input. The message goes away when you change the input, and the card goes away once you are signed in.

See [Sign in](engines-and-models.md#sign-in) for the details.

## 3. Ask for something

Type a question or a task and press `Enter`. For example:

```
Explain what src/index.ts does
```

Type `@` and the start of a file name to pick a file. See [File mentions](screen.md#file-mentions). Your messages are saved together as a *session*. The agent's reply shows its thinking, the tools it calls and the text it writes.

Now ask for a change:

```
Add a one-line comment at the top of src/index.ts
```

## 4. Approve the change

By default the agent asks before it edits files or runs commands. A prompt appears above the input. It shows the tool and what it will do. The agent can reach outside the folder, so read what it will touch. See [Security](security.md#outside-the-project-folder). Answer with one key:

| Key | Meaning |
| --- | --- |
| `y` | Allow this call once. |
| `n` | Deny it. The agent is told you said no. |
| `Esc` | Deny it and stop the reply. |

After you press `y`, the tool runs and the agent goes on. The reply shows what it did.

`a` always allows. Before you use it, read [what it covers](security.md#what-always-allow-covers).

## 5. Quit

Press `Ctrl+C` twice on an empty input, or type `/exit`. marcsh saves every session, so you can come back to it later: it prints the session's ID, and `marcsh -c` opens it again. See [Sessions](sessions.md).

## Next

- [Plan, then build](guides/plan-then-build.md): make a change safely.
- [Resume your work](guides/resume-work.md): pick up where you left off.
- [The screen](screen.md): the status line, toasts and what you can type while the agent works.
