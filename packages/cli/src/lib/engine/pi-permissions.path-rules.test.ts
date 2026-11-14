import { describe, expect, test } from "bun:test";
import type { ApprovalMode } from "../approval-policy";
import { openStorage } from "../storage";
import type { Guard } from "./pi-guard";
import { createApprovalHandler, DENIED_REASON, PLAN_MODE_REASON, type ToolSource } from "./pi-permissions";
import { type PermissionAsk, type PermissionDecision, pathAnswer } from "./types";

// Not under a temp dir: in yolo, `rm` inside a scratch folder runs without asking, which would hide the floor ask these tests are about.
const cwd = "/srv/t6-project";
const MODES: ApprovalMode[] = ["normal", "auto", "yolo"];

const builtin = (name: string): ToolSource => ({ name, sourceInfo: { path: `builtin:${name}` } });
const extension = (name: string): ToolSource => ({ name, sourceInfo: { path: `/agent/extensions/${name}.ts` } });
const piTools = ["read", "bash", "edit", "write"].map(builtin);

const noGuard: Guard = () => null;
const guardDeniesRm: Guard = (command) => (/rm /.test(command) ? { decision: "deny", reason: "marcsh: guard says no" } : null);

function setup(
  approvalMode: ApprovalMode | undefined,
  { decision = "allow", guard = noGuard, tools = piTools, planMode, withPathRules = true }: {
    decision?: PermissionDecision;
    guard?: Guard;
    tools?: ToolSource[];
    planMode?: boolean;
    withPathRules?: boolean;
  } = {},
) {
  const storage = openStorage(":memory:");
  const asks: PermissionAsk[] = [];
  const handler = createApprovalHandler({
    cwd,
    rules: withPathRules
      ? storage
      : { hasPermissionRule: storage.hasPermissionRule, addPermissionRule: storage.addPermissionRule },
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
  return { storage, asks, handler, bash };
}

describe("a stored path rule skips the ask", () => {
  test("for a folder under /tmp, in every mode", async () => {
    for (const mode of MODES) {
      const { storage, bash, asks } = setup(mode);
      storage.addPathRule({ cwd, program: "rm", dir: "/tmp/x" });

      expect(await bash("rm -rf /tmp/x/y")).toBeUndefined();
      expect(await bash("rm /tmp/x/a /tmp/x/b/c && rm -r /tmp/x/d")).toBeUndefined();
      expect(asks).toEqual([]);
    }
  });

  test("for a project folder, also where the policy would floor-ask (A3)", async () => {
    for (const mode of MODES) {
      const command = `rm -rf ${cwd}/build/out`;
      const { storage, bash, asks } = setup(mode);

      await bash(command);
      if (mode !== "normal") expect(asks[0]?.suppressAlwaysAllowRule).toBe(true);
      expect(asks).toHaveLength(1);

      storage.addPathRule({ cwd, program: "rm", dir: `${cwd}/build` });
      expect(await bash(command)).toBeUndefined();
      expect(asks).toHaveLength(1);
    }
  });

  test("for find -delete and mv, with their own program", async () => {
    const { storage, bash, asks } = setup("normal");
    storage.addPathRule({ cwd, program: "find", dir: "/tmp/x" });
    storage.addPathRule({ cwd, program: "mv", dir: "/tmp/x" });

    expect(await bash("find /tmp/x/cache -name '*.o' -delete")).toBeUndefined();
    expect(await bash("mv /tmp/x/a /tmp/x/b")).toBeUndefined();
    expect(asks).toEqual([]);
  });
});

describe("a stored path rule does not cover", () => {
  // Outside /tmp, so that in auto and yolo these still floor-ask on their own (`rm -rf` in a scratch folder runs unasked, S11).
  const NOT_COVERED = [
    "mv -f /srv/data/x/a /srv/data/x/b",
    "rm -rf /srv/data/xy/a",
    "rm -rf /srv/data/x",
    "rm -rf /srv/data/x/a && ls",
    "cd /srv/data/x && rm -rf a",
    "rm -rf $DIR",
    "rm -rf /srv/data/x/../y",
    "rm -rf /srv/elsewhere/a",
  ];

  test("another program, another folder, a mixed chain, another project (normal: every one asks)", async () => {
    const { storage, bash, asks } = setup("normal");
    storage.addPathRule({ cwd, program: "rm", dir: "/srv/data/x" });
    storage.addPathRule({ cwd: "/other", program: "rm", dir: "/srv/elsewhere" });

    for (const command of NOT_COVERED) await bash(command);

    expect(asks.map((ask) => (ask.input as { command: string }).command)).toEqual(NOT_COVERED);
  });

  test("the same in yolo: what asked before the rule still asks", async () => {
    const { storage, bash, asks } = setup("yolo");
    storage.addPathRule({ cwd, program: "rm", dir: "/srv/data/x" });
    const floorAsked = NOT_COVERED.filter((command) => command.includes("rm -rf"));

    for (const command of floorAsked) await bash(command);

    expect(asks.map((ask) => (ask.input as { command: string }).command)).toEqual(floorAsked);
    expect(asks.every((ask) => ask.suppressAlwaysAllowRule === true)).toBe(true);
  });

  test("sudo or doas", async () => {
    for (const mode of MODES) {
      const { storage, bash, asks } = setup(mode);
      storage.addPathRule({ cwd, program: "rm", dir: "/tmp/x" });

      await bash("sudo rm -rf /tmp/x/y");
      await bash("doas rm -rf /tmp/x/y");

      expect(asks).toHaveLength(2);
      expect(asks[0]?.pathRule).toBeUndefined();
    }
  });
});

describe("a stored path rule never loosens a block", () => {
  test("a catastrophic command is blocked in every mode, whatever the rules", async () => {
    for (const mode of MODES) {
      const { storage, bash, asks } = setup(mode);
      storage.addPathRule({ cwd, program: "rm", dir: "/tmp" });
      storage.addPathRule({ cwd, program: "rm", dir: "/" });

      for (const command of ["rm -rf /", "rm -rf /tmp/x/a /", "rm -rf /*", "rm -rf ~"]) {
        expect(await bash(command)).toEqual({ block: true, reason: expect.any(String) });
      }
      expect(asks).toEqual([]);
    }
  });

  test("the guard's deny still blocks", async () => {
    for (const mode of MODES) {
      const { storage, bash, asks } = setup(mode, { guard: guardDeniesRm });
      storage.addPathRule({ cwd, program: "rm", dir: "/tmp/x" });

      expect(await bash("rm -rf /tmp/x/y")).toEqual({ block: true, reason: "marcsh: guard says no" });
      expect(asks).toEqual([]);
    }
  });

  test("plan mode still blocks", async () => {
    const { storage, bash, asks } = setup("normal", { planMode: true });
    storage.addPathRule({ cwd, program: "rm", dir: "/tmp/x" });

    expect(await bash("rm -rf /tmp/x/y")).toEqual({ block: true, reason: PLAN_MODE_REASON });
    expect(asks).toEqual([]);
  });

  test("a bash tool that is not pi's own is not covered", async () => {
    const { storage, handler, asks } = setup("normal", { tools: [builtin("read"), extension("bash")] });
    storage.addPathRule({ cwd, program: "rm", dir: "/tmp/x" });

    await handler({ toolName: "bash", input: { command: "rm -rf /tmp/x/y" } });

    expect(asks).toHaveLength(1);
    expect(asks[0]?.pathRule).toBeUndefined();
  });
});

describe("the ask offers the choice", () => {
  test("a path command carries the program and the folders to allow it under", async () => {
    const { bash, asks } = setup("normal");

    await bash("rm -rf /tmp/x/a /tmp/x/b");

    expect(asks).toEqual([{ toolName: "bash", input: { command: "rm -rf /tmp/x/a /tmp/x/b" }, pathRule: { program: "rm", dirs: ["/tmp/x", "/tmp"] } }]);
  });

  test("a floor ask offers it too, and still no always-allow", async () => {
    const { bash, asks } = setup("yolo");

    await bash(`rm -rf ${cwd}/build/out`);

    expect(asks).toHaveLength(1);
    expect(asks[0]?.suppressAlwaysAllowRule).toBe(true);
    expect(asks[0]?.pathRule).toEqual({ program: "rm", dirs: [`${cwd}/build`, cwd, "/srv"] });
  });

  test("other commands and other tools carry no choice", async () => {
    const { bash, handler, asks } = setup("normal");

    await bash("ls -la");
    await bash("rm /tmp/x/a && ls");
    await bash("sudo rm /tmp/x/a");
    await bash("rm -rf /tmp/x/$NAME");
    await handler({ toolName: "edit", input: { path: "/tmp/x/a" } });

    expect(asks).toHaveLength(5);
    expect(asks.every((ask) => ask.pathRule === undefined)).toBe(true);
  });

  test("a store without path rules asks as before", async () => {
    const { bash, asks } = setup("normal", { withPathRules: false });

    expect(await bash("rm -rf /tmp/x/a")).toBeUndefined();

    expect(asks).toEqual([{ toolName: "bash", input: { command: "rm -rf /tmp/x/a" } }]);
  });
});

describe("a path answer", () => {
  test("runs the call and stores the rule, and the next matching call is not asked", async () => {
    for (const mode of MODES) {
      const { storage, bash, asks } = setup(mode, { decision: pathAnswer("/srv/data/x") });

      expect(await bash("rm -rf /srv/data/x/a")).toBeUndefined();
      expect(asks).toHaveLength(1);
      expect(storage.pathRulesFor(cwd)).toEqual([{ cwd, program: "rm", dir: "/srv/data/x" }]);

      expect(await bash("rm -rf /srv/data/x/b/c")).toBeUndefined();
      expect(asks).toHaveLength(1);
      expect(storage.hasPermissionRule({ cwd, toolName: "bash", command: "rm -rf /srv/data/x/a" })).toBe(false);
    }
  });

  test("a wider folder covers a sibling folder", async () => {
    const { storage, bash, asks } = setup("normal", { decision: pathAnswer("/tmp") });

    await bash("rm -rf /tmp/x/a");
    expect(await bash("rm -rf /tmp/y/b")).toBeUndefined();

    expect(asks).toHaveLength(1);
    expect(storage.pathRulesFor(cwd)).toEqual([{ cwd, program: "rm", dir: "/tmp" }]);
  });

  test("a folder that was not offered runs the call once and stores nothing", async () => {
    const { storage, bash, asks } = setup("normal", { decision: pathAnswer("/") });

    expect(await bash("rm -rf /tmp/x/a")).toBeUndefined();
    expect(await bash("rm -rf /tmp/x/b")).toBeUndefined();

    expect(asks).toHaveLength(2);
    expect(storage.pathRulesFor(cwd)).toEqual([]);
  });

  test("a deny stores nothing and blocks", async () => {
    const { storage, bash } = setup("normal", { decision: "deny" });

    expect(await bash("rm -rf /tmp/x/a")).toEqual({ block: true, reason: DENIED_REASON });
    expect(storage.pathRulesFor(cwd)).toEqual([]);
  });

  test("always and allow answers store no path rule", async () => {
    for (const decision of ["allow", "always"] as const) {
      const { storage, bash } = setup("normal", { decision });

      await bash("rm -rf /tmp/x/a");

      expect(storage.pathRulesFor(cwd)).toEqual([]);
    }
  });
});
