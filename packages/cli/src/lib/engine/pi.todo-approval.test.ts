import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { offeredInPlan, runsUnasked } from "./pi-permissions";
import { trustEveryProject } from "./test-trust";
import type { PermissionAsk, TurnHost, TurnRequest } from "./types";

// Only marcsh's own inline `todo` runs without asking; a user's or project's `todo` still asks, and plan mode never runs it.
let dir: string;
let agentDir: string;
let cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-todo-approval-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const call = (name: string, args: Record<string, unknown>, id = "c1") => fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });
const finish = () => fauxAssistantMessage([fauxText("done")]);
const results = (messages: Message[]) => messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((b) => ("text" in b ? b.text : "")).join("")] : []));

async function setup(steps: Array<() => ReturnType<typeof fauxAssistantMessage>>) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const seen: { tools: string[]; results: string[] }[] = [];
  let next = 0;
  const router: FauxResponseStep = (context) => {
    const messages = context.messages as Message[];
    seen.push({ tools: getCurrentTools(messages).map((t) => t.name).sort(), results: results(messages) });
    const step = steps[next++];
    return step ? step() : finish();
  };
  faux.setResponses(Array.from({ length: 12 }, () => router));
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });
  async function turn(answer: "allow" | "deny", overrides: Partial<TurnRequest> = {}) {
    const asks: PermissionAsk[] = [];
    const host: TurnHost = { emit: () => {}, askPermission: async (ask) => (asks.push(ask), answer), askQuestions: async () => null };
    await engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal, ...overrides }, host).done;
    return asks;
  }
  return { turn, seen };
}

const fakeTodo = (marker: string) => `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: "todo", label: "fake", description: "fake todo", parameters: Type.Object({ action: Type.String() }),
    async execute() { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); return { content: [{ type: "text", text: "fake ran" }] }; } });
}
`;
const tree = (root: string): string[] =>
  readdirSync(root)
    .sort()
    .flatMap((name) => {
      const path = join(root, name);
      return statSync(path).isDirectory() ? tree(path) : [`${path}:${readFileSync(path, "utf8")}`];
    });

describe("todo approval", () => {
  test("a user pi extension named todo asks, and a denied call does not run", async () => {
    const marker = join(dir, "user-marker");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "todo.ts"), fakeTodo(marker));
    const { turn } = await setup([() => call("todo", { action: "list" })]);
    const asks = await turn("deny");
    expect(asks.length).toBe(1);
    expect(existsSync(marker)).toBe(false);
  }, 60000);

  test("a project pi extension named todo asks", async () => {
    const marker = join(dir, "project-marker");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "extensions", "todo.ts"), fakeTodo(marker));
    const { turn } = await setup([() => call("todo", { action: "list" })]);
    expect((await turn("deny")).length).toBe(1);
    expect(existsSync(marker)).toBe(false);
  }, 60000);

  test("in plan mode a user's todo is not offered and never runs", async () => {
    const marker = join(dir, "plan-marker");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "todo.ts"), fakeTodo(marker));
    const { turn, seen } = await setup([() => call("todo", { action: "list" })]);
    expect(await turn("allow", { mode: Mode.PLAN })).toEqual([]);
    expect(seen[0]!.tools).not.toContain("todo");
    expect(existsSync(marker)).toBe(false);
  }, 60000);

  test("in plan mode marcsh's todo runs unasked and changes no project file", async () => {
    writeFileSync(join(cwd, "a.ts"), "x");
    const before = tree(cwd);
    const set = { action: "set", todos: [{ id: "T1", text: "a" }] };
    const { turn, seen } = await setup([() => call("todo", set), () => call("todo", { action: "update", id: "T1", status: "done" }, "c2"), () => call("todo", { action: "clear" }, "c3")]);
    expect(await turn("deny", { mode: Mode.PLAN })).toEqual([]);
    expect(seen[3]!.results.at(-1)).toBe("No todos");
    expect(tree(cwd)).toEqual(before);
  }, 60000);

  test("runsUnasked needs both the name and marcsh's inline source", () => {
    const tool = (name: string, path: string) => ({ name, sourceInfo: { path } }) as never;
    expect(runsUnasked(tool("todo", "<inline:marcsh-todo>"))).toBe(true);
    expect(offeredInPlan(tool("todo", "<inline:marcsh-todo>"))).toBe(true);
    for (const [name, path] of [
      ["todo", "<inline:marcsh-mcp>"],
      ["mcp__srv__todo", "<inline:marcsh-mcp>"],
      ["todo", "/u/.pi/agent/extensions/todo.ts"],
      ["todo", "<inline:marcsh-todo2>"],
      ["write", "<inline:marcsh-todo>"],
    ] as const) {
      expect(runsUnasked(tool(name, path))).toBe(false);
    }
  });
});
