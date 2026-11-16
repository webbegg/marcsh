import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { createBackgroundHub, type BackgroundHub } from "../background/hub";
import type { ProcessEntry } from "../background/leftovers";
import { isPiToolDenied } from "../agent-tools";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine, type PiEngineOptions } from "./pi";
import { createProcTools, isMarcshProcTool, PROC_PLAN_TOOLS, PROC_TOOLS } from "./pi-proc-tools";
import { createApprovalHandler, DENIED_REASON, offeredInPlan, PLAN_MODE_REASON, runsUnasked } from "./pi-permissions";
import { trustEveryProject } from "./test-trust";
import type { PermissionAsk, TurnHost, TurnRequest } from "./types";

// M6: on pi, the agent lists this run's leftover processes (proc_list, unasked, also in Plan) and stops them (proc_stop, not in Plan),
// which always asks first (R1-1), in every approval mode, with no "always".
let dir: string;
let agentDir: string;
let cwd: string;
const hubs: BackgroundHub[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-proc-tools-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
  rmSync(dir, { recursive: true, force: true });
});

function newHub() {
  const hub = createBackgroundHub({ debounceMs: 5, registerTurn: () => () => {} });
  hubs.push(hub);
  hub.setIdleSink(() => true);
  return hub;
}

const entry = (over: Partial<ProcessEntry> & { pid: number }): ProcessEntry => ({
  ppid: 1,
  pgid: over.pid,
  startedAt: Date.now() - 60_000,
  rssKb: 87_000,
  marked: true,
  command: `node server-${over.pid}.js`,
  ...over,
});

/** A fake process table and kill: nothing real is signalled. `gone` pids vanish once signalled. */
function fakeProcesses(entries: ProcessEntry[]) {
  const signals: Array<[number, string]> = [];
  // marcsh itself (pid 7, the selfPid below), in a group of its own.
  let table = [entry({ pid: 7, marked: false, startedAt: 1 }), ...entries];
  const leftovers: NonNullable<PiEngineOptions["leftovers"]> = {
    session: { id: "test-session", since: Date.now() - 3_600_000 },
    selfPid: 7,
    read: async () => table,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      table = table.filter((item) => item.pid !== Math.abs(pid) && item.pgid !== Math.abs(pid));
    },
    exists: (pid) => table.some((item) => item.pid === pid),
    graceMs: 10,
  };
  return { leftovers, signals };
}

async function setup(responses: FauxResponseStep[], leftovers: PiEngineOptions["leftovers"]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 2000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject, ...(leftovers ? { leftovers } : {}) });
  return { engine, model: "faux/faux-1" };
}

const call = (name: string, args: Record<string, unknown>, id = "c1") => fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });
const toolResultTexts = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));

function run(
  engine: Awaited<ReturnType<typeof setup>>["engine"],
  model: string,
  overrides: Partial<TurnRequest> = {},
  answer: Awaited<ReturnType<TurnHost["askPermission"]>> = "allow",
) {
  const asks: PermissionAsk[] = [];
  const host: TurnHost = { emit: () => {}, askPermission: async (ask) => (asks.push(ask), answer), askQuestions: async () => null };
  const turn = engine.startTurn({ prompt: "go", cwd, mode: Mode.BUILD, model, signal: new AbortController().signal, ...overrides }, host);
  return { turn, asks };
}

const declaredProcTools = (messages: unknown) => {
  const declared = (messages as Array<{ role: string; toolsAdded?: { name: string }[] }>).flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : []));
  return [...new Set(declared.map((tool) => tool.name))].filter((name) => name.startsWith("proc_")).sort();
};

function offered(names: string[][]): FauxResponseStep {
  return (context) => {
    names.push(declaredProcTools(context.messages));
    return fauxAssistantMessage([fauxText("ok")]);
  };
}

function results(into: string[][]): FauxResponseStep {
  return (context) => {
    into.push(toolResultTexts(context.messages));
    return fauxAssistantMessage([fauxText("done")]);
  };
}

