# marcsh

marcsh is a terminal app for working with coding agents. You chat with an agent in your project folder, and it reads files, edits code and runs commands. By default it asks for your approval before it edits files or runs commands.

marcsh talks to AI models through an **engine**. It has two, and you can switch between them:

- **pi** is the default. It works with many model providers. You sign in to the ones you want with `/login`.
- **Claude** runs Claude through the Claude Agent SDK. It uses the Claude sign-in that is already on your machine.

See [Engines and models](docs/engines-and-models.md) to choose one.

## Requirements

- [Bun](https://bun.sh) to install and run marcsh.
- `git`, to download marcsh and to install packs.
- A terminal. On Linux, if the launcher fails with an error about `env`, see [Troubleshooting](docs/troubleshooting.md#an-error-from-env-about-the--s-option).

## Install and launch

marcsh runs from a copy of this repository. Download it, install the dependencies, then register the `marcsh` command:

```
git clone https://github.com/webbegg/marcsh.git
cd marcsh
bun install
bun run link:cli
```

`link:cli` builds the CLI and links it with Bun. The `marcsh` command runs the code in this folder, so you do not need to link again after you pull changes.

Then go to the folder you want to work on and start marcsh:

```
cd ~/projects/my-app
marcsh
```

marcsh works on the folder you start it in. It takes no command-line options.

If the `marcsh` command is not found, run the launcher from the repository instead:

```
/path/to/marcsh/packages/cli/bin/marcsh
```

## Quick start

1. Start `marcsh` in your project folder. You see the home screen with an input box.
2. Sign in.
   - pi (the default): the status line under the input says `no model · run /login`. Type `/login`, pick a provider and follow the steps.
   - Claude: type `/engine`, then pick Claude. marcsh has no Claude sign-in screen. It uses the Claude sign-in already on your machine.
3. Type a question or a task and press `Enter`. For example: `Explain what src/index.ts does`. Type `@` to pick a file by name. To see an approval, ask for a change: `Add a one-line comment at the top of src/index.ts`.
4. When the agent wants to use a tool that needs your approval, a prompt appears. Press `y` to allow it once, `a` to always allow it, or `n` to deny it. [Security](docs/security.md) explains what `a` covers.
5. Press `Tab` to switch agent. Build edits files and runs commands. Plan only reads and plans. The status line shows the agent you picked.

To leave, press `Ctrl+C` on an empty input, or type `/exit`.

## Documentation

- [Getting started](docs/getting-started.md): the screens, the input and approving tool calls. A toast is a short message in the top right corner.
- [Engines and models](docs/engines-and-models.md): the engine is what runs the conversation, pi or Claude. Choose a model and sign in.
- [Sessions](docs/sessions.md): a session is one saved conversation. Start, find and resume them.
- [Commands](docs/commands.md): every `/` command and the key bindings.
- [Agents](docs/agents.md): an agent is a role with a permission level, such as Build or Plan. Switch agents and write your own.
- [Packs](docs/packs.md): a pack is a public GitHub repository that adds agents, skills and commands. Install one from GitHub.
- [Pack hooks](docs/pack-hooks.md): commands a pack can run around tool calls. They stay off until you turn them on.
- [Building a pack](docs/building-a-pack.md): publish your own pack.
- [Configuration](docs/configuration.md): files under `~/.marcsh`, MCP servers and environment variables.
- [Security](docs/security.md): what marcsh asks about, what it trusts and what it never runs.
- [Troubleshooting](docs/troubleshooting.md): common problems and their messages.
