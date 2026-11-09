import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getCurrentTools,
  InMemoryCredentialStore,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import type { ChatMessage } from "../chat-types";
import { Mode } from "../modes";
import { openStorage, type Storage } from "../storage";
import { createPiEngine, defaultPiAgentDir, type PiEngineOptions } from "./pi";
import type { Engine, EngineEvent, NoticeLevel, PermissionAsk, PermissionDecision, TurnHost, TurnRequest } from "./types";

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-engine-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function setup(responses: FauxResponseStep[], permissionRules: Storage = openStorage(":memory:"), engineOptions: PiEngineOptions = {}) {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);

  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules, ...engineOptions });
  return { engine, faux, model: "faux/faux-1", permissionRules };
}

type Outcome = {
  events: EngineEvent[];
  reply: ChatMessage;
  errors: string[];
  refs: string[];
};

const emptyReply = (): ChatMessage => ({ id: "reply", role: "assistant", parts: [] });

function summarize(events: EngineEvent[]): Outcome {
  let reply = emptyReply();
  for (const event of events) if (event.type === "reply") reply = event.update(reply);
  return {
    events,
    reply,
    errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])),
    refs: events.flatMap((e) => (e.type === "session" ? [e.ref] : [])),
  };
}

function start(engine: Engine, model: string, overrides: Partial<TurnRequest> = {}, hostOverrides: Partial<TurnHost> = {}) {
  const events: EngineEvent[] = [];
  const host: TurnHost = {
    emit: (event) => events.push(event),
    askPermission: async () => "deny",
    askQuestions: async () => null,
    ...hostOverrides,
  };
  const controller = new AbortController();
  const turn = engine.startTurn(
    { prompt: "hello", cwd, mode: Mode.BUILD, model, signal: controller.signal, ...overrides },
    host,
  );
  return { turn, events, controller };
}

async function runTurn(engine: Engine, model: string, overrides: Partial<TurnRequest> = {}, hostOverrides: Partial<TurnHost> = {}) {
  const running = start(engine, model, overrides, hostOverrides);
  await running.turn.done;
  return summarize(running.events);
}

// A response that stays open until the request is aborted, as a slow model would.
function hangingResponse() {
  let begin: () => void = () => {};
  const started = new Promise<void>((resolve) => (begin = resolve));
  const step: FauxResponseStep = (_context, options) =>
    new Promise((resolve) => {
      begin();
      options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage([], { stopReason: "aborted" })), {
        once: true,
      });
    });
  return { step, started };
}

const toolParts = (reply: ChatMessage) => reply.parts.flatMap((p) => (p.type === "tool" ? [p] : []));

const bashCall = (command: string, id = "call-1") =>
  fauxAssistantMessage([fauxToolCall("bash", { command }, { id })], { stopReason: "toolUse" });

// A host that answers every approval with `decision` and records what it was asked.
function answering(decision: PermissionDecision) {
  const asks: PermissionAsk[] = [];
  const host: Partial<TurnHost> = {
    askPermission: async (ask) => {
      asks.push(ask);
      return decision;
    },
  };
  return { asks, host };
}

describe("createPiEngine", () => {
  test("keeps pi's files in marcsh's own agent directory, never pi's", () => {
    expect(defaultPiAgentDir()).toBe(join(homedir(), ".marcsh", "agent"));
    expect(defaultPiAgentDir()).not.toContain(join(".pi", "agent"));
  });

  test("identifies itself as pi", async () => {
    const { engine } = await setup([]);

    expect(engine.id).toBe("pi");
  });

  test("replies with the scripted text and records duration and cost metadata", async () => {
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("hi there")])]);

    const { reply, errors } = await runTurn(engine, model);

    expect(errors).toEqual([]);
    expect(reply.parts).toEqual([{ type: "text", text: "hi there" }]);
    expect(reply.metadata?.durationMs).toBeGreaterThanOrEqual(0);
    // The faux provider always reports zero cost; the summing itself is covered in pi-events.test.ts.
    expect(reply.metadata?.costUsd).toBe(0);
  });

  test("maps thinking to a reasoning part before the text", async () => {
    const { engine, model } = await setup([fauxAssistantMessage([fauxThinking("let me think"), fauxText("answer")])]);

    const { reply } = await runTurn(engine, model);

    expect(reply.parts).toEqual([
      { type: "reasoning", text: "let me think" },
      { type: "text", text: "answer" },
    ]);
  });

  test("runs tools: one call finishes done, one fails with the error text", async () => {
    writeFileSync(join(cwd, "notes.txt"), "contents");
    const { engine, model } = await setup([
      fauxAssistantMessage([fauxToolCall("read", { path: join(cwd, "notes.txt") }, { id: "ok" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: join(cwd, "missing.txt") }, { id: "bad" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("finished")]),
    ]);

    const { reply, errors } = await runTurn(engine, model);

    expect(errors).toEqual([]);
    const tools = reply.parts.flatMap((p) => (p.type === "tool" ? [p] : []));
    expect(tools.map((t) => [t.toolCallId, t.toolName, t.state])).toEqual([
      ["ok", "read", "done"],
      ["bad", "read", "error"],
    ]);
    expect(tools[0]?.input).toEqual({ path: join(cwd, "notes.txt") });
    expect(tools[1]?.errorText).toContain("missing.txt");
    expect(reply.parts.at(-1)).toEqual({ type: "text", text: "finished" });
  });

  test("emits the session file as the resume ref, under the agent directory", async () => {
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("one")])]);

    const { refs } = await runTurn(engine, model);

    expect(refs).toHaveLength(1);
    expect(refs[0]?.startsWith(join(agentDir, "sessions"))).toBe(true);
    expect(existsSync(refs[0]!)).toBe(true);
  });

  test("resumes the same session file with its history on the next turn", async () => {
    const seen: string[] = [];
    const recall: FauxResponseStep = (context) => {
      const users = context.messages.flatMap((m) =>
        m.role === "user" ? [typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join("")] : [],
      );
      seen.push(...users);
      return fauxAssistantMessage([fauxText(`saw ${users.length}`)]);
    };
    const { engine, model } = await setup([recall, recall]);

    const first = await runTurn(engine, model, { prompt: "remember 42" });
    const second = await runTurn(engine, model, { prompt: "what number?", resumeRef: first.refs[0] });

    expect(second.refs).toEqual(first.refs);
    expect(seen).toEqual(["remember 42", "remember 42", "what number?"]);
    expect(second.reply.parts).toEqual([{ type: "text", text: "saw 2" }]);
  });

  test("interrupt ends the turn without an error", async () => {
    const hanging = hangingResponse();
    const { engine, model } = await setup([hanging.step]);

    const running = start(engine, model);
    await hanging.started;
    running.turn.interrupt();
    await running.turn.done;

    expect(summarize(running.events).errors).toEqual([]);
  });

  test("aborting the request signal ends the turn without an error", async () => {
    const hanging = hangingResponse();
    const { engine, model } = await setup([hanging.step]);

    const running = start(engine, model);
    await hanging.started;
    running.controller.abort();
    await running.turn.done;

    expect(summarize(running.events).errors).toEqual([]);
  });

  test("a signal that is already aborted never prompts the model", async () => {
    const { engine, faux, model } = await setup([fauxAssistantMessage([fauxText("never")])]);
    const controller = new AbortController();
    controller.abort();

    const outcome = await runTurn(engine, model, { signal: controller.signal });

    expect(outcome.errors).toEqual([]);
    expect(faux.state.callCount).toBe(0);
  });

  test("reports a provider error once", async () => {
    const { engine, model } = await setup([fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider exploded" })]);

    const { errors } = await runTurn(engine, model);

    expect(errors).toEqual(["provider exploded"]);
  });

  test("redacts keys and bearer tokens a provider error echoes", async () => {
    const { engine, model } = await setup([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "401 invalid x-api-key sk-ant-api03-AbCdEf0123456789 (Authorization: Bearer tok.en-123_456)",
      }),
    ]);

    const { errors } = await runTurn(engine, model);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("401 invalid x-api-key");
    expect(errors[0]).not.toContain("sk-ant");
    expect(errors[0]).not.toContain("tok.en");
  });

  test("redacts a secret a failed tool prints before it reaches the reply", async () => {
    const { engine, model } = await setup([
      bashCall("echo key sk-ant-api03-AbCdEf0123456789 >&2; exit 1"),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const { host } = answering("allow");

    const { reply } = await runTurn(engine, model, {}, host);

    const [part] = toolParts(reply);
    expect(part).toMatchObject({ state: "error" });
    expect(part?.errorText).toContain("key");
    expect(part?.errorText).not.toContain("sk-ant");
  });

  test("reports an unknown model and ends the turn", async () => {
    const { engine, faux } = await setup([fauxAssistantMessage([fauxText("never")])]);

    const missing = await runTurn(engine, "faux/nope");
    const malformed = await runTurn(engine, "sonnet");

    expect(missing.errors).toEqual(['Unknown pi model "faux/nope". Use provider/model-id.']);
    expect(malformed.errors).toEqual(['Unknown pi model "sonnet". Use provider/model-id.']);
    expect(faux.state.callCount).toBe(0);
    expect(missing.refs).toEqual([]);
  });
});

