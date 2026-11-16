import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { Cooldowns, LIMIT_COOLDOWN_MS, TRANSIENT_COOLDOWN_MS } from "../model-fallback";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import type { EngineEvent, NoticeLevel, TurnHost, TurnRequest } from "./types";

// Fallback chains on real pi sessions with the faux provider: a failure that stays after pi's own retries moves the turn (or a Task child)
// to the next model of its route's chain; context length and invalid requests never do.

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-fallback-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // pi retries a 429 or an overload with a pause by itself; the tests turn that off (one test leaves one fast retry on).
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CHILD_PROMPT = "child: do the task";
const userTexts = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "user" ? [typeof m.content === "string" ? m.content : m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));
const toolResults = (messages: Message[]) => messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));

const failure = (errorMessage: string) => fauxAssistantMessage([], { stopReason: "error", errorMessage });
const QUOTA = "429 You exceeded your current quota, please check your plan and billing details";
const OVERLOADED = "529 overloaded_error: Overloaded";
const CONTEXT = "400 invalid_request_error: prompt is too long: 250000 tokens > 200000 maximum";

type Call = { model: string; users: string[]; results: string[] };
type Script = { parent: (model: string, call: Call) => ReturnType<typeof fauxAssistantMessage>; child: (model: string, call: Call) => ReturnType<typeof fauxAssistantMessage> };

/**
 * Both models are scripted by `parent(model, call)` and `child(model, call)`; a request whose first user message is the child prompt is the
 * Task child's. `calls` records every request, the parent's and the child's.
 */
async function setup(script: Partial<Script>, { cooldowns = new Cooldowns() }: { cooldowns?: Cooldowns } = {}) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const parents: Call[] = [];
  const children: Call[] = [];
  const router: FauxResponseStep = (context, _options, _state, model) => {
    const messages = context.messages as Message[];
    const call = { model: model.id, users: userTexts(messages), results: toolResults(messages) };
    if (call.users[0] === CHILD_PROMPT) {
      children.push(call);
      return (script.child ?? (() => fauxAssistantMessage([fauxText("child answer")])))(model.id, call);
    }
    parents.push(call);
    return (script.parent ?? (() => fauxAssistantMessage([fauxText("parent answer")])))(model.id, call);
  };
  faux.setResponses(Array.from({ length: 24 }, () => router));
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject, cooldowns });

  async function turn(overrides: Partial<TurnRequest> = {}) {
    const events: EngineEvent[] = [];
    const notices: Array<{ message: string; level: NoticeLevel }> = [];
    const host: TurnHost = {
      emit: (event) => events.push(event),
      askPermission: async () => "allow",
      askQuestions: async () => null,
      notify: (message, level) => notices.push({ message, level }),
    };
    await engine.startTurn({ prompt: "fix the bug", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal, ...overrides }, host).done;
    let text = "";
    for (const event of events) {
      if (event.type !== "reply") continue;
      const reply = event.update({ id: "r", role: "assistant", parts: [] });
      for (const part of reply.parts) if (part.type === "text") text += part.text;
    }
    return { errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])), notices, text };
  }
  return { turn, parents, children, cooldowns };
}

const taskCall = (agent?: string) =>
  fauxAssistantMessage([fauxToolCall("Task", { description: "Do the task", prompt: CHILD_PROMPT, ...(agent ? { agent } : {}) } as never, { id: "task-1" })], { stopReason: "toolUse" });
const REFUTER = { name: "refuter", readOnly: true };

