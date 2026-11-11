import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  getCurrentSystemMessage,
  getSystemMessageText,
  InMemoryCredentialStore,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import type { EngineEvent, TurnHost, TurnRequest } from "./types";

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-agent-prompt-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// What the model reads as its system prompt: a resumed session carries the first turn's prompt plus patches, replayed into one.
function systemText(messages: Message[]) {
  const system = getCurrentSystemMessage(messages);
  return system ? getSystemMessageText(system) : "";
}

// The system prompt pi sent for each model call, read from the faux provider's request context.
async function setup() {
  const prompts: string[] = [];
  const respond: FauxResponseStep = (context) => {
    prompts.push(systemText(context.messages));
    return fauxAssistantMessage([fauxText("ok")]);
  };
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses([respond, respond, respond]);
  const engine = createPiEngine({
    agentDir,
    modelRuntime,
    permissionRules: openStorage(":memory:"),
    projectTrust: { getProjectTrust: () => "trusted", setProjectTrust: () => {} },
  });

  async function turn(overrides: Partial<TurnRequest> = {}) {
    const events: EngineEvent[] = [];
    const host: TurnHost = { emit: (event) => events.push(event), askPermission: async () => "deny", askQuestions: async () => null };
    const running = engine.startTurn(
      { prompt: "hello", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal, ...overrides },
      host,
    );
    await running.done;
    const ref = events.flatMap((e) => (e.type === "session" ? [e.ref] : [])).at(-1);
    return { ref, errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])) };
  }

  return { prompts, turn };
}

describe("pi turns with an agent prompt", () => {
  test("the agent prompt is appended to pi's system prompt", async () => {
    const { prompts, turn } = await setup();

    const { errors } = await turn({ systemPromptAppend: "You are the FTD agent." });

    expect(errors).toEqual([]);
    expect(prompts).toHaveLength(1);
    // pi puts appended text in its addendum, after its own prompt, not in place of it.
    expect(prompts[0]).toContain("<addendum>\nYou are the FTD agent.\n</addendum>");
    expect(prompts[0]).toContain("You are a coding assistant running inside pi");
  });

  test("a global APPEND_SYSTEM.md still applies next to the agent prompt", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Always answer in haiku.");
    const { prompts, turn } = await setup();

    await turn({ systemPromptAppend: "You are the FTD agent." });

    expect(prompts[0]).toContain("Always answer in haiku.");
    expect(prompts[0]).toContain("You are the FTD agent.");
  });

  test("a turn without an agent prompt carries none", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Always answer in haiku.");
    const { prompts, turn } = await setup();

    await turn();

    expect(prompts[0]).toContain("Always answer in haiku.");
    expect(prompts[0]).not.toContain("FTD agent");
  });

  test("switching agent on a resumed conversation applies the new prompt from the next turn, keeping the conversation", async () => {
    const { prompts, turn } = await setup();

    const first = await turn({ prompt: "one", systemPromptAppend: "You are agent ALPHA." });
    const second = await turn({ prompt: "two", resumeRef: first.ref, systemPromptAppend: "You are agent BETA." });
    const third = await turn({ prompt: "three", resumeRef: second.ref });

    expect(second.ref).toBe(first.ref);
    expect(third.ref).toBe(first.ref);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("ALPHA");
    expect(prompts[0]).not.toContain("BETA");
    expect(prompts[1]).toContain("BETA");
    expect(prompts[1]).not.toContain("ALPHA");
    expect(prompts[2]).not.toContain("ALPHA");
    expect(prompts[2]).not.toContain("BETA");
  });
});