// Tool declarations travel in the transcript's system messages.
const offeredTools = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []).map((tool) => tool.name) : []));

describe("pi engine permissions (S8)", () => {
  const made = () => join(cwd, "made.txt");

  test("a bash call asks with the tool name and input, and a denial stops it from running", async () => {
    const { engine, model } = await setup([bashCall(`echo hi > ${made()}`), fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host } = answering("deny");

    const { reply, errors } = await runTurn(engine, model, {}, host);

    expect(errors).toEqual([]);
    expect(asks).toEqual([{ toolName: "bash", input: { command: `echo hi > ${made()}` } }]);
    expect(existsSync(made())).toBe(false);
    const [tool] = toolParts(reply);
    expect(tool?.state).toBe("error");
    expect(tool?.errorText).toContain("The user denied this tool call.");
  });

  test("allow runs the call", async () => {
    const { engine, model } = await setup([bashCall(`echo hi > ${made()}`), fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host } = answering("allow");

    const { reply } = await runTurn(engine, model, {}, host);

    expect(asks).toHaveLength(1);
    expect(existsSync(made())).toBe(true);
    expect(toolParts(reply)[0]?.state).toBe("done");
  });

  test("always runs the call, stores a rule, and the same command in the next turn does not ask", async () => {
    const command = `echo hi >> ${made()}`;
    const { engine, model, permissionRules } = await setup([
      bashCall(command),
      fauxAssistantMessage([fauxText("one")]),
      bashCall(command),
      fauxAssistantMessage([fauxText("two")]),
    ]);
    const { asks, host } = answering("always");

    await runTurn(engine, model, {}, host);
    expect(permissionRules.hasPermissionRule({ cwd, toolName: "bash", command })).toBe(true);
    const second = await runTurn(engine, model, {}, host);

    expect(asks).toHaveLength(1);
    expect(toolParts(second.reply)[0]?.state).toBe("done");
  });

  test("a different command still asks even after an always", async () => {
    const { engine, model } = await setup([
      bashCall(`echo a >> ${made()}`),
      fauxAssistantMessage([fauxText("one")]),
      bashCall(`echo b >> ${made()}`),
      fauxAssistantMessage([fauxText("two")]),
    ]);
    const first = answering("always");
    await runTurn(engine, model, {}, first.host);
    const second = answering("deny");

    await runTurn(engine, model, {}, second.host);

    expect(second.asks.map((a) => a.input)).toEqual([{ command: `echo b >> ${made()}` }]);
  });

  test("a rule stored for another project does not apply here", async () => {
    const command = `echo hi >> ${made()}`;
    const rules = openStorage(":memory:");
    rules.addPermissionRule({ cwd: join(dir, "elsewhere"), toolName: "bash", command });
    const { engine, model } = await setup([bashCall(command), fauxAssistantMessage([fauxText("ok")])], rules);
    const { asks, host } = answering("deny");

    await runTurn(engine, model, {}, host);

    expect(asks).toHaveLength(1);
  });

  test("a stored rule from the rules store lets the call run without asking", async () => {
    const command = `echo hi >> ${made()}`;
    const rules = openStorage(":memory:");
    rules.addPermissionRule({ cwd, toolName: "bash", command });
    const { engine, model } = await setup([bashCall(command), fauxAssistantMessage([fauxText("ok")])], rules);
    const { asks, host } = answering("deny");

    await runTurn(engine, model, {}, host);

    expect(asks).toEqual([]);
    expect(existsSync(made())).toBe(true);
  });

  test("the read tool never asks", async () => {
    writeFileSync(join(cwd, "notes.txt"), "contents");
    const { engine, model } = await setup([
      fauxAssistantMessage([fauxToolCall("read", { path: join(cwd, "notes.txt") }, { id: "r" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const { asks, host } = answering("deny");

    const { reply } = await runTurn(engine, model, {}, host);

    expect(asks).toEqual([]);
    expect(toolParts(reply)[0]?.state).toBe("done");
  });

  test("plan mode offers only the read-only tools and AskUserQuestion, so bash cannot run or ask", async () => {
    let offered: string[] | undefined;
    const planned: FauxResponseStep = (context) => {
      offered = offeredTools(context.messages);
      return bashCall(`echo hi > ${made()}`);
    };
    const { engine, model } = await setup([planned, fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host } = answering("allow");

    const { reply } = await runTurn(engine, model, { mode: Mode.PLAN }, host);

    expect(offered?.sort()).toEqual(["AskUserQuestion", "find", "grep", "ls", "read"]);
    expect(asks).toEqual([]);
    expect(existsSync(made())).toBe(false);
    expect(toolParts(reply)[0]?.state).toBe("error");
  });

  test("build mode keeps pi's default tools", async () => {
    let offered: string[] | undefined;
    const building: FauxResponseStep = (context) => {
      offered = offeredTools(context.messages);
      return fauxAssistantMessage([fauxText("ok")]);
    };
    const { engine, model } = await setup([building]);

    await runTurn(engine, model, { mode: Mode.BUILD });

    expect(offered).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "AskUserQuestion"]));
  });

  test("aborting the turn while an approval is pending leaves the call unexecuted", async () => {
    let asked: () => void = () => {};
    const pending = new Promise<void>((resolve) => (asked = resolve));
    const { engine, model } = await setup([bashCall(`echo hi > ${made()}`), fauxAssistantMessage([fauxText("ok")])]);
    const running = start(engine, model, {}, {
      askPermission: (_ask, signal) =>
        new Promise<PermissionDecision>((resolve) => {
          asked();
          signal.addEventListener("abort", () => resolve("deny"), { once: true });
        }),
    });

    await pending;
    running.controller.abort();
    await running.turn.done;

    expect(existsSync(made())).toBe(false);
    expect(summarize(running.events).errors).toEqual([]);
  });

  test("the signal given to an approval aborts when the turn ends", async () => {
    let seen: AbortSignal | undefined;
    const { engine, model } = await setup([bashCall("true"), fauxAssistantMessage([fauxText("ok")])]);

    await runTurn(engine, model, {}, {
      askPermission: async (_ask, signal) => {
        seen = signal;
        expect(signal.aborted).toBe(false);
        return "allow";
      },
    });

    expect(seen?.aborted).toBe(true);
  });

  test("plan mode blocks a call to any tool that is not a built-in read-only one, without asking", async () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "ext-tool.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: "ext_tool", label: "ext", description: "ext", parameters: Type.Object({}),
    async execute() { require("node:fs").writeFileSync(${JSON.stringify(made())}, "ran"); return { content: [{ type: "text", text: "ran" }] }; } });
}
`,
    );
    const { engine, model, permissionRules } = await setup([
      fauxAssistantMessage([fauxToolCall("ext_tool", {}, { id: "e1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("ok")]),
    ]);
    permissionRules.addPermissionRule({ cwd, toolName: "ext_tool" });
    const { asks, host } = answering("allow");

    const { reply } = await runTurn(engine, model, { mode: Mode.PLAN }, host);

    expect(asks).toEqual([]);
    expect(existsSync(made())).toBe(false);
    expect(toolParts(reply)[0]?.state).toBe("error");
  });
});

describe("pi engine plan and build turns on one session (S8)", () => {
  // The tools a turn's model request carries, one entry per turn in the order they ran.
  function recording(turns: number) {
    const offered: string[][] = [];
    const steps: FauxResponseStep[] = Array.from({ length: turns }, () => (context) => {
      offered.push(getCurrentTools(context.messages).map((tool) => tool.name).sort());
      return fauxAssistantMessage([fauxText("ok")]);
    });
    return { offered, steps };
  }

  // Runs the modes in order on one session, resuming each turn from the previous one's file.
  async function alternate(modes: TurnRequest["mode"][], steps: FauxResponseStep[]) {
    const { engine, model } = await setup(steps);
    let resumeRef: string | undefined;
    for (const mode of modes) {
      const { refs } = await runTurn(engine, model, { mode, resumeRef });
      resumeRef = refs.at(-1) ?? resumeRef;
    }
  }

  const PLAN = ["AskUserQuestion", "find", "grep", "ls", "read"];
  const BUILD = ["AskUserQuestion", "bash", "edit", "read", "write"];

  test("plan, build, plan, build: each turn offers its mode's tools", async () => {
    const { offered, steps } = recording(5);

    await alternate([Mode.BUILD, Mode.PLAN, Mode.BUILD, Mode.PLAN, Mode.BUILD], steps);

    expect(offered).toEqual([BUILD, PLAN, BUILD, PLAN, BUILD]);
  });

  test("a build session that never planned keeps the tools it had", async () => {
    const { offered, steps } = recording(3);

    await alternate([Mode.BUILD, Mode.BUILD, Mode.BUILD], steps);

    expect(offered).toEqual([BUILD, BUILD, BUILD]);
  });

  test("after a plan turn, build offers the user's defaultTools and the extension tools, like a new session", async () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));
    writeFileSync(
      join(agentDir, "extensions", "ext-tool.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: "ext_tool", label: "ext", description: "ext", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "ran" }] }; } });
}
`,
    );
    const { offered, steps } = recording(3);

    await alternate([Mode.BUILD, Mode.PLAN, Mode.BUILD], steps);

    expect(offered).toEqual([["AskUserQuestion", "bash", "ext_tool", "read"], PLAN, ["AskUserQuestion", "bash", "ext_tool", "read"]]);
  });
});

const COLOR = {
  question: "Which color do you prefer?",
  header: "Color",
  options: [
    { label: "Red", description: "A warm color" },
    { label: "Green", description: "A natural color" },
  ],
  multiSelect: false,
};

const askCall = (input: Parameters<typeof fauxToolCall>[1], id = "ask-1") =>
  fauxAssistantMessage([fauxToolCall("AskUserQuestion", input, { id })], { stopReason: "toolUse" });

// The text of every tool result in the transcript: what the model reads after its tool calls.
const toolResultTexts = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));

