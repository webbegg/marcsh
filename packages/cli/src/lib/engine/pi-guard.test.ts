import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../storage";
import { guardBashCommand, isBuiltinBash } from "./pi-guard";
import { createApprovalHandler, DENIED_REASON, PLAN_MODE_REASON, type ToolSource } from "./pi-permissions";
import type { PermissionAsk, PermissionDecision } from "./types";

const root = mkdtempSync(join(tmpdir(), "marcsh-pi-guard-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
// A real repository whose HEAD is `branch` (unborn is enough: the guard only reads the branch name).
function repo(branch: string): string {
  const dir = join(root, `repo-${count++}`);
  mkdirSync(dir);
  const git = Bun.spawnSync(["git", "init", "-q", "-b", branch], { cwd: dir, stdout: "ignore", stderr: "pipe" });
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  return dir;
}

const BRANCH_DENIED = (branch: string) =>
  `marcsh: commits on ${branch} are blocked; create a branch first (git switch -c <type>/<description>)`;

describe("guardBashCommand (guard-lib behind a real git lookup)", () => {
  test("git commit on the default branch is denied with guard-lib's reason", () => {
    const dir = repo("main");

    expect(guardBashCommand('git commit -m "x"', dir)).toEqual({ decision: "deny", reason: BRANCH_DENIED("main") });
    expect(guardBashCommand("git add -A && git commit -m x", dir)).toEqual({ decision: "deny", reason: BRANCH_DENIED("main") });
  });

  test("git commit on a feature branch is allowed", () => {
    expect(guardBashCommand("git commit -m x", repo("feat/thing"))).toBeNull();
  });

  test("creating a branch first in the same command moves the commit off the default branch", () => {
    expect(guardBashCommand("git switch -c feat/x && git commit -m x", repo("main"))).toBeNull();
  });

  test("git -C <dir> looks the branch up in that directory", () => {
    const here = repo("feat/here");
    const other = repo("main");

    expect(guardBashCommand(`git -C ${other} commit -m x`, here)).toEqual({ decision: "deny", reason: BRANCH_DENIED("main") });
  });

  test("shipping commands ask", () => {
    const dir = repo("feat/thing");

    expect(guardBashCommand("git push origin feat/thing", dir)).toEqual({ decision: "ask", reason: "marcsh: git push needs your approval" });
    expect(guardBashCommand("gh pr create --fill", dir)).toEqual({ decision: "ask", reason: "marcsh: gh pr create needs your approval" });
    expect(guardBashCommand("gh pr merge 3", dir)).toEqual({ decision: "ask", reason: "marcsh: gh pr merge needs your approval" });
    expect(guardBashCommand("npm publish", dir)).toEqual({ decision: "ask", reason: "marcsh: npm publish needs your approval" });
  });

  test("an ordinary command is no decision", () => {
    const dir = repo("main");

    expect(guardBashCommand("ls -la", dir)).toBeNull();
    expect(guardBashCommand('echo "git push"', dir)).toBeNull();
  });

  test("a directory that is not a repository, or does not exist, never blocks (fail open)", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);

    expect(guardBashCommand("git commit -m x", plain)).toBeNull();
    expect(guardBashCommand("git commit -m x", join(root, "missing"))).toBeNull();
  });

  test("a quote left open is no decision", () => {
    expect(guardBashCommand("git commit -m 'x", repo("main"))).toBeNull();
  });
});

describe("isBuiltinBash", () => {
  test("only pi's own bash tool is guarded; an extension tool named bash is not", () => {
    expect(isBuiltinBash({ name: "bash", sourceInfo: { path: "builtin:bash" } })).toBe(true);
    expect(isBuiltinBash({ name: "bash", sourceInfo: { path: "/agent/extensions/bash.ts" } })).toBe(false);
    expect(isBuiltinBash({ name: "powershell", sourceInfo: { path: "builtin:powershell" } })).toBe(false);
    expect(isBuiltinBash({ name: "edit", sourceInfo: { path: "builtin:edit" } })).toBe(false);
  });
});

