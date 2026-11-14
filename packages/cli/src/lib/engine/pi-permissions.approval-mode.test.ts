import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalMode } from "../approval-policy";
import { openStorage } from "../storage";
import type { Guard } from "./pi-guard";
import { createApprovalHandler, DENIED_REASON, PLAN_MODE_REASON, type ToolSource } from "./pi-permissions";
import type { PermissionAsk, PermissionDecision } from "./types";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-pi-approval-")));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const builtin = (name: string): ToolSource => ({ name, sourceInfo: { path: `builtin:${name}` } });
const extension = (name: string): ToolSource => ({ name, sourceInfo: { path: `/agent/extensions/${name}.ts` } });
const piTools = ["read", "bash", "edit", "write"].map(builtin);

const noGuard: Guard = () => null;
const guardAsks: Guard = (command) => (/git push/.test(command) ? { decision: "ask", reason: "marcsh: git push needs your approval" } : null);
const guardDeniesCommit: Guard = (command) =>
  /git commit/.test(command) ? { decision: "deny", reason: "marcsh: commits on main are blocked; create a branch first (git switch -c <type>/<description>)" } : null;

function setup(
  approvalMode: ApprovalMode | undefined,
  { decision = "allow", guard = noGuard, tools = piTools, planMode }: { decision?: PermissionDecision; guard?: Guard; tools?: ToolSource[]; planMode?: boolean } = {},
) {
  const storage = openStorage(":memory:");
  const lookups: unknown[] = [];
  const rules = {
    hasPermissionRule: (rule: Parameters<typeof storage.hasPermissionRule>[0]) => (lookups.push(rule), storage.hasPermissionRule(rule)),
    addPermissionRule: storage.addPermissionRule,
  };
  const asks: PermissionAsk[] = [];
  const handler = createApprovalHandler({
    cwd,
    rules,
    signal: new AbortController().signal,
    tools: () => tools,
    guard,
    planMode,
    approvalMode,
    host: {
      askPermission: async (ask) => {
        asks.push(ask);
        return decision;
      },
    },
  });
  const bash = (command: string) => handler({ toolName: "bash", input: { command } });
  return { storage, lookups, asks, handler, bash };
}

describe("normal mode (and no mode): today's flow", () => {
  test("every non-read tool asks with just the call; no policy reason", async () => {
    for (const mode of [undefined, "normal"] as const) {
      const { handler, bash, asks } = setup(mode);

      expect(await bash("ls -la")).toBeUndefined();
      expect(await handler({ toolName: "edit", input: { path: join(cwd, "a.ts") } })).toBeUndefined();

      expect(asks).toEqual([
        { toolName: "bash", input: { command: "ls -la" } },
        { toolName: "edit", input: { path: join(cwd, "a.ts") } },
      ]);
    }
  });

  test("an always rule is honoured, and an always answer stores one", async () => {
    const { bash, asks, storage } = setup("normal", { decision: "always" });

    await bash("ls -la");
    await bash("ls -la");

    expect(asks).toHaveLength(1);
    expect(storage.hasPermissionRule({ cwd, toolName: "bash", command: "ls -la" })).toBe(true);
  });

  test("the guard's ask still asks without always-allow", async () => {
    const { bash, asks } = setup("normal", { guard: guardAsks });

    await bash("git push");

    expect(asks).toEqual([{ toolName: "bash", input: { command: "git push" }, decisionReason: "marcsh: git push needs your approval", suppressAlwaysAllowRule: true }]);
  });
});

describe("auto mode", () => {
  test("an edit or write inside the project and an ordinary command run without asking or looking up rules", async () => {
    const { handler, bash, asks, lookups } = setup("auto");
    const file = join(cwd, "src", "a.ts");

    expect(await handler({ toolName: "edit", input: { path: file } })).toBeUndefined();
    expect(await handler({ toolName: "write", input: { path: file, content: "" } })).toBeUndefined();
    expect(await bash("ls -la")).toBeUndefined();

    expect(asks).toEqual([]);
    expect(lookups).toEqual([]);
  });

  test("an edit outside the project asks with a reason and no always-allow", async () => {
    const { handler, asks } = setup("auto");

    await handler({ toolName: "edit", input: { path: "/etc/hosts" } });

    expect(asks).toEqual([
      { toolName: "edit", input: { path: "/etc/hosts" }, decisionReason: expect.stringContaining("/etc/hosts"), suppressAlwaysAllowRule: true },
    ]);
  });

  test("git push asks with suppress, though no guard spoke", async () => {
    const { bash, asks } = setup("auto");

    expect(await bash("git push origin feat/x")).toBeUndefined();

    expect(asks).toEqual([
      { toolName: "bash", input: { command: "git push origin feat/x" }, decisionReason: expect.stringContaining("git push"), suppressAlwaysAllowRule: true },
    ]);
  });

  test("a stored rule does not skip a floor ask", async () => {
    const { bash, asks, storage } = setup("auto");
    storage.addPermissionRule({ cwd, toolName: "bash", command: "git push" });

    await bash("git push");

    expect(asks).toHaveLength(1);
  });
});

