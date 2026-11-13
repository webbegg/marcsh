# Install a pack

Install a pack someone shared with you.

A teammate sends you `acme/review-pack`, a public GitHub repository with agents for marcsh. This guide installs it, finds its agents, and shows how to update and remove it.

## Install it

1. In the input, type:

   ```
   /agents install acme/review-pack
   ```

   You see `Fetching acme/review-pack…`. Press `Esc` if you want to stop. Nothing is kept.

2. Read the preview. It looks like this:

   ```
   acme/review-pack @ 3f2a9c1
   Agents:
    • Reviewer (read-only, no edit, bash)
   Skills: tdd
   hooks: present, off — enable with /agents hooks acme/review-pack
   Not used: .mcp.json
   Check: skills/tdd/SKILL.md pre-approves tools (allowed-tools)
   Pack hooks stay off until you enable them.
   MCP servers are not run.
   ```

   Check four things:
   - **Agents.** Each one shows its permission (`read-only` or `build`), its model if it sets one, and its tools. `no edit, bash` means those tool groups are removed. `tools: read` lists the groups that are kept when four or more are removed. A `build` agent asks before it writes or runs, like Build.
   - **`Not used`.** Parts of the pack that marcsh ignores, such as `.mcp.json`.
   - **`Check:`.** Something worth a look. Here, a skill that pre-approves tools.
   - **`hooks:`.** Hooks are programs. They stay off. See [Pack hooks](../pack-hooks.md#turn-hooks-on) before you turn them on.

   The agents' prompts are in the repository. Read them if you do not know the author. See [Security](../security.md#packs).

3. Choose **Install**. The first choice, **Cancel**, is selected, so press `Down` to reach **Install**, then `Enter`. `Esc` cancels.

4. A [toast](../screen.md#toasts) in the top right corner says `Installed acme/review-pack (1 agent)`.

You can pin a branch, a tag or a full 40-character commit hash: `/agents install acme/review-pack@v1.2.0`. Without `@`, you get the default branch. Either way, marcsh keeps the exact commit you saw in the preview.

## Use its agents

Press `Tab` in the input. It goes through Build, Plan, your personal agents, then the agents of your packs. Stop on `Reviewer`. The status line shows the name. The agent applies from your next message.

You can also type `/agents` and pick it from the list.

A toast that starts with `Warning:` tells you something about the agent you picked, such as a field it ignores or hooks that are off. The agent still works. See [Warnings](../agents.md#warnings).

If two agents have the same name, marcsh adds a prefix to both. Your personal copy shows as `user/Reviewer` and the pack one as `acme/review-pack/Reviewer`.

## Update it later

Updates are never automatic. When you want the newest version:

1. Type `/agents update acme/review-pack`.
2. If a toast says `acme/review-pack is up to date`, you are done.
3. Otherwise you see the change, for example `acme/review-pack: 3f2a9c1 → 8b41d07`, with a new preview. Press `Down` then `Enter` to choose **Update**.
4. A toast says `Updated acme/review-pack to 8b41d07`.

If the pack's hooks were on, the update turns them off. Review them again with `/agents hooks acme/review-pack`.

Use the plain name. A pack pinned to a commit stays on that commit, so `update` has nothing to move.

## Remove it

1. Type `/agents remove acme/review-pack`.
2. marcsh asks `Remove acme/review-pack (3f2a9c1)?`. Press `Down` then `Enter` to choose **Remove**.
3. A toast says `Removed acme/review-pack`.

If the pack's agent was selected, marcsh goes back to Build.

## If it fails

A toast says why. The two likely ones:

- `… was not found, or it is private: marcsh installs public repositories only`: check the name. The repository must be public.
- `acme/review-pack is already installed; use update to move it to a newer commit`: run `/agents update acme/review-pack`.

The full list is in [Packs](../packs.md#error-messages). marcsh needs `git` on your path.

## Next

- [Packs](../packs.md): what a pack holds, [limits](../packs.md#limits) and where packs live.
- [Pack hooks](../pack-hooks.md): read and enable a pack's hooks.
- [Build and publish a pack](publish-a-pack.md): share your own.
