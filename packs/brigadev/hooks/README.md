# brigadev evidence gate (hooks)

Port of brigadev's evidence gate to marcsh pack hooks. One script, `hooks/evidence.ts`, runs in three modes. It needs only `bun` on the `PATH` and has no npm dependencies. `hooks.json` runs each mode as `bun "${CLAUDE_PLUGIN_ROOT}/hooks/evidence.ts" <mode>` with a 30 second timeout.

| Event (matcher) | Mode | What it does |
| --- | --- | --- |
| `PreToolUse` (`Bash\|Edit\|Write\|MultiEdit\|NotebookEdit`) | `pre` | Three checks, in this order. 1. A Bash command that **writes** to the evidence folder is blocked, and so is an Edit or Write whose path is inside it (any repo's `<home>/<repo>/evidence/`, symlinks and `..` resolved). Reading stays allowed. 2. A recognized `git commit` is blocked (exit 2, with the reason on stderr) when the repository has source changes and no passing test run is recorded for the current working tree. 3. For a check command (tests, lint, typecheck, build), it notes the tree the command starts on. |
| `PostToolUse` (`Bash`) | `post` | Records a finished check command. The call worked, so the exit code is 0. |
| `PostToolUseFailure` (`Bash`) | `post-failure` | Records a failed check command. The exit code is parsed from `error`. |

## The gate

- **Recorded runs.** Each check command goes to `~/.brigadev/<repo>/evidence/<branch>.jsonl` (`BRIGADEV_HOME` replaces `~/.brigadev`; `<repo>` is the basename of the main worktree root, so all worktrees share one folder; a detached HEAD uses `detached.jsonl`). One JSON line per run, with brigadev's field names: `v`, `type: "run"`, `ts`, `branch`, `tree`, `cwd`, `agent` (`MARCSH_AGENT`, else `parent`), `command` (first 500 characters), `kind` (`test` or `check`), `exitCode`, `outcome` (`pass`, `fail`, `unknown`), `tail` (last 20 lines, at most 2,000 characters), and `note` when the outcome could not be trusted. The file is mode 0600, the folder 0700. Outside git nothing is recorded.
- **What counts.** Only `kind: "test"` with `outcome: "pass"` on the current tree unlocks a commit. Test commands are those of brigadev's classifier (`npm test`, `npm run test:*`, `node --test`, `pytest`, `go test`, `cargo test`, `vitest`, `jest`, ...) plus `bun test` and `bun run test`. Lint, typecheck and build runs are recorded but never unlock a commit.
- **Exit-code rule.** The test must be the command itself, alone or in an `&&` chain. A `;`, `||`, `&`, `!`, comment, subshell, `$(...)`, backtick or a `|` after it, or an `exit`, `exec`, `eval` or `source` before it, makes the run `unknown` (a leading `set -o pipefail;` allows a pipe). `echo npm test` and `grep "node --test" package.json` do not count. Help, version and listing flags (`--help`, `-v`, `--collect-only`, `--dry-run`, ...) do not count. A `cd` before the test must stay inside the repository. A package-manager run counts only as plain `npm test` (optionally `-s`, arguments after `--`) and without `npm_config_*` variables. `bun test` is bun's own runner, so its flags and paths are the runner's (`bun test --timeout 60000 ./x`).
- **Tree key.** The key is the git tree id of every non-ignored file as it is on disk, computed in a throwaway index (the real index and `.git/objects` are never touched). Commits do not change it; any edit does. A run counts for a tree only if the tree was the same before and after the run: `pre` stores the tree under `evidence/.pending/<key>.json` (key = hash of session, directory and command; on Claude of the session, `tool_use_id` and command), and `post` compares it with the tree after. If they differ, or the "before" note is missing, the run is recorded `unknown` with a `note` and no tree. Notes older than a day are pruned.
- **Prose-only changes pass without a test.** `.md`, `.markdown`, `.rst`, `.adoc`, `LICENSE`, `NOTICE`, `COPYING` and `AUTHORS`. `.txt` and `.mdx` count as source.
- **Fails closed.** If the tree cannot be computed (git takes longer than 10 s, a corrupt index, a missing directory), the commit is blocked with that reason. A commit that runs elsewhere (`cd other && git commit`, `git -C other commit`, `GIT_DIR=...`, after a branch switch) cannot be checked and is blocked. If `pre` crashes or cannot read its input, a payload that looks like a commit (or names `evidence`) is blocked with exit 2. Outside git a commit is allowed.
- **Applies in every permission mode,** including yolo, and to every agent in the turn.

## Bypass

Hooks can only block, never approve, so there is no force flag, command or variable. The user bypasses the gate by turning this pack's hooks off with `/agents hooks`, committing, and turning them back on. The model cannot do that. (A change to any file of the pack turns the hooks off until the user reviews them again.)

## Data stored (sensitive)

`~/.brigadev/<repo>/evidence/` holds commands and **output tails in plaintext** (tests can print secrets, paths and tokens), plus `.pending/` notes with a tree id. Files are 0600 and the folder 0700. Treat it as sensitive: do not share or commit it. Nothing is sent anywhere.

## Payloads this relies on

Verified in marcsh and pi at the time of writing:

- pi, a successful Bash call: `tool_response` is `{content: [{type: "text", text}], is_error: false}` and carries **no exit code** (`packages/cli/src/lib/engine/pi-pack-hooks.ts:326`).
- pi, a non-zero exit: only `PostToolUseFailure`, with `error` = the output text ending `\n\nCommand exited with code N` (`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js:297`). A timeout or abort throws `Command timed out after N seconds` / `Command aborted` (`bash.js:271,275`), so there is no code: `unknown`.
- pi `bg_start` reaches the hooks as `tool_name: "Bash"` with `{command}` (`pi-pack-hooks.ts:22,27,28`), and its PostToolUse fires when the process starts, with the text `Started background terminal ...` (`packages/cli/src/lib/background/terminal-prompt.ts:45`, `pi-bg-tools.ts:103`). That is not a finished run: it is ignored, so a test started in the background is never recorded.
- pi payload keys: `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, plus `permission_mode` and `agent` when known; **no `tool_use_id`** (`pi-pack-hooks.ts:261,324-326`). A `PreToolUse` that times out blocks the call; any exit code but 2 does not block (`pi-pack-hooks.ts:148-153`). Hooks run before approval (`pi-pack-hooks.ts:12`).
- Claude: hooks are wrapped by `packages/cli/plugin/hooks/pack-hook-filter.ts`, which passes the exit code and stderr through (`:100-120`). `PostToolUseFailure` has `error` and `tool_use_id`.

**Assumptions not verified** (when they do not hold, the run is `unknown`, never a pass):

- Claude's `error` for a failed Bash call starts with `Exit code N`. The engine is told apart by `tool_use_id` (Claude has one, pi has none), and only that engine's form is trusted, so a command cannot print the other engine's form to forge a code. A failure that says code 0 is `unknown`.
- Claude's successful Bash `tool_response` is `{stdout, stderr, interrupted}` (read as text; `interrupted: true` is `unknown`). A call with `run_in_background` or a `backgroundTaskId` is ignored. Claude's `BashOutput` has no exit code, so background runs are not recorded there either.

## Limitations

- A best-effort guard, not a sandbox. It recognizes commands by their executable form, like brigadev's classifier: shell aliases, `git commit-tree`, wrappers and scripts that commit are not gated, and an obfuscated command (a path built from variables, `cd` then a relative write into the evidence folder) is not prevented. Deliberate tricks with runner options or environment can still fake a pass (a package script that is not a test, `bun test -t nomatch` running zero tests). Known commit forms that pass ungated: a backtick substitution (`` echo `git commit` ``), wrapper options that take a value (`sudo -u me git commit`, `nice -n 5 git commit`, `env -u FOO git commit`), and git aliases (`git -c alias.ci=commit ci`). A write into the evidence folder through `$BRIGADEV_HOME` or a quoted path segment is not caught.
- On Claude, a hook that times out does not block the call (on pi it does). The gate's git calls are bounded (10 s for the tree, 5 s for each other lookup) under the 30 s hook timeout, but a very slow git could still let a commit through on Claude.
- A hook that cannot run is not a gate: without `bun` on the `PATH`, or with the hooks off, nothing is checked (a `PreToolUse` hook that exits with anything but 2 does not block).
- Two identical test commands running at the same time in one session on pi share a "before" note; one of them is recorded `unknown` (never a false pass).
- Test runs started in the background, and runs of a command that `cd`s out of the repository, are recorded `unknown` or not at all.
- Hook latency: `pre` for a commit computes the tree (up to 10 s) and runs a few git commands, normally about a second.

## Tests

From the repo root: `bun test ./packs/brigadev/hooks` (works with the root `bunfig.toml` preload; `cd packs/brigadev/hooks && bun test` works too). `test/unit.test.ts` covers the pure logic; `test/e2e.test.ts` spawns `bun hooks/evidence.ts <mode>` with JSON on stdin against a temporary git repository with `BRIGADEV_HOME` in a temp directory. The e2e file takes about a minute (every case spawns several hook processes).

Vendored from `brigadev-pi-harness` v0.16.0: `lib/shell.ts` (command-classifier), `lib/evidence.ts`, `lib/tree.ts` (worktree-tree, worktree-snapshot), `lib/home.ts` (repo-docs), `lib/paths.ts`, `lib/guard.ts` (guard-rules). Keep them in step by hand.