describe("the main turn falls back (pi)", () => {
  test("a quota failure on the turn's model continues the same conversation on the next model of the chain, with a notice", async () => {
    const { turn, parents, cooldowns } = await setup({ parent: (model) => (model === "faux-1" ? failure(QUOTA) : fauxAssistantMessage([fauxText("done on the next model")])) });

    const { errors, notices, text } = await turn({ routing: { model: "faux/faux-1", fallback: [{ model: "faux/faux-2" }, { model: "faux/faux-3" }] } });

    expect(errors).toEqual([]);
    expect(text).toContain("done on the next model");
    expect(parents.map((call) => call.model)).toEqual(["faux-1", "faux-2"]);
    // The next model has the user's request, then a note (pi sends it as a user message, shown to no one) to pick up where the failed one stopped.
    expect(parents[1]!.users).toHaveLength(2);
    expect(parents[1]!.users[0]).toBe("fix the bug");
    expect(parents[1]!.users[1]).toContain("The previous model (faux/faux-1) failed with a usage limit; you now run on faux/faux-2");
    expect(parents[1]!.users[1]).toContain("The user's latest request:\nfix the bug");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe("warning");
    expect(notices[0]!.message).toContain("faux/faux-1");
    expect(notices[0]!.message).toContain("faux/faux-2");
    expect(cooldowns.isCooling("faux/faux-1")).toBe(true);
    expect(cooldowns.isCooling("faux/faux-2")).toBe(false);
  });

  test("the chain is walked in order: the second model fails too, the third answers", async () => {
    const { turn, parents } = await setup({ parent: (model) => (model === "faux-3" ? fauxAssistantMessage([fauxText("third")]) : failure(model === "faux-1" ? QUOTA : OVERLOADED)) });
    const { errors, text } = await turn({ routing: { fallback: [{ model: "faux/faux-2" }, { model: "faux/faux-3" }] } });
    expect(errors).toEqual([]);
    expect(text).toContain("third");
    expect(parents.map((call) => call.model)).toEqual(["faux-1", "faux-2", "faux-3"]);
  });

  test("work already done is kept: the next model sees the tool results of the failed one's turn", async () => {
    const { turn, parents } = await setup({
      parent: (model, call) => {
        if (call.results.length === 0) return fauxAssistantMessage([fauxToolCall("bash", { command: "echo marker-123" }, { id: "b1" })], { stopReason: "toolUse" });
        return model === "faux-1" ? failure(OVERLOADED) : fauxAssistantMessage([fauxText("finished")]);
      },
    });
    const { errors, text } = await turn({ routing: { fallback: [{ model: "faux/faux-2" }] } });
    expect(errors).toEqual([]);
    expect(text).toContain("finished");
    expect(parents.map((call) => call.model)).toEqual(["faux-1", "faux-1", "faux-2"]);
    expect(parents[2]!.results.join("\n")).toContain("marker-123");
  });

  test("after pi's own retries: a failure that stayed through them falls back too", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
    const { turn, parents } = await setup({ parent: (model) => (model === "faux-1" ? failure(OVERLOADED) : fauxAssistantMessage([fauxText("recovered")])) });
    const { errors, text } = await turn({ routing: { fallback: [{ model: "faux/faux-2" }] } });
    expect(errors).toEqual([]);
    expect(text).toContain("recovered");
    // The original request, pi's one retry, then the next model.
    expect(parents.map((call) => call.model)).toEqual(["faux-1", "faux-1", "faux-2"]);
  });

  test("an auth failure, a rate limit, a network error and a timeout fall back as well", async () => {
    for (const message of ["401 invalid x-api-key", "429 Too Many Requests", "Connection error.", "Request timed out"]) {
      const { turn, parents } = await setup({ parent: (model) => (model === "faux-1" ? failure(message) : fauxAssistantMessage([fauxText("ok")])) });
      const { errors } = await turn({ routing: { fallback: [{ model: "faux/faux-2" }] } });
      expect(errors, message).toEqual([]);
      expect(parents.map((call) => call.model), message).toEqual(["faux-1", "faux-2"]);
    }
  });

  test("a context-length error does not fall back: it is reported, and no other model is asked", async () => {
    const { turn, parents, cooldowns } = await setup({ parent: () => failure(CONTEXT) });
    const { errors, notices } = await turn({ routing: { fallback: [{ model: "faux/faux-2" }] } });
    expect(errors).toEqual([CONTEXT]);
    expect(parents.map((call) => call.model)).toEqual(["faux-1"]);
    expect(notices).toEqual([]);
    expect(cooldowns.isCooling("faux/faux-1")).toBe(false);
  });

  test("a failure no category knows is not retried on another model", async () => {
    const { turn, parents } = await setup({ parent: () => failure("provider exploded") });
    const { errors } = await turn({ routing: { fallback: [{ model: "faux/faux-2" }] } });
    expect(errors).toEqual(["provider exploded"]);
    expect(parents).toHaveLength(1);
  });

  test("the whole chain failing reports the last failure once", async () => {
    const { turn, parents } = await setup({ parent: (model) => failure(model === "faux-1" ? QUOTA : OVERLOADED) });
    const { errors } = await turn({ routing: { fallback: [{ model: "faux/faux-2" }] } });
    expect(errors).toEqual([OVERLOADED]);
    expect(parents.map((call) => call.model)).toEqual(["faux-1", "faux-2"]);
  });

  test("models that are cooling down, unknown, or not usable on pi are skipped", async () => {
    const cooldowns = new Cooldowns();
    cooldowns.cool("faux/faux-2", LIMIT_COOLDOWN_MS);
    const { turn, parents } = await setup({ parent: (model) => (model === "faux-1" ? failure(QUOTA) : fauxAssistantMessage([fauxText("third answered")])) }, { cooldowns });
    const { errors, text } = await turn({ routing: { fallback: [{ model: "faux/faux-2" }, { model: "faux/missing" }, { model: "sonnet" }, { model: "faux/faux-3" }] } });
    expect(errors).toEqual([]);
    expect(text).toContain("third answered");
    expect(parents.map((call) => call.model)).toEqual(["faux-1", "faux-3"]);
  });

  test("a step's thinking level applies when the turn moves to it", async () => {
    const levels: Array<string | undefined> = [];
    const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }, { id: "faux-2", reasoning: true }] });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      (_context, options, _state, model) => (levels.push(`${model.id}:${options?.reasoning ?? "-"}`), failure(QUOTA)),
      (_context, options, _state, model) => (levels.push(`${model.id}:${options?.reasoning ?? "-"}`), fauxAssistantMessage([fauxText("ok")])),
    ]);
    const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject, cooldowns: new Cooldowns() });
    const host: TurnHost = { emit: () => {}, askPermission: async () => "allow", askQuestions: async () => null };
    await engine.startTurn({ prompt: "x", cwd, mode: Mode.BUILD, model: "faux/faux-1", routing: { model: "faux/faux-1", thinking: "low", fallback: [{ model: "faux/faux-2", thinking: "high" }] }, signal: new AbortController().signal }, host).done;
    expect(levels).toEqual(["faux-1:low", "faux-2:high"]);
  });

  test("without a chain nothing changes: the failure is reported as it always was", async () => {
    const { turn, parents } = await setup({ parent: () => failure(QUOTA) });
    expect((await turn()).errors).toEqual([QUOTA]);
    expect(parents).toHaveLength(1);
  });
});

