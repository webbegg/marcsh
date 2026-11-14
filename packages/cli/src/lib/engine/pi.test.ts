import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getCurrentSystemMessage,
  getCurrentTools,
  getSystemMessageText,
  InMemoryCredentialStore,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import type { ChatMessage } from "../chat-types";
import { approvalModeLine } from "../approval-policy";
import { Mode } from "../modes";
import { openStorage, type Storage } from "../storage";
import { createPiEngine, defaultPiAgentDir, type PiEngineOptions } from "./pi";
import { reviewProject, type ProjectTrustAsk, type TrustAnswer } from "./pi-trust";
import { trustEveryProject } from "./test-trust";
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

  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules, projectTrust: trustEveryProject, ...engineOptions });
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

/** Runs `body` with MARCSH_AGENT_DIR set to `value` (unset when undefined), then restores it. */
function withAgentDirEnv(value: string | undefined, body: () => void) {
  const previous = process.env.MARCSH_AGENT_DIR;
  try {
    if (value === undefined) delete process.env.MARCSH_AGENT_DIR;
    else process.env.MARCSH_AGENT_DIR = value;
    body();
  } finally {
    if (previous === undefined) delete process.env.MARCSH_AGENT_DIR;
    else process.env.MARCSH_AGENT_DIR = previous;
  }
}

