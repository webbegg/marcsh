import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getCurrentSystemMessage,
  getCurrentTools,
  getSystemMessageText,
  InMemoryCredentialStore,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import { createBackgroundHub, type BackgroundHub } from "../background/hub";
import { subagentsFor } from "../background/session-subagents";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import type { EngineEvent, PermissionAsk, TurnHost, TurnRequest, TurnSubagent } from "./types";

// M1 on real pi sessions with the faux provider: `Task` with `agent` runs the child as that named subagent: its prompt, model,
// pack skills, and tools that only ever narrow the parent's.

let dir: string;
let agentDir: string;
let cwd: string;
let packView: string;
const hubs: BackgroundHub[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-named-subagents-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  // A pack's plugin view with one skill (see pi.pack.test.ts).
  packView = join(dir, "packs", "acme", "flows", "plugin");
  mkdirSync(join(packView, "skills", "tdd"), { recursive: true });
  writeFileSync(join(packView, "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: Work test first\n---\nRED then GREEN.\n");
});

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
  rmSync(dir, { recursive: true, force: true });
});

const CHILD_PROMPT = "child: do the task";
const made = () => join(cwd, "made.txt");

const systemText = (messages: Message[]) => {
  const system = getCurrentSystemMessage(messages);
  return system ? getSystemMessageText(system) : "";
};
const firstUserText = (messages: Message[]) => {
  const user = messages.find((m) => m.role === "user");
  if (!user) return "";
  return typeof user.content === "string" ? user.content : user.content.map((block) => ("text" in block ? block.text : "")).join("");
};
const toolResults = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));
const call = (name: string, args: Record<string, unknown>, id: string) => fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });

type Seen = { system: string; tools: string[]; task: string; model: string; results: string[] };

/**
 * The parent calls `Task` with `task` once, then answers "ok"; the child (told apart by its prompt) answers with `child(results)`.
 * Every child request is recorded: its system prompt, tools, model and the tool results it has seen.
 */
async function setup(task: Record<string, unknown>, child: (results: string[]) => ReturnType<typeof fauxAssistantMessage> = () => fauxAssistantMessage([fauxText("child answer")])) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const children: Seen[] = [];
  const parents: Seen[] = [];
  const router: FauxResponseStep = (context, _options, _state, model) => {
    const messages = context.messages as Message[];
    const tools = getCurrentTools(messages);
    const taskTool = tools.find((tool) => tool.name === "Task");
    const seen = {
      system: systemText(messages),
      tools: tools.map((tool) => tool.name).sort(),
      task: taskTool ? `${taskTool.description}\n${JSON.stringify(taskTool.parameters)}` : "",
      model: model.id,
      results: toolResults(messages),
    };
    if (firstUserText(messages) === CHILD_PROMPT) {
      children.push(seen);
      return child(seen.results);
    }
    parents.push(seen);
    return seen.results.length === 0 ? call("Task", { description: "Do the task", prompt: CHILD_PROMPT, ...task }, "task-1") : fauxAssistantMessage([fauxText("ok")]);
  };
  faux.setResponses(Array.from({ length: 12 }, () => router));
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });

  async function turn(overrides: Partial<TurnRequest> = {}) {
    const events: EngineEvent[] = [];
    const asks: PermissionAsk[] = [];
    const host: TurnHost = { emit: (event) => events.push(event), askPermission: async (ask) => (asks.push(ask), "allow"), askQuestions: async () => null };
    await engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal, ...overrides }, host).done;
    return { asks, errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])) };
  }
  return { turn, children, parents };
}

const REFUTER: TurnSubagent = { name: "refuter", description: "Refutes claims", prompt: "You are the REFUTER subagent.", readOnly: true };
const DEVELOPER: TurnSubagent = { name: "developer", description: "Builds one task", prompt: "You are the DEVELOPER subagent.", readOnly: false };
const BUILD_TOOLS = ["bash", "edit", "find", "grep", "ls", "read", "write"];

