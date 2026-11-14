import { describe, expect, test } from "bun:test";
import { openStorage } from "../storage";
import { createApprovalHandler, DENIED_REASON, needsApproval, offeredInPlan, PLAN_MODE_REASON, runsUnasked, type ToolSource } from "./pi-permissions";
import type { Decision, Guard } from "./pi-guard";
import type { PermissionAsk, PermissionDecision } from "./types";

// S1a: marcsh's bg_start asks exactly like pi's bash for the same command; its other bg_* tools run unasked.
const builtin = (name: string): ToolSource => ({ name, sourceInfo: { path: `builtin:${name}` } });
const marcshBg = (name: string): ToolSource => ({ name, sourceInfo: { path: "<inline:marcsh-background>" } });
const fromExtension = (name: string): ToolSource => ({ name, sourceInfo: { path: `/agent/extensions/${name}.ts` } });
const BG = ["bg_start", "bg_status", "bg_list", "bg_kill"];
const tools = [...["read", "bash", "edit"].map(builtin), ...BG.map(marcshBg)];

function setup({ decision = "allow", guard, planMode, list = tools }: { decision?: PermissionDecision; guard?: Guard; planMode?: boolean; list?: ToolSource[] } = {}) {
  const rules = openStorage(":memory:");
  const asks: PermissionAsk[] = [];
  const handler = createApprovalHandler({
    cwd: "/work",
    rules,
    signal: new AbortController().signal,
    tools: () => list,
    planMode,
    host: {
      askPermission: async (ask) => {
        asks.push(ask);
        return decision;
      },
    },
    ...(guard ? { guard } : { guard: () => null }),
  });
  return { rules, asks, handler };
}

describe("bg_* approval (S1a)", () => {
  test("bg_status, bg_list and bg_kill run unasked; bg_start asks", () => {
    for (const name of ["bg_status", "bg_list", "bg_kill"]) expect(needsApproval(name, tools)).toBe(false);
    expect(needsApproval("bg_start", tools)).toBe(true);
  });

  test("a same-named tool from another source asks, whatever its name", () => {
    for (const name of BG) expect(needsApproval(name, [fromExtension(name)])).toBe(true);
    for (const name of BG) expect(runsUnasked(fromExtension(name))).toBe(false);
  });

  test("bg_start asks with its own name and full input, so the user sees it runs in the background", async () => {
    const { asks, handler } = setup();
    const input = { command: "npm run dev", title: "dev server", working_dir: "web" };
    expect(await handler({ toolName: "bg_start", input })).toBeUndefined();
    expect(asks).toEqual([{ toolName: "bg_start", input }]);
  });

  test("an \"always\" for bg_start is bash's rule for that command, and covers bash", async () => {
    const { rules, asks, handler } = setup({ decision: "always" });
    await handler({ toolName: "bg_start", input: { command: "make watch", title: "watch" } });
    expect(rules.hasPermissionRule({ cwd: "/work", toolName: "bash", command: "make watch" })).toBe(true);
    expect(await handler({ toolName: "bash", input: { command: "make watch" } })).toBeUndefined();
    expect(await handler({ toolName: "bg_start", input: { command: "make watch", title: "again" } })).toBeUndefined();
    expect(asks).toHaveLength(1);
    // Another command still asks.
    await handler({ toolName: "bg_start", input: { command: "make other", title: "other" } });
    expect(asks).toHaveLength(2);
  });

  test("an \"always\" for bash covers bg_start with the same command", async () => {
    const { rules, asks, handler } = setup();
    rules.addPermissionRule({ cwd: "/work", toolName: "bash", command: "npm test" });
    expect(await handler({ toolName: "bg_start", input: { command: "npm test", title: "tests" } })).toBeUndefined();
    expect(asks).toEqual([]);
  });

  test("a bash rule does not cover a bg_start from another source", async () => {
    const { rules, asks, handler } = setup({ list: [builtin("bash"), fromExtension("bg_start")] });
    rules.addPermissionRule({ cwd: "/work", toolName: "bash", command: "npm test" });
    await handler({ toolName: "bg_start", input: { command: "npm test" } });
    expect(asks).toHaveLength(1);
  });

  test("the guard judges bg_start's command: deny blocks without asking", async () => {
    const seen: string[] = [];
    const guard: Guard = (command) => (seen.push(command), { decision: "deny", reason: "No pushes from here." } as Decision);
    const { asks, handler } = setup({ guard });
    expect(await handler({ toolName: "bg_start", input: { command: "git push", title: "push" } })).toEqual({ block: true, reason: "No pushes from here." });
    expect(seen).toEqual(["git push"]);
    expect(asks).toEqual([]);
  });

  test("a guard ask always asks, with its reason, and is never stored as a rule", async () => {
    const guard: Guard = () => ({ decision: "ask", reason: "This commits on main." }) as Decision;
    const { rules, asks, handler } = setup({ guard, decision: "always" });
    rules.addPermissionRule({ cwd: "/work", toolName: "bash", command: "git commit -m x" });
    await handler({ toolName: "bg_start", input: { command: "git commit -m x", title: "commit" } });
    expect(asks).toEqual([
      { toolName: "bg_start", input: { command: "git commit -m x", title: "commit" }, decisionReason: "This commits on main.", suppressAlwaysAllowRule: true },
    ]);
  });

  test("a denied bg_start is blocked", async () => {
    const { handler } = setup({ decision: "deny" });
    expect(await handler({ toolName: "bg_start", input: { command: "ls", title: "ls" } })).toEqual({ block: true, reason: DENIED_REASON });
  });
});

describe("bg_* in plan mode (S1a, A10)", () => {
  test("bg_start and bg_kill are blocked without asking; bg_status and bg_list run", async () => {
    const { rules, asks, handler } = setup({ planMode: true });
    rules.addPermissionRule({ cwd: "/work", toolName: "bash", command: "ls" });
    expect(await handler({ toolName: "bg_start", input: { command: "ls", title: "ls" } })).toEqual({ block: true, reason: PLAN_MODE_REASON });
    expect(await handler({ toolName: "bg_kill", input: { ids: ["bt-1"] } })).toEqual({ block: true, reason: PLAN_MODE_REASON });
    expect(await handler({ toolName: "bg_status", input: { id: "bt-1" } })).toBeUndefined();
    expect(await handler({ toolName: "bg_list", input: {} })).toBeUndefined();
    expect(asks).toEqual([]);
  });

  test("plan mode offers only the reading bg tools", () => {
    expect(tools.filter(offeredInPlan).map((tool) => tool.name)).toEqual(["read", "bg_status", "bg_list"]);
  });
});