describe("proc_list and proc_stop in a pi turn (M6)", () => {
  test("proc_list runs unasked and lists this run's leftovers: pid, age, memory, command and the terminal that started it", async () => {
    const { leftovers } = fakeProcesses([entry({ pid: 4242, bg: "bt-2" }), entry({ pid: 99, marked: false }), entry({ pid: 50, ppid: 7 })]);
    const seen: string[][] = [];
    const { engine, model } = await setup([call("proc_list", {}), results(seen)], leftovers);
    const { turn, asks } = run(engine, model, { background: newHub() });
    await turn.done;
    expect(asks).toEqual([]);
    const text = seen[0]![0]!;
    expect(text).toContain("pid 4242 · 1m · 85 MB · node server-4242.js (started by terminal bt-2)");
    expect(text).not.toContain("pid 99");
    expect(text).not.toContain("pid 50");
  }, 20000);

  test("proc_list says when there are none", async () => {
    const { leftovers } = fakeProcesses([]);
    const seen: string[][] = [];
    const { engine, model } = await setup([call("proc_list", {}), results(seen)], leftovers);
    await run(engine, model, { background: newHub() }).turn.done;
    expect(seen[0]![0]).toBe("No leftover processes.");
  }, 20000);

  test("proc_list's result is bounded", async () => {
    const { leftovers } = fakeProcesses(Array.from({ length: 80 }, (_, i) => entry({ pid: 1000 + i, command: `node ${"y".repeat(400)}` })));
    const seen: string[][] = [];
    const { engine, model } = await setup([call("proc_list", {}), results(seen)], leftovers);
    await run(engine, model, { background: newHub() }).turn.done;
    const text = seen[0]![0]!;
    expect(text.split("\n").filter((line) => line.startsWith("pid ")).length).toBe(30);
    expect(text).toContain("… and 50 more");
    expect(text.length).toBeLessThan(8000);
  }, 20000);

  test("proc_list redacts secret-looking values and marks what may be the user's own", async () => {
    const { leftovers } = fakeProcesses([entry({ pid: 4242, command: "node server.js --token=abc123", tty: true })]);
    const seen: string[][] = [];
    const { engine, model } = await setup([call("proc_list", {}), results(seen)], leftovers);
    await run(engine, model, { background: newHub() }).turn.done;
    const text = seen[0]![0]!;
    expect(text).toContain("node server.js --token=***");
    expect(text).not.toContain("abc123");
    expect(text).toContain("possibly yours: it has a terminal");
  }, 20000);

  test("proc_list says when the process table could not be read", async () => {
    const { leftovers } = fakeProcesses([]);
    const seen: string[][] = [];
    const { engine, model } = await setup([call("proc_list", {}), results(seen)], { ...leftovers, read: async () => Promise.reject(new Error("ps timed out")) });
    await run(engine, model, { background: newHub() }).turn.done;
    expect(seen[0]![0]).toContain("ps timed out");
    expect(seen[0]![0]).not.toContain("No leftover processes");
  }, 20000);

  test("proc_stop asks first, showing each process (redacted), and stops this run's leftover, refusing any other pid", async () => {
    const { leftovers, signals } = fakeProcesses([entry({ pid: 4242, command: "node server-4242.js --api-key=SECRET" }), entry({ pid: 99, marked: false })]);
    const seen: string[][] = [];
    const { engine, model } = await setup([call("proc_stop", { pids: [4242, 99] }), results(seen)], leftovers);
    const { turn, asks } = run(engine, model, { background: newHub() });
    await turn.done;
    expect(asks.length).toBe(1);
    expect(asks[0]!.toolName).toBe("proc_stop");
    expect(asks[0]!.suppressAlwaysAllowRule).toBe(true);
    expect(asks[0]!.decisionReason).toContain("pid 4242 · 1m · 85 MB · node server-4242.js --api-key=***");
    expect(asks[0]!.decisionReason).toContain("pid 99");
    expect(asks[0]!.decisionReason).not.toContain("SECRET");
    expect(signals).toEqual([[-4242, "SIGTERM"]]);
    expect(seen[0]![0]).toContain("Stopped pid 4242 (SIGTERM, with its process group): node server-4242.js --api-key=***");
    expect(seen[0]![0]).toContain("Not stopped pid 99: not a leftover process of this marcsh run");
  }, 20000);

  test("denied, proc_stop stops nothing", async () => {
    const { leftovers, signals } = fakeProcesses([entry({ pid: 4242 })]);
    const seen: string[][] = [];
    const { engine, model } = await setup([call("proc_stop", { pids: [4242] }), results(seen)], leftovers);
    const { turn, asks } = run(engine, model, { background: newHub() }, "deny");
    await turn.done;
    expect(asks.length).toBe(1);
    expect(signals).toEqual([]);
  }, 20000);

  test("in yolo proc_stop still asks, and an \"always\" answer allows only that call", async () => {
    const { leftovers, signals } = fakeProcesses([entry({ pid: 4242 }), entry({ pid: 4343 })]);
    const seen: string[][] = [];
    const { engine, model } = await setup([call("proc_stop", { pids: [4242] }), call("proc_stop", { pids: [4343] }, "c2"), results(seen)], leftovers);
    const { turn, asks } = run(engine, model, { background: newHub(), approvalMode: "yolo" }, "always");
    await turn.done;
    expect(asks.map((ask) => ask.toolName)).toEqual(["proc_stop", "proc_stop"]);
    expect(signals).toEqual([
      [-4242, "SIGTERM"],
      [-4343, "SIGTERM"],
    ]);
  }, 20000);

  test("in Plan only proc_list is offered, and a proc_stop call is blocked", async () => {
    const { leftovers, signals } = fakeProcesses([entry({ pid: 4242 })]);
    const names: string[][] = [];
    const seen: string[][] = [];
    const stopAnyway: FauxResponseStep = (context) => {
      names.push(declaredProcTools(context.messages));
      return call("proc_stop", { pids: [4242] });
    };
    const { engine, model } = await setup([stopAnyway, results(seen)], leftovers);
    await run(engine, model, { background: newHub(), mode: Mode.PLAN }).turn.done;
    expect(names[0]).toEqual(["proc_list"]);
    // Not offered, so pi does not find it; were it offered anyway, approval would block it.
    expect(seen.at(-1)![0]).toMatch(new RegExp(`Tool proc_stop not found|${PLAN_MODE_REASON}`));
    expect(signals).toEqual([]);
  }, 20000);

  test("a build turn offers both; a turn without a background hub (a child, `marcsh run`) offers neither", async () => {
    const withHub: string[][] = [];
    const first = await setup([offered(withHub)], fakeProcesses([]).leftovers);
    await run(first.engine, first.model, { background: newHub() }).turn.done;
    expect(withHub[0]).toEqual(["proc_list", "proc_stop"]);
    const without: string[][] = [];
    const second = await setup([offered(without)], fakeProcesses([]).leftovers);
    await run(second.engine, second.model).turn.done;
    expect(without[0]).toEqual([]);
  }, 20000);

  test("an agent without the bash group gets neither", async () => {
    const names: string[][] = [];
    const { engine, model } = await setup([offered(names)], fakeProcesses([]).leftovers);
    await run(engine, model, { background: newHub(), deniedTools: ["bash"] }).turn.done;
    expect(names[0]).toEqual([]);
  }, 20000);
});

