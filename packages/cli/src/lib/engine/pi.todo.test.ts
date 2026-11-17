import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { isMarcshTodo } from "./pi-todo";
import { trustEveryProject } from "./test-trust";
import type { EngineEvent, PermissionAsk, TurnHost, TurnRequest } from "./types";

// S2/T7: the pi engine's `todo` tool on real pi sessions with the faux provider.
let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-todo-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CHILD_PROMPT = "child: do the task";
const call = (name: string, args: Record<string, unknown>, id = "c1") => fauxAssistantMessage([fauxToolCall(name, args as never, { id })], { stopReason: "toolUse" });
const toolResults = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));
const firstUserText = (messages: Message[]) => {
  const user = messages.find((m) => m.role === "user");
  if (!user) return "";
  return typeof user.content === "string" ? user.content : user.content.map((block) => ("text" in block ? block.text : "")).join("");
};
const systemText = (messages: Message[]) => {
  const system = getCurrentSystemMessage(messages);
  return system ? getSystemMessageText(system) : "";
};

type Seen = { tools: string[]; system: string; results: string[]; prompt: string };

/** `steps` answer the main session in order (a step gets what it has seen); a request carrying CHILD_PROMPT is a Task child's and is recorded apart. */
async function setup(steps: Array<(seen: Seen) => ReturnType<typeof fauxAssistantMessage>>) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const main: Seen[] = [];
  const children: Seen[] = [];
  let next = 0;
  const router: FauxResponseStep = (context) => {
    const messages = context.messages as Message[];
    const seen = { tools: getCurrentTools(messages).map((tool) => tool.name).sort(), system: systemText(messages), results: toolResults(messages), prompt: firstUserText(messages) };
    if (seen.prompt === CHILD_PROMPT) {
      children.push(seen);
      return fauxAssistantMessage([fauxText("child answer")]);
    }
    main.push(seen);
    const step = steps[next++];
    return step ? step(seen) : fauxAssistantMessage([fauxText("ok")]);
  };
  faux.setResponses(Array.from({ length: 24 }, () => router));
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });

  async function turn(overrides: Partial<TurnRequest> = {}) {
    const events: EngineEvent[] = [];
    const asks: PermissionAsk[] = [];
    const host: TurnHost = { emit: (event) => events.push(event), askPermission: async (ask) => (asks.push(ask), "allow"), askQuestions: async () => null };
    await engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal, ...overrides }, host).done;
    return { asks, ref: events.flatMap((e) => (e.type === "session" ? [e.ref] : [])).at(-1), errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])) };
  }
  return { turn, main, children };
}

const SET = { action: "set", todos: [{ id: "T1", text: "write tests", status: "in_progress" }, { id: "T2", text: "ship", status: "pending" }] };
const finish = () => fauxAssistantMessage([fauxText("done")]);

describe("the todo tool in a pi turn (S2)", () => {
  test("the main session has it, it runs without asking in normal mode, and the result shows the list", async () => {
    const { turn, main } = await setup([() => call("todo", SET), () => call("todo", { action: "update", id: "T1", status: "done" }, "c2"), () => call("todo", { action: "list" }, "c3"), finish]);
    const { asks, errors } = await turn();

    expect(errors).toEqual([]);
    expect(asks).toEqual([]);
    expect(main[0]!.tools).toEqual(["AskUserQuestion", "Task", "bash", "edit", "find", "grep", "ls", "read", "todo", "write"]);
    expect(main[1]!.results).toEqual(["◐ T1 write tests [in_progress]\n○ T2 ship [pending]"]);
    expect(main[3]!.results.at(-1)).toBe("✓ T1 write tests [done]\n○ T2 ship [pending]");
  }, 30000);

  test("invalid input is a tool error and leaves the list as it was", async () => {
    const { turn, main } = await setup([
      () => call("todo", SET),
      () => call("todo", { action: "update", id: "T2", status: "blocked" }, "c2"),
      () => call("todo", { action: "list" }, "c3"),
      finish,
    ]);
    await turn();

    expect(main[2]!.results[1]).toContain("T2 is blocked; add a note saying what it waits for");
    expect(main[3]!.results[2]).toBe("◐ T1 write tests [in_progress]\n○ T2 ship [pending]");
  }, 30000);

  test("plan mode offers it too (it changes no files) and runs it without asking", async () => {
    const { turn, main } = await setup([() => call("todo", SET), finish]);
    const { asks, errors } = await turn({ mode: Mode.PLAN });

    expect(errors).toEqual([]);
    expect(asks).toEqual([]);
    expect(main[0]!.tools).toContain("todo");
    expect(main[1]!.results[0]).toContain("T1 write tests");
  }, 30000);

  test("the list comes back when the conversation is resumed", async () => {
    const { turn, main } = await setup([() => call("todo", SET), finish, () => call("todo", { action: "list" }), finish]);
    const first = await turn();
    expect(first.ref).toBeDefined();
    await turn({ resumeRef: first.ref });

    expect(main[2]!.results.at(-1)).toBe("◐ T1 write tests [in_progress]\n○ T2 ship [pending]");
  }, 30000);

  test("the list is read from the branch the session is on: a resumed list can be updated", async () => {
    const { turn, main } = await setup([() => call("todo", SET), finish, () => call("todo", { action: "update", id: "T2", status: "done" }), finish]);
    const first = await turn();
    await turn({ resumeRef: first.ref });

    expect(main[3]!.results.at(-1)).toBe("◐ T1 write tests [in_progress]\n✓ T2 ship [done]");
  }, 30000);

  test("the list never enters the system prompt", async () => {
    const { turn, main } = await setup([() => call("todo", SET), finish]);
    await turn();

    expect(main[1]!.system).not.toContain("write tests");
    expect(main[0]!.system).not.toContain("- todo");
  }, 30000);

  test("a Task child does not get it, and denying a group does not take it from the main session", async () => {
    const { turn, main, children } = await setup([() => call("Task", { description: "d", prompt: CHILD_PROMPT }), finish]);
    await turn();
    expect(children[0]!.tools).not.toContain("todo");
    expect(main[0]!.tools).toContain("todo");

    const denied = await setup([finish]);
    await denied.turn({ deniedTools: ["bash", "edit", "task"] });
    expect(denied.main[0]!.tools).toContain("todo");
  }, 30000);
});

describe("isMarcshTodo", () => {
  test("needs the name and marcsh's own inline extension as the source", () => {
    const tool = (name: string, path: string) => ({ name, sourceInfo: { path } }) as unknown as Parameters<typeof isMarcshTodo>[0];
    expect(isMarcshTodo(tool("todo", "<inline:marcsh-todo>"))).toBe(true);
    expect(isMarcshTodo(tool("todo", "/home/me/.pi/extensions/todo.ts"))).toBe(false);
    expect(isMarcshTodo(tool("other", "<inline:marcsh-todo>"))).toBe(false);
  });
});
