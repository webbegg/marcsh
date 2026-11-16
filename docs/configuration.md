# Configuration

marcsh keeps its files in one folder, `~/.marcsh`. This page lists what is in it, how to set up MCP servers and which environment variables change where marcsh looks.

## Files under `~/.marcsh`

| Path | What it holds |
| --- | --- |
| `preferences.json` | Your settings: theme, engine, pi model, selected agent, permission mode, favorite and recent models, the turn notification and how large pastes show. |
| `marcsh.db` | Your sessions, project trust decisions, the `/` menu command list and, for pi sessions, your "always allow" answers. On Claude, "always allow" is stored by Claude Code, not by marcsh. See [Sessions](sessions.md). |
| `profiles.json` | Model profiles: which model each subagent and the main turn use, and what to fall back to. You write it. See [Model profiles](#model-profiles). |
| `work/` | Feature docs made by [`/marcsh:feature`](commands.md#marcshfeature), one folder per project. An environment variable cannot move it. |
| `agents/` | Your own agent files, one `.md` file per agent. See [Agents](agents.md). |
| `packs/` | Installed packs and the `packs.json` file that pins each one to a commit. See [Packs](packs.md). |
| `attachments/` | Images you pasted from the clipboard, one folder per session. See [Pasting](screen.md#pasting). |
| `agent/` | Everything pi keeps: logins (`auth.json`), custom models (`models.json`), MCP settings (`mcp.json`) and pi's own settings and sessions. |

`~/.marcsh`, `~/.marcsh/agent` and `marcsh.db` are private to your user account, so other users on the machine cannot read your sessions or logins.

marcsh never reads or writes pi's usual `~/.pi/agent` folder.

## Preferences

`preferences.json` is a small JSON file. marcsh writes it when you change a setting, and reads it when it starts. It keeps the keys you do not change. If the file is not valid JSON, marcsh ignores it and overwrites it the next time you change a setting.

```json
{
  "themeName": "Nightfox",
  "defaultEngine": "pi",
  "piModel": "anthropic/claude-opus-5-5",
  "agent": "build",
  "approvalMode": "normal",
  "favoriteModels": { "claude": ["sonnet"], "pi": ["anthropic/claude-opus-5-5"] },
  "recentModels": { "claude": ["opus", "sonnet"], "pi": ["anthropic/claude-opus-5-5"] },
  "notify": "bell",
  "paste": "compact"
}
```

| Key | Meaning | Set by |
| --- | --- | --- |
| `themeName` | The color theme, by name. | `/theme` |
| `defaultEngine` | The engine new sessions start on: `claude` or `pi`. Default: `pi`. | `/engine` |
| `piModel` | The model pi uses, as `provider/model-id`. | `/models` on pi |
| `agent` | The ID of the selected agent. | `Tab` or `/agents` |
| `approvalMode` | The permission mode new sessions start in: `normal`, `auto` or `yolo`. Default: `normal`. | `/permissions default <mode>`, or "Use … for new sessions" in `/permissions` |
| `favoriteModels` | The models you marked as favorites, for each engine (`claude` and `pi`), in the order you marked them. | `Ctrl+F` in `/models` |
| `recentModels` | The last 5 models you chose or used for a turn, for each engine, newest first. | `/models`, `F2` and sending a message |
| `notify` | What marcsh does when a turn finishes: `bell` rings the terminal bell, `system` shows a macOS notification (the bell on other systems), `off` does nothing. Default: `bell`. | Edit the file |
| `paste` | How a large paste (3 lines or more, or over 150 characters) shows in the input: `compact` shows a `[Pasted ~N lines: <start of the first line>…]` placeholder, `full` shows the text. The pasted text is sent either way; a placeholder leaves out only the line ends at the very end of the paste. Default: `compact`. See [Pasting](screen.md#pasting). | Edit the file |

A value marcsh does not understand is ignored, and the default is used. Use the commands above to change settings. If you edit the file by hand, do it while marcsh is closed.

The `system` notification is shown by `osascript` and reads `<session title>: done` (or `failed`, when the turn ended with an error). It is not sent when you interrupt a turn with `Esc`. A `favoriteModels` or `recentModels` entry for a model that is no longer offered is kept in the file and not shown.

The Claude model (`opus`, `sonnet`, `haiku`) is not saved. Each launch starts on `opus`.

A permission mode you choose with `/permissions` lasts for the app session. Only the default is saved. See [Security](security.md#permission-modes).

## Model profiles

A profile routes models: which model, thinking level and fallback chain the main turn and each named subagent use. `~/.marcsh/profiles.json` is yours to write; marcsh reads it at the start of every turn, so an edit applies from your next message, and only `/profile default` writes to it.

```json
{
  "version": 1,
  "default": "cheap",
  "profiles": {
    "cheap": {
      "primary": {
        "model": "anthropic/claude-sonnet-5-5",
        "thinking": "medium",
        "fallback": [{ "model": "openai/gpt-5", "thinking": "high" }, "google/gemini-3-pro"]
      },
      "review-*": { "model": "anthropic/claude-haiku-5-5", "thinking": "low" },
      "refuter": { "model": "openai/gpt-5" },
      "*": { "model": "anthropic/claude-haiku-5-5" }
    },
    "claude": {
      "primary": { "model": "opus", "fallback": [{ "model": "sonnet" }] },
      "*": { "model": "sonnet" }
    }
  }
}
```

| Key | What it routes |
| --- | --- |
| `primary` | The turn of the selected agent. |
| A subagent's file name, such as `refuter` | That [named subagent](agents.md#subagents). |
| A prefix with `*`, such as `review-*` | Every subagent whose name starts with it. The longest prefix wins. |
| `*` | Any other subagent. It does not apply to `primary`. |

A route is `{ "model": ..., "thinking": ..., "fallback": [...] }`. Only `model` is required. `thinking` is `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. `fallback` lists up to 8 models (a plain string is a model with no thinking level), tried in order. Profile names use letters, digits, `.`, `_` and `-`.

- **Models.** The same rule as an agent's `model`: pi takes `provider/id` (a bare model ID is not accepted), Claude takes `opus`, `sonnet`, `haiku` or a `claude-…` name. A route whose model does not fit the engine is skipped, so keep one profile per engine, or give each key the model for the engine you use.
- **Which route a launch gets.** For each subagent launch, marcsh takes, in order: the profile you chose with `/profile use`, then the `default` profile, then the `model` in the agent's file, then the turn's own model. Inside a profile the key that names the subagent wins, then the longest prefix, then `*`. A route is used as a whole: its model, thinking level and fallback chain come together, never mixed with another route's.
- **`primary`.** `/profile use <name>` switches the session's model to the profile's `primary` model. You can change the model afterwards; your choice stays until the next `/profile use`. Its `thinking` applies while the turn runs on that model. Its `fallback` is the chain the main turn follows (see below). `default` does not switch the model by itself.
- **A file that is not valid.** If the file cannot be read, is not a JSON object, or does not have `"version": 1`, marcsh ignores all of it and shows a `Warning:` with the file's path. If a profile, a route or a fallback entry is wrong, only that part is ignored, and the warning says which. `/profile` lists what is ignored. marcsh never rewrites a file it cannot read.
- **Thinking levels are pi's.** marcsh has no thinking setting for Claude, so `thinking` is ignored there.

### Fallback chains

A route's `fallback` is what to try when its model fails. marcsh moves to the next model when the model fails with a usage limit or quota, a sign-in or key error, a rate limit, a provider overload or 5xx error, a timeout or a network error. On pi this happens after pi's own retries are used up. It never happens for a context that is too long, an invalid request, or when you stop the turn.

- **The main turn (pi).** The same conversation continues on the next model: it gets what the failed model had done and is told to pick up the request where it stopped. A warning says which model failed and which one took over. Each model of the chain is tried once per turn. If none can take over, the last error is shown.
- **A subagent (pi).** The subagent starts again from its prompt on the next model, with a warning.
- **Cooldown.** In memory, for this run of marcsh: a model that failed with a usage limit or a sign-in error is skipped for 30 minutes, and one that failed with a rate limit, a provider error, a timeout or a network error for 2 minutes. Later subagent launches start on the first model of their chain that is not cooling down; the fallback skips cooling models too. A model that is unknown to pi, or that has no login, is skipped as well.
- **Claude.** The SDK does the work. The first model of the `primary` fallback that is a Claude model (and not the turn's own) is sent as the SDK's `fallbackModel`: it takes over while the model is overloaded or unavailable, and the model is tried again at the start of each turn. A subagent runs on its routed model; it has no chain on Claude.

## MCP servers

MCP servers give the agent extra tools. How you set them up depends on the engine.

### pi

pi reads MCP servers from two files:

- `~/.marcsh/agent/mcp.json` for every project.
- `.pi/mcp.json` inside a project, for that project only. marcsh reads it only when you have trusted the project. See [Security](security.md).

Both files use the same format. A server is either a local command or a remote address:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "/path/to/my-mcp-server",
      "args": ["--some-flag"]
    },
    "docs": {
      "url": "https://example.com/mcp"
    }
  }
}
```

Add `"enabled": false` to a server to turn it off. A project file can turn off a server from the global file for that project only: write the same name with just `"enabled": false`.

The files are read at the start of each turn, so a change applies from your next message. The agent sees each tool as `mcp__<server>__<tool>`. Every MCP call asks for your approval, like other tools, and the Plan agent cannot use them. The server log goes to `~/.marcsh/agent/mcp.log`, and sign-ins for servers that need one are kept in `~/.marcsh/agent/mcp-auth.json`.

### Claude

marcsh does not configure MCP servers for Claude. It passes your Claude Code settings to the SDK (`~/.claude/settings.json`, the project's `.claude/settings.json` and `.claude/settings.local.json`). Set up MCP servers the way you do for Claude Code.

## Environment variables

These variables move marcsh's files. All of them are optional. An empty value is ignored.

| Variable | Overrides | Default |
| --- | --- | --- |
| `MARCSH_PREFERENCES_PATH` | The preferences file. | `~/.marcsh/preferences.json` |
| `MARCSH_DB_PATH` | The database file with your sessions. | `~/.marcsh/marcsh.db` |
| `MARCSH_PROFILES_PATH` | The model profiles file. | `profiles.json` in the folder of the preferences file, so `~/.marcsh/profiles.json` |
| `MARCSH_AGENTS_DIR` | The folder with your own agent files. | `~/.marcsh/agents` |
| `MARCSH_PACKS_DIR` | The folder where packs are installed. | `~/.marcsh/packs` |
| `MARCSH_AGENT_DIR` | The folder where pi keeps its logins, MCP settings and sessions. | `~/.marcsh/agent` |
| `MARCSH_ATTACHMENTS_DIR` | The folder where images pasted from the clipboard are saved. It must be an absolute path; a relative one is ignored, so that images never land in a project folder. | `~/.marcsh/attachments` |

For example, to use a separate database and preferences file:

```
MARCSH_DB_PATH=/tmp/marcsh-try/marcsh.db \
MARCSH_PREFERENCES_PATH=/tmp/marcsh-try/preferences.json \
marcsh
```

Your pi logins, your agents and your installed packs stay shared. To separate them too, set `MARCSH_AGENT_DIR`, `MARCSH_AGENTS_DIR` and `MARCSH_PACKS_DIR` the same way.

marcsh creates the folder of the database file if needed. It does not create or change the permissions of a custom `MARCSH_AGENT_DIR`, so make sure that folder is private to you.

marcsh always points pi at its own folder, whatever `PI_CODING_AGENT_DIR` your shell has. Use `MARCSH_AGENT_DIR` to move it.

## What the launcher does not read

The `marcsh` launcher starts Bun with its automatic `.env` loading and its `bunfig.toml` loading turned off. A `.env` file or a `bunfig.toml` in the folder where you run marcsh is not read, so a project cannot change how marcsh runs by shipping one. This also means that variables you keep in a project's `.env` do not reach marcsh. Set them in your shell instead. See [Security](security.md).

## Next

- [Troubleshooting](troubleshooting.md)
- [Security](security.md)
