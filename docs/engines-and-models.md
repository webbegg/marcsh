# Engines and models

marcsh runs your sessions on [pi](https://github.com/earendil-works/pi), a coding agent that talks to many model providers. This page explains how to sign in to a provider and how to pick a model. The last section covers the second engine, [Claude](#the-claude-engine), and how it differs.

marcsh keeps pi's logins and data in its own folder (`~/.marcsh/agent`), apart from any pi install of your own.

## Sign in

### `/login`

Type `/login`. The list shows the providers pi knows. A check mark and a label such as `logged in` mark the ones you have already signed in to. Pick one:

- For a **subscription** or **sign in** provider, the dialog shows a link or a device code. Open the link in your browser (or go to the address shown and enter the code), and finish there. If it asks for a code, paste it into the field and press `Enter`.
- For an **API key** provider, paste the key into the field and press `Enter`. The field shows dots instead of the key.

Press `Esc` at any time to cancel. When it works you see `Logged in to <provider>` or `Saved API key for <provider>`.

For a subscription sign-in, the dialog reminds you to check that your plan's terms allow use with other apps. For Anthropic it adds that third-party use of a Claude plan is billed as extra usage, per token.

marcsh saves pi's logins in `~/.marcsh/agent/auth.json`. pi also uses API keys it finds in the environment variables of its providers, and keys set in `~/.marcsh/agent/models.json`. Those count as signed in without `/login`.

`/login` works from any screen, whichever engine you are on.

### `/logout`

Type `/logout`, then pick a login to remove. It is removed at once, with no further question. `/logout` only removes logins made with `/login`. Keys that come from environment variables stay as they are. marcsh confirms with one of two messages:

- `Logged out of <provider>` after a subscription login.
- `Removed stored API key for <provider>. Environment variables are unchanged.` after an API key login.

With nothing to remove, it says `No pi logins to remove. /logout only removes logins made with /login; environment variables are unchanged.`

## Choose a model

Type `/models`. The list shows the models of the providers you have signed in to, as `provider/model-id` with the model's name next to it. After you pick one, marcsh says `pi will use provider/model-id`, and uses it for the following turns and for new sessions. It remembers the choice between launches.

If no provider is signed in, `/models` says `No pi model is available yet. Run /login to sign in to a provider.`

If the model you picked becomes unavailable, for example after `/logout`, marcsh uses the first available model instead. Your pick comes back when its provider has a sign-in again. If you have not picked a model, marcsh uses `anthropic/claude-opus-5-5` when it is available, and otherwise the first available one.

### Favorites and recent models

The list shows your favorite models first, then your recent models, then the rest, each model once. A favorite has a `★` before it, and a recent model has `recent` after it.

- **Favorites:** press `Ctrl+F` on the highlighted model to add it to your favorites, or to remove it. The list keeps its order until you open `/models` again, so the row under the cursor does not move.
- **Recent models:** marcsh keeps your last 5 models. A model becomes the most recent one when you pick it in `/models` and when a message is sent with it.
- **`F2`:** in a session, switches to the next recent model and shows `Model: <model>`. Press it again for the one after, and so on around the list. It says `No other recent model` when there is none. It skips models whose provider you are no longer signed in to. `F2` does nothing while a dialog, an approval or a question is open.

Favorites and recent models are kept in `preferences.json` ([Configuration](configuration.md#preferences)), apart for each engine.

### Reopened sessions

A session you open again (`marcsh -c`, `marcsh -s <id>` or the session list) starts on the model it used last, when that model is still available (its provider still has a sign-in). Otherwise it starts on the model you chose last. That model applies only while the session is open: when you leave it (to the home screen, another session or a new one), marcsh goes back to the model you chose last. Opening an old session does not change the model marcsh keeps for new sessions. A model you pick inside the old session is a new choice, so it is kept.

### Models set by an agent

An [agent](agents.md) can name its own model, as a `provider/model-id` you have signed in to. marcsh uses it for that agent's turns. If it cannot (the provider has no sign-in, or the name is a Claude alias such as `sonnet`), it uses the session model and shows a warning when you select the agent.

### Models set by a profile

A [model profile](configuration.md#model-profiles) routes models per subagent and for the main turn, with fallback chains for when a model hits a limit or an error. `/profile use <name>` switches the session's model to the profile's `primary` model (you can change it afterwards with `/models`); `/profile` shows what is in force. A failing model is replaced by the next one of its chain, for the main turn (the conversation goes on) and for subagents (they start again, unless they had already run a tool: those are not restarted, so their steps do not run twice). A profile can also set each route's thinking level.

## Time limits and leftover processes

A command (`bash`) or a subagent (`Task`) that runs longer than 3 minutes is stopped. The model gets an error that says it timed out. For a command it suggests a larger `timeout`, and it suggests running the work in the background (`bg_start`, or `Task` with `background: true`) only when the session can do that, so not in Plan or in `marcsh run`. A command that sets its own `timeout` keeps it. Time a subagent spends waiting for your approval does not count.

marcsh finds the processes the agent's tools left running (leftover processes) and lists them in `/ps`. The agent has `proc_list` and `proc_stop` for them. See [What marcsh may stop](security.md#what-marcsh-may-stop).

## The Claude engine

marcsh can also run Claude through the Claude Agent SDK, the engine behind Claude Code. It offers Claude models only, and uses the Claude sign-in already on your machine.

The Claude engine is less used and less tested than pi. Use it when you want your Claude Code setup (its sign-in, settings, MCP servers and permission rules) inside marcsh. Expect some features to be missing:

| | pi | Claude |
| --- | --- | --- |
| Models | Any model of a provider you signed in to, as `provider/model-id` | `opus`, `sonnet`, `haiku` |
| Sign-in | `/login` and `/logout` | The Claude sign-in already on your machine |
| Typing while a reply runs | Possible: steer or queue | Not possible: `Esc` stops the reply |
| Background terminals and subagents | Yes (`/ps`, `/subagents`) | No |
| Leftover processes | Listed in `/ps`, and the agent has `proc_list` and `proc_stop` | Listed in `/ps` only |
| Time limit on commands and subagents | 3 minutes, as above | None from marcsh |
| Project pi files and trust | Asked about with a trust prompt | Not used |
| MCP servers | `mcp.json` files | Set up in Claude Code, not by marcsh |
| "Always allow" | Stored by marcsh, per project | The rule Claude Code suggests, stored by Claude Code |
| Thinking levels in a profile | Yes | Ignored |

See [Configuration](configuration.md) for the MCP details and [Security](security.md) for trust and approvals.

### Switch to it

Type `/engine` and pick `Claude (Agent SDK)`, or `pi` to go back. marcsh confirms with a message like `New sessions will use pi`, and remembers the choice for the next time you start it.

The choice applies to **new** sessions. A session you already started keeps the engine it was created with, and the status line shows which one that is. To start fresh on the new engine, type `/new`.

### Its models

`/models` on a Claude session lists `opus`, `sonnet` and `haiku`. The pick applies to your next messages. marcsh remembers it between launches, so the next start begins on the model you picked last. Before you pick one, every start begins on `opus`. If the saved value is not one of these three, marcsh starts on `opus`. Favorites, recent models and `F2` work the same as on pi, with their own list.

An agent's `model` is used on Claude when it is a name that starts with `claude` or an alias (see [Agents](agents.md#model-and-fallback)). In a profile, the first Claude model of the `primary` fallback chain becomes the SDK's fallback model, and subagents use their routed model.

### Its sign-in

marcsh has no sign-in screen for Claude, and it does not ask for or store a Claude key. It does not manage Claude sign-in or Claude MCP servers. It starts the Claude Agent SDK, which uses the sign-in your Claude setup already has on this machine. marcsh also passes your Claude Code settings to the SDK: `~/.claude/settings.json` and the project's `.claude/settings.json` and `.claude/settings.local.json`. The Claude engine reads the project files without the `/trust` prompt. If Claude Code works for you, the Claude engine should too. `/login` is for pi providers only.

## Next

- [Sessions](sessions.md)
- [Configuration](configuration.md)
- [Troubleshooting](troubleshooting.md)