// A host that answers every question with `answers` (null = declines) and records what it was asked.
function answeringQuestions(answers: Record<string, string> | null) {
  const questions: unknown[] = [];
  const host: Partial<TurnHost> = {
    askQuestions: async (asked) => {
      questions.push(asked);
      return answers;
    },
  };
  return { questions, host };
}

// What the model reads after the tool call, from a recording step that ends the turn.
function reading() {
  const seen: string[][] = [];
  const step: FauxResponseStep = (context) => {
    seen.push(toolResultTexts(context.messages));
    return fauxAssistantMessage([fauxText("ok")]);
  };
  return { seen, step };
}

describe("pi engine AskUserQuestion (S9)", () => {
  const marker = () => join(cwd, "ext-ran.txt");
  const shadowingExtension = () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "ask.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: "AskUserQuestion", label: "ask", description: "an extension's own tool", parameters: Type.Object({}),
    async execute() { require("node:fs").writeFileSync(${JSON.stringify(marker())}, "ran"); return { content: [{ type: "text", text: "ext ran" }] }; } });
}
`,
    );
  };

  test("the answers go to the model as the tool result, without any approval prompt", async () => {
    const { seen, step } = reading();
    const { engine, model } = await setup([askCall({ questions: [COLOR] }), step]);
    const { asks, host: permissions } = answering("deny");
    const { questions, host: asking } = answeringQuestions({ [COLOR.question]: "Green" });

    const { reply, errors } = await runTurn(engine, model, {}, { ...permissions, ...asking });

    expect(errors).toEqual([]);
    expect(asks).toEqual([]);
    expect(questions).toEqual([[COLOR]]);
    expect(toolParts(reply).map((t) => [t.toolName, t.state])).toEqual([["AskUserQuestion", "done"]]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0]?.[0]).toContain(`"${COLOR.question}"="Green"`);
  });

  test("a multi-select answer reaches the model comma-separated, as the host built it", async () => {
    const toppings = { ...COLOR, question: "Which toppings?", header: "Toppings", multiSelect: true };
    const { seen, step } = reading();
    const { engine, model } = await setup([askCall({ questions: [toppings] }), step]);
    const { host } = answeringQuestions({ [toppings.question]: "Red, Green" });

    await runTurn(engine, model, {}, host);

    expect(seen[0]?.[0]).toContain(`"${toppings.question}"="Red, Green"`);
  });

  test("a declined question is a tool error: The user declined to answer.", async () => {
    const { seen, step } = reading();
    const { engine, model } = await setup([askCall({ questions: [COLOR] }), step]);
    const { asks, host: permissions } = answering("allow");
    const { host: asking } = answeringQuestions(null);

    const { reply, errors } = await runTurn(engine, model, {}, { ...permissions, ...asking });

    expect(errors).toEqual([]);
    expect(asks).toEqual([]);
    const [tool] = toolParts(reply);
    expect(tool?.state).toBe("error");
    expect(tool?.errorText).toContain("The user declined to answer.");
    expect(seen[0]?.[0]).toContain("The user declined to answer.");
  });

  test("input pi's schema check rejects is a tool error that never asks", async () => {
    const oneOption = { ...COLOR, options: COLOR.options.slice(0, 1) };
    const { engine, model } = await setup([askCall({ questions: [oneOption] }), fauxAssistantMessage([fauxText("ok")])]);
    const { questions, host } = answeringQuestions({});

    const { reply } = await runTurn(engine, model, {}, host);

    expect(questions).toEqual([]);
    const [tool] = toolParts(reply);
    expect(tool?.state).toBe("error");
    expect(tool?.errorText).toContain("options");
  });

  test("input marcsh's own check rejects (two identical questions) is a tool error that explains the schema", async () => {
    const { seen, step } = reading();
    const { engine, model } = await setup([askCall({ questions: [COLOR, COLOR] }), step]);
    const { questions, host } = answeringQuestions({});

    const { reply } = await runTurn(engine, model, {}, host);

    expect(questions).toEqual([]);
    const [tool] = toolParts(reply);
    expect(tool?.state).toBe("error");
    expect(tool?.errorText).toContain("Invalid AskUserQuestion input");
    expect(seen[0]?.[0]).toMatch(/1-4.*2-9.*multiSelect/s);
  });

  test("is allowed in plan mode: asked and answered with no approval prompt", async () => {
    const { seen, step } = reading();
    const { engine, model } = await setup([askCall({ questions: [COLOR] }), step]);
    const { asks, host: permissions } = answering("deny");
    const { questions, host: asking } = answeringQuestions({ [COLOR.question]: "Red" });

    const { reply } = await runTurn(engine, model, { mode: Mode.PLAN }, { ...permissions, ...asking });

    expect(asks).toEqual([]);
    expect(questions).toEqual([[COLOR]]);
    expect(toolParts(reply)[0]?.state).toBe("done");
    expect(seen[0]?.[0]).toContain(`"${COLOR.question}"="Red"`);
  });

  test("a question still open when the turn is interrupted is declined and the turn ends quietly", async () => {
    let asked: () => void = () => {};
    const pending = new Promise<void>((resolve) => (asked = resolve));
    const { engine, model } = await setup([askCall({ questions: [COLOR] }), fauxAssistantMessage([fauxText("ok")])]);
    let seen: AbortSignal | undefined;
    const running = start(engine, model, {}, {
      askQuestions: (_questions, signal) =>
        new Promise<null>((resolve) => {
          seen = signal;
          asked();
          signal.addEventListener("abort", () => resolve(null), { once: true });
        }),
    });

    await pending;
    running.turn.interrupt();
    await running.turn.done;

    expect(seen?.aborted).toBe(true);
    expect(summarize(running.events).errors).toEqual([]);
  });

  test("an extension tool named AskUserQuestion is not marcsh's: it asks in build mode and nothing is asked of the user", async () => {
    shadowingExtension();
    const { engine, model } = await setup([askCall({ questions: [COLOR] }), fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host: permissions } = answering("deny");
    const { questions, host: asking } = answeringQuestions({ [COLOR.question]: "Red" });

    const { reply } = await runTurn(engine, model, {}, { ...permissions, ...asking });

    expect(asks.map((a) => a.toolName)).toEqual(["AskUserQuestion"]);
    expect(questions).toEqual([]);
    expect(existsSync(marker())).toBe(false);
    expect(toolParts(reply)[0]?.errorText).toContain("The user denied this tool call.");
  });

  test("an approved extension tool named AskUserQuestion runs as the extension's own", async () => {
    shadowingExtension();
    const { engine, model } = await setup([askCall({ questions: [COLOR] }), fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host: permissions } = answering("allow");
    const { questions, host: asking } = answeringQuestions({ [COLOR.question]: "Red" });

    const { reply } = await runTurn(engine, model, {}, { ...permissions, ...asking });

    expect(asks).toHaveLength(1);
    expect(questions).toEqual([]);
    expect(existsSync(marker())).toBe(true);
    expect(toolParts(reply)[0]?.state).toBe("done");
  });

  test("an extension tool named AskUserQuestion is blocked in plan mode, without asking, even with a stored rule", async () => {
    shadowingExtension();
    const { engine, model, permissionRules } = await setup([askCall({ questions: [COLOR] }), fauxAssistantMessage([fauxText("ok")])]);
    permissionRules.addPermissionRule({ cwd, toolName: "AskUserQuestion" });
    const { asks, host: permissions } = answering("allow");
    const { questions, host: asking } = answeringQuestions({ [COLOR.question]: "Red" });

    const { reply } = await runTurn(engine, model, { mode: Mode.PLAN }, { ...permissions, ...asking });

    expect(asks).toEqual([]);
    expect(questions).toEqual([]);
    expect(existsSync(marker())).toBe(false);
    expect(toolParts(reply)[0]?.state).toBe("error");
  });
});

describe("pi engine branch/ship guard (S10)", () => {
  const marker = () => join(cwd, "ran.txt");
  const repo = (branch: string) => {
    const git = Bun.spawnSync(["git", "init", "-q", "-b", branch], { cwd, stdout: "ignore", stderr: "pipe" });
    if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  };
  const REASON_PUSH = "marcsh: git push needs your approval";
  const REASON_COMMIT = "marcsh: commits on main are blocked; create a branch first (git switch -c <type>/<description>)";

  test("a commit on the default branch is blocked with the guard's reason, without a prompt", async () => {
    repo("main");
    const command = `git commit -m x; touch ${marker()}`;
    const { seen, step } = reading();
    const { engine, model, permissionRules } = await setup([bashCall(command), step]);
    permissionRules.addPermissionRule({ cwd, toolName: "bash", command });
    const { asks, host } = answering("allow");

    const { reply, errors } = await runTurn(engine, model, {}, host);

    expect(errors).toEqual([]);
    expect(asks).toEqual([]);
    expect(existsSync(marker())).toBe(false);
    const [tool] = toolParts(reply);
    expect(tool?.state).toBe("error");
    expect(tool?.errorText).toContain(REASON_COMMIT);
    expect(seen[0]?.[0]).toContain(REASON_COMMIT);
  });

  test("a push always asks with the guard's reason and no always-allow, even when an always rule matches", async () => {
    repo("feat/x");
    const command = `git push; touch ${marker()}`;
    const { engine, model, permissionRules } = await setup([bashCall(command), fauxAssistantMessage([fauxText("ok")])]);
    permissionRules.addPermissionRule({ cwd, toolName: "bash", command });
    const { asks, host } = answering("allow");

    await runTurn(engine, model, {}, host);

    expect(asks).toEqual([{ toolName: "bash", input: { command }, decisionReason: REASON_PUSH, suppressAlwaysAllowRule: true }]);
    expect(existsSync(marker())).toBe(true);
  });

  test("a denied push does not run, and answering always stores no rule", async () => {
    repo("feat/x");
    const command = `git push; touch ${marker()}`;
    const { engine, model, permissionRules } = await setup([
      bashCall(command),
      fauxAssistantMessage([fauxText("one")]),
      bashCall(command, "call-2"),
      fauxAssistantMessage([fauxText("two")]),
    ]);
    const denied = answering("deny");
    const first = await runTurn(engine, model, {}, denied.host);
    expect(toolParts(first.reply)[0]?.errorText).toContain("The user denied this tool call.");
    expect(existsSync(marker())).toBe(false);

    const always = answering("always");
    await runTurn(engine, model, {}, always.host);

    expect(existsSync(marker())).toBe(true);
    expect(permissionRules.hasPermissionRule({ cwd, toolName: "bash", command })).toBe(false);
  });

  test("a push whose prompt is open when the turn is interrupted does not run", async () => {
    repo("feat/x");
    let asked: () => void = () => {};
    const pending = new Promise<void>((resolve) => (asked = resolve));
    const { engine, model } = await setup([bashCall(`git push; touch ${marker()}`), fauxAssistantMessage([fauxText("ok")])]);
    const running = start(engine, model, {}, {
      askPermission: (_ask, signal) =>
        new Promise<PermissionDecision>((resolve) => {
          asked();
          signal.addEventListener("abort", () => resolve("deny"), { once: true });
        }),
    });

    await pending;
    running.turn.interrupt();
    await running.turn.done;

    expect(existsSync(marker())).toBe(false);
    expect(summarize(running.events).errors).toEqual([]);
  });

  test("an ordinary command, and a commit on a feature branch, go through the normal approval with no guard reason", async () => {
    repo("feat/x");
    const { engine, model } = await setup([
      bashCall("echo hi"),
      fauxAssistantMessage([fauxText("one")]),
      bashCall("git commit -m x", "call-2"),
      fauxAssistantMessage([fauxText("two")]),
    ]);
    const { asks, host } = answering("deny");

    await runTurn(engine, model, {}, host);
    await runTurn(engine, model, {}, host);

    expect(asks).toEqual([
      { toolName: "bash", input: { command: "echo hi" } },
      { toolName: "bash", input: { command: "git commit -m x" } },
    ]);
  });

  test("a guard that fails is no decision: the commit goes through the normal approval (fail open, like the Claude hook)", async () => {
    repo("main");
    const command = `git commit -m x; touch ${marker()}`;
    const guard = () => {
      throw new Error("guard exploded");
    };
    const { engine, model } = await setup([bashCall(command), fauxAssistantMessage([fauxText("ok")])], openStorage(":memory:"), { guard });
    const { asks, host } = answering("allow");

    const { errors } = await runTurn(engine, model, {}, host);

    expect(errors).toEqual([]);
    expect(asks).toEqual([{ toolName: "bash", input: { command } }]);
    expect(existsSync(marker())).toBe(true);
  });

  test("a directory that is not a repository is no decision either", async () => {
    const command = `git commit -m x; touch ${marker()}`;
    const { engine, model } = await setup([bashCall(command), fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host } = answering("allow");

    await runTurn(engine, model, {}, host);

    expect(asks).toEqual([{ toolName: "bash", input: { command } }]);
  });

  test("plan mode never reaches the guard: bash is not offered", async () => {
    repo("main");
    const { engine, model } = await setup([bashCall(`git commit -m x; touch ${marker()}`), fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host } = answering("allow");

    await runTurn(engine, model, { mode: Mode.PLAN }, host);

    expect(asks).toEqual([]);
    expect(existsSync(marker())).toBe(false);
  });
});

// Bun caches os.homedir() at startup, so the default agentDir is checked in a child process with its own HOME.
const touchAgentDir = `
import { createPiEngine } from "./pi.ts";
const engine = createPiEngine(process.env.PROBE_AGENT_DIR ? { agentDir: process.env.PROBE_AGENT_DIR } : {});
await engine.getDeviceId();
await engine.getRuntime();
console.log("ok");
`;

async function runChild(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, "-e", touchAgentDir], {
    cwd: import.meta.dir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out.trim()).toBe("ok");
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("the agent directory's permissions (S5)", () => {
  test("~/.marcsh/agent is created owner-only before pi writes its settings there", async () => {
    const home = join(dir, "home");
    mkdirSync(home);

    await runChild({ HOME: home });

    expect(modeOf(join(home, ".marcsh", "agent"))).toBe(0o700);
    expect(existsSync(join(home, ".marcsh", "agent", "settings.json"))).toBe(true);
  });

  test("an existing ~/.marcsh/agent made with looser permissions is tightened to owner-only", async () => {
    const home = join(dir, "home");
    const marcsh = join(home, ".marcsh");
    mkdirSync(join(marcsh, "agent"), { recursive: true });
    chmodSync(marcsh, 0o755);
    chmodSync(join(marcsh, "agent"), 0o755);

    await runChild({ HOME: home });

    expect(modeOf(join(marcsh, "agent"))).toBe(0o700);
  });

  test("a custom agentDir and its parent keep their permissions", async () => {
    const home = join(dir, "home");
    const shared = join(dir, "shared");
    const custom = join(shared, "agent");
    mkdirSync(home);
    mkdirSync(custom, { recursive: true });
    chmodSync(shared, 0o755);
    chmodSync(custom, 0o755);

    await runChild({ HOME: home, PROBE_AGENT_DIR: custom });

    expect(modeOf(shared)).toBe(0o755);
    expect(modeOf(custom)).toBe(0o755);
    expect(existsSync(join(home, ".marcsh"))).toBe(false);
  });
});

// Extensions are loaded from the agent dir like a user's own: their code is plain text in the test.
function writeExtension(name: string, body: string) {
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", `${name}.ts`),
    `import { Type } from "typebox";\nexport default function (pi) {\n${body}\n}\n`,
  );
}

describe("pi extension UI (S7)", () => {
  const out = () => join(cwd, "ui-out.json");
  const written = () => JSON.parse(readFileSync(out(), "utf8")) as Record<string, unknown>;

  // A host that records each UI ask and answers it from `answers`; `hang` leaves asks open until they are cancelled.
  function uiHost(answers: { select?: string; confirm?: boolean; input?: string; editor?: string } = {}, hang = false) {
    const asked: unknown[][] = [];
    const signals: AbortSignal[] = [];
    const notices: { message: string; level: NoticeLevel }[] = [];
    let opened: () => void = () => {};
    const firstAsk = new Promise<void>((resolve) => (opened = resolve));
    const reply = <T,>(kind: string, args: unknown[], signal: AbortSignal, answer: T, cancelled: T) => {
      asked.push([kind, ...args]);
      signals.push(signal);
      opened();
      if (!hang) return Promise.resolve(answer);
      return new Promise<T>((resolve) => signal.addEventListener("abort", () => resolve(cancelled), { once: true }));
    };
    const host: Partial<TurnHost> = {
      select: (title, options, signal) => reply("select", [title, options], signal, answers.select, undefined),
      confirm: (title, message, signal) => reply("confirm", [title, message], signal, answers.confirm ?? false, false),
      input: (title, placeholder, signal) => reply("input", [title, placeholder], signal, answers.input, undefined),
      editor: (title, prefill, signal) => reply("editor", [title, prefill], signal, answers.editor, undefined),
      notify: (message, level) => notices.push({ message, level }),
    };
    return { host, asked, signals, notices, firstAsk };
  }

  const dialogCommand = () => `
    pi.registerCommand("probe-ui", { description: "probe", handler: async (args, ctx) => {
      const result = { args, hasUI: ctx.hasUI, mode: ctx.mode };
      result.select = await ctx.ui.select("Pick one", ["a", "b"]);
      result.confirm = await ctx.ui.confirm("Sure?", "Really sure");
      result.input = await ctx.ui.input("Name", "kebab-case");
      result.editor = await ctx.ui.editor("Edit", "prefill");
      ctx.ui.notify("all asked", "warning");
      require("node:fs").writeFileSync(${JSON.stringify(out())}, JSON.stringify(result));
    } });`;

  test("an extension's select, confirm, input, editor and notify reach the host, and it gets the answers", async () => {
    writeExtension("probe-ui", dialogCommand());
    const { engine, faux, model } = await setup([fauxAssistantMessage([fauxText("never used")])]);
    const { host, asked, notices } = uiHost({ select: "b", confirm: true, input: "my-name", editor: "edited text" });

    const { errors } = await runTurn(engine, model, { prompt: "/probe-ui now" }, host);

    expect(errors).toEqual([]);
    expect(asked).toEqual([
      ["select", "Pick one", ["a", "b"]],
      ["confirm", "Sure?", "Really sure"],
      ["input", "Name", "kebab-case"],
      ["editor", "Edit", "prefill"],
    ]);
    expect(notices).toEqual([{ message: "all asked", level: "warning" }]);
    expect(written()).toMatchObject({ args: "now", select: "b", confirm: true, input: "my-name", editor: "edited text" });
    expect(faux.state.callCount).toBe(0);
  });

  test("extensions are told dialogs work (hasUI) but that this is not pi's terminal UI (mode is not tui)", async () => {
    writeExtension("probe-ui", dialogCommand());
    const { engine, model } = await setup([]);

    await runTurn(engine, model, { prompt: "/probe-ui" }, uiHost().host);

    expect(written()).toMatchObject({ hasUI: true, mode: "rpc" });
  });

  test("a host without dialogs cancels the asks instead of breaking the extension", async () => {
    writeExtension("probe-ui", dialogCommand());
    const { engine, model } = await setup([]);

    const { errors } = await runTurn(engine, model, { prompt: "/probe-ui" });

    expect(errors).toEqual([]);
    const result = written();
    expect(result.select).toBeUndefined();
    expect(result.confirm).toBe(false);
    expect(result.input).toBeUndefined();
    expect(result.editor).toBeUndefined();
  });

  test("a component dialog (custom) says once that pi's own terminal UI is not supported, and resolves as cancelled", async () => {
    writeExtension(
      "probe-custom",
      `pi.registerCommand("probe-custom", { description: "probe", handler: async (_args, ctx) => {
        const first = await ctx.ui.custom(() => { throw new Error("must not be built"); });
        const second = await ctx.ui.custom(() => { throw new Error("must not be built"); });
        require("node:fs").writeFileSync(${JSON.stringify(out())}, JSON.stringify({ first: first ?? null, second: second ?? null }));
      } });`,
    );
    const { engine, model } = await setup([]);
    const { host, notices } = uiHost();

    const { errors } = await runTurn(engine, model, { prompt: "/probe-custom" }, host);

    expect(errors).toEqual([]);
    expect(written()).toEqual({ first: null, second: null });
    expect(notices).toEqual([
      { message: "This extension needs pi's own terminal UI, which marcsh does not support", level: "warning" },
    ]);
  });

  test("every member of pi's UI context exists, so an extension never meets a missing function", async () => {
    writeExtension(
      "probe-members",
      `pi.registerCommand("probe-members", { description: "probe", handler: async (_args, ctx) => {
        require("node:fs").writeFileSync(${JSON.stringify(out())}, JSON.stringify(Object.keys(ctx.ui).sort()));
      } });`,
    );
    const { engine, model } = await setup([]);

    await runTurn(engine, model, { prompt: "/probe-members" }, uiHost().host);

    expect(JSON.parse(readFileSync(out(), "utf8")) as string[]).toEqual(
      [
        "select", "confirm", "input", "notify", "onTerminalInput", "setStatus", "setWorkingMessage", "setWorkingVisible",
        "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "custom",
        "pasteToEditor", "setEditorText", "getEditorText", "editor", "addAutocompleteProvider", "setEditorComponent",
        "getEditorComponent", "theme", "getAllThemes", "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded",
      ].sort(),
    );
  });

  test("interrupting the turn cancels the open ask, and the extension carries on with the cancelled value", async () => {
    writeExtension("probe-ui", dialogCommand());
    const { engine, model } = await setup([]);
    const { host, asked, signals, firstAsk } = uiHost({}, true);

    const running = start(engine, model, { prompt: "/probe-ui" }, host);
    await firstAsk;
    expect(signals[0]!.aborted).toBe(false);
    running.controller.abort();
    await running.turn.done;

    expect(signals[0]!.aborted).toBe(true);
    expect(asked).toHaveLength(1);
    const result = written();
    expect(result.select).toBeUndefined();
    expect(result.confirm).toBe(false);
    expect(summarize(running.events).errors).toEqual([]);
  });

  test("an ask the extension leaves open when the turn ends is cancelled", async () => {
    writeExtension(
      "probe-leave",
      `pi.registerCommand("probe-leave", { description: "probe", handler: async (_args, ctx) => {
        globalThis.__piUiLeftOpen = ctx.ui.confirm("Still there?", "asked and not awaited");
      } });`,
    );
    const { engine, model } = await setup([]);
    const { host, signals, firstAsk } = uiHost({}, true);

    try {
      const running = start(engine, model, { prompt: "/probe-leave" }, host);
      await firstAsk;
      await running.turn.done;

      expect(signals[0]!.aborted).toBe(true);
      expect(await (globalThis as any).__piUiLeftOpen).toBe(false);
    } finally {
      delete (globalThis as any).__piUiLeftOpen;
    }
  });

  test("a tool can ask through the UI mid-turn and the model reads the answer", async () => {
    writeExtension(
      "ask-ui",
      `pi.registerTool({ name: "ask_ui", label: "ask", description: "asks the user", parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
          const pick = await ctx.ui.select("Which?", ["x", "y"]);
          ctx.ui.notify("picked " + pick);
          return { content: [{ type: "text", text: "user picked " + pick }] };
        } });`,
    );
    const { seen, step } = reading();
    const { engine, model } = await setup([
      fauxAssistantMessage([fauxToolCall("ask_ui", {}, { id: "u1" })], { stopReason: "toolUse" }),
      step,
    ]);
    const { host: ui, notices } = uiHost({ select: "y" });
    const { host: permissions } = answering("allow");

    const { errors } = await runTurn(engine, model, {}, { ...permissions, ...ui });

    expect(errors).toEqual([]);
    expect(seen[0]).toEqual(["user picked y"]);
    expect(notices).toEqual([{ message: "picked y", level: "info" }]);
  });
});

describe("pi commands (S11)", () => {
  const writePrompt = (name: string, text: string) => {
    mkdirSync(join(agentDir, "prompts"), { recursive: true });
    writeFileSync(join(agentDir, "prompts", `${name}.md`), text);
  };
  const writeSkill = (name: string, description: string, body: string) => {
    mkdirSync(join(agentDir, "skills", name), { recursive: true });
    writeFileSync(join(agentDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
  };

  // What the model is sent as the user's messages, one entry per model request.
  const userTexts = (messages: Message[]) =>
    messages.flatMap((m) =>
      m.role === "user" ? [typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join("")] : [],
    );
  function recording() {
    const requests: string[][] = [];
    const step: FauxResponseStep = (context) => {
      requests.push(userTexts(context.messages));
      return fauxAssistantMessage([fauxText("ok")]);
    };
    return { requests, step };
  }

  const BUILTINS = ["settings", "model", "tree", "thinking", "export", "session", "fork", "login", "logout", "new", "compact", "resume", "reload", "quit"];

  async function listed() {
    writeExtension("deploy", `pi.registerCommand("deploy", { description: "Ship it", handler: async () => {} });`);
    writePrompt("review", "---\ndescription: Review a file\n---\nReview $1");
    writeSkill("pdf", "Read PDFs", "Use the pdf tools.");
    const { engine, faux } = await setup([fauxAssistantMessage([fauxText("unused")])]);
    const saved: Parameters<Parameters<Engine["warmUpCommands"]>[0]["save"]>[0][] = [];
    await engine.warmUpCommands({ cwd, save: (commands) => saved.push(commands) });
    return { saved, faux };
  }

  test("warm-up lists extension commands, prompt templates and skills with their source, and the plugin's, saving once", async () => {
    const { saved } = await listed();

    expect(saved).toHaveLength(1);
    const byName = new Map(saved[0]!.map((command) => [command.name, command]));
    expect(byName.get("deploy")).toMatchObject({ source: "extension", description: "Ship it" });
    expect(byName.get("review")).toMatchObject({ source: "prompt", description: "Review a file" });
    expect(byName.get("skill:pdf")).toMatchObject({ source: "skill", description: "Read PDFs" });
    expect(byName.get("marcsh:feature")).toMatchObject({ source: "prompt", description: "Create or resume the feature doc for a large change" });
    expect(byName.get("marcsh:workflow")).toMatchObject({ source: "skill" });
    expect(byName.has("feature")).toBe(false);
    expect(byName.has("skill:workflow")).toBe(false);
  });

  test("warm-up does not list pi's interactive-only built-ins", async () => {
    const { saved } = await listed();

    const names = saved[0]!.map((command) => command.name);
    for (const builtin of BUILTINS) expect(names).not.toContain(builtin);
  });

  test("warm-up makes no model call and leaves no session file", async () => {
    const { faux } = await listed();

    expect(faux.state.callCount).toBe(0);
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(existsSync(join(agentDir, "sessions"))).toBe(false);
  });

  test("warm-up never throws and saves nothing when pi cannot start", async () => {
    const { engine } = await setup([], undefined, { modelRuntime: {} as never });
    const saved: unknown[] = [];

    await engine.warmUpCommands({ cwd, save: (commands) => saved.push(commands) });

    expect(saved).toEqual([]);
  });

  test("a turn leaves the command list to the warm-up: it reports none", async () => {
    writeExtension("deploy", `pi.registerCommand("deploy", { description: "Ship it", handler: async () => {} });`);
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("hi")])]);

    const { events } = await runTurn(engine, model);

    expect(events.filter((event) => event.type === "commands")).toEqual([]);
  });

  test("/name args runs a prompt template: the model gets the expanded text", async () => {
    writePrompt("greet", "---\ndescription: Greet\n---\nSay hello to $1, then $2.");
    const { requests, step } = recording();
    const { engine, model } = await setup([step]);

    const { errors } = await runTurn(engine, model, { prompt: "/greet Bob 'a long goodbye'" });

    expect(errors).toEqual([]);
    expect(requests).toEqual([["Say hello to Bob, then a long goodbye."]]);
  });

  test("/skill:name args expands a skill", async () => {
    writeSkill("pdf", "Read PDFs", "Use the pdf tools.");
    const { requests, step } = recording();
    const { engine, model } = await setup([step]);

    await runTurn(engine, model, { prompt: "/skill:pdf summarize it" });

    expect(requests[0]![0]).toContain('<skill name="pdf"');
    expect(requests[0]![0]).toContain("Use the pdf tools.");
    expect(requests[0]![0]).toEndWith("summarize it");
  });

  test("/name args runs an extension command with its arguments, with no model call", async () => {
    writeExtension(
      "probe-args",
      `pi.registerCommand("probe-args", { description: "probe", handler: async (args, ctx) => {
        require("node:fs").writeFileSync(${JSON.stringify(join(cwd, "args.txt"))}, JSON.stringify([args, ctx.hasUI]));
      } });`,
    );
    const { engine, faux, model } = await setup([fauxAssistantMessage([fauxText("unused")])]);

    const { errors } = await runTurn(engine, model, { prompt: "/probe-args first  second" });

    expect(errors).toEqual([]);
    expect(JSON.parse(readFileSync(join(cwd, "args.txt"), "utf8"))).toEqual(["first  second", true]);
    expect(faux.state.callCount).toBe(0);
  });

  test("an extension command that throws is reported as a notice and does not fail the turn", async () => {
    writeExtension("boom", `pi.registerCommand("boom", { description: "probe", handler: async () => { throw new Error("it broke"); } });`);
    const { engine, model } = await setup([]);
    const notices: { message: string; level: NoticeLevel }[] = [];

    const { errors } = await runTurn(engine, model, { prompt: "/boom" }, { notify: (message, level) => notices.push({ message, level }) });

    expect(errors).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe("error");
    expect(notices[0]!.message).toContain("it broke");
  });

  test("an unknown /name args goes to the model exactly as typed", async () => {
    const { requests, step } = recording();
    const { engine, model } = await setup([step]);

    await runTurn(engine, model, { prompt: "/nope some args" });

    expect(requests).toEqual([["/nope some args"]]);
  });

  test("the plugin's feature command runs as /marcsh:feature, with the argument in the template", async () => {
    const { requests, step } = recording();
    const { engine, model } = await setup([step]);

    const { errors } = await runTurn(engine, model, { prompt: "/marcsh:feature my-feature" });

    expect(errors).toEqual([]);
    expect(requests[0]![0]).toContain("Create or resume the feature doc named `my-feature`.");
    expect(requests[0]![0]).not.toContain("$ARGUMENTS");
  });

  test("the plugin's feature command also runs under pi's own name, /feature", async () => {
    const { requests, step } = recording();
    const { engine, model } = await setup([step]);

    await runTurn(engine, model, { prompt: "/feature other-feature" });

    expect(requests[0]![0]).toContain("Create or resume the feature doc named `other-feature`.");
  });

  test("the plugin's workflow skill runs as /marcsh:workflow", async () => {
    const { requests, step } = recording();
    const { engine, model } = await setup([step]);

    await runTurn(engine, model, { prompt: "/marcsh:workflow fix the login bug" });

    expect(requests[0]![0]).toContain('<skill name="workflow"');
    expect(requests[0]![0]).toContain("# marcsh workflow");
    expect(requests[0]![0]).toEndWith("fix the login bug");
  });

  test("/marcsh:feature and /marcsh:workflow send the text pi itself builds for /feature and /skill:workflow", async () => {
    const own = recording();
    const ours = recording();
    const first = await setup([own.step, own.step, ours.step, ours.step]);

    await runTurn(first.engine, first.model, { prompt: '/feature one "two words" ${3:-x}' });
    await runTurn(first.engine, first.model, { prompt: "/skill:workflow  fix the login bug " });
    await runTurn(first.engine, first.model, { prompt: '/marcsh:feature one "two words" ${3:-x}' });
    await runTurn(first.engine, first.model, { prompt: "/marcsh:workflow  fix the login bug " });

    expect(ours.requests).toHaveLength(2);
    expect(ours.requests.map((r) => r[0])).toEqual(own.requests.map((r) => r[0]));
  });

  test("the plugin files are read in place: nothing is copied into the agent dir", async () => {
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("hi")])]);

    await runTurn(engine, model);

    expect(existsSync(join(agentDir, "prompts"))).toBe(false);
    expect(existsSync(join(agentDir, "skills"))).toBe(false);
  });
});
