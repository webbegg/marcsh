import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { createBackgroundHub, type BackgroundBatch, type BackgroundHub } from "../background/hub";
import { terminalsFor } from "../background/session-terminals";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { createBackgroundTools } from "./pi-bg-tools";
import { trustEveryProject } from "./test-trust";
import type { PermissionAsk, TurnHost, TurnRequest } from "./types";

// S1/S1a: the pi engine offers marcsh's bg_* tools only when the turn has a background hub, and their results go through it.
let dir: string;
let agentDir: string;
let cwd: string;
const hubs: BackgroundHub[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-bg-terminals-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
  rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (!check() && Date.now() - start < timeoutMs) await wait(10);
  expect(check()).toBe(true);
}

function newHub(debounceMs = 5) {
  const hub = createBackgroundHub({ debounceMs, registerTurn: () => () => {} });
  hubs.push(hub);
  const idle: BackgroundBatch[] = [];
  hub.setIdleSink((batch) => (idle.push(batch), true));
  return { hub, idle };
}

async function setup(responses: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 2000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });
  return { engine, faux, model: "faux/faux-1" };
}

const call = (name: string, args: Record<string, unknown>, id = "c1") => fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });
const toolResultTexts = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));

function run(engine: ReturnType<typeof createPiEngine>, model: string, overrides: Partial<TurnRequest> = {}) {
  const asks: PermissionAsk[] = [];
  const host: TurnHost = {
    emit: () => {},
    askPermission: async (ask) => (asks.push(ask), "allow"),
    askQuestions: async () => null,
  };
  const turn = engine.startTurn({ prompt: "go", cwd, mode: Mode.BUILD, model, signal: new AbortController().signal, ...overrides }, host);
  return { turn, asks };
}

/** A step that records the tool names the request offers and answers with text. */
function offered(names: string[][]): FauxResponseStep {
  return (context) => {
    const declared = (context.messages as Array<{ role: string; toolsAdded?: { name: string }[] }>).flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : []));
    names.push([...new Set(declared.map((tool) => tool.name))].filter((name) => name.startsWith("bg_")));
    return fauxAssistantMessage([fauxText("ok")]);
  };
}

