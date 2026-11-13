# marcsh

marcsh is a terminal app for working with coding agents. You chat with an agent in your project folder, and it reads files, edits code and runs commands. By default it asks for your approval before it edits files or runs commands.

marcsh talks to AI models through an **engine**. It has two, and you can switch between them:

- **pi** is the default. It works with many model providers. You sign in to the ones you want with `/login`.
- **Claude** runs Claude through the Claude Agent SDK. It uses the Claude sign-in that is already on your machine.

See [Engines and models](docs/engines-and-models.md) to choose one.

## Requirements

- [Bun](https://bun.sh) 1.4 or newer. The installer can install it for you.
- `git`, to install packs.
- macOS for the one-line installer. On other systems, install [from source](#from-source).

## Install

On macOS, run:

```
curl -fsSL https://raw.githubusercontent.com/webbegg/marcsh/main/install.sh | bash
```

The installer downloads the latest release, checks its checksum, and installs it in `~/.marcsh/app`. The checksum guards against a broken or incomplete download. It does not prove who published the release. It then links the `marcsh` command in `~/.local/bin`. It never uses `sudo`. If `~/.local/bin` is not on your `PATH`, it prints the line to add to your shell profile.

The install script itself is fetched from the `main` branch and runs as it arrives, so you trust it because of where it comes from (GitHub, this repository). Only the release archive has its checksum checked. To fetch a fixed copy of the script, use the tag URL shown below.

Releases are built by GitHub Actions with a provenance attestation. To check a release archive you downloaded:

```
gh attestation verify marcsh.tar.gz --repo webbegg/marcsh
```

Add options after `bash -s --`:

```
curl -fsSL https://raw.githubusercontent.com/webbegg/marcsh/main/install.sh | bash -s -- --with-bun --modify-path
```

- `--with-bun` runs Bun's official installer first, if you don't have Bun 1.4 or newer. That installer comes from bun.sh and is not verified, and it may add Bun to your shell profile.
- `--modify-path` adds `~/.local/bin` to your `PATH` in `~/.zshrc`.
- `--uninstall` removes marcsh's app and the `marcsh` command. Your sessions, agents and packs in `~/.marcsh` stay.

To update, run the same command again. The previous version is kept, so a failed update leaves the version you had working.

To install a specific version, set `MARCSH_VERSION` and fetch the script from the same tag:

```
curl -fsSL https://raw.githubusercontent.com/webbegg/marcsh/v0.1.0/install.sh | MARCSH_VERSION=0.1.0 bash
```

Check which version you have with `marcsh --version`.

To roll back, run the installer again with the previous version, as shown above. For example, set `MARCSH_VERSION=0.1.0`.

### From source

You can also run marcsh from a copy of this repository:

```
git clone https://github.com/webbegg/marcsh.git
cd marcsh
bun install
bun run link:cli
```

`link:cli` builds the CLI and links it with Bun. The `marcsh` command runs the code in this folder, so you do not need to link again after you pull changes. If the command is not found, run `packages/cli/bin/marcsh` from the repository. On Linux, if the launcher fails with an error about `env`, see [Troubleshooting](docs/troubleshooting.md#an-error-from-env-about-the--s-option).

## Launch

Go to the folder you want to work on and start marcsh:

```
cd ~/projects/my-app
marcsh
```

marcsh works on the folder you start it in. `marcsh --version` prints the version, and `marcsh --help` lists the options.

## Quick start

1. Start `marcsh` in your project folder.
2. If the status line says `no model · run /login`, type `/login` and follow the steps.
3. Type a task and press `Enter`, for example `Explain what src/index.ts does`.
4. When a prompt asks for approval, press `y` to allow it once.

[Getting started](docs/getting-started.md) has the full first task.

## Documentation

### Using marcsh

- [Getting started](docs/getting-started.md): your first task, from start to quit.
- [Plan, then build](docs/guides/plan-then-build.md): make a change safely.
- [Resume your work](docs/guides/resume-work.md): pick up where you left off.
- [Install a pack](docs/guides/install-a-pack.md): add what someone shared.

### Customizing it

- [Write an agent](docs/guides/write-an-agent.md): make an agent for a job.
- [Switch engine or model](docs/guides/switch-engine-or-model.md): use Claude or another model.
- [Agents](docs/agents.md): an agent is a role with a permission level, such as Build or Plan. Switch agents and write your own.
- [Configuration](docs/configuration.md): files under `~/.marcsh`, MCP servers and environment variables.

### Building packs

- [Build and publish a pack](docs/guides/publish-a-pack.md): build a pack and share it.
- [Building a pack](docs/building-a-pack.md): the layout and files of a pack.
- [Pack hooks](docs/pack-hooks.md): commands a pack can run around tool calls. They stay off until you turn them on.

### Reference

- [Commands](docs/commands.md): every `/` command and the key bindings.
- [The screen](docs/screen.md): the screens, the input, the status line, toasts and approval prompts.
- [Sessions](docs/sessions.md): a session is one saved conversation. Start, find and resume them.
- [Engines and models](docs/engines-and-models.md): the engine is what runs the conversation, pi or Claude. Choose a model and sign in.
- [Packs](docs/packs.md): a pack is a public GitHub repository that adds agents, skills and commands. Install one from GitHub.
- [Security](docs/security.md): what marcsh asks about, what it trusts and what it never runs.
- [Troubleshooting](docs/troubleshooting.md): common problems and their messages.

## License

marcsh is released under the [MIT License](LICENSE).
