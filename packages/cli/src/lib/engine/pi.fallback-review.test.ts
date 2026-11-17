import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { Cooldowns } from "../model-fallback";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import type { EngineEvent, NoticeLevel, TurnHost, TurnRequest } from "./types";

// Review corrections to the fallback chains on real pi sessions (faux provider): a subagent that ran tools is never restarted (R4-001),
// the continuation quotes the text actually being run (R4-002), an interrupt during the model switch stops the turn (R4-005).

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-fallback-review-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
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

type Call = { model: string; users: string[]; results: string[] };
type Reply = ReturnType<typeof fauxAssistantMessage>;

async function setup(
  script: { parent?: (model: string, call: Call) => Reply | Promise<Reply>; child?: (model: string, call: Call) => Reply },
  { cooldowns = new Cooldowns(), onCheckAuth }: { cooldowns?: Cooldowns; onCheckAuth?: (calls: Call[]) => void } = {},
) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const parents: Call[] = [];
  const children: Call[] = [];
  const router: FauxResponseStep = async (context, _options, _state, model) => {
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
  if (onCheckAuth) {
    const original = modelRuntime.checkAuth.bind(modelRuntime);
    modelRuntime.checkAuth = (async (...args: Parameters<typeof original>) => {
      onCheckAuth(parents);
      return original(...args);
    }) as typeof modelRuntime.checkAuth;
  }
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject, cooldowns });

  function begin(overrides: Partial<TurnRequest> = {}, signal = new AbortController().signal) {
    const events: EngineEvent[] = [];
    const notices: Array<{ message: string; level: NoticeLevel }> = [];
    const host: TurnHost = {
      emit: (event) => events.push(event),
      askPermission: async () => "allow",
      askQuestions: async () => null,
      notify: (message, level) => notices.push({ message, level }),
    };
    const turn = engine.startTurn({ prompt: "fix the bug", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal, ...overrides }, host);
    return { turn, events, notices };
  }
  async function run(overrides: Partial<TurnRequest> = {}) {
    const running = begin(overrides);
    await running.turn.done;
    const errors = running.events.flatMap((e) => (e.type === "error" ? [e.message] : []));
    return { errors, notices: running.notices };
  }
  return { begin, run, parents, children, cooldowns };
}

const taskCall = (agent: string) =>
  fauxAssistantMessage([fauxToolCall("Task", { description: "Do the task", prompt: CHILD_PROMPT, agent } as never, { id: "task-1" })], { stopReason: "toolUse" });
const WORKER = { name: "worker", readOnly: false, model: "faux/faux-2", fallback: [{ model: "faux/faux-3" }] };

describe("a child that ran tools is not restarted (R4-001)", () => {
  const parent = (_model: string, call: Call) => (call.results.length === 0 ? taskCall("worker") : fauxAssistantMessage([fauxText("parent done")]));
  const append = (id: string) => fauxAssistantMessage([fauxToolCall("bash", { command: "echo ran >> ran.txt" }, { id })], { stopReason: "toolUse" });

  test("a bash call and then a 429: the bash runs once, the Task fails with the provider error and says why it was not restarted", async () => {
    const { run, children, parents, cooldowns } = await setup({
      parent,
      child: (_model, call) => (call.results.length === 0 ? append("b1") : failure(QUOTA)),
    });

    const { errors } = await run({ subagents: [WORKER] });

    expect(errors).toEqual([]);
    expect(children.map((call) => call.model)).toEqual(["faux-2", "faux-2"]);
    expect(readFileSync(join(cwd, "ran.txt"), "utf8")).toBe("ran\n");
    const result = parents[1]!.results.join("\n");
    expect(result).toContain("quota");
    expect(result).toContain("stopped after running 1 tool call on faux/faux-2");
    expect(result).toContain("not restarted so its steps would not run twice");
    // The model is cooled as for any failure.
    expect(cooldowns.isCooling("faux/faux-2")).toBe(true);
  });

  test("a child that fails before any tool still restarts on the next model", async () => {
    const { run, children, parents } = await setup({
      parent,
      child: (model) => (model === "faux-2" ? failure(OVERLOADED) : fauxAssistantMessage([fauxText("child answered on faux-3")])),
    });
    await run({ subagents: [WORKER] });
    expect(children.map((call) => call.model)).toEqual(["faux-2", "faux-3"]);
    expect(parents[1]!.results.join("\n")).toContain("child answered on faux-3");
    expect(parents[1]!.results.join("\n")).not.toContain("not restarted");
  });
});

describe("the continuation quotes the text being run (R4-002)", () => {
  test("a queued follow-up that fails is continued on the next model with the follow-up as the latest request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const first = new Promise<void>((resolve) => (started = resolve));
    const { begin, parents } = await setup({
      parent: async (model, call) => {
        if (call.users.at(-1) === "fix the bug" && model === "faux-1") {
          started();
          await gate;
          return fauxAssistantMessage([fauxText("first done")]);
        }
        // The queued follow-up fails on faux-1 and is taken over by faux-2.
        if (model === "faux-1") return failure(QUOTA);
        return fauxAssistantMessage([fauxText("second done")]);
      },
    });

    const running = begin({ routing: { fallback: [{ model: "faux/faux-2" }] } });
    await first;
    await running.turn.followUp!("now rename the file");
    release();
    await running.turn.done;

    const continuation = parents.find((call) => call.model === "faux-2")!;
    expect(continuation).toBeDefined();
    const note = continuation.users.at(-1)!;
    expect(note).toContain("The user's latest request:\nnow rename the file");
    expect(note).not.toContain("The user's latest request:\nfix the bug");
  });
});

describe("an interrupt during the model switch (R4-005)", () => {
  test("stops the turn: the next model is not asked and no continuation is sent", async () => {
    const controller = new AbortController();
    const { begin, parents } = await setup(
      { parent: (model) => (model === "faux-1" ? failure(QUOTA) : fauxAssistantMessage([fauxText("never asked")])) },
      // The first auth check is the turn's own request; the one after the failure is the switch to the next model.
      { onCheckAuth: (calls) => calls.length >= 1 && controller.abort() },
    );

    const running = begin({ routing: { fallback: [{ model: "faux/faux-2" }] } }, controller.signal);
    await running.turn.done;

    expect(parents.map((call) => call.model)).toEqual(["faux-1"]);
    expect(running.events.filter((e) => e.type === "error")).toEqual([]);
    expect(running.notices.filter((n) => n.message.includes("continuing on"))).toEqual([]);
  });
});
