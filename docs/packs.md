# Packs

A pack is a public GitHub repository that adds agents to marcsh, and can bring its own skills and commands. You install one with `/agents install`, see what is inside before anything is kept, and update it only when you decide to.

To write your own, see [Building a pack](building-a-pack.md). For a single agent that only you use, a [personal agent](agents.md#write-a-personal-agent) is simpler.

## What a pack holds

| In the repository | What marcsh does with it |
| --- | --- |
| `agents/*.md` | Each file is an agent. It works like a [personal agent](agents.md). |
| `skills/` | Skills for the engine. |
| `commands/` | Slash commands. |
| `hooks/hooks.json` | Hooks. They stay **off** until you turn them on. See [Pack hooks](pack-hooks.md). |

A pack needs at least one agent you can select. Everything else is optional.

marcsh does not run MCP servers from a pack. If the pack lists some, the preview shows them under `Not used`.

## Install a pack

Type this in the input:

```
/agents install owner/repo
```

You can also pin a branch, a tag or a commit with `@`:

```
/agents install owner/repo@v1.2.0
```

For a commit, use the full 40-character hash. The short hash that previews show does not work after `@`.

A full GitHub address works too: `https://github.com/owner/repo` (with `@ref` after it if you like). You can also open `/agents` and choose **Install from GitHub…**, then type the same text.

marcsh then:

1. Shows `Fetching owner/repo…` while it downloads. Press `Esc` to stop. See [Cancel a download](#cancel-a-download).
2. Shows a preview of the pack.
3. Waits for your answer. The first choice, **Cancel**, is selected. Choose **Install** to keep the pack. `Esc` also cancels.

Nothing is kept before you choose **Install**. When it is done, a toast says `Installed owner/repo (1 agent)`.

The new agents appear in `/agents` and in the `Tab` order, after your personal agents. Pack names are lowercase: `Owner/Repo` becomes `owner/repo`.

### The preview

The preview lists what the pack holds and what marcsh will not use:

```
owner/repo @ 3f2a9c1
Agents:
 • Reviewer (read-only, no edit, bash)
Skills: tdd
Commands: ship
hooks: present, off — enable with /agents hooks owner/repo
Not used: .mcp.json
Check: skills/tdd/SKILL.md pre-approves tools (allowed-tools)
Pack hooks stay off until you enable them.
MCP servers are not run.
```

- `3f2a9c1` is the start of the commit you are about to install.
- Each agent shows its permission (`read-only` or `build`), its model if it sets one, and a summary of its `tools` field.
- `Not used` lists parts of the pack that marcsh ignores, such as `.mcp.json`, or hooks and MCP servers declared in the pack's plugin manifest.
- `Check:` lines point at something that deserves a look. For example, a skill that pre-approves tools with `allowed-tools`.
- The `hooks:` line appears only when the pack has a `hooks/` folder. It says `present, off`, or `present but unusable (reason); they can never be enabled`.

Read the agents' prompts in the repository if you want to know more. A pack's prompt can tell the model to do anything an agent may do, and your approvals are still the safety net. See [Security](security.md).

### Pinned commit

marcsh remembers the exact commit you saw. The pack stays on that commit until you update it. Even if you installed a branch such as `@main`, new commits on that branch do not reach you by themselves.

## Update a pack

```
/agents update owner/repo
```

Without a name, `/agents update` opens a list of installed packs. You can also open `/agents` and choose **Update packs…**.

marcsh checks the pack's branch or tag again (the default branch if you gave no ref). Then:

- If nothing changed, a toast says `owner/repo is up to date`.
- Otherwise it shows the change as `owner/repo: 3f2a9c1 → 8b41d07`, with the new contents in the same preview as an install. Choose **Update** to switch, or **Cancel**.

On success, a toast says `Updated owner/repo to 8b41d07`.

Updates are never automatic. A pack installed with a commit as its ref never moves.

If the pack's hooks were on, an update turns them off. The preview says `Hooks turned off; review them again with /agents hooks owner/repo`. See [Pack hooks](pack-hooks.md).

Use `owner/repo` without `@ref` for update and remove. marcsh keeps the ref you installed with.

## Remove a pack

```
/agents remove owner/repo
```

marcsh asks `Remove owner/repo (3f2a9c1)?` and says `Its agents, skills and commands are deleted from ~/.marcsh/packs.` Choose **Remove**. A toast says `Removed owner/repo`.

If you remove the pack whose agent is selected, marcsh goes back to Build.

You can also open `/agents` and choose **Remove a pack…**.

## Where packs live

Packs are stored under `~/.marcsh/packs/`:

- `~/.marcsh/packs/owner/repo/` holds one pack.
- `~/.marcsh/packs/packs.json` records each installed pack and the commit it is pinned to. Do not edit it by hand.

To keep packs somewhere else, see [Configuration](configuration.md).

## Skills and commands load per agent

A pack's skills and commands are available only **while one of that pack's agents is selected**. Build, Plan and your personal agents do not see them. They keep marcsh's own skills and commands. So a pack agent's prompt should say when to use which skill.

## Cancel a download

While `Fetching owner/repo…` or `Checking owner/repo for updates…` is on screen, press `Esc`. marcsh stops Git and keeps nothing. A toast says `Install cancelled` or `Update cancelled`. For an update, the installed pack stays as it was.

Once the preview is on screen, the download is done. `Esc` then answers **Cancel**.

## If something goes wrong

### Error messages

If a command fails, a toast shows one of these:

| Message | What to do |
| --- | --- |
| `Cannot install "x": not a GitHub repository. Use owner/repo, owner/repo@ref or https://github.com/owner/repo` | Check the spelling. Only these three forms work. marcsh adds the usage line (below) to this and the next two messages. |
| `Cannot install "x": the owner or repository name has characters GitHub does not allow. …` | Check the owner and repository names. |
| `Cannot install "x": the ref is not a plain branch, tag or commit name. …` | Use a simple branch, tag or commit name after `@`. |
| `https://github.com/owner/repo.git was not found, or it is private: marcsh installs public repositories only` | Check the name. The repository must be public. |
| `owner/repo is already installed; use update to move it to a newer commit` | Run `/agents update owner/repo`. |
| `owner/repo is not installed` | Check the name with `/agents`. |
| `owner/repo is not installed; did you mean Owner/Repo?` | Type the name as listed. |
| `owner/repo@v1 names a ref; update takes owner/repo.` | Leave the `@ref` out for update, remove and hooks. The usage line follows this message too. |
| `git fetch failed: timed out after 120 s` | Try again on a better connection, or use a smaller repository. |
| `git could not run: …` | Install `git` and make sure it is on your path. |
| `Pack rejected: …` | The pack broke one of marcsh's rules and nothing was kept. The text after the colon says which. [Building a pack](building-a-pack.md#what-marcsh-rejects) lists every rule and its message. |

If you type a command wrong, marcsh shows the usage line:

```
Usage: /agents install <owner/repo[@ref]> | update [<owner/repo>] | remove <owner/repo> | hooks [<owner/repo> [off]]
```

For other problems, see [Troubleshooting](troubleshooting.md).

### Leftover folders

If marcsh is stopped at the wrong moment while it installs, a folder can remain in `~/.marcsh/packs/owner/repo` with no entry in `packs.json`. Its agents are not loaded, and installing the same pack says:

```
~/.marcsh/packs/owner/repo exists but is not an installed pack; run /agents remove owner/repo to clear it
```

Run `/agents remove owner/repo`. marcsh asks `Remove the leftover folder of owner/repo?`, and after you confirm, a toast says `Removed the leftover folder of owner/repo`.

### When `packs.json` cannot be read

If `~/.marcsh/packs/packs.json` is damaged, `/agents` shows a yellow line at the top and hides all pack agents:

```
packs.json could not be read: not valid JSON; pack agents are hidden
```

The part after the colon is `not valid JSON`, `no packs list`, or `read error` with a code. Fix the file, or delete it. Pack commands stop with the same reason until you do:

```
~/.marcsh/packs/packs.json cannot be read (not valid JSON); fix or delete it
```

If you delete it, marcsh forgets which packs are installed. Their folders become leftovers: run `/agents remove owner/repo` for each, then install the packs again.

## Limits

marcsh refuses a pack that is too big, so that a pack cannot fill your disk:

| Limit | Value |
| --- | --- |
| Download: the Git data of the one commit marcsh fetches, plus the checked-out files | 100 MB. marcsh stops the download as soon as it passes this. |
| Files and folders in the checked-out repository | 5,000 |
| Size of the checked-out files | 50 MB |
| One file in `skills/` or `commands/` | 1 MB |
| One agent file | 256 KB |
| Time for each Git step of the download | 120 seconds |

Keep a pack to prompts, skills and commands. Deleted history does not count, because marcsh fetches only one commit. A file you keep counts in both the Git data and the checked-out copy, so keep the files well under 50 MB.

## How marcsh keeps a pack in check

Only public repositories are installed, nothing in a pack runs at install, and you see the preview before anything is kept. A private repository looks like a missing one. marcsh needs `git` on your path. See [Security](security.md#packs) for the full list.

## Next

- Packs and hooks: [Pack hooks](pack-hooks.md).
- Write a pack: [Building a pack](building-a-pack.md).
- All `/agents` forms: [Commands](commands.md).