describe("which proc tools are marcsh's", () => {
  const source = { path: "<inline:marcsh-procs>" };
  test("by name and source: proc_list runs unasked, proc_stop asks, and only proc_list is offered in Plan", () => {
    expect([...PROC_TOOLS]).toEqual(["proc_list", "proc_stop"]);
    expect([...PROC_PLAN_TOOLS]).toEqual(["proc_list"]);
    expect(runsUnasked({ name: "proc_list", sourceInfo: source })).toBe(true);
    expect(runsUnasked({ name: "proc_stop", sourceInfo: source })).toBe(false);
    for (const name of PROC_TOOLS) {
      expect(isMarcshProcTool({ name, sourceInfo: source })).toBe(true);
      // The same name from another extension is just another tool: it asks, and Plan never offers it.
      expect(isMarcshProcTool({ name, sourceInfo: { path: "/x/ext.ts" } })).toBe(false);
      expect(runsUnasked({ name, sourceInfo: { path: "/x/ext.ts" } })).toBe(false);
      expect(offeredInPlan({ name, sourceInfo: { path: "/x/ext.ts" } })).toBe(false);
    }
    expect(offeredInPlan({ name: "proc_list", sourceInfo: source })).toBe(true);
    expect(offeredInPlan({ name: "proc_stop", sourceInfo: source })).toBe(false);
  });

  test("the approval handler asks for proc_stop in yolo on a feature branch, even with a saved rule, and offers no always", async () => {
    const [, stop] = createProcTools(fakeProcesses([entry({ pid: 4242, tty: true })]).leftovers);
    const tools = [{ name: "proc_stop", sourceInfo: source, parameters: stop!.parameters }];
    for (const answer of ["always", "deny"] as const) {
      const asks: PermissionAsk[] = [];
      const decide = createApprovalHandler({
        cwd: "/p",
        rules: { addPermissionRule: () => {}, hasPermissionRule: () => true },
        host: { askPermission: async (ask) => (asks.push(ask), answer) },
        signal: new AbortController().signal,
        tools: () => tools,
        approvalMode: "yolo",
        branchOf: () => ({ kind: "feature", branch: "feat/x" }),
      });
      const verdict = await decide({ toolName: "proc_stop", input: { pids: [4242] } });
      expect(asks.length).toBe(1);
      expect(asks[0]!.suppressAlwaysAllowRule).toBe(true);
      expect(asks[0]!.decisionReason).toContain("pid 4242");
      expect(asks[0]!.decisionReason).toContain("possibly yours: it has a terminal");
      expect(verdict).toEqual(answer === "deny" ? { block: true, reason: DENIED_REASON } : undefined);
    }
  });

  // R4-6: an interrupted turn does not wait for a scan or a stop.
  test("both honour the tool's abort signal", async () => {
    const { leftovers, signals } = fakeProcesses([entry({ pid: 4242 })]);
    const [list, stop] = createProcTools(leftovers);
    const controller = new AbortController();
    controller.abort();
    await expect(list!.execute("c1", {}, controller.signal, undefined, undefined as never)).rejects.toThrow();
    await expect(stop!.execute("c2", { pids: [4242] }, controller.signal, undefined, undefined as never)).rejects.toThrow();
    expect(signals).toEqual([]);
  });

  test("they are in the bash group", () => {
    expect(isPiToolDenied("proc_list", ["bash"])).toBe(true);
    expect(isPiToolDenied("proc_stop", ["bash"])).toBe(true);
    expect(isPiToolDenied("proc_list", ["edit"])).toBe(false);
  });
});