describe("pi Task with a named subagent", () => {
  test("the child's system prompt has the subagent's prompt; the parent's does not, and a plain child gets none", async () => {
    const named = await setup({ agent: "developer" });
    const { errors } = await named.turn({ subagents: [DEVELOPER, REFUTER] });
    expect(errors).toEqual([]);
    expect(named.children[0]!.system).toContain("You are the DEVELOPER subagent.");
    expect(named.children[0]!.system).not.toContain("REFUTER");
    expect(named.parents[0]!.system).not.toContain("DEVELOPER subagent");

    const plain = await setup({});
    await plain.turn({ subagents: [DEVELOPER] });
    expect(plain.children[0]!.system).not.toContain("DEVELOPER subagent");
  });

  test("the parent is told the names it can pass as `agent`", async () => {
    const { turn, parents } = await setup({});
    await turn({ subagents: [DEVELOPER, REFUTER] });
    expect(parents[0]!.task).toContain("- developer: Builds one task");
    expect(parents[0]!.task).toContain("- refuter: Refutes claims (read-only)");
    expect(parents[0]!.task).toContain('"agent"');
  });

  test("an unknown name is a tool error for the parent that lists the valid ones; no child runs", async () => {
    const { turn, children, parents } = await setup({ agent: "nope" });
    await turn({ subagents: [DEVELOPER, REFUTER] });
    expect(children).toEqual([]);
    expect(parents[1]!.results.join("\n")).toContain('Unknown subagent "nope". Available: developer, refuter.');
  });

  test("the subagent's model is used when the engine has it; otherwise the parent's", async () => {
    const cases: [string | undefined, string][] = [
      ["faux/faux-2", "faux-2"],
      ["faux/missing", "faux-1"],
      ["sonnet", "faux-1"],
      [undefined, "faux-1"],
    ];
    for (const [model, expected] of cases) {
      const { turn, children } = await setup({ agent: "developer" });
      await turn({ subagents: [{ ...DEVELOPER, ...(model ? { model } : {}) }] });
      expect(children[0]!.model, String(model)).toBe(expected);
    }
  });

  test("the subagent's own denied groups narrow the child further", async () => {
    const { turn, children } = await setup({ agent: "developer" });
    await turn({ subagents: [{ ...DEVELOPER, deniedTools: ["bash"] }] });
    expect(children[0]!.tools).toEqual(BUILD_TOOLS.filter((name) => name !== "bash"));
  });

  test("its tools never widen the parent's: the parent denies bash, so a subagent that keeps bash still cannot run it [invariant]", async () => {
    // A subagent whose `tools` keep bash and read (denying only edit): it starts from the parent's narrowing, never from pi's defaults.
    const { turn, children } = await setup({ agent: "developer" }, (results) =>
      results.length === 0 ? call("bash", { command: `echo hi > ${made()}` }, "b1") : fauxAssistantMessage([fauxText("child answer")]),
    );
    const { asks } = await turn({ deniedTools: ["bash"], subagents: [{ ...DEVELOPER, deniedTools: ["edit"] }] });
    expect(children[0]!.tools).toEqual(["find", "grep", "ls", "read"]);
    expect(existsSync(made())).toBe(false);
    expect(asks.map((ask) => ask.toolName)).not.toContain("bash");
    expect(children[1]!.results.join("\n")).toMatch(/not available|not found/i);
  });

  test("a read-only subagent only reads even when the parent builds: it gets the read-only tools and a write is blocked unasked", async () => {
    const { turn, children } = await setup({ agent: "refuter" }, (results) =>
      results.length === 0 ? call("write", { path: made(), content: "x" }, "w1") : fauxAssistantMessage([fauxText("child answer")]),
    );
    const { asks } = await turn({ subagents: [REFUTER] });
    expect(children[0]!.tools).toEqual(["find", "grep", "ls", "read"]);
    expect(existsSync(made())).toBe(false);
    expect(asks).toEqual([]);
  });

  test("a build subagent started from a plan turn still only reads [invariant]", async () => {
    const { turn, children } = await setup({ agent: "developer" }, (results) =>
      results.length === 0 ? call("write", { path: made(), content: "x" }, "w1") : fauxAssistantMessage([fauxText("child answer")]),
    );
    const { asks } = await turn({ mode: Mode.PLAN, subagents: [DEVELOPER] });
    expect(children[0]!.tools).toEqual(["find", "grep", "ls", "read"]);
    expect(existsSync(made())).toBe(false);
    expect(asks).toEqual([]);
  });

  test("a pack subagent gets its pack's skills when the turn loads that pack; the user's own subagent does not", async () => {
    const pack = await setup({ agent: "developer" });
    await pack.turn({ packPluginPath: packView, subagents: [{ ...DEVELOPER, pluginDir: packView }] });
    expect(pack.children[0]!.system).toContain("Work test first");

    const user = await setup({ agent: "developer" });
    await user.turn({ packPluginPath: packView, subagents: [DEVELOPER] });
    expect(user.children[0]!.system).not.toContain("Work test first");
  });
});

describe("a background Task with a named subagent", () => {
  test("the background child runs as that subagent: its prompt, and read-only stays read-only", async () => {
    const hub = createBackgroundHub({ debounceMs: 5, registerTurn: () => () => {} });
    hubs.push(hub);
    hub.setIdleSink(() => true);
    const sessionAsks: PermissionAsk[] = [];
    hub.host = { askPermission: async (ask) => (sessionAsks.push(ask), "allow") };
    const { turn, children } = await setup({ agent: "refuter", background: true }, (results) =>
      results.length === 0 ? call("write", { path: made(), content: "x" }, "w1") : fauxAssistantMessage([fauxText("child answer")]),
    );
    await turn({ background: hub, subagents: [REFUTER] });
    await subagentsFor(hub).settled("sa-1");
    expect(children[0]!.system).toContain("You are the REFUTER subagent.");
    expect(children[0]!.tools).toEqual(["find", "grep", "ls", "read"]);
    expect(existsSync(made())).toBe(false);
    expect(sessionAsks).toEqual([]);
  });
});
