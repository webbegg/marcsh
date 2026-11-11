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
let packView: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-pack-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });

  // What `installPack` generates: a plugin view with the pack's skills and commands, nothing else.
  packView = join(dir, "packs", "acme", "flows", "plugin");
  mkdirSync(join(packView, "skills", "tdd"), { recursive: true });
  mkdirSync(join(packView, "commands"), { recursive: true });
  writeFileSync(join(packView, "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Work test first\n---\nRED then GREEN.\n");
  writeFileSync(join(packView, "commands", "ship.md"), "---\ndescription: Ship it\n---\nShip the change carefully.\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function systemText(messages: Message[]) {
  const system = getCurrentSystemMessage(messages);
  return system ? getSystemMessageText(system) : "";
}

const userText = (messages: Message[]) =>
  messages.flatMap((message) =>
    message.role === "user" ? [typeof message.content === "string" ? message.content : message.content.map((part) => ("text" in part ? part.text : "")).join("")] : [],
  );

// What pi sent for each model call, read from the faux provider's request context.
async function setup() {
  const prompts: string[] = [];
  const users: string[][] = [];
  const respond: FauxResponseStep = (context) => {
    prompts.push(systemText(context.messages));
    users.push(userText(context.messages));
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

  return { prompts, users, turn };
}

describe("pi turns with a pack agent (S12)", () => {
  test("the pack's skill is available to that turn", async () => {
    const { prompts, turn } = await setup();

    const { errors } = await turn({ packPluginPath: packView });

    expect(errors).toEqual([]);
    expect(prompts[0]).toContain("tdd");
    expect(prompts[0]).toContain("Work test first");
  });

  test("a turn without a pack agent does not have it, and neither does the next turn after switching away", async () => {
    const { prompts, turn } = await setup();

    const plain = await turn();
    const withPack = await turn({ prompt: "two", resumeRef: plain.ref, packPluginPath: packView });
    const after = await turn({ prompt: "three", resumeRef: plain.ref });

    expect(withPack.ref).toBe(plain.ref);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).not.toContain("Work test first");
    expect(prompts[1]).toContain("Work test first");
    expect(prompts[2]).not.toContain("Work test first");
    // marcsh's own skills stay in every turn.
    for (const prompt of prompts) expect(prompt).toContain("workflow");
    expect(after.errors).toEqual([]);
  });

  test("the pack's command runs as a prompt template", async () => {
    const { users, turn } = await setup();

    await turn({ prompt: "/ship now", packPluginPath: packView });

    expect(users[0]!.join("\n")).toContain("Ship the change carefully.");
  });

  test("a view that is gone does not break the turn", async () => {
    const { prompts, turn } = await setup();

    const { errors } = await turn({ packPluginPath: join(dir, "packs", "gone", "plugin") });

    expect(errors).toEqual([]);
    expect(prompts).toHaveLength(1);
  });
});