describe("createPiEngine", () => {
  test("keeps pi's files in marcsh's own agent directory, never pi's", () => {
    withAgentDirEnv(undefined, () => {
      expect(defaultPiAgentDir()).toBe(join(homedir(), ".marcsh", "agent"));
      expect(defaultPiAgentDir()).not.toContain(join(".pi", "agent"));
    });
  });

  test("MARCSH_AGENT_DIR overrides the agent directory, trimmed; empty or blank means the default", () => {
    withAgentDirEnv(" /tmp/x/agent ", () => expect(defaultPiAgentDir()).toBe("/tmp/x/agent"));
    withAgentDirEnv("", () => expect(defaultPiAgentDir()).toBe(join(homedir(), ".marcsh", "agent")));
    withAgentDirEnv("   ", () => expect(defaultPiAgentDir()).toBe(join(homedir(), ".marcsh", "agent")));
  });

  test("the test preload points the agent directory at a temp dir, never the real one", () => {
    const configured = process.env.MARCSH_AGENT_DIR;
    expect(configured).toBeTruthy();
    expect(defaultPiAgentDir()).toBe(configured as string);
    expect(configured as string).not.toBe(join(homedir(), ".marcsh", "agent"));
    expect((configured as string).startsWith(realpathSync(tmpdir())) || (configured as string).startsWith(tmpdir())).toBe(true);
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

    expect(offered?.sort()).toEqual(["AskUserQuestion", "Task", "find", "grep", "ls", "read"]);
    expect(asks).toEqual([]);
    expect(existsSync(made())).toBe(false);
    expect(toolParts(reply)[0]?.state).toBe("error");
  });

  test("build mode offers pi's default tools plus the built-in ls, grep and find", async () => {
    let offered: string[] | undefined;
    const building: FauxResponseStep = (context) => {
      offered = offeredTools(context.messages);
      return fauxAssistantMessage([fauxText("ok")]);
    };
    const { engine, model } = await setup([building]);

    await runTurn(engine, model, { mode: Mode.BUILD });

    expect(offered?.sort()).toEqual(["AskUserQuestion", "Task", "bash", "edit", "find", "grep", "ls", "read", "write"]);
  });

  test("a model's ls call in build mode lists the directory without an approval prompt", async () => {
    writeFileSync(join(cwd, "visible.txt"), "x");
    const { seen, step } = reading();
    const lsCall = fauxAssistantMessage([fauxToolCall("ls", { path: cwd }, { id: "ls-1" })], { stopReason: "toolUse" });
    const { engine, model } = await setup([lsCall, step]);
    const { asks, host } = answering("deny");

    const { reply, errors } = await runTurn(engine, model, { mode: Mode.BUILD }, host);

    expect(errors).toEqual([]);
    expect(asks).toEqual([]);
    expect(toolParts(reply).map((t) => [t.toolName, t.state])).toEqual([["ls", "done"]]);
    expect(seen[0]?.[0]).toContain("visible.txt");
  });

  test.each([
    ["the agent dir's settings", () => join(agentDir, "settings.json")],
    ["the project's settings", () => join(cwd, ".pi", "settings.json")],
  ])("a defaultTools setting in %s is respected exactly: no ls, grep or find are added", async (_where, file) => {
    mkdirSync(join(file(), ".."), { recursive: true });
    writeFileSync(file(), JSON.stringify({ defaultTools: ["read", "bash"] }));
    let offered: string[] | undefined;
    const building: FauxResponseStep = (context) => {
      offered = offeredTools(context.messages);
      return fauxAssistantMessage([fauxText("ok")]);
    };
    const { engine, model } = await setup([building]);

    await runTurn(engine, model, { mode: Mode.BUILD });

    expect(offered?.sort()).toEqual(["AskUserQuestion", "Task", "bash", "read"]);
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

  const PLAN = ["AskUserQuestion", "Task", "find", "grep", "ls", "read"];
  const BUILD = ["AskUserQuestion", "Task", "bash", "edit", "find", "grep", "ls", "read", "write"];

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

    expect(offered).toEqual([["AskUserQuestion", "Task", "bash", "ext_tool", "read"], PLAN, ["AskUserQuestion", "Task", "bash", "ext_tool", "read"]]);
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

// The preload's agent dir override must not reach a child that checks the default path under its own HOME.
function childBaseEnv() {
  const { MARCSH_AGENT_DIR: _ignored, ...rest } = process.env;
  return rest;
}

async function runChild(env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, "-e", touchAgentDir], {
    cwd: import.meta.dir,
    env: { ...childBaseEnv(), ...env },
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

describe("pi engine subagents (S13)", () => {
  const taskCall = (description: string, prompt: string, id = "task-1") =>
    fauxAssistantMessage([fauxToolCall("Task", { description, prompt }, { id })], { stopReason: "toolUse" });
  const taskParts = (reply: ChatMessage) => reply.parts.flatMap((p) => (p.type === "task" ? [p] : []));
  const userTexts = (messages: Message[]) =>
    messages.flatMap((m) => (m.role === "user" ? [typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join("")] : []));
  const made = () => join(cwd, "made.txt");

  // A child step that records what its session was offered and sent, then answers with `text`.
  function child(text = "child answer") {
    const seen: { tools: string[]; user: string[]; model: string }[] = [];
    const step: FauxResponseStep = (context, _options, _state, model) => {
      seen.push({ tools: offeredTools(context.messages).sort(), user: userTexts(context.messages), model: model.id });
      return fauxAssistantMessage([fauxText(text)]);
    };
    return { seen, step };
  }

  test("Task runs a child session in the same project and returns its final text as the tool result, with no approval", async () => {
    const kid = child("The answer is 42.");
    const { seen, step } = reading();
    const { engine, model } = await setup([taskCall("Find the answer", "What is 6 times 7?"), kid.step, step]);
    const { asks, host } = answering("deny");

    const { reply, errors } = await runTurn(engine, model, {}, host);

    expect(errors).toEqual([]);
    expect(asks).toEqual([]);
    expect(kid.seen).toHaveLength(1);
    expect(kid.seen[0]?.user).toEqual(["What is 6 times 7?"]);
    expect(seen[0]).toEqual(["The answer is 42."]);
    expect(toolParts(reply).map((t) => [t.toolCallId, t.toolName, t.state])).toEqual([["task-1", "Task", "done"]]);
  });

  test("the child uses the parent turn's model", async () => {
    const kid = child();
    const { engine, model } = await setup([taskCall("Check model", "go"), kid.step, fauxAssistantMessage([fauxText("ok")])]);

    await runTurn(engine, model);

    expect(kid.seen[0]?.model).toBe("faux-1");
  });

  test("the child has pi's default tools but no Task, no AskUserQuestion and none of the user's extension tools", async () => {
    writeExtension("ext-tool", `pi.registerTool({ name: "ext_tool", label: "x", description: "x", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "x" }] }; } });`);
    let parentTools: string[] = [];
    const first: FauxResponseStep = (context) => {
      parentTools = offeredTools(context.messages).sort();
      return taskCall("Look around", "go");
    };
    const kid = child();
    const { engine, model } = await setup([first, kid.step, fauxAssistantMessage([fauxText("ok")])]);

    await runTurn(engine, model);

    expect(parentTools).toEqual(["AskUserQuestion", "Task", "bash", "edit", "ext_tool", "find", "grep", "ls", "read", "write"]);
    expect(kid.seen[0]?.tools).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
  });

  test("the child follows the user's defaultTools setting too", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));
    const kid = child();
    const { engine, model } = await setup([taskCall("Look around", "go"), kid.step, fauxAssistantMessage([fauxText("ok")])]);

    await runTurn(engine, model);

    expect(kid.seen[0]?.tools).toEqual(["bash", "read"]);
  });

  test("the parent reply gets a task line: running with the description first, then completed with the summary and usage", async () => {
    writeFileSync(join(cwd, "notes.txt"), "contents");
    const kid = child("Found the notes.");
    const reads = fauxAssistantMessage([fauxToolCall("read", { path: join(cwd, "notes.txt") }, { id: "child-read" })], { stopReason: "toolUse" });
    const { engine, model } = await setup([taskCall("Read the notes", "go"), reads, kid.step, fauxAssistantMessage([fauxText("ok")])]);

    const running = start(engine, model);
    await running.turn.done;

    let reply = emptyReply();
    const snapshots: ChatMessage[] = [];
    for (const event of running.events) {
      if (event.type !== "reply") continue;
      reply = event.update(reply);
      snapshots.push(reply);
    }
    const lines = snapshots.flatMap((snapshot) => taskParts(snapshot)).map((task) => [task.status, task.description, task.lastToolName, task.toolUses]);
    expect(lines[0]).toEqual(["running", "Read the notes", undefined, undefined]);
    expect(lines).toContainEqual(["running", "Read the notes", "read", 1]);
    const [task] = taskParts(reply);
    expect(taskParts(reply)).toHaveLength(1);
    expect(task).toMatchObject({ type: "task", taskId: "task-1", description: "Read the notes", status: "completed", summary: "Found the notes.", toolUses: 1, lastToolName: "read" });
    expect(task?.totalTokens).toBeGreaterThan(0);
  });

  test("the child's own tool calls never appear in the parent reply", async () => {
    writeFileSync(join(cwd, "notes.txt"), "contents");
    const reads = fauxAssistantMessage([fauxToolCall("read", { path: join(cwd, "notes.txt") }, { id: "child-read" })], { stopReason: "toolUse" });
    const { engine, model } = await setup([taskCall("Read the notes", "go"), reads, fauxAssistantMessage([fauxText("child done")]), fauxAssistantMessage([fauxText("parent done")])]);

    const { reply } = await runTurn(engine, model);

    expect(toolParts(reply).map((t) => t.toolCallId)).toEqual(["task-1"]);
    expect(reply.parts.some((p) => p.type === "text" && p.text === "child done")).toBe(false);
    expect(reply.parts.at(-1)).toEqual({ type: "text", text: "parent done" });
  });

  test("the child leaves no session file of its own", async () => {
    const { engine, model } = await setup([taskCall("Quick", "go"), fauxAssistantMessage([fauxText("child")]), fauxAssistantMessage([fauxText("parent")])]);

    await runTurn(engine, model);

    const files = [...new Bun.Glob("**/*.jsonl").scanSync(agentDir)];
    expect(files).toHaveLength(1);
  });

  describe("approvals from the child", () => {
    test("a child's bash call asks the user through the turn's host, and a denial stops it", async () => {
      const { seen, step } = reading();
      const { engine, model } = await setup([taskCall("Make a file", "go"), bashCall(`echo hi > ${made()}`, "child-bash"), fauxAssistantMessage([fauxText("gave up")]), step]);
      const { asks, host } = answering("deny");

      const { reply, errors } = await runTurn(engine, model, {}, host);

      expect(errors).toEqual([]);
      expect(asks).toEqual([{ toolName: "bash", input: { command: `echo hi > ${made()}` } }]);
      expect(existsSync(made())).toBe(false);
      expect(taskParts(reply)[0]?.status).toBe("completed");
      expect(seen[0]).toEqual(["gave up"]);
    });

    test("allow runs the child's command", async () => {
      const { engine, model } = await setup([taskCall("Make a file", "go"), bashCall(`echo hi > ${made()}`, "child-bash"), fauxAssistantMessage([fauxText("made it")]), fauxAssistantMessage([fauxText("ok")])]);
      const { asks, host } = answering("allow");

      await runTurn(engine, model, {}, host);

      expect(asks).toHaveLength(1);
      expect(existsSync(made())).toBe(true);
    });

    test("always from the child stores the same rule the parent would, so the next child does not ask again", async () => {
      const command = `echo hi > ${made()}`;
      const { engine, model, permissionRules } = await setup([
        taskCall("Make a file", "go"),
        bashCall(command, "child-bash"),
        fauxAssistantMessage([fauxText("made it")]),
        taskCall("Make it again", "go", "task-2"),
        bashCall(command, "child-bash-2"),
        fauxAssistantMessage([fauxText("made it again")]),
        fauxAssistantMessage([fauxText("ok")]),
      ]);
      const { asks, host } = answering("always");

      await runTurn(engine, model, {}, host);

      expect(permissionRules.hasPermissionRule({ cwd, toolName: "bash", command })).toBe(true);
      expect(asks).toHaveLength(1);
    });

    test("the branch/ship guard applies: a command it denies is blocked with its reason and never asked", async () => {
      const guard = (command: string) => (command.includes("forbidden") ? { decision: "deny" as const, reason: "guard says no" } : null);
      const { seen, step } = reading();
      const sawResult: string[][] = [];
      const afterBlocked: FauxResponseStep = (context) => {
        sawResult.push(toolResultTexts(context.messages));
        return fauxAssistantMessage([fauxText("blocked")]);
      };
      const { engine, model } = await setup([taskCall("Try it", "go"), bashCall(`touch ${made()}; forbidden`, "child-bash"), afterBlocked, step], undefined, { guard });
      const { asks, host } = answering("allow");

      await runTurn(engine, model, {}, host);

      expect(asks).toEqual([]);
      expect(existsSync(made())).toBe(false);
      expect(sawResult[0]?.[0]).toContain("guard says no");
      expect(seen[0]).toEqual(["blocked"]);
    });

    test("a child's ask is declined, and its command never runs, when the turn is interrupted while the prompt is open", async () => {
      let asked: () => void = () => {};
      const pending = new Promise<void>((resolve) => (asked = resolve));
      const { engine, model } = await setup([taskCall("Make a file", "go"), bashCall(`echo hi > ${made()}`, "child-bash"), fauxAssistantMessage([fauxText("ok")])]);
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
  });

  describe("plan mode", () => {
    test("the parent offers Task with the read-only tools, runs it without asking, and the child only gets the read-only tools", async () => {
      let parentTools: string[] = [];
      const first: FauxResponseStep = (context) => {
        parentTools = offeredTools(context.messages).sort();
        return taskCall("Survey the code", "go");
      };
      const kid = child("surveyed");
      const { seen, step } = reading();
      const { engine, model } = await setup([first, kid.step, step]);
      const { asks, host } = answering("allow");

      const { reply, errors } = await runTurn(engine, model, { mode: Mode.PLAN }, host);

      expect(errors).toEqual([]);
      expect(parentTools).toEqual(["AskUserQuestion", "Task", "find", "grep", "ls", "read"]);
      expect(kid.seen[0]?.tools).toEqual(["find", "grep", "ls", "read"]);
      expect(asks).toEqual([]);
      expect(seen[0]).toEqual(["surveyed"]);
      expect(taskParts(reply)[0]?.status).toBe("completed");
    });

    test("a plan-mode child cannot run bash: the call fails without asking", async () => {
      const { engine, model } = await setup([taskCall("Sneak", "go"), bashCall(`echo hi > ${made()}`, "child-bash"), fauxAssistantMessage([fauxText("could not")]), fauxAssistantMessage([fauxText("ok")])]);
      const { asks, host } = answering("allow");

      await runTurn(engine, model, { mode: Mode.PLAN }, host);

      expect(asks).toEqual([]);
      expect(existsSync(made())).toBe(false);
    });
  });

  describe("an extension tool named Task", () => {
    const marker = () => join(cwd, "ext-task-ran.txt");
    const shadow = () =>
      writeExtension(
        "task",
        `pi.registerTool({ name: "Task", label: "t", description: "an extension's own tool", parameters: Type.Object({}), async execute() { require("node:fs").writeFileSync(${JSON.stringify(marker())}, "ran"); return { content: [{ type: "text", text: "ext ran" }] }; } });`,
      );

    test("is not marcsh's: it asks in build mode, and a denial keeps it from running", async () => {
      shadow();
      const { engine, model } = await setup([fauxAssistantMessage([fauxToolCall("Task", {}, { id: "t" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
      const { asks, host } = answering("deny");

      const { reply } = await runTurn(engine, model, {}, host);

      expect(asks.map((a) => a.toolName)).toEqual(["Task"]);
      expect(existsSync(marker())).toBe(false);
      expect(taskParts(reply)).toEqual([]);
      expect(toolParts(reply)[0]?.errorText).toContain("The user denied this tool call.");
    });

    test("is blocked in plan mode without asking, even with a stored rule", async () => {
      shadow();
      const { engine, model, permissionRules } = await setup([fauxAssistantMessage([fauxToolCall("Task", {}, { id: "t" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("ok")])]);
      permissionRules.addPermissionRule({ cwd, toolName: "Task" });
      const { asks, host } = answering("allow");

      const { reply } = await runTurn(engine, model, { mode: Mode.PLAN }, host);

      expect(asks).toEqual([]);
      expect(existsSync(marker())).toBe(false);
      expect(toolParts(reply)[0]?.state).toBe("error");
    });
  });

  test("a child error is a tool error in the parent and fails the task line, without failing the turn", async () => {
    const { seen, step } = reading();
    const failing = fauxAssistantMessage([], { stopReason: "error", errorMessage: "child exploded" });
    const { engine, model } = await setup([taskCall("Doomed", "go"), failing, step]);

    const { reply, errors } = await runTurn(engine, model);

    expect(errors).toEqual([]);
    const [tool] = toolParts(reply);
    expect(tool?.state).toBe("error");
    expect(tool?.errorText).toContain("child exploded");
    expect(taskParts(reply)[0]).toMatchObject({ status: "failed", error: expect.stringContaining("child exploded") });
    expect(seen[0]?.[0]).toContain("child exploded");
  });

  test("a secret in a child's error is redacted", async () => {
    const failing = fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 Authorization: Bearer sk-ant-api03-SECRETSECRETSECRET1234" });
    const { engine, model } = await setup([taskCall("Doomed", "go"), failing, fauxAssistantMessage([fauxText("ok")])]);

    const { reply } = await runTurn(engine, model);

    expect(JSON.stringify(reply)).not.toContain("SECRETSECRET");
    expect(taskParts(reply)[0]?.status).toBe("failed");
  });

  test("interrupting the turn aborts the child, ends the turn quietly, and leaves the task stopped", async () => {
    const hanging = hangingResponse();
    const { engine, model } = await setup([taskCall("Slow work", "go"), hanging.step]);

    const running = start(engine, model);
    await hanging.started;
    running.turn.interrupt();
    await running.turn.done;

    const { reply, errors } = summarize(running.events);
    expect(errors).toEqual([]);
    expect(taskParts(reply)).toHaveLength(1);
    expect(taskParts(reply)[0]).toMatchObject({ description: "Slow work", status: "stopped" });
  });

  test("aborting the request signal aborts the child too", async () => {
    const hanging = hangingResponse();
    const { engine, model } = await setup([taskCall("Slow work", "go"), hanging.step]);

    const running = start(engine, model);
    await hanging.started;
    running.controller.abort();
    await running.turn.done;

    expect(summarize(running.events).errors).toEqual([]);
    expect(taskParts(summarize(running.events).reply)[0]?.status).toBe("stopped");
  });

  test("parallel Task calls in one message each run a child and get their own task line", async () => {
    const answerWithPrompt: FauxResponseStep = (context) => fauxAssistantMessage([fauxText(`done: ${userTexts(context.messages)[0]}`)]);
    const both = fauxAssistantMessage(
      [fauxToolCall("Task", { description: "First job", prompt: "one" }, { id: "task-a" }), fauxToolCall("Task", { description: "Second job", prompt: "two" }, { id: "task-b" })],
      { stopReason: "toolUse" },
    );
    const { seen, step } = reading();
    const { engine, model } = await setup([both, answerWithPrompt, answerWithPrompt, step]);

    const { reply, errors } = await runTurn(engine, model);

    expect(errors).toEqual([]);
    expect(taskParts(reply).map((t) => [t.taskId, t.description, t.status, t.summary])).toEqual([
      ["task-a", "First job", "completed", "done: one"],
      ["task-b", "Second job", "completed", "done: two"],
    ]);
    expect(seen[0]?.sort()).toEqual(["done: one", "done: two"]);
    expect(toolParts(reply).map((t) => t.toolCallId)).toEqual(["task-a", "task-b"]);
  });

  test("a prompt that starts with a slash is the child's text, not a command", async () => {
    const kid = child();
    const { engine, model } = await setup([taskCall("Odd prompt", "/skill:nothing hello"), kid.step, fauxAssistantMessage([fauxText("ok")])]);

    await runTurn(engine, model);

    expect(kid.seen[0]?.user).toEqual(["/skill:nothing hello"]);
  });
});

describe("pi user extensions (S14)", () => {
  const marker = () => join(cwd, "fixture-ran.txt");
  const locations = [
    ["the marcsh agent dir (<agentDir>/extensions)", () => join(agentDir, "extensions")],
    ["the project (<project>/.pi/extensions)", () => join(cwd, ".pi", "extensions")],
  ] as const;
  const fixtureCall = fauxAssistantMessage([fauxToolCall("fixture_tool", { text: "hi" }, { id: "fx-1" })], { stopReason: "toolUse" });

  for (const [label, where] of locations) {
    describe(`an extension in ${label}`, () => {
      beforeEach(() => {
        mkdirSync(where(), { recursive: true });
        writeFileSync(
          join(where(), "fixture.ts"),
          `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: "fixture_tool", label: "fixture", description: "A fixture tool", parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) { require("node:fs").writeFileSync(${JSON.stringify(marker())}, params.text); return { content: [{ type: "text", text: "fixture ran: " + params.text }] }; } });
  pi.registerCommand("fixture-cmd", { description: "A fixture command", handler: async () => {} });
}
`,
        );
      });

      test("loads and offers its tool to the model", async () => {
        let offered: string[] = [];
        const step: FauxResponseStep = (context) => {
          offered = offeredTools(context.messages);
          return fauxAssistantMessage([fauxText("ok")]);
        };
        const { engine, model } = await setup([step]);

        const { errors } = await runTurn(engine, model);

        expect(errors).toEqual([]);
        expect(offered).toContain("fixture_tool");
      });

      test("its tool goes through marcsh's approval: it asks with the tool and input, and runs on allow", async () => {
        const { seen, step } = reading();
        const { engine, model } = await setup([fixtureCall, step]);
        const { asks, host } = answering("allow");

        const { reply } = await runTurn(engine, model, {}, host);

        expect(asks).toEqual([{ toolName: "fixture_tool", input: { text: "hi" } }]);
        expect(readFileSync(marker(), "utf8")).toBe("hi");
        expect(toolParts(reply).map((t) => [t.toolName, t.state])).toEqual([["fixture_tool", "done"]]);
        expect(seen[0]).toEqual(["fixture ran: hi"]);
      });

      test("its tool is blocked on deny, and the model is told", async () => {
        const { seen, step } = reading();
        const { engine, model } = await setup([fixtureCall, step]);
        const { asks, host } = answering("deny");

        const { reply } = await runTurn(engine, model, {}, host);

        expect(asks).toHaveLength(1);
        expect(existsSync(marker())).toBe(false);
        expect(toolParts(reply)[0]?.state).toBe("error");
        expect(seen[0]?.[0]).toContain("The user denied this tool call.");
      });

      test("its tool is neither offered nor callable in plan mode, and never asks", async () => {
        let offered: string[] = [];
        const step: FauxResponseStep = (context) => {
          offered = offeredTools(context.messages);
          return fixtureCall;
        };
        const { engine, model } = await setup([step, fauxAssistantMessage([fauxText("ok")])]);
        const { asks, host } = answering("allow");

        const { reply } = await runTurn(engine, model, { mode: Mode.PLAN }, host);

        expect(offered).not.toContain("fixture_tool");
        expect(asks).toEqual([]);
        expect(existsSync(marker())).toBe(false);
        expect(toolParts(reply)[0]?.state).toBe("error");
      });

      test("its command appears in the / menu list as an extension command", async () => {
        const { engine } = await setup([]);
        const saved: Parameters<Parameters<Engine["warmUpCommands"]>[0]["save"]>[0][] = [];

        await engine.warmUpCommands({ cwd, save: (commands) => saved.push(commands) });

        expect(saved).toHaveLength(1);
        expect(saved[0]!.find((command) => command.name === "fixture-cmd")).toMatchObject({ source: "extension", description: "A fixture command" });
      });

      test("its command runs when typed, with no model call", async () => {
        const { engine, faux, model } = await setup([fauxAssistantMessage([fauxText("unused")])]);

        const { errors } = await runTurn(engine, model, { prompt: "/fixture-cmd" });

        expect(errors).toEqual([]);
        expect(faux.state.callCount).toBe(0);
      });
    });
  }
});

// A stdio MCP server in one small Bun script that logs each start: only the launch matters to these tests.
const TRUST_SERVER = `import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], "start\\n");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
function handle(request) {
  if (request.id === undefined) return;
  if (request.method === "initialize") return send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
  if (request.method === "tools/list") return send({ id: request.id, result: { tools: [{ name: "echo", description: "Echoes", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  return send({ id: request.id, result: {} });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`;

describe("project trust on the pi engine (S18)", () => {
  const marker = () => join(cwd, "marker-written.txt");
  const starts = () => join(dir, "mcp-starts.log");
  const startCount = () => (existsSync(starts()) ? readFileSync(starts(), "utf8").split("\n").filter(Boolean).length : 0);
  const MARKER_TOOL = "marker_tool";
  const MCP_TOOL = "mcp__fixture__echo";

  // A project with a pi extension that writes a marker file the moment it is loaded, and an MCP server that logs its start.
  function writeProjectFiles() {
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "extensions", "marker.ts"),
      `import { writeFileSync } from "node:fs";
import { Type } from "typebox";
writeFileSync(${JSON.stringify(marker())}, "loaded");
export default function (pi) {
  pi.registerTool({ name: ${JSON.stringify(MARKER_TOOL)}, label: "marker", description: "A marker tool", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "marker ran" }] }; } });
  pi.registerCommand("marker-cmd", { description: "A marker command", handler: async () => {} });
}
`,
    );
    const script = join(dir, "trust-server.ts");
    writeFileSync(script, TRUST_SERVER);
    writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script, starts()], exposure: "direct" } } }));
  }

  /** A host that answers the trust question with `answer` and records what it saw when asked. */
  function trusting(answer: TrustAnswer | ((signal: AbortSignal) => Promise<TrustAnswer>)) {
    const asks: { ask: ProjectTrustAsk; markerExisted: boolean; mcpStarts: number }[] = [];
    const host: Partial<TurnHost> = {
      askProjectTrust: async (ask, signal) => {
        asks.push({ ask, markerExisted: existsSync(marker()), mcpStarts: startCount() });
        return typeof answer === "function" ? answer(signal) : answer;
      },
    };
    return { asks, host };
  }

  const offeredInTurn = (engine: Engine, model: string, host: Partial<TurnHost> = {}) => runTurn(engine, model, {}, host);

  function recordingOffer() {
    const offered: string[][] = [];
    const step: FauxResponseStep = (context) => {
      offered.push(offeredTools(context.messages));
      return fauxAssistantMessage([fauxText("ok")]);
    };
    return { offered, step };
  }

  beforeEach(() => writeProjectFiles());

  test("an undecided project asks the host before anything of the project is loaded: no marker yet, no MCP server started", async () => {
    const { offered, step } = recordingOffer();
    const records = openStorage(":memory:");
    const { engine, model } = await setup([step], undefined, { projectTrust: records });
    const { asks, host } = trusting("trust");

    await offeredInTurn(engine, model, host);

    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ markerExisted: false, mcpStarts: 0 });
    // Most dangerous first: MCP servers before extensions.
    expect(asks[0]!.ask.resources).toEqual([
      { path: ".pi/mcp.json", detail: expect.stringContaining("server fixture: ") },
      { path: ".pi/extensions/marker.ts" },
    ]);
    expect(offered[0]).toBeDefined();
  });

  test("trust: the project's extension and MCP server load as before, and the decision is stored", async () => {
    const { offered, step } = recordingOffer();
    const records = openStorage(":memory:");
    const { engine, model } = await setup([step], undefined, { projectTrust: records });
    const { host } = trusting("trust");

    const { errors } = await offeredInTurn(engine, model, host);

    expect(errors).toEqual([]);
    expect(existsSync(marker())).toBe(true);
    expect(startCount()).toBeGreaterThan(0);
    expect(offered[0]).toContain(MARKER_TOOL);
    expect(offered[0]).toContain(MCP_TOOL);
    expect(records.getProjectTrust(cwd)).toBe("trusted");
  });

  test("don't trust: the extension never loads (no marker), the MCP server never starts, its tools are not offered, and the turn still runs", async () => {
    const { offered, step } = recordingOffer();
    const records = openStorage(":memory:");
    const { engine, model } = await setup([step], undefined, { projectTrust: records });
    const { host } = trusting("distrust");

    const { errors, reply } = await offeredInTurn(engine, model, host);

    expect(errors).toEqual([]);
    expect(reply.parts.some((p) => p.type === "text" && p.text === "ok")).toBe(true);
    expect(existsSync(marker())).toBe(false);
    expect(startCount()).toBe(0);
    expect(offered[0]).not.toContain(MARKER_TOOL);
    expect(offered[0]).not.toContain(MCP_TOOL);
    expect(offered[0]).toContain("bash");
    expect(records.getProjectTrust(cwd)).toBe("untrusted");
  });

  test("a stored decision is not asked again: trusted loads without asking", async () => {
    const records = openStorage(":memory:");
    records.setProjectTrust(cwd, "trusted", reviewProject(cwd).record);
    const { offered, step } = recordingOffer();
    const { engine, model } = await setup([step], undefined, { projectTrust: records });
    const { asks, host } = trusting("distrust");

    await offeredInTurn(engine, model, host);

    expect(asks).toEqual([]);
    expect(existsSync(marker())).toBe(true);
    expect(offered[0]).toContain(MARKER_TOOL);
  });

  test("a stored decision is not asked again: untrusted stays untrusted without asking", async () => {
    const records = openStorage(":memory:");
    records.setProjectTrust(cwd, "untrusted");
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("ok")])], undefined, { projectTrust: records });
    const { asks, host } = trusting("trust");

    await offeredInTurn(engine, model, host);

    expect(asks).toEqual([]);
    expect(existsSync(marker())).toBe(false);
    expect(startCount()).toBe(0);
  });

  test("the first answer covers the next turns of the project: one question across two turns", async () => {
    const records = openStorage(":memory:");
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])], undefined, { projectTrust: records });
    const { asks, host } = trusting("distrust");

    await offeredInTurn(engine, model, host);
    await offeredInTurn(engine, model, host);

    expect(asks).toHaveLength(1);
    expect(existsSync(marker())).toBe(false);
  });

  test("the decision is per project: another folder with the same files is asked again", async () => {
    const records = openStorage(":memory:");
    records.setProjectTrust(cwd, "trusted");
    const other = join(dir, "other");
    mkdirSync(join(other, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(other, ".pi", "extensions", "x.ts"), "export default function () {}\n");
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("ok")])], undefined, { projectTrust: records });
    const { asks, host } = trusting("skip");

    await runTurn(engine, model, { cwd: other }, host);

    // The question names the project by its real path (macOS temp folders are symlinks).
    expect(asks.map((a) => a.ask.cwd)).toEqual([realpathSync(other)]);
  });

  test("a project without pi files is never asked about and nothing is stored", async () => {
    rmSync(join(cwd, ".pi"), { recursive: true, force: true });
    writeFileSync(join(cwd, "AGENTS.md"), "# rules");
    const records = openStorage(":memory:");
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("ok")])], undefined, { projectTrust: records });
    const { asks, host } = trusting("trust");

    const { errors } = await offeredInTurn(engine, model, host);

    expect(errors).toEqual([]);
    expect(asks).toEqual([]);
    expect(records.getProjectTrust(cwd)).toBeNull();
  });

  test("Esc (skip): untrusted for this turn only, nothing is stored, the turn still runs, and the next turn asks again", async () => {
    const records = openStorage(":memory:");
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])], undefined, { projectTrust: records });
    const { asks, host } = trusting("skip");

    const first = await offeredInTurn(engine, model, host);
    await offeredInTurn(engine, model, host);

    expect(first.errors).toEqual([]);
    expect(existsSync(marker())).toBe(false);
    expect(startCount()).toBe(0);
    expect(asks).toHaveLength(2);
    expect(records.getProjectTrust(cwd)).toBeNull();
  });

  test("a host that cannot ask leaves the project untrusted without storing anything", async () => {
    const records = openStorage(":memory:");
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("ok")])], undefined, { projectTrust: records });

    const { errors } = await runTurn(engine, model);

    expect(errors).toEqual([]);
    expect(existsSync(marker())).toBe(false);
    expect(startCount()).toBe(0);
    expect(records.getProjectTrust(cwd)).toBeNull();
  });

  test("a project's own settings are ignored while untrusted: its defaultTools does not narrow the tools", async () => {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
    const records = openStorage(":memory:");
    const { offered, step } = recordingOffer();
    const { engine, model } = await setup([step], undefined, { projectTrust: records });
    const { host } = trusting("distrust");

    await offeredInTurn(engine, model, host);

    expect(offered[0]).toEqual(expect.arrayContaining(["bash", "edit", "write"]));
  });

  test("aborting the turn while the trust question is pending loads nothing and stores nothing", async () => {
    const records = openStorage(":memory:");
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("unused")])], undefined, { projectTrust: records });
    let asked: () => void = () => {};
    const pending = new Promise<void>((resolve) => (asked = resolve));
    const running = start(engine, model, {}, {
      askProjectTrust: (_ask, signal) =>
        new Promise<TrustAnswer>((resolve) => {
          asked();
          signal.addEventListener("abort", () => resolve("skip"), { once: true });
        }),
    });

    await pending;
    running.controller.abort();
    await running.turn.done;

    expect(existsSync(marker())).toBe(false);
    expect(startCount()).toBe(0);
    expect(records.getProjectTrust(cwd)).toBeNull();
    expect(summarize(running.events).errors).toEqual([]);
  });

  test("an answer of 'trust' that arrives after the turn was aborted does not load the project", async () => {
    const records = openStorage(":memory:");
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("unused")])], undefined, { projectTrust: records });
    const controller = new AbortController();
    const { host } = trusting(async () => {
      controller.abort();
      return "trust";
    });
    const events: EngineEvent[] = [];
    const turn = engine.startTurn(
      { prompt: "hello", cwd, mode: Mode.BUILD, model, signal: controller.signal },
      { emit: (event) => events.push(event), askPermission: async () => "deny", askQuestions: async () => null, ...host },
    );
    await turn.done;

    expect(existsSync(marker())).toBe(false);
    expect(startCount()).toBe(0);
    expect(records.getProjectTrust(cwd)).toBeNull();
  });

  describe("command warm-up", () => {
    const warm = async (engine: Engine) => {
      const saved: Parameters<Parameters<Engine["warmUpCommands"]>[0]["save"]>[0][] = [];
      await engine.warmUpCommands({ cwd, save: (commands) => saved.push(commands) });
      return saved;
    };

    test("for an undecided project it never loads the project's extension or starts its MCP server, and still lists the other commands", async () => {
      const records = openStorage(":memory:");
      const { engine } = await setup([], undefined, { projectTrust: records });

      const saved = await warm(engine);

      expect(existsSync(marker())).toBe(false);
      expect(startCount()).toBe(0);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.map((command) => command.name)).not.toContain("marker-cmd");
      expect(records.getProjectTrust(cwd)).toBeNull();
    });

    test("for an untrusted project it loads nothing of the project", async () => {
      const records = openStorage(":memory:");
      records.setProjectTrust(cwd, "untrusted");
      const { engine } = await setup([], undefined, { projectTrust: records });

      await warm(engine);

      expect(existsSync(marker())).toBe(false);
      expect(startCount()).toBe(0);
    });

    test("for a trusted project it loads the extension as before and lists its command", async () => {
      const records = openStorage(":memory:");
      records.setProjectTrust(cwd, "trusted", reviewProject(cwd).record);
      const { engine } = await setup([], undefined, { projectTrust: records });

      const saved = await warm(engine);

      expect(existsSync(marker())).toBe(true);
      expect(saved[0]!.find((command) => command.name === "marker-cmd")).toMatchObject({ source: "extension" });
    });
  });

  describe("subagent child sessions follow the parent's trust", () => {
    const taskCall = fauxAssistantMessage([fauxToolCall("Task", { description: "Look", prompt: "go" }, { id: "task-1" })], { stopReason: "toolUse" });
    const childTools = async (decision: "trusted" | "untrusted") => {
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
      const records = openStorage(":memory:");
      records.setProjectTrust(cwd, decision, decision === "trusted" ? reviewProject(cwd).record : undefined);
      let tools: string[] = [];
      const kid: FauxResponseStep = (context) => {
        tools = offeredTools(context.messages).sort();
        return fauxAssistantMessage([fauxText("child done")]);
      };
      const { engine, model } = await setup([taskCall, kid, fauxAssistantMessage([fauxText("ok")])], undefined, { projectTrust: records });
      await runTurn(engine, model);
      return tools;
    };

    test("in a trusted project the child reads the project's settings", async () => {
      expect(await childTools("trusted")).toEqual(["read"]);
    });

    test("in an untrusted project the child ignores them, like its parent", async () => {
      expect(await childTools("untrusted")).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    });
  });
});

