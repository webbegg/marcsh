# Pack hooks

A pack can ship hooks: small commands that run around the model's tool calls, for example to block a risky command. They are **off by default**. They run only after you read the commands and turn them on, and only while one of that pack's agents is selected.

Read this page before you enable hooks from a pack you did not write. A hook is a program that runs on your computer.

## What a hook can do

A hook can **narrow**. It can:

- block a tool call before it runs, with a reason the model sees;
- stop (`"continue": false`): on pi this blocks the call, on Claude it stops the turn;
- give the model feedback after a tool call.

A hook can **never widen**:

- It cannot approve a tool call. marcsh still asks you, as usual.
- It cannot change what the model asked for (the input of the call).

If a hook says `allow`, `ask` or `approve`, or sends a changed input, marcsh drops it. A call that a hook blocks never reaches you as a question.

## Turn hooks on

Hooks stay off when you install or update a pack. The install preview only says:

```
hooks: present, off — enable with /agents hooks owner/repo
```

To review and enable them:

```
/agents hooks owner/repo
```

You can also open `/agents`, choose **Pack hooks…**, and pick the pack. The list shows each pack that has hooks, with `hooks off`, `hooks on`, `hooks changed — off` or `hooks unusable` after it. Typing `/agents hooks` with no name opens the same list.

The review shows:

- the pack and the commit, for example `owner/repo @ 3f2a9c1`;
- each event, with its matcher (`all tools` or `matcher: Bash`), and the exact command under it, starting with `$`. A `timeout` is shown in seconds;
- the files in the pack's `hooks/` folder, with their sizes;
- which events run on which engine (see [Engines](#what-runs-on-each-engine));
- two reminders: `Hooks may run any file of this pack; the whole pack is pinned to this commit.` and `These commands run on your machine with your permissions while one of this pack's agents is selected.`

Read the commands, and read the files they run. Scroll with `Up`, `Down`, `PageUp`, `PageDown`, `Home`, `End` or the mouse wheel. **Enable** does not work until the end of the list has been on screen. Until then the dialog says `Scroll to the end to review all 2 commands`.

The first choice, **Cancel**, is selected. Choose **Enable** to turn the hooks on. `Esc` also cancels. A toast confirms: `Enabled hooks of owner/repo: they run while one of its agents is selected`.

Your pack agent's row in `/agents` now ends with `(hooks on)`.

## Turn hooks off

```
/agents hooks owner/repo off
```

This asks nothing. A toast says `Turned off hooks of owner/repo`.

You can also run `/agents hooks owner/repo` again. When hooks are on, the review reads `Hooks are on. They run these commands:` and the second choice is **Turn off**.

## When consent no longer counts

When you enable hooks, marcsh records your consent for **one commit** and for **the exact files**: everything in the pack's `hooks/`, `skills/` and `commands/` folders. Hooks can run any file of the pack, so all of it is covered.

Hooks turn off by themselves when:

- You **update** the pack to a new commit. The update preview says `Hooks turned off; review them again with /agents hooks owner/repo`, and so does the toast after it.
- Any of those files **changes** on disk after you enabled them.

When that happens, the agent's row in `/agents` reads `(hooks changed — off)`. The review says `Hooks changed — off. Enabling runs these commands:` and `They changed since you last enabled them, so they were turned off.` You have to read them and enable them again.

Warnings you can see:

```
owner/repo: hooks are off because their files changed since you approved them; review them with /agents hooks owner/repo
```

This one appears when you select the agent. At the start of a turn you can see:

```
owner/repo: hooks are off for this turn because their files no longer match what you approved. Review them with /agents hooks owner/repo
```

The turn still runs, without the hooks.

If `/agents hooks owner/repo` cannot enable the hooks, a toast says why:

| Message | Meaning |
| --- | --- |
| `owner/repo is not installed` | There is no such pack. |
| `owner/repo has no hooks` | The pack has no `hooks/` folder. |
| `The hooks of owner/repo cannot be enabled: …` | The pack's hooks are unusable, and the reason follows. They can never be enabled. |
| `The hooks of owner/repo changed since you reviewed them; open /agents hooks owner/repo again` | Something changed while the review was open. Nothing was enabled. |

## What runs on each engine

Only the events that matter for tool calls run on both engines.

| Event | Claude | pi |
| --- | --- | --- |
| `PreToolUse` | yes | yes |
| `PostToolUse` | yes | yes |
| `PostToolUseFailure` | yes | yes |
| Every other event (`SessionStart`, `Stop`, …) | yes | no |

The review lists them, for example `PreToolUse, PostToolUse run on Claude and pi; Stop run on Claude only.` If you use pi and the pack has other events, selecting its agent shows `owner/repo: hooks for Stop run on Claude only`.

### What blocks and what times out

- On both engines, exit code 2 blocks the call, and what the hook wrote to its error output is the reason. A JSON answer that says block or deny blocks too. Anything that would approve a call or change its input is dropped.
- On pi, hooks run **before** the approval prompt. Because a blocked call never asks, you only see questions for calls that every hook let through.
- On pi, another non-zero exit does not block. A toast shows a notice, for example `Warning: Pack hook PreToolUse (sh "${CLAUDE_PLUGIN_ROOT}/hooks/check.sh"): exit 1: message`. The text in parentheses is the hook's command, cut to 60 characters.
- On pi, exit code 2 from a `PostToolUse` or `PostToolUseFailure` hook gives the model feedback next to the tool's own result. It does not change the result.
- A hook has 60 seconds on pi, unless its `timeout` (in seconds) says otherwise. On Claude, the `timeout` goes to Claude.
- **On pi, if a `PreToolUse` hook times out, cannot start, or is cut off because the turn ended, marcsh blocks the call.** A check that did not finish is not a pass. On Claude, a hook that times out does not block the call.

## Background processes are stopped

Hooks are checks, not services. When a hook finishes, marcsh stops everything it left running in the background (for example a command started with `&`).

## Limits

Hooks are powerful. Be clear about what they cannot protect you from:

- **A hook runs with your permissions.** It can read and change any file you can, including marcsh's own files and Claude's settings. Consent is your decision to trust the pack's author. See [Security](security.md).
- **Changes during a turn are noticed at the next turn.** marcsh checks that the files still match what you approved at the start of each turn. If a file changes while a turn runs, marcsh checks it again at the next turn.
- **The review needs room.** Use a terminal at least 16 rows tall. A narrow window needs more rows, because the header wraps. In a smaller one, the commit line or the choices can be cut off. Make the window larger.

## Next

- Write hooks for your own pack: [Building a pack](building-a-pack.md#hooks).
- Install and update packs: [Packs](packs.md).
- The whole safety picture: [Security](security.md).
