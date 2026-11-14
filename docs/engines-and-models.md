# Engines and models

marcsh can run your sessions on two engines, Claude and pi. This page explains how they differ, how to choose one, how to pick a model and how to sign in.

## The two engines

**Claude** runs Claude through the Claude Agent SDK, the engine behind Claude Code. It offers Claude models only.

**pi** is a coding agent that talks to many model providers. It is the default engine. You sign in to the providers you want with `/login`, and marcsh keeps pi's logins and data in its own folder (`~/.marcsh/agent`), apart from any pi install of your own.

| | Claude | pi |
| --- | --- | --- |
| Models | `opus`, `sonnet`, `haiku` | Any model of a provider you signed in to, as `provider/model-id` |
| Sign-in | The Claude sign-in already on your machine | `/login` and `/logout` |
| Typing while a reply runs | Not possible | Possible: steer or queue |
| Project pi files and trust | Not used | Asked about with a trust prompt |
| MCP servers | Set up in Claude Code, not by marcsh | `mcp.json` files |

See [Configuration](configuration.md) for the MCP details and [Security](security.md) for trust.

On pi, a command (`bash`) or a subagent (`Task`) that runs longer than 3 minutes is stopped. The model gets an error that says it timed out. For a command it suggests a larger `timeout`, and it suggests running the work in the background (`bg_start`, or `Task` with `background: true`) only when the session can do that, so not in Plan or in `marcsh run`. A command that sets its own `timeout` keeps it. Time a subagent spends waiting for your approval does not count.

## Choose an engine

Type `/engine` and pick `Claude (Agent SDK)` or `pi`. marcsh confirms with a message like `New sessions will use pi`, and remembers the choice for the next time you start it.

The choice applies to **new** sessions. A session you already started keeps the engine it was created with, and the status line shows which one that is. To start fresh on the new engine, type `/new`.

## Choose a model

Type `/models`. The list depends on the engine of the screen you are on.

### Favorites and recent models

On both engines, the list shows your favorite models first, then your recent models, then the rest, each model once. A favorite has a `★` before it, and a recent model has `recent` after it.

- **Favorites:** press `Ctrl+F` on the highlighted model to add it to your favorites, or to remove it. The list keeps its order until you open `/models` again, so the row under the cursor does not move.
- **Recent models:** marcsh keeps the last 5 models of each engine. A model becomes the most recent one when you pick it in `/models` and when a message is sent with it.
- **`F2`:** in a session, switches to the next recent model of the session's engine and shows `Model: <model>`. Press it again for the one after, and so on around the list. It says `No other recent model` when there is none. On pi it skips models whose provider you are no longer signed in to. `F2` does nothing while a dialog, an approval or a question is open.

Favorites and recent models are kept in `preferences.json` ([Configuration](configuration.md#preferences)), for each engine apart. This also applies to Claude: the favorites and the recent models are kept between launches, although the model in use is not.

### Claude

The list has `opus`, `sonnet` and `haiku`. The pick applies to your next messages. marcsh does not remember it between launches: every start begins on `opus`.

### pi

The list shows the models of the providers you have signed in to, as `provider/model-id` with the model's name next to it. After you pick one, marcsh says `pi will use provider/model-id`, and uses it for the following turns and for new pi sessions. It remembers the choice between launches.

If no provider is signed in, `/models` says `No pi model is available yet. Run /login to sign in to a provider.`

If the model you picked becomes unavailable, for example after `/logout`, marcsh uses the first available model instead. Your pick comes back when its provider has a sign-in again. If you have not picked a model, marcsh uses `anthropic/claude-opus-5-5` when it is available, and otherwise the first available one.

### Models set by an agent

An [agent](agents.md) can name its own model. marcsh uses it only if the current engine can use it: a Claude model name or alias on Claude, a `provider/model-id` on pi that you have signed in to. Otherwise it uses the session model and shows a warning when you select the agent.

## Sign in

### pi: `/login`

Type `/login`. The list shows the providers pi knows. A check mark and a label such as `logged in` mark the ones you have already signed in to. Pick one:

- For a **subscription** or **sign in** provider, the dialog shows a link or a device code. Open the link in your browser (or go to the address shown and enter the code), and finish there. If it asks for a code, paste it into the field and press `Enter`.
- For an **API key** provider, paste the key into the field and press `Enter`. The field shows dots instead of the key.

Press `Esc` at any time to cancel. When it works you see `Logged in to <provider>` or `Saved API key for <provider>`.

For a subscription sign-in, the dialog reminds you to check that your plan's terms allow use with other apps. For Anthropic it adds that third-party use of a Claude plan is billed as extra usage, per token.

marcsh saves pi's logins in `~/.marcsh/agent/auth.json`. pi also uses API keys it finds in the environment variables of its providers, and keys set in `~/.marcsh/agent/models.json`. Those count as signed in without `/login`.

`/login` works from any screen, whichever engine you are on.

### pi: `/logout`

Type `/logout`, then pick a login to remove. It is removed at once, with no further question. `/logout` only removes logins made with `/login`. Keys that come from environment variables stay as they are. marcsh confirms with one of two messages:

- `Logged out of <provider>` after a subscription login.
- `Removed stored API key for <provider>. Environment variables are unchanged.` after an API key login.

With nothing to remove, it says `No pi logins to remove. /logout only removes logins made with /login; environment variables are unchanged.`

### Claude

marcsh has no sign-in screen for Claude, and it does not ask for or store a Claude key. It does not manage Claude sign-in or Claude MCP servers. It starts the Claude Agent SDK, which uses the sign-in your Claude setup already has on this machine. marcsh also passes your Claude Code settings to the SDK: `~/.claude/settings.json` and the project's `.claude/settings.json` and `.claude/settings.local.json`. The Claude engine reads the project files without the `/trust` prompt. If Claude Code works for you, the Claude engine should too. `/login` is for pi providers only.

## Next

- [Sessions](sessions.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
