import { describe, expect, test } from "bun:test";
import { openStorage } from "../storage";
import {
  createApprovalHandler,
  DENIED_REASON,
  needsApproval,
  PLAN_MODE_REASON,
  READ_ONLY_TOOLS,
  ruleFor,
  type ToolSource,
} from "./pi-permissions";
import type { PermissionAsk, PermissionDecision } from "./types";

const builtin = (name: string): ToolSource => ({ name, sourceInfo: { path: `builtin:${name}` } });
const fromExtension = (name: string): ToolSource => ({ name, sourceInfo: { path: `/agent/extensions/${name}.ts` } });
const piTools = ["read", "grep", "find", "ls", "bash", "edit", "write", "powershell"].map(builtin);

describe("needsApproval", () => {
  test("pi's built-in read-only tools run without asking", () => {
    expect([...READ_ONLY_TOOLS]).toEqual(["read", "grep", "find", "ls"]);
    for (const tool of READ_ONLY_TOOLS) expect(needsApproval(tool, piTools)).toBe(false);
  });

  test("bash, edit, write and every other tool ask", () => {
    const tools = [...piTools, ...["AskUserQuestion", "mcp__fs__delete", "my_extension_tool"].map(fromExtension)];
    for (const tool of ["bash", "edit", "write", "powershell", "AskUserQuestion", "mcp__fs__delete", "my_extension_tool"]) {
      expect(needsApproval(tool, tools)).toBe(true);
    }
  });

  test("an extension tool named like a read-only tool asks", () => {
    for (const tool of READ_ONLY_TOOLS) expect(needsApproval(tool, [fromExtension(tool)])).toBe(true);
  });

  test("a tool pi does not list asks", () => {
    expect(needsApproval("read", [])).toBe(true);
  });
});

describe("ruleFor", () => {
  test("a bash rule is the exact command in that project", () => {
    expect(ruleFor("/work", "bash", { command: "ls -la" })).toEqual({ cwd: "/work", toolName: "bash", command: "ls -la" });
  });

  test("any other tool is ruled by its name alone, whatever the input", () => {
    expect(ruleFor("/work", "edit", { path: "a.ts" })).toEqual({ cwd: "/work", toolName: "edit" });
    expect(ruleFor("/work", "mcp__fs__delete", {})).toEqual({ cwd: "/work", toolName: "mcp__fs__delete" });
  });

  test("a bash call without a usable command has no rule", () => {
    expect(ruleFor("/work", "bash", {})).toBeUndefined();
    expect(ruleFor("/work", "bash", { command: "" })).toBeUndefined();
    expect(ruleFor("/work", "bash", { command: 42 })).toBeUndefined();
  });

  test("powershell is ruled like bash: the exact command, never the whole tool", () => {
    expect(ruleFor("/work", "powershell", { command: "Get-Date" })).toEqual({ cwd: "/work", toolName: "powershell", command: "Get-Date" });
    expect(ruleFor("/work", "powershell", {})).toBeUndefined();
    expect(ruleFor("/work", "powershell", { command: "" })).toBeUndefined();
  });
});

