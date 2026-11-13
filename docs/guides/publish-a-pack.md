# Build and publish a pack

Build a pack, test it and publish it on GitHub.

You have a reviewer agent and a checklist skill, and you want your team to install them. This guide builds a minimal pack, tests it, and publishes it on GitHub.

In the examples, `you/review-pack` is your GitHub user and repository. Replace it.

## Build it

1. Make the folders and start a repository:

   ```sh
   mkdir -p review-pack/agents review-pack/skills/checklist
   cd review-pack
   git init
   ```

2. Save `agents/reviewer.md` (the fields are in [Frontmatter fields](../agents.md#frontmatter-fields)):

   ```markdown
   ---
   name: Reviewer
   description: Reviews a change with the team checklist; changes nothing
   permission: read-only
   tools: Read, Grep, Glob
   ---
   You are the Reviewer. Read the change and report what could break.

   Use the checklist skill before you answer.
   ```

3. Save `skills/checklist/SKILL.md`:

   ```markdown
   ---
   name: checklist
   description: Use this when reviewing a change; lists what to check
   ---
   Check each item and report the ones that fail:

   - The change has a test.
   - Errors are handled, not ignored.
   - Nothing private is committed.
   ```

The prompt says when to use the skill. That matters: a pack's skills and commands load only while one of its agents is selected. A pack needs at least one agent. Skills and commands are optional. See [Layout](../building-a-pack.md#layout).

You can also ask marcsh to help. Type `/marcsh:agent-workflows`, or ask in plain words. It helps you write the agent, set up the pack layout and run a checklist. It is told to leave pushing to you.

## Test it from a branch

marcsh installs only from GitHub, so test from a branch.

1. Commit and push the pack to a **public** repository on a branch (create the repository on GitHub first):

   ```sh
   git remote add origin https://github.com/you/review-pack.git
   git add .
   git commit -m "Reviewer agent and checklist skill"
   git push -u origin HEAD:my-branch
   ```

2. Type `/agents install you/review-pack@my-branch`. Read the preview, press `Down` then `Enter` to choose **Install**, and select the agent with `Tab`. Ask for a review. The agent should use the checklist skill.
3. After you push a fix, run `/agents update you/review-pack` and press `Down` then `Enter` to choose **Update**. Use the name without `@ref`.

Tip: to try the agent alone before you push, copy `agents/reviewer.md` to `~/.marcsh/agents/`. The skill does not load for a personal agent. If you keep the copy next to the installed pack, both agents get a prefix (`user/Reviewer` and `you/review-pack/Reviewer`), so delete the copy when you are done. A toast that starts with `Warning:` tells you something about the agent. See [Warnings](../agents.md#warnings).

## Publish it

1. Merge your work into the default branch of the public repository, and push.
2. Tell people to install it:

   ```
   /agents install you/review-pack
   ```

3. For versions, push a tag and tell people to use it:

   ```sh
   git tag v1.0.0
   git push origin v1.0.0
   ```

   ```
   /agents install you/review-pack@v1.0.0
   ```

marcsh pins every install to the exact commit the user saw. People move to a newer commit only when they run `/agents update` and accept the new preview. See [Security](../security.md#packs).

## Check it works for others

Remove your test install: type `/agents remove you/review-pack`, then press `Down` then `Enter` to choose **Remove**. Then follow [Install a pack](install-a-pack.md) from a different folder.

If you see `Pack rejected: …`, nothing was kept. See [What marcsh rejects](../building-a-pack.md#what-marcsh-rejects).

## Next

- [Building a pack](../building-a-pack.md): [layout](../building-a-pack.md#layout), [the checklist before you publish](../building-a-pack.md#check-before-you-publish), size limits and [hooks](../building-a-pack.md#hooks).
- [Pack hooks](../pack-hooks.md): what your users see before they turn hooks on.
- [Packs](../packs.md): how users install, update and remove.
