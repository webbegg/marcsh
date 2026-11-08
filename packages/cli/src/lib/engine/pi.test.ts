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
  InMemoryCredentialStore,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { ChatMessage } from "../chat-types";
import { Mode } from "../modes";
import { createPiEngine, defaultPiAgentDir } from "./pi";
import type { Engine, EngineEvent, TurnHost, TurnRequest } from "./types";

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

async function setup(responses: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);

  const engine = createPiEngine({ agentDir, modelRuntime });
  return { engine, faux, model: "faux/faux-1" };
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

function start(engine: Engine, model: string, overrides: Partial<TurnRequest> = {}) {
  const events: EngineEvent[] = [];
  const host: TurnHost = {
    emit: (event) => events.push(event),
    askPermission: async () => "deny",
    askQuestions: async () => null,
  };
  const controller = new AbortController();
  const turn = engine.startTurn(
    { prompt: "hello", cwd, mode: Mode.BUILD, model, signal: controller.signal, ...overrides },
    host,
  );
  return { turn, events, controller };
}

async function runTurn(engine: Engine, model: string, overrides: Partial<TurnRequest> = {}) {
  const running = start(engine, model, overrides);
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