describe("the approval handler with the guard (S10)", () => {
  const builtin = (name: string): ToolSource => ({ name, sourceInfo: { path: `builtin:${name}` } });
  const piTools = ["read", "bash", "edit"].map(builtin);

  function setup(cwd: string, decision: PermissionDecision = "allow", extra: { planMode?: boolean; tools?: ToolSource[] } = {}) {
    const rules = openStorage(":memory:");
    const asks: PermissionAsk[] = [];
    const controller = new AbortController();
    const handler = createApprovalHandler({
      cwd,
      rules,
      signal: controller.signal,
      tools: () => extra.tools ?? piTools,
      planMode: extra.planMode,
      host: {
        askPermission: async (ask) => {
          asks.push(ask);
          return decision;
        },
      },
    });
    const bash = (command: string) => handler({ toolName: "bash", input: { command } });
    return { rules, asks, controller, handler, bash };
  }

  test("deny: blocks with guard-lib's reason and never prompts, even with an always rule", async () => {
    const dir = repo("main");
    const { bash, asks, rules } = setup(dir);
    rules.addPermissionRule({ cwd: dir, toolName: "bash", command: "git commit -m x" });

    expect(await bash("git commit -m x")).toEqual({ block: true, reason: BRANCH_DENIED("main") });
    expect(asks).toEqual([]);
  });

  test("ask: always prompts with the guard's reason and no always-allow, even when an always rule matches", async () => {
    const dir = repo("feat/x");
    const { bash, asks, rules } = setup(dir);
    rules.addPermissionRule({ cwd: dir, toolName: "bash", command: "git push" });

    const result = await bash("git push");

    expect(result).toBeUndefined();
    expect(asks).toEqual([
      {
        toolName: "bash",
        input: { command: "git push" },
        decisionReason: "marcsh: git push needs your approval",
        suppressAlwaysAllowRule: true,
      },
    ]);
  });

  test("ask: a denial blocks the call", async () => {
    const { bash } = setup(repo("feat/x"), "deny");

    expect(await bash("git push")).toEqual({ block: true, reason: DENIED_REASON });
  });

  test("ask: an always answer allows once and stores no rule", async () => {
    const dir = repo("feat/x");
    const { bash, asks, rules } = setup(dir, "always");

    expect(await bash("git push")).toBeUndefined();
    expect(await bash("git push")).toBeUndefined();

    expect(asks).toHaveLength(2);
    expect(rules.hasPermissionRule({ cwd: dir, toolName: "bash", command: "git push" })).toBe(false);
  });

  test("ask: the turn ending while the prompt is open blocks the call", async () => {
    const dir = repo("feat/x");
    const rules = openStorage(":memory:");
    const controller = new AbortController();
    const handler = createApprovalHandler({
      cwd: dir,
      rules,
      signal: controller.signal,
      tools: () => piTools,
      host: {
        askPermission: (_ask, signal) =>
          new Promise<PermissionDecision>((resolve) => {
            signal.addEventListener("abort", () => resolve("deny"), { once: true });
            controller.abort();
          }),
      },
    });

    const result = await handler({ toolName: "bash", input: { command: "git push" } });

    expect(result).toMatchObject({ block: true });
  });

  test("allow: an ordinary command goes through the normal approval, with no guard reason", async () => {
    const dir = repo("main");
    const { bash, asks, rules } = setup(dir, "always");

    expect(await bash("ls -la")).toBeUndefined();
    expect(asks).toEqual([{ toolName: "bash", input: { command: "ls -la" } }]);
    expect(rules.hasPermissionRule({ cwd: dir, toolName: "bash", command: "ls -la" })).toBe(true);
    expect(await bash("ls -la")).toBeUndefined();
    expect(asks).toHaveLength(1);
  });

  test("a bash tool that is not pi's built-in is not guarded", async () => {
    const dir = repo("main");
    const tools = [{ name: "bash", sourceInfo: { path: "/agent/extensions/bash.ts" } }];
    const { bash, asks } = setup(dir, "allow", { tools });

    expect(await bash("git commit -m x")).toBeUndefined();
    expect(asks).toEqual([{ toolName: "bash", input: { command: "git commit -m x" } }]);
  });

  test("other tools are not guarded", async () => {
    const dir = repo("main");
    const { handler, asks } = setup(dir);

    expect(await handler({ toolName: "edit", input: { command: "git commit -m x" } })).toBeUndefined();
    expect(asks).toEqual([{ toolName: "edit", input: { command: "git commit -m x" } }]);
  });

  test("a bash call without a command string is not guarded", async () => {
    const { handler, asks } = setup(repo("main"));

    expect(await handler({ toolName: "bash", input: {} })).toBeUndefined();
    expect(asks).toEqual([{ toolName: "bash", input: {} }]);
  });

  test("plan mode blocks bash with the plan reason before the guard speaks", async () => {
    const { bash, asks } = setup(repo("main"), "allow", { planMode: true });

    expect(await bash("git commit -m x")).toEqual({ block: true, reason: PLAN_MODE_REASON });
    expect(asks).toEqual([]);
  });

  test("a guard that throws fails open: the call goes through the normal approval", async () => {
    const dir = repo("main");
    const rules = openStorage(":memory:");
    const asks: PermissionAsk[] = [];
    const handler = createApprovalHandler({
      cwd: dir,
      rules,
      signal: new AbortController().signal,
      tools: () => piTools,
      guard: () => {
        throw new Error("guard exploded");
      },
      host: {
        askPermission: async (ask) => {
          asks.push(ask);
          return "allow";
        },
      },
    });

    expect(await handler({ toolName: "bash", input: { command: "git commit -m x" } })).toBeUndefined();
    expect(asks).toEqual([{ toolName: "bash", input: { command: "git commit -m x" } }]);
  });

  test("the guard is called with the command and the session's cwd", async () => {
    const dir = repo("main");
    const seen: unknown[] = [];
    const handler = createApprovalHandler({
      cwd: dir,
      rules: openStorage(":memory:"),
      signal: new AbortController().signal,
      tools: () => piTools,
      guard: (command, cwd) => {
        seen.push([command, cwd]);
        return null;
      },
      host: { askPermission: async () => "allow" },
    });

    await handler({ toolName: "bash", input: { command: "echo hi" } });

    expect(seen).toEqual([["echo hi", dir]]);
  });
});