describe("pi engine approval modes (S5, S7, S9, S13)", () => {
  const made = () => join(cwd, "made.txt");
  const feature = { kind: "feature", branch: "feat/x" } as const;
  // Auto and yolo relax only on a feature branch: the project is a real repository on one.
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  beforeEach(() => git("init", "-q", "-b", "feat/x"));
  const taskCall = (description: string, prompt: string) =>
    fauxAssistantMessage([fauxToolCall("Task", { description, prompt }, { id: "task-1" })], { stopReason: "toolUse" });
  const systemOf = (messages: Message[]) => {
    const system = getCurrentSystemMessage(messages);
    return system ? getSystemMessageText(system) : "";
  };
  // The system prompt pi sent for the first model call.
  function promptOf() {
    const prompts: string[] = [];
    const step: FauxResponseStep = (context) => {
      prompts.push(systemOf(context.messages));
      return fauxAssistantMessage([fauxText("ok")]);
    };
    return { prompts, step };
  }

  test("yolo runs an ordinary command without asking", async () => {
    const { engine, model } = await setup([bashCall(`echo hi > ${made()}`), fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host } = answering("deny");

    const { reply, errors } = await runTurn(engine, model, { approvalMode: "yolo" }, host);

    expect(errors).toEqual([]);
    expect(asks).toEqual([]);
    expect(existsSync(made())).toBe(true);
    expect(toolParts(reply)[0]?.state).toBe("done");
  });

  test("without a mode the same command asks, as before", async () => {
    const { engine, model } = await setup([bashCall(`echo hi > ${made()}`), fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host } = answering("deny");

    await runTurn(engine, model, {}, host);

    expect(asks).toEqual([{ toolName: "bash", input: { command: `echo hi > ${made()}` } }]);
    expect(existsSync(made())).toBe(false);
  });

  test("a floor command asks with suppressAlwaysAllowRule in yolo, and a denial stops it", async () => {
    const { engine, model } = await setup([bashCall(`npm install left-pad; touch ${made()}`), fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host } = answering("deny");

    await runTurn(engine, model, { approvalMode: "yolo" }, host);

    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ toolName: "bash", suppressAlwaysAllowRule: true });
    expect(existsSync(made())).toBe(false);
  });

  test("a Task child inherits the mode: its ordinary command runs unasked, its floor command asks", async () => {
    const { engine, model } = await setup([
      taskCall("Work", "go"),
      bashCall(`echo hi > ${made()}`, "child-1"),
      bashCall("npm install left-pad", "child-2"),
      fauxAssistantMessage([fauxText("child done")]),
      fauxAssistantMessage([fauxText("parent done")]),
    ]);
    const { asks, host } = answering("deny");

    const { errors } = await runTurn(engine, model, { approvalMode: "auto" }, host);

    expect(errors).toEqual([]);
    expect(existsSync(made())).toBe(true);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ toolName: "bash", input: { command: "npm install left-pad" }, suppressAlwaysAllowRule: true });
  });

  test("auto and yolo add the mode line to the system prompt, after the agent prompt", async () => {
    for (const approvalMode of ["auto", "yolo"] as const) {
      const { prompts, step } = promptOf();
      const { engine, model } = await setup([step]);

      await runTurn(engine, model, { approvalMode, systemPromptAppend: "You are the FTD agent." });

      const line = approvalModeLine(approvalMode, feature)!;
      expect(line).toContain("on feature branch feat/x");
      expect(prompts[0]).toContain(`<addendum>\nYou are the FTD agent.\n\n${line}\n</addendum>`);
    }
  });

  test("off a feature branch the line says the mode is paused, and the call asks as in normal", async () => {
    git("symbolic-ref", "HEAD", "refs/heads/main");
    const { prompts, step } = promptOf();
    const { engine, model } = await setup([step]);
    await runTurn(engine, model, { approvalMode: "yolo" });
    expect(prompts[0]).toContain(`<addendum>\n${approvalModeLine("yolo", { kind: "default", branch: "main" })}\n</addendum>`);
    expect(prompts[0]).toContain("Approval mode YOLO is paused: this folder is not on a feature branch (on the default branch main)");

    const second = await setup([bashCall(`echo hi > ${made()}`), fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host } = answering("deny");
    await runTurn(second.engine, second.model, { approvalMode: "yolo" }, host);
    expect(asks).toEqual([{ toolName: "bash", input: { command: `echo hi > ${made()}` } }]);
    expect(existsSync(made())).toBe(false);
  });

  test("yolo asks for a push, without always-allow", async () => {
    const { engine, model } = await setup([bashCall("git push origin feat/x"), fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host } = answering("deny");

    await runTurn(engine, model, { approvalMode: "yolo" }, host);

    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ toolName: "bash", suppressAlwaysAllowRule: true });
  });

  test("the mode line alone is appended when there is no agent prompt", async () => {
    const { prompts, step } = promptOf();
    const { engine, model } = await setup([step]);

    await runTurn(engine, model, { approvalMode: "yolo" });

    expect(prompts[0]).toContain(`<addendum>\n${approvalModeLine("yolo", feature)}\n</addendum>`);
  });

  test("normal mode adds no mode line", async () => {
    for (const approvalMode of [undefined, "normal"] as const) {
      const { prompts, step } = promptOf();
      const { engine, model } = await setup([step]);

      await runTurn(engine, model, { approvalMode, systemPromptAppend: "You are the FTD agent." });

      expect(prompts[0]).toContain("<addendum>\nYou are the FTD agent.\n</addendum>");
      expect(prompts[0]).not.toContain("Approval mode");
    }
  });

  test("a plan turn gets no mode line, whatever the session's approval mode", async () => {
    for (const approvalMode of ["auto", "yolo"] as const) {
      const { prompts, step } = promptOf();
      const { engine, model } = await setup([step]);

      await runTurn(engine, model, { mode: Mode.PLAN, approvalMode, systemPromptAppend: "You are the FTD agent." });

      expect(prompts[0]).toContain("<addendum>\nYou are the FTD agent.\n</addendum>");
      expect(prompts[0]).not.toContain("Approval mode");
    }
  });
});
