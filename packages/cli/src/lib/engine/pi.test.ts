import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { createPiEngine, defaultPiAgentDir } from "./pi";
import type { Engine, EngineEvent, PermissionAsk, PermissionDecision, TurnHost, TurnRequest } from "./types";

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

async function setup(responses: FauxResponseStep[], permissionRules: Storage = openStorage(":memory:")) {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);

  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules });
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

  test("identifies itself as pi and has nothing to warm up", async () => {
    const { engine } = await setup([]);
    const saved: unknown[] = [];

    expect(engine.id).toBe("pi");
    await engine.warmUpCommands({ cwd, save: (commands) => saved.push(commands) });
    expect(saved).toEqual([]);
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

  test("plan mode offers only the read-only tools, so bash cannot run or ask", async () => {
    let offered: string[] | undefined;
    const planned: FauxResponseStep = (context) => {
      offered = offeredTools(context.messages);
      return bashCall(`echo hi > ${made()}`);
    };
    const { engine, model } = await setup([planned, fauxAssistantMessage([fauxText("ok")])]);
    const { asks, host } = answering("allow");

    const { reply } = await runTurn(engine, model, { mode: Mode.PLAN }, host);

    expect(offered?.sort()).toEqual(["find", "grep", "ls", "read"]);
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

    expect(offered).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
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

  const PLAN = ["find", "grep", "ls", "read"];
  const BUILD = ["bash", "edit", "read", "write"];

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

    expect(offered).toEqual([["bash", "ext_tool", "read"], PLAN, ["bash", "ext_tool", "read"]]);
  });
});
