import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import type { ApprovalMode } from "../approval-policy";
import { createBackgroundHub, type BackgroundBatch, type BackgroundHub } from "../background/hub";
import { subagentsFor } from "../background/session-subagents";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import type { PermissionAsk, TurnHost, TurnRequest } from "./types";

// S4: a background Task's child runs on after the parent turn, asks through the session's channel, and its result goes through the hub.
let dir: string;
let agentDir: string;
let cwd: string;
const hubs: BackgroundHub[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-bg-subagents-"));
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

function newHub() {
  const hub = createBackgroundHub({ debounceMs: 5, registerTurn: () => () => {} });
  hubs.push(hub);
  const idle: BackgroundBatch[] = [];
  hub.setIdleSink((batch) => (idle.push(batch), true));
  return { hub, idle };
}

const CHILD_PROMPT = "child: list the files";

const call = (name: string, args: Record<string, unknown>, id: string) => fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });
const toolResultTexts = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));
const firstUserText = (messages: Message[]) => {
  const user = messages.find((m) => m.role === "user");
  if (!user) return "";
  return typeof user.content === "string" ? user.content : user.content.map((block) => ("text" in block ? block.text : "")).join("");
};
const declared = (messages: Message[]) =>
  [...new Set((messages as Array<{ role: string; toolsAdded?: { name: string }[] }>).flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : [])).map((tool) => tool.name))];

type Answer = ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;

type Script = {
  /** The parent's first answer. */
  parent: () => Answer;
  /** The child's answer, given the tool results it has seen. */
  child: (results: string[]) => Answer;
};

/** Parent and child share the faux provider, in no fixed order: every step routes on whose request it is. */
async function setup(script: Script, seen: { child: string[][]; childResults: string[][] } = { child: [], childResults: [] }) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 4000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const router: FauxResponseStep = (context) => {
    const messages = context.messages as Message[];
    if (firstUserText(messages) === CHILD_PROMPT) {
      seen.child.push(declared(messages));
      const results = toolResultTexts(messages);
      seen.childResults.push(results);
      return script.child(results);
    }
    return toolResultTexts(messages).length === 0 ? script.parent() : fauxAssistantMessage([fauxText("started it")]);
  };
  faux.setResponses(Array.from({ length: 12 }, () => router));
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });
  return { engine, seen, model: "faux/faux-1" };
}

function run(engine: ReturnType<typeof createPiEngine>, model: string, overrides: Partial<TurnRequest> = {}) {
  const asks: PermissionAsk[] = [];
  const host: TurnHost = { emit: () => {}, askPermission: async (ask) => (asks.push(ask), "allow"), askQuestions: async () => null };
  const turn = engine.startTurn({ prompt: "go", cwd, mode: Mode.BUILD, model, signal: new AbortController().signal, ...overrides }, host);
  return { turn, asks };
}

const startInBackground = () => call("Task", { description: "List files", prompt: CHILD_PROMPT, background: true }, "t1");

