# Plan, then build

Make a change safely: plan with Plan, then let Build carry it out.

Use this when a change touches more than one file, or when you want to see the approach before anything is written. You ask the Plan agent for a plan. Plan only reads, so nothing changes. When the plan looks right, you switch to Build and let it carry the plan out.

The example: your project is a small command-line tool, and you want it to accept a `--verbose` flag.

## Steps

1. **Start marcsh in the project folder.** The status line under the input names the agent first. marcsh remembers the agent you used last, so you may not start on Build:

   ```
   Build › anthropic/claude-opus-5-5 · pi v1.5.0
   ```

2. **Switch to Plan.** Press `Tab` until the status line starts with `Plan`, or type `/agents` and pick Plan. Plan can read your files and search them. It cannot write files or run commands.

3. **Ask for a plan, not for code.** Type this and press `Enter`:

   ```
   Plan how to add a --verbose flag to the CLI. Look at @src/ first. Do not change anything.
   ```

   The `@src/` part is a [file mention](../screen.md#file-mentions). Type `@src/`, pick a file with `Up`, `Down` and `Enter`, or just keep typing the name.

4. **Read the plan.** The agent reads files, then answers with a list of steps: which files change and what each change is. You might see something like:

   ```
   1. Add a `verbose` option in src/args.ts.
   2. Pass it to the logger in src/main.ts.
   3. Add a test in src/args.test.ts.
   ```

5. **Adjust it.** The conversation goes on, so reply to the plan like you would to a colleague:

   ```
   Good. Also document the flag in the README.
   ```

   Plan answers with a new version. Repeat until you are happy. Nothing has changed on disk yet.

6. **Switch to Build.** Press `Tab` until the status line starts with `Build`, or type `/agents` and pick Build. The switch applies from your next message, in the same conversation, so Build has the plan in front of it.

7. **Tell Build to carry it out:**

   ```
   Carry out the plan.
   ```

8. **Approve what it wants to do.** A prompt appears when Build wants to write a file or run a command. Press `y` to allow it once. The other keys are in [The screen](../screen.md#approving-tool-calls).

9. **Check the result.** The conversation lists each edit. Ask Build to prove it works:

   ```
   Run the tests.
   ```

   Approve the command with `y`. If something fails, say what you see. Build fixes it in the next turn.

## If you ask Plan to change something

On pi, Plan is only given reading tools, so it cannot write files or run commands. Switch to Build and ask again. See [Security](../security.md#plan-is-read-only) for what Plan can do on each engine.

## Next

- [Agents](../agents.md#switch-agents): how `Tab` and `/agents` order and switch agents, and how to write your own planner.
- [Security](../security.md#git-guard): commits and pushes always get a check, even in Build.
- [Resume your work](resume-work.md): come back to this conversation tomorrow.
