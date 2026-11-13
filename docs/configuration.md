# Configuration

marcsh keeps its files in one folder, `~/.marcsh`. This page lists what is in it, how to set up MCP servers and which environment variables change where marcsh looks.

## Files under `~/.marcsh`

| Path | What it holds |
| --- | --- |
| `preferences.json` | Your settings: theme, engine, pi model and selected agent. |
| `marcsh.db` | Your sessions, project trust decisions, the `/` menu command list and, for pi sessions, your "always allow" answers. On Claude, "always allow" is stored by Claude Code, not by marcsh. See [Sessions](sessions.md). |
| `work/` | Feature docs made by [`/marcsh:feature`](commands.md#marcshfeature), one folder per project. An environment variable cannot move it. |
| `agents/` | Your own agent files, one `.md` file per agent. See [Agents](agents.md). |
| `packs/` | Installed packs and the `packs.json` file that pins each one to a commit. See [Packs](packs.md). |
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
  "agent": "build"
}
```

| Key | Meaning | Set by |
| --- | --- | --- |
| `themeName` | The color theme, by name. | `/theme` |
| `defaultEngine` | The engine new sessions start on: `claude` or `pi`. Default: `pi`. | `/engine` |
| `piModel` | The model pi uses, as `provider/model-id`. | `/models` on pi |
| `agent` | The ID of the selected agent. | `Tab` or `/agents` |

A value marcsh does not understand is ignored, and the default is used. Use the commands above to change settings. If you edit the file by hand, do it while marcsh is closed.

The Claude model (`opus`, `sonnet`, `haiku`) is not saved. Each launch starts on `opus`.

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
| `MARCSH_AGENTS_DIR` | The folder with your own agent files. | `~/.marcsh/agents` |
| `MARCSH_PACKS_DIR` | The folder where packs are installed. | `~/.marcsh/packs` |
| `MARCSH_AGENT_DIR` | The folder where pi keeps its logins, MCP settings and sessions. | `~/.marcsh/agent` |

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