describe("a background subagent in a pi turn (S4)", () => {
  test("runs on after the parent turn, asks the session's channel after the turn ended, and delivers its result through the hub", async () => {
    const { hub, idle } = newHub();
    const sessionAsks: PermissionAsk[] = [];
    hub.host = { askPermission: async (ask) => (sessionAsks.push(ask), "allow") };
    let parentDone = false;
    const { engine, model, seen } = await setup({
      parent: startInBackground,
      child: async (results) => {
        if (results.length > 0) return fauxAssistantMessage([fauxText("CHILD-FINAL-ANSWER")]);
        // The child's first tool call comes only once the parent turn is over.
        await until(() => parentDone);
        return call("bash", { command: "echo CHILD-RAN" }, "b1");
      },
    });
    const { turn, asks } = run(engine, model, { background: hub });
    await turn.done;
    parentDone = true;

    expect(subagentsFor(hub).get("sa-1")?.status).toBe("running");
    await until(() => idle.length === 1);

    // Task itself ran unasked; the child's bash asked the session's channel, labelled, after the turn had ended.
    expect(asks).toEqual([]);
    expect(sessionAsks).toEqual([{ toolName: "bash", input: { command: "echo CHILD-RAN" }, description: "Background subagent: List files" }]);
    expect(seen.childResults.at(-1)![0]).toContain("CHILD-RAN");
    expect(idle[0]!.ids).toEqual(["sa-1"]);
    expect(idle[0]!.notice).toBe("[background] List files finished");
    expect(idle[0]!.text).toContain("CHILD-FINAL-ANSWER");
    const snapshot = subagentsFor(hub).get("sa-1")!;
    expect(snapshot.status).toBe("completed");
    // The live transcript was folded from the child's events.
    expect(snapshot.transcript.parts.some((part) => part.type === "tool" && part.toolName === "bash")).toBe(true);
  }, 30000);

  test("with nobody to ask (no session channel) the child's call is denied", async () => {
    const { hub, idle } = newHub();
    const { engine, model, seen } = await setup({
      parent: startInBackground,
      child: (results) => (results.length > 0 ? fauxAssistantMessage([fauxText("could not run it")]) : call("bash", { command: "echo NOPE" }, "b1")),
    });
    await run(engine, model, { background: hub }).turn.done;
    await until(() => idle.length === 1);
    expect(seen.childResults.at(-1)![0]).toContain("denied");
    expect(seen.childResults.at(-1)![0]).not.toContain("NOPE\n");
  }, 30000);

  test("the child has no background tools: no bg_*, no task_*, no Task", async () => {
    const { hub, idle } = newHub();
    const { engine, model, seen } = await setup({ parent: startInBackground, child: () => fauxAssistantMessage([fauxText("done")]) });
    await run(engine, model, { background: hub }).turn.done;
    await until(() => idle.length === 1);
    expect(seen.child.length).toBeGreaterThan(0);
    for (const names of seen.child) {
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((name) => name.startsWith("bg_") || name.startsWith("task_") || name === "Task")).toEqual([]);
    }
  }, 30000);

  test("the task tools are offered only with a hub, without task_cancel in plan mode, and none when task is denied", async () => {
    const names: string[][] = [];
    const offered: FauxResponseStep = (context) => {
      names.push(declared(context.messages as Message[]).filter((name) => name.startsWith("task_")));
      return fauxAssistantMessage([fauxText("ok")]);
    };
    const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 4000, tokenSize: { min: 1, max: 1 } });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([offered, offered, offered, offered]);
    const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });
    const model = "faux/faux-1";
    await run(engine, model, { background: newHub().hub }).turn.done;
    await run(engine, model).turn.done;
    await run(engine, model, { background: newHub().hub, mode: Mode.PLAN }).turn.done;
    await run(engine, model, { background: newHub().hub, deniedTools: ["task"] }).turn.done;
    expect(names).toEqual([["task_wait", "task_check", "task_cancel", "task_list"], [], ["task_wait", "task_check", "task_list"], []]);
  }, 30000);

  test("in plan mode a background Task starts nothing", async () => {
    const { hub } = newHub();
    const results: string[][] = [];
    const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 4000, tokenSize: { min: 1, max: 1 } });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      startInBackground(),
      (context) => (results.push(toolResultTexts(context.messages as Message[])), fauxAssistantMessage([fauxText("ok")])),
    ]);
    const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });
    await run(engine, "faux/faux-1", { background: hub, mode: Mode.PLAN }).turn.done;
    expect(results[0]![0]).toContain("Background subagents are not available");
    expect(subagentsFor(hub).list()).toEqual([]);
  }, 30000);

  test("the child asks under the session's approval mode as it is at each call, also after the parent turn ended", async () => {
    // Auto and yolo relax only on a feature branch: the project is a real repository on one.
    const git = Bun.spawnSync(["git", "init", "-q", "-b", "feat/x"], { cwd, stdout: "ignore", stderr: "pipe" });
    expect(git.exitCode).toBe(0);
    const { hub, idle } = newHub();
    const sessionAsks: PermissionAsk[] = [];
    hub.host = { askPermission: async (ask) => (sessionAsks.push(ask), "deny") };
    let approvalMode: ApprovalMode = "auto";
    let parentDone = false;
    const { engine, model, seen } = await setup({
      parent: startInBackground,
      child: async (results) => {
        if (results.length === 0) {
          await until(() => parentDone);
          return call("bash", { command: "echo AUTO-RAN" }, "b1");
        }
        // The user switches the session's mode while the child runs.
        if (results.length === 1) return (approvalMode = "normal"), call("bash", { command: "echo NORMAL-ASKED" }, "b2");
        if (results.length === 2) return (approvalMode = "yolo"), call("bash", { command: "npm install left-pad" }, "b3");
        return fauxAssistantMessage([fauxText("done")]);
      },
    });
    const { turn, asks } = run(engine, model, { background: hub, approvalMode: "auto", currentApprovalMode: () => approvalMode });
    await turn.done;
    parentDone = true;
    await until(() => idle.length === 1);

    expect(asks).toEqual([]);
    // auto: the ordinary command ran unasked; normal: it asked; yolo: the floor command asked, without always.
    expect(seen.childResults.at(-1)![0]).toContain("AUTO-RAN");
    expect(sessionAsks).toHaveLength(2);
    expect(sessionAsks[0]).toEqual({ toolName: "bash", input: { command: "echo NORMAL-ASKED" }, description: "Background subagent: List files" });
    expect(sessionAsks[1]).toMatchObject({ toolName: "bash", input: { command: "npm install left-pad" }, suppressAlwaysAllowRule: true, description: "Background subagent: List files" });
  }, 30000);
});
