import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "guard.ts");

// Isolate from the developer's own git config (signing, hooks, templates).
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: gitEnv,
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function runGuard(input: unknown, cwd: string = process.cwd()) {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const result = Bun.spawnSync(["bun", GUARD], { cwd, env: gitEnv, stdin: new TextEncoder().encode(stdin) });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

const hook = (command: string, cwd: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });

let root = "";
let repo = "";
let plain = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "marcsh-guard-"));
  repo = join(root, "repo");
  plain = join(root, "plain");
  Bun.spawnSync(["mkdir", "-p", repo, plain]);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("guard.ts (hook script)", () => {
  test("denies git commit on main with the exact reason", () => {
    const { code, out } = runGuard(hook('git commit -m "x"', repo));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "marcsh: commits on main are blocked; create a branch first (git switch -c <type>/<description>)",
      },
    });
  });

  test("still denies on main when a tag is also named main", () => {
    git(repo, "tag", "main");
    try {
      expect(JSON.parse(runGuard(hook('git commit -m "x"', repo)).out).hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      git(repo, "tag", "-d", "main");
    }
  });

  test("allows git commit on a feature branch (prints nothing)", () => {
    git(repo, "switch", "-q", "-c", "feat/x");
    const { code, out } = runGuard(hook('git commit -m "x"', repo));
    expect(code).toBe(0);
    expect(out).toBe("");
    git(repo, "switch", "-q", "main");
  });

  test("git -C <dir> commit judges the branch of that directory, not the cwd", () => {
    git(repo, "switch", "-q", "-c", "feat/y");
    // cwd is a non-repo; the repo is on a feature branch: no decision.
    expect(runGuard(hook(`git -C ${repo} commit -m x`, plain)).out).toBe("");
    git(repo, "switch", "-q", "main");
    expect(JSON.parse(runGuard(hook(`git -C ${repo} commit -m x`, plain)).out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("judges the branch a commit lands on after a switch earlier in the same command", () => {
    git(repo, "switch", "-q", "-c", "feat/real");
    git(repo, "commit", "-q", "--allow-empty", "-m", "feature work");
    try {
      // On a real feature branch, checking out main (an existing local branch) and committing lands on main.
      const out = runGuard(hook("git checkout main && git commit -m x", repo)).out;
      expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toBe(
        "marcsh: commits on main are blocked; create a branch first (git switch -c <type>/<description>)",
      );
      expect(JSON.parse(runGuard(hook("git switch main && git commit -m x", repo)).out).hookSpecificOutput.permissionDecision).toBe("deny");
      // A file path or a name that is not a local branch is not a switch.
      expect(runGuard(hook("git checkout -- main && git commit -m x", repo)).out).toBe("");
      expect(runGuard(hook("git checkout no-such-branch && git commit -m x", repo)).out).toBe("");
      // From main, switching to the existing feature branch first makes the commit allowed.
      git(repo, "switch", "-q", "main");
      expect(runGuard(hook("git switch feat/real && git commit -m x", repo)).out).toBe("");
      expect(runGuard(hook("git checkout feat/real && git commit -m x", repo)).out).toBe("");
      expect(JSON.parse(runGuard(hook("git commit -m x", repo)).out).hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      git(repo, "switch", "-q", "main");
    }
  });

  test("the default branch comes from origin/HEAD when it is set", () => {
    git(repo, "switch", "-q", "-c", "develop");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    try {
      expect(JSON.parse(runGuard(hook("git commit -m x", repo)).out).hookSpecificOutput.permissionDecision).toBe("deny");
      git(repo, "switch", "-q", "main");
      expect(runGuard(hook("git commit -m x", repo)).out).toBe("");
    } finally {
      git(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
      git(repo, "switch", "-q", "main");
    }
  });

  test("asks for git push, gh pr create and publish, even outside a repo", () => {
    for (const [command, action] of [
      ["git push origin main", "git push"],
      ["gh pr create --fill", "gh pr create"],
      ["gh pr merge 3", "gh pr merge"],
      ["npm publish", "npm publish"],
    ] as const) {
      const { code, out } = runGuard(hook(command, plain));
      expect(code).toBe(0);
      expect(JSON.parse(out)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `marcsh: ${action} needs your approval`,
        },
      });
    }
  });

  test("prints nothing for unrelated commands, quoted text, and commits where git cannot answer", () => {
    expect(runGuard(hook("ls -la", repo)).out).toBe("");
    expect(runGuard(hook('echo "git push"', repo)).out).toBe("");
    // Not a repository: the branch lookup fails, so there is no decision.
    expect(runGuard(hook("git commit -m x", plain)).out).toBe("");
  });

  test("never fails on bad input", () => {
    for (const input of ["", "not json", "{}", "[]", "null", { tool_input: { command: 5 } }, { tool_input: {} }, { tool_input: { command: "git push" } }]) {
      const { code, err } = runGuard(input as never);
      expect(code).toBe(0);
      expect(err).toBe("");
    }
    // The last input has no cwd; it still asks for the push.
    expect(JSON.parse(runGuard({ tool_input: { command: "git push" } }).out).hookSpecificOutput.permissionDecision).toBe("ask");
  });
});