describe("createApprovalHandler", () => {
  function setup(decision: PermissionDecision | (() => Promise<PermissionDecision>), cwd = "/work") {
    const rules = openStorage(":memory:");
    const asks: PermissionAsk[] = [];
    const controller = new AbortController();
    const handler = createApprovalHandler({
      cwd,
      rules,
      signal: controller.signal,
      tools: () => piTools,
      host: {
        askPermission: async (ask) => {
          asks.push(ask);
          return typeof decision === "function" ? decision() : decision;
        },
      },
    });
    return { rules, asks, controller, handler };
  }

  test("read-only tools pass without asking", async () => {
    const { asks, handler } = setup("deny");

    expect(await handler({ toolName: "read", input: { path: "a" } })).toBeUndefined();
    expect(asks).toEqual([]);
  });

  test("a read tool that an extension replaced asks", async () => {
    const rules = openStorage(":memory:");
    const asks: PermissionAsk[] = [];
    const handler = createApprovalHandler({
      cwd: "/work",
      rules,
      signal: new AbortController().signal,
      tools: () => [fromExtension("read")],
      host: {
        askPermission: async (ask) => {
          asks.push(ask);
          return "deny";
        },
      },
    });

    expect(await handler({ toolName: "read", input: { path: "a" } })).toEqual({ block: true, reason: DENIED_REASON });
    expect(asks).toHaveLength(1);
  });

  test("asks with the tool name and input, and lets an allowed call through", async () => {
    const { asks, handler } = setup("allow");

    expect(await handler({ toolName: "bash", input: { command: "ls" } })).toBeUndefined();
    expect(asks).toEqual([{ toolName: "bash", input: { command: "ls" } }]);
  });

  test("blocks a denied call with the reason", async () => {
    const { handler } = setup("deny");

    expect(await handler({ toolName: "bash", input: { command: "ls" } })).toEqual({ block: true, reason: DENIED_REASON });
    expect(DENIED_REASON).toBe("The user denied this tool call.");
  });

  test("allow once stores nothing", async () => {
    const { rules, handler } = setup("allow");

    await handler({ toolName: "bash", input: { command: "ls" } });

    expect(rules.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" })).toBe(false);
  });

  test("always allows the call and later identical bash commands skip the ask", async () => {
    const { rules, asks, handler } = setup("always");

    expect(await handler({ toolName: "bash", input: { command: "make test" } })).toBeUndefined();
    expect(rules.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "make test" })).toBe(true);
    expect(await handler({ toolName: "bash", input: { command: "make test" } })).toBeUndefined();
    expect(asks).toHaveLength(1);

    expect(await handler({ toolName: "bash", input: { command: "make deploy" } })).toBeUndefined();
    expect(asks).toHaveLength(2);
  });

  test("always on another tool allows that tool for the project whatever its input", async () => {
    const { asks, handler } = setup("always");

    await handler({ toolName: "edit", input: { path: "a.ts" } });
    await handler({ toolName: "edit", input: { path: "b.ts" } });

    expect(asks).toHaveLength(1);
  });

  test("a rule from another project does not apply", async () => {
    const { rules, asks, handler } = setup("allow");
    rules.addPermissionRule({ cwd: "/elsewhere", toolName: "bash", command: "ls" });

    await handler({ toolName: "bash", input: { command: "ls" } });

    expect(asks).toHaveLength(1);
  });

  test("always on a bash call without a command allows once and stores nothing", async () => {
    const { rules, handler } = setup("always");

    expect(await handler({ toolName: "bash", input: {} })).toBeUndefined();
    expect(rules.hasPermissionRule({ cwd: "/work", toolName: "bash" })).toBe(false);
  });

  test("a turn that ends while the ask is pending blocks the call even if the answer was allow", async () => {
    let answer: (decision: PermissionDecision) => void = () => {};
    const { rules, controller, handler } = setup(() => new Promise((resolve) => (answer = resolve)));

    const pending = handler({ toolName: "bash", input: { command: "touch x" } });
    controller.abort();
    answer("always");

    const result = await pending;
    expect(result?.block).toBe(true);
    expect(rules.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "touch x" })).toBe(false);
  });

  test("a failing ask blocks the call", async () => {
    const { handler } = setup(() => Promise.reject(new Error("prompt crashed")));

    const result = await handler({ toolName: "bash", input: { command: "ls" } });

    expect(result?.block).toBe(true);
  });
});

describe("createApprovalHandler in plan mode", () => {
  function setupPlan(tools: ToolSource[]) {
    const rules = openStorage(":memory:");
    const asks: PermissionAsk[] = [];
    const handler = createApprovalHandler({
      cwd: "/work",
      rules,
      planMode: true,
      signal: new AbortController().signal,
      tools: () => tools,
      host: {
        askPermission: async (ask) => {
          asks.push(ask);
          return "allow";
        },
      },
    });
    return { rules, asks, handler };
  }

  test("pi's read-only built-ins still run without asking", async () => {
    const { asks, handler } = setupPlan(piTools);

    for (const tool of READ_ONLY_TOOLS) expect(await handler({ toolName: tool, input: {} })).toBeUndefined();
    expect(asks).toEqual([]);
  });

  test("every other call is blocked without asking, even with an \"always\" rule", async () => {
    const { rules, asks, handler } = setupPlan([...piTools, fromExtension("late_tool")]);
    rules.addPermissionRule({ cwd: "/work", toolName: "late_tool" });
    rules.addPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" });

    for (const [toolName, input] of [["bash", { command: "ls" }], ["edit", {}], ["late_tool", {}], ["unknown", {}]] as const) {
      expect(await handler({ toolName, input })).toEqual({ block: true, reason: PLAN_MODE_REASON });
    }
    expect(PLAN_MODE_REASON).toBe("Plan mode only allows reading tools.");
    expect(asks).toEqual([]);
  });

  test("an extension tool named read is blocked", async () => {
    const { asks, handler } = setupPlan([fromExtension("read")]);

    expect(await handler({ toolName: "read", input: { path: "a" } })).toEqual({ block: true, reason: PLAN_MODE_REASON });
    expect(asks).toEqual([]);
  });
});
