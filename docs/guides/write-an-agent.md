# Write an agent

Write your own agent for a job.

You want a second pair of eyes on your changes, but you do not want it to touch your files. This guide writes a read-only `Reviewer` agent, selects it, and improves it.

A personal agent is one Markdown file. It works in every project. marcsh never loads agents from a project folder.

## Write it

1. Create the folder in a terminal:

   ```sh
   mkdir -p ~/.marcsh/agents
   ```

2. Save this as `~/.marcsh/agents/reviewer.md`:

   ```markdown
   ---
   name: Reviewer
   description: Reads the diff and reports risks; changes nothing
   permission: read-only
   tools: Read, Grep, Glob
   ---
   You are the Reviewer. Your lane is review: read the change and report what could break.

   - Read the diff and the code around it before judging.
   - Report findings as a list: file, line, the risk, a suggested fix.
   - Never edit files or run commands that change anything.
   - End with one line: the riskiest item, or "no findings".
   ```

3. Know what each part does:
   - `name` is what the status line and `/agents` show. Without it, the file name is used.
   - `description` is one line shown after the name in `/agents`.
   - `permission: read-only` works like Plan: the agent cannot write files or run commands. `build` is the default and asks before it writes or runs.
   - `tools` takes tools away. `Read, Grep, Glob` removes the edit, bash, web, task and mcp groups. Tools that belong to no group are not touched. It never adds a tool. See [Limit tools](../agents.md#limit-tools).
   - Everything after the second `---` is the prompt. marcsh adds it to the engine's own prompt. Write only the role.

   The other fields are in [Frontmatter fields](../agents.md#frontmatter-fields).

## Select it

1. Type `/agents`. marcsh reads the folder again, so you do not need to restart.
2. Find `Reviewer`. The row reads `Reviewer  (read-only)  (limited tools)  Reads the diff and reports risks; changes nothing`. Press `Enter` to select it.
3. You can also press `Tab` in the input. The order is Build, Plan, your personal agents, then pack agents.
4. Check the status line. It shows `Reviewer` on the left.

The agent applies from your next message. Ask something real, for example `Review my last commit`.

## Check the warnings

If a [toast](../screen.md#toasts) in the top right corner starts with `Warning:`, marcsh ignored or changed something. The agent still works. See [Warnings](../agents.md#warnings).

## Improve it

1. Edit the prompt in `reviewer.md`. Add a rule where the first answer was weak.
2. Open `/agents` again so marcsh reads the file, and select the agent.
3. Send your next message. The change applies from there.

To give the agent its own model, add a `model` line. On Claude, use a name that starts with `claude`, or an alias such as `sonnet`. On pi, use `provider/id`. Leave it out to use the session model. See [Model and fallback](../agents.md#model-and-fallback).

If a tool call still asks for approval, that is normal. See [approving tool calls](../screen.md#approving-tool-calls).

## Next

- [Agents](../agents.md): all fields, names and labels, engine differences.
- [Build and publish a pack](publish-a-pack.md): share the agent with others.
- [Install a pack](install-a-pack.md): use agents others wrote.
