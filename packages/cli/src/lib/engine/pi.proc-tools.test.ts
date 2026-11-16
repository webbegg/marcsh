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
import { isMarcshProcTool, PROC_PLAN_TOOLS, PROC_TOOLS } from "./pi-proc-tools";
import { offeredInPlan, PLAN_MODE_REASON, runsUnasked } from "./pi-permissions";
import { trustEveryProject } from "./test-trust";
import type { PermissionAsk, TurnHost, TurnRequest } from "./types";

// M6: on pi, the agent lists this run's leftover processes (proc_list, also in Plan) and stops them (proc_stop, not in Plan); both run unasked.
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

function run(engine: Awaited<ReturnType<typeof setup>>["engine"], model: string, overrides: Partial<TurnRequest> = {}) {
  const asks: PermissionAsk[] = [];
  const host: TurnHost = { emit: () => {}, askPermission: async (ask) => (asks.push(ask), "allow"), askQuestions: async () => null };
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

  test("proc_stop runs unasked and stops this run's leftover, refusing any other pid", async () => {
    const { leftovers, signals } = fakeProcesses([entry({ pid: 4242 }), entry({ pid: 99, marked: false })]);
    const seen: string[][] = [];
    const { engine, model } = await setup([call("proc_stop", { pids: [4242, 99] }), results(seen)], leftovers);
    const { turn, asks } = run(engine, model, { background: newHub() });
    await turn.done;
    expect(asks).toEqual([]);
    expect(signals).toEqual([[-4242, "SIGTERM"]]);
    expect(seen[0]![0]).toContain("Stopped pid 4242 (SIGTERM, with its process group): node server-4242.js");
    expect(seen[0]![0]).toContain("Not stopped pid 99: not a leftover process of this marcsh run");
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
  test("by name and source: they run unasked, and only proc_list is offered in Plan", () => {
    expect([...PROC_TOOLS]).toEqual(["proc_list", "proc_stop"]);
    expect([...PROC_PLAN_TOOLS]).toEqual(["proc_list"]);
    for (const name of PROC_TOOLS) {
      expect(isMarcshProcTool({ name, sourceInfo: source })).toBe(true);
      expect(runsUnasked({ name, sourceInfo: source })).toBe(true);
      // The same name from another extension is just another tool: it asks, and Plan never offers it.
      expect(isMarcshProcTool({ name, sourceInfo: { path: "/x/ext.ts" } })).toBe(false);
      expect(runsUnasked({ name, sourceInfo: { path: "/x/ext.ts" } })).toBe(false);
      expect(offeredInPlan({ name, sourceInfo: { path: "/x/ext.ts" } })).toBe(false);
    }
    expect(offeredInPlan({ name: "proc_list", sourceInfo: source })).toBe(true);
    expect(offeredInPlan({ name: "proc_stop", sourceInfo: source })).toBe(false);
  });

  test("they are in the bash group", () => {
    expect(isPiToolDenied("proc_list", ["bash"])).toBe(true);
    expect(isPiToolDenied("proc_stop", ["bash"])).toBe(true);
    expect(isPiToolDenied("proc_list", ["edit"])).toBe(false);
  });
});