describe("a Task child falls back (pi)", () => {
  const parent: Script["parent"] = (_model, call) => (call.results.length === 0 ? taskCall("refuter") : fauxAssistantMessage([fauxText("parent done")]));

  test("a child that fails on its routed model restarts on the next model and the turn completes", async () => {
    const { turn, children, parents } = await setup({ parent, child: (model) => (model === "faux-2" ? failure(OVERLOADED) : fauxAssistantMessage([fauxText("child answered on faux-3")])) });

    const { errors, notices, text } = await turn({ subagents: [{ ...REFUTER, model: "faux/faux-2", fallback: [{ model: "faux/faux-3" }] }] });

    expect(errors).toEqual([]);
    expect(text).toContain("parent done");
    expect(children.map((call) => call.model)).toEqual(["faux-2", "faux-3"]);
    expect(parents[1]!.results.join("\n")).toContain("child answered on faux-3");
    expect(notices.map((notice) => notice.message).join("\n")).toContain("faux/faux-2");
    expect(notices.map((notice) => notice.message).join("\n")).toContain("faux/faux-3");
  });

  test("the restart is a fresh child: it gets the same prompt, not the failed one's history", async () => {
    const { turn, children } = await setup({ parent, child: (model) => (model === "faux-2" ? failure(QUOTA) : fauxAssistantMessage([fauxText("fresh")])) });
    await turn({ subagents: [{ ...REFUTER, model: "faux/faux-2", fallback: [{ model: "faux/faux-3" }] }] });
    expect(children[1]!.users).toEqual([CHILD_PROMPT]);
  });

  test("a context-length error in the child does not restart it: the Task fails", async () => {
    const { turn, children, parents } = await setup({ parent, child: () => failure(CONTEXT) });
    const { errors } = await turn({ subagents: [{ ...REFUTER, model: "faux/faux-2", fallback: [{ model: "faux/faux-3" }] }] });
    expect(errors).toEqual([]);
    expect(children.map((call) => call.model)).toEqual(["faux-2"]);
    expect(parents[1]!.results.join("\n")).toContain("prompt is too long");
  });

  test("every model of the chain failing is a Task error with the last failure", async () => {
    const { turn, children, parents } = await setup({ parent, child: (model) => failure(model === "faux-2" ? QUOTA : OVERLOADED) });
    await turn({ subagents: [{ ...REFUTER, model: "faux/faux-2", fallback: [{ model: "faux/faux-3" }] }] });
    expect(children.map((call) => call.model)).toEqual(["faux-2", "faux-3"]);
    expect(parents[1]!.results.join("\n")).toContain("Overloaded");
  });

  test("with no chain a failing child is a Task error, as before", async () => {
    const { turn, children, parents } = await setup({ parent, child: () => failure(QUOTA) });
    await turn({ subagents: [{ ...REFUTER, model: "faux/faux-2" }] });
    expect(children.map((call) => call.model)).toEqual(["faux-2"]);
    expect(parents[1]!.results.join("\n")).toContain("quota");
  });

  test("a failed model is skipped on the next launch (30 minutes after a limit); a transient one for 2", async () => {
    let now = 1_000_000;
    const cooldowns = new Cooldowns(() => now);
    const { turn, children } = await setup({ parent, child: (model) => (model === "faux-2" ? failure(QUOTA) : fauxAssistantMessage([fauxText("ok")])) }, { cooldowns });
    const subagents = [{ ...REFUTER, model: "faux/faux-2", fallback: [{ model: "faux/faux-3" }] }];

    await turn({ subagents });
    expect(children.map((call) => call.model)).toEqual(["faux-2", "faux-3"]);

    // The next launch starts on the model that answers: faux-2 is not asked again.
    children.length = 0;
    await turn({ subagents });
    expect(children.map((call) => call.model)).toEqual(["faux-3"]);

    // Just under 30 minutes later it is still skipped; at 30 it is tried first again.
    children.length = 0;
    now += LIMIT_COOLDOWN_MS - 1;
    await turn({ subagents });
    expect(children.map((call) => call.model)).toEqual(["faux-3"]);
    children.length = 0;
    now += 1;
    await turn({ subagents });
    expect(children[0]!.model).toBe("faux-2");
    expect(TRANSIENT_COOLDOWN_MS).toBeLessThan(LIMIT_COOLDOWN_MS);
  });

  test("a transient failure is skipped for 2 minutes only", async () => {
    let now = 5_000;
    const cooldowns = new Cooldowns(() => now);
    const { turn, children } = await setup({ parent, child: (model) => (model === "faux-2" ? failure(OVERLOADED) : fauxAssistantMessage([fauxText("ok")])) }, { cooldowns });
    const subagents = [{ ...REFUTER, model: "faux/faux-2", fallback: [{ model: "faux/faux-3" }] }];
    await turn({ subagents });
    children.length = 0;
    now += TRANSIENT_COOLDOWN_MS - 1;
    await turn({ subagents });
    expect(children.map((call) => call.model)).toEqual(["faux-3"]);
    children.length = 0;
    now += 1;
    await turn({ subagents });
    expect(children[0]!.model).toBe("faux-2");
  });

  test("a child with no routed model runs on the turn's model; its failure cools that model for later launches", async () => {
    const { turn, children, cooldowns } = await setup({ parent, child: () => failure(QUOTA) });
    await turn({ subagents: [REFUTER] });
    expect(children.map((call) => call.model)).toEqual(["faux-1"]);
    expect(cooldowns.isCooling("faux/faux-1")).toBe(true);
  });
});