describe("yolo mode", () => {
  test("git push runs without asking even when the guard says ask", async () => {
    const { bash, asks, lookups } = setup("yolo", { guard: guardAsks });

    expect(await bash("git push origin feat/x")).toBeUndefined();

    expect(asks).toEqual([]);
    expect(lookups).toEqual([]);
  });

  test("npm install asks with suppressAlwaysAllowRule, and an always answer stores no rule", async () => {
    const { bash, asks, storage } = setup("yolo", { decision: "always" });

    expect(await bash("npm install left-pad")).toBeUndefined();
    expect(await bash("npm install left-pad")).toBeUndefined();

    expect(asks).toHaveLength(2);
    expect(asks[0]).toEqual({
      toolName: "bash",
      input: { command: "npm install left-pad" },
      decisionReason: expect.stringContaining("npm install"),
      suppressAlwaysAllowRule: true,
    });
    expect(storage.hasPermissionRule({ cwd, toolName: "bash", command: "npm install left-pad" })).toBe(false);
  });

  test("a denied floor ask blocks the call", async () => {
    const { bash } = setup("yolo", { decision: "deny" });

    expect(await bash("npm install left-pad")).toEqual({ block: true, reason: DENIED_REASON });
  });

  test("a floor ask that is answered after the turn ended blocks the call", async () => {
    const controller = new AbortController();
    const handler = createApprovalHandler({
      cwd,
      rules: openStorage(":memory:"),
      signal: controller.signal,
      tools: () => piTools,
      approvalMode: "yolo",
      host: {
        askPermission: async () => {
          controller.abort();
          return "allow";
        },
      },
    });

    expect(await handler({ toolName: "bash", input: { command: "npm install left-pad" } })).toMatchObject({ block: true });
  });

  test("a floor ask whose prompt fails blocks the call", async () => {
    const handler = createApprovalHandler({
      cwd,
      rules: openStorage(":memory:"),
      signal: new AbortController().signal,
      tools: () => piTools,
      approvalMode: "yolo",
      host: {
        askPermission: async () => {
          throw new Error("closed");
        },
      },
    });

    expect(await handler({ toolName: "bash", input: { command: "npm install left-pad" } })).toEqual({ block: true, reason: DENIED_REASON });
  });

  test("a commit on the default branch stays denied by the guard", async () => {
    const { bash, asks } = setup("yolo", { guard: guardDeniesCommit });

    expect(await bash("git commit -m x")).toEqual({
      block: true,
      reason: "marcsh: commits on main are blocked; create a branch first (git switch -c <type>/<description>)",
    });
    expect(asks).toEqual([]);
  });

  test("plan mode still blocks everything but reads", async () => {
    const { bash, asks } = setup("yolo", { planMode: true });

    expect(await bash("ls")).toEqual({ block: true, reason: PLAN_MODE_REASON });
    expect(asks).toEqual([]);
  });
});

describe("the catastrophic block", () => {
  test("rm -rf ~ is blocked in every mode without asking", async () => {
    for (const mode of [undefined, "normal", "auto", "yolo"] as const) {
      const { bash, asks, storage } = setup(mode);
      storage.addPermissionRule({ cwd, toolName: "bash", command: "rm -rf ~" });

      expect(await bash("rm -rf ~")).toEqual({ block: true, reason: expect.stringContaining("never allowed") });
      expect(asks).toEqual([]);
    }
  });
});

describe("what the policy does not classify keeps the existing flow", () => {
  test("extension tools named bash, edit or write, MCP tools and bash without a command ask as today in yolo", async () => {
    const tools = [extension("bash"), extension("edit"), builtin("write"), { name: "mcp_server_tool", sourceInfo: { path: "/mcp" } }];
    const { handler, asks } = setup("yolo", { tools });

    await handler({ toolName: "bash", input: { command: "ls" } });
    await handler({ toolName: "edit", input: { path: join(cwd, "a.ts") } });
    await handler({ toolName: "mcp_server_tool", input: { a: 1 } });
    // pi's own write without a path string cannot be placed in the project.
    await handler({ toolName: "write", input: {} });

    expect(asks).toEqual([
      { toolName: "bash", input: { command: "ls" } },
      { toolName: "edit", input: { path: join(cwd, "a.ts") } },
      { toolName: "mcp_server_tool", input: { a: 1 } },
      { toolName: "write", input: {} },
    ]);
  });

  test("a tool that is not registered asks as today", async () => {
    const { handler, asks } = setup("yolo");

    await handler({ toolName: "mystery", input: {} });

    expect(asks).toEqual([{ toolName: "mystery", input: {} }]);
  });

  test("read-only built-ins run unasked in every mode", async () => {
    for (const mode of ["normal", "auto", "yolo"] as const) {
      const { handler, asks } = setup(mode);

      expect(await handler({ toolName: "read", input: { path: "/etc/hosts" } })).toBeUndefined();
      expect(asks).toEqual([]);
    }
  });
});

describe("a publish the guard asks about is never loosened by the mode", () => {
  const guardAsksPublish: Guard = (command) => (/\bpublish\b/.test(command) ? { decision: "ask", reason: "marcsh: npm publish needs your approval" } : null);
  test("npm -w pkg publish asks in auto and yolo, without always-allow", async () => {
    for (const mode of ["auto", "yolo"] as const) {
      const { bash, asks } = setup(mode, { guard: guardAsksPublish });
      expect(await bash("npm -w pkg publish")).toBeUndefined();
      expect(asks).toHaveLength(1);
      expect(asks[0]?.suppressAlwaysAllowRule).toBe(true);
    }
  });

  test("a merge the guard asks about asks in yolo even when the policy would allow the command", async () => {
    const guardAsksMerge: Guard = (command) => (/make release/.test(command) ? { decision: "ask", reason: "marcsh: gh pr merge needs your approval" } : null);
    const { bash, asks } = setup("yolo", { guard: guardAsksMerge });
    expect(await bash("make release")).toBeUndefined();
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ decisionReason: "marcsh: gh pr merge needs your approval", suppressAlwaysAllowRule: true });
  });

  test("a push the guard asks about still runs in yolo", async () => {
    const { bash, asks } = setup("yolo", { guard: guardAsks });
    expect(await bash("git push origin feat")).toBeUndefined();
    expect(asks).toEqual([]);
  });
});
