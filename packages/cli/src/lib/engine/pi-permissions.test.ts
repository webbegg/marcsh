import { describe, expect, test } from "bun:test";
import { openStorage } from "../storage";
import {
  createApprovalHandler,
  DENIED_REASON,
  needsApproval,
  READ_ONLY_TOOLS,
  ruleFor,
} from "./pi-permissions";
import type { PermissionAsk, PermissionDecision } from "./types";

describe("needsApproval", () => {
  test("pi's read-only tools run without asking", () => {
    expect([...READ_ONLY_TOOLS]).toEqual(["read", "grep", "find", "ls"]);
    for (const tool of READ_ONLY_TOOLS) expect(needsApproval(tool)).toBe(false);
  });

  test("bash, edit, write and every other tool ask", () => {
    for (const tool of ["bash", "edit", "write", "powershell", "AskUserQuestion", "mcp__fs__delete", "my_extension_tool"]) {
      expect(needsApproval(tool)).toBe(true);
    }
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
