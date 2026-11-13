# Switch engine or model

Change the model, sign in to another provider, or start a session on the other engine.

marcsh runs on one of two engines. **pi** (the default) lets you pick models from many providers. On pi you can also keep typing while a reply runs ([steer or queue](../screen.md#typing-while-the-agent-works)). **Claude** uses the Claude sign-in already on your machine.

The example: you start on pi with one model, try another, add a provider, and then open a session on Claude.

## Steps

1. **Look at the status line.** It shows the agent, the model and the engine:

   ```
   Build › anthropic/claude-opus-5-5 · pi v1.5.0
   ```

2. **Pick another model.** Type `/models` and press `Enter`. On pi, the list shows the models of the providers you signed in to, as `provider/model-id`. Choose one with `Up`, `Down` and `Enter`. A toast in the top right corner says `pi will use provider/model-id`. It applies to your following messages and to new pi sessions. marcsh remembers it.

3. **Add a provider.** The provider you want is not in the list? Type `/login` and pick a provider. `/login` works on any screen.

4. **Follow the dialog.** Open the link or enter the code, or paste the API key and press `Enter`. `Esc` cancels. You see `Logged in to <provider>` when it works, or `Saved API key for <provider>` for an API key. Then open `/models` again. See [pi: `/login`](../engines-and-models.md#pi-login).

5. **Switch the engine.** Type `/engine` and press `Enter`. Choose `Claude (Agent SDK)`. A toast says `New sessions will use Claude (Agent SDK)`. marcsh remembers the choice for the next start.

6. **Check that your current session did not change.** The engine you choose applies to **new** sessions. A session you already started keeps the engine it was created with. Its status line still says `pi`.

7. **Start a session on the new engine.** Type `/new` and send your first message. The status line now shows the Claude model and the engine:

   ```
   Build › opus · claude
   ```

8. **Change the Claude model.** Type `/models`. On Claude the list is `opus`, `sonnet` and `haiku`. The pick applies to your next messages. marcsh does not remember it: every start begins on `opus`.

To go back, type `/engine` again and choose `pi`.

## Good to know

- **Remove a login.** Type `/logout` and pick the login. It is removed at once. Keys that come from environment variables stay.
- **Claude sign-in.** marcsh has no sign-in for Claude. If Claude fails to start a reply, make Claude work on this machine first. `/login` and `/logout` are for pi providers only.
- **No model on pi.** If the status line says `no model · run /login`, sign in to a provider with `/login`.
- **Agents with their own model.** An agent can name a model in its file. marcsh uses it only if the current engine can run it: a Claude model name on Claude, a `provider/model-id` you have signed in to on pi. Otherwise it uses the session model, and selecting the agent shows a toast that starts with `Warning:`. See [Models set by an agent](../engines-and-models.md#models-set-by-an-agent).
- **Resumed sessions.** An old session opens on its own engine. Its model is the one you have selected now.

## Next

- [Engines and models](../engines-and-models.md#the-two-engines): the two engines side by side.
- [Commands](../commands.md#engine): `/engine`, `/models`, `/login` and `/logout`.
- [Troubleshooting](../troubleshooting.md#models-and-signing-in): messages about models and sign-in.