describe("background terminals in a pi turn (S1, S1a)", () => {
  test("bg_start asks as bg_start, returns at once, and the exit is delivered through the hub after the turn", async () => {
    const { hub, idle } = newHub();
    const results: string[][] = [];
    const after: FauxResponseStep = (context) => {
      results.push(toolResultTexts(context.messages));
      return fauxAssistantMessage([fauxText("started it")]);
    };
    const { engine, model } = await setup([call("bg_start", { command: "sleep 0.4; echo BUILD-OK", title: "build" }), after]);
    const { turn, asks } = run(engine, model, { background: hub });
    await turn.done;

    expect(asks).toEqual([{ toolName: "bg_start", input: { command: "sleep 0.4; echo BUILD-OK", title: "build" } }]);
    expect(results[0]![0]).toContain('Started background terminal bt-1 "build"');
    const snap = terminalsFor(hub).get("bt-1")!;
    expect(snap.cwd).toBe(cwd);
    await until(() => idle.length === 1);
    expect(snap.status).toBe("done");
    expect(idle[0]!.ids).toEqual(["bt-1"]);
    expect(idle[0]!.notice).toBe("[background] build finished");
    expect(idle[0]!.text).toContain("BUILD-OK");
    expect(idle[0]!.text).toContain("exit 0");
  }, 20000);

  test("bg_status of a finished terminal reports it, so it is never announced", async () => {
    // A long debounce: the hub would announce it only well after bg_status has collected it.
    const { hub, idle } = newHub(1500);
    const results: string[][] = [];
    const status: FauxResponseStep = async () => {
      await until(() => terminalsFor(hub).get("bt-1")?.status === "done");
      return call("bg_status", { id: "bt-1" }, "c2");
    };
    const after: FauxResponseStep = (context) => {
      results.push(toolResultTexts(context.messages));
      return fauxAssistantMessage([fauxText("all good")]);
    };
    const { engine, model } = await setup([call("bg_start", { command: "echo QUICK-OUT", title: "quick" }), status, after]);
    await run(engine, model, { background: hub }).turn.done;

    expect(results[0]![1]).toContain("bt-1 [done]");
    expect(results[0]![1]).toContain("QUICK-OUT");
    await wait(1700);
    expect(idle).toEqual([]);
    expect(hub.pending()).toEqual([]);
  }, 20000);

  test("bg_kill only knows this session's terminals", async () => {
    const other = newHub();
    const foreign = terminalsFor(other.hub).start({ command: "sleep 30", title: "other session", cwd });
    const { hub } = newHub();
    const results: string[][] = [];
    const after: FauxResponseStep = (context) => {
      results.push(toolResultTexts(context.messages));
      return fauxAssistantMessage([fauxText("ok")]);
    };
    const { engine, model } = await setup([call("bg_kill", { ids: [foreign.id] }), after]);
    await run(engine, model, { background: hub }).turn.done;
    expect(results[0]![0]).toContain(`Unknown terminal id "${foreign.id}"`);
    expect(foreign.status).toBe("running");
  }, 20000);

  test("the tools are offered only with a hub, only bg_status and bg_list in plan mode, and none when bash is denied", async () => {
    const names: string[][] = [];
    const { engine, model } = await setup([offered(names), offered(names), offered(names), offered(names)]);
    await run(engine, model, { background: newHub().hub }).turn.done;
    await run(engine, model).turn.done;
    await run(engine, model, { background: newHub().hub, mode: Mode.PLAN }).turn.done;
    await run(engine, model, { background: newHub().hub, deniedTools: ["bash"] }).turn.done;
    expect(names).toEqual([["bg_start", "bg_status", "bg_list", "bg_kill"], [], ["bg_status", "bg_list"], []]);
  }, 30000);

  test("a bg_start into another repository on main is denied there, though a bash rule for the command is saved in the session folder (B1)", async () => {
    const gitInit = (at: string, branch: string) => {
      mkdirSync(at, { recursive: true });
      expect(Bun.spawnSync(["git", "init", "-q", "-b", branch], { cwd: at, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    };
    gitInit(cwd, "feat/x");
    const other = join(dir, "other");
    gitInit(other, "main");
    const command = "git -c user.email=a@b -c user.name=a commit --allow-empty -m PROBE";
    const { hub } = newHub();
    const rules = openStorage(":memory:");
    rules.addPermissionRule({ cwd, toolName: "bash", command });
    const results: string[][] = [];
    const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 2000, tokenSize: { min: 1, max: 1 } });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      call("bg_start", { command, title: "c", working_dir: other }),
      (context) => (results.push(toolResultTexts(context.messages)), fauxAssistantMessage([fauxText("ok")])),
    ]);
    const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: rules, projectTrust: trustEveryProject });
    const { turn, asks } = run(engine, "faux/faux-1", { background: hub });
    await turn.done;
    expect(asks).toEqual([]);
    expect(results[0]![0]).toContain("marcsh: commits on main are blocked");
    expect(terminalsFor(hub).list()).toEqual([]);
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], { cwd: other, stdout: "ignore", stderr: "ignore" }).exitCode).not.toBe(0);
  }, 20000);

  test("bg_kill and bg_status of a terminal whose result the hub already handed on still show its output (V-A2: a duplicate, never a loss)", async () => {
    const { hub, idle } = newHub();
    const snapshot = terminalsFor(hub).start({ command: "echo TAIL-OUT", title: "tail", cwd });
    await until(() => idle.length === 1);
    const tools = createBackgroundTools({ hub, cwd });
    const execute = (name: string, params: unknown) => tools.find((tool) => tool.name === name)!.execute("t1", params as never, undefined, undefined, undefined as never);
    const texts = async (name: string, params: unknown) => ((await execute(name, params)) as { content: { text: string }[] }).content.map((block) => block.text).join("");
    const killed = await texts("bg_kill", { ids: [snapshot.id] });
    expect(killed).toContain("was already done");
    expect(killed).toContain("TAIL-OUT");
    expect(await texts("bg_status", { id: snapshot.id })).toContain("TAIL-OUT");
  }, 20000);

  test("a bg_start a stored bash rule allows runs without asking", async () => {
    const { hub } = newHub();
    const rules = openStorage(":memory:");
    rules.addPermissionRule({ cwd, toolName: "bash", command: "true" });
    const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 2000, tokenSize: { min: 1, max: 1 } });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([call("bg_start", { command: "true", title: "noop" }), fauxAssistantMessage([fauxText("ok")])]);
    const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: rules, projectTrust: trustEveryProject });
    const { turn, asks } = run(engine, "faux/faux-1", { background: hub });
    await turn.done;
    expect(asks).toEqual([]);
    expect(terminalsFor(hub).get("bt-1")).toBeDefined();
  }, 20000);
});
