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
  getCurrentTools,
  InMemoryCredentialStore,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import type { ChatMessage } from "../chat-types";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createDeniedToolsExtension, createPiEngine } from "./pi";
import { TASK_TOOL } from "./pi-subagent";
import { trustEveryProject } from "./test-trust";
import type { EngineEvent, PermissionAsk, TurnHost, TurnRequest } from "./types";

// S15 on real pi sessions with the faux provider: the tools an agent's `tools` field takes away are neither offered nor callable.

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-agent-tools-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const made = () => join(cwd, "made.txt");
const names = (messages: Message[]) => getCurrentTools(messages).map((tool) => tool.name).sort();
const toolCall = (name: string, input: Parameters<typeof fauxToolCall>[1], id = "call-1") =>
  fauxAssistantMessage([fauxToolCall(name, input, { id })], { stopReason: "toolUse" });
const bashCall = () => toolCall("bash", { command: `echo hi > ${made()}` });

async function setup(steps: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(steps);
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });

  async function turn(overrides: Partial<TurnRequest> = {}) {
    const events: EngineEvent[] = [];
    const asks: PermissionAsk[] = [];
    const host: TurnHost = {
      emit: (event) => events.push(event),
      askPermission: async (ask) => {
        asks.push(ask);
        return "allow";
      },
      askQuestions: async () => null,
    };
    const running = engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal, ...overrides }, host);
    await running.done;
    let reply: ChatMessage = { id: "reply", role: "assistant", parts: [] };
    for (const event of events) if (event.type === "reply") reply = event.update(reply);
    return {
      asks,
      reply,
      ref: events.flatMap((e) => (e.type === "session" ? [e.ref] : [])).at(-1),
      errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])),
      tools: reply.parts.flatMap((p) => (p.type === "tool" ? [p] : [])),
    };
  }
  return { turn };
}

// Steps that record the tools each model call was offered, one entry per call, and answer "ok".
function recording(calls: number) {
  const offered: string[][] = [];
  const steps: FauxResponseStep[] = Array.from({ length: calls }, () => (context) => {
    offered.push(names(context.messages));
    return fauxAssistantMessage([fauxText("ok")]);
  });
  return { offered, steps };
}

const ALL_BUILD = ["AskUserQuestion", "Task", "bash", "edit", "find", "grep", "ls", "read", "write"];
const without = (list: string[], ...removed: string[]) => list.filter((name) => !removed.includes(name));

describe("pi build turns with denied tool groups", () => {
  test("a turn without denied tools offers what it always did", async () => {
    const { offered, steps } = recording(1);
    const { turn } = await setup(steps);

    await turn();

    expect(offered[0]).toEqual(ALL_BUILD);
  });

  test.each([
    ["bash", ["bash"], ["bash"]],
    ["edit", ["edit"], ["edit", "write"]],
    ["read", ["read"], ["find", "grep", "ls", "read"]],
    ["task", ["task"], ["Task"]],
  ] as const)("denying %s removes its tools and nothing else", async (_group, deny, removed) => {
    const { offered, steps } = recording(1);
    const { turn } = await setup(steps);

    await turn({ deniedTools: [...deny] });

    expect(offered[0]).toEqual(without(ALL_BUILD, ...removed));
    // The question tool is never taken away.
    expect(offered[0]).toContain("AskUserQuestion");
  });

  test("a denied group not found on pi (web) changes nothing", async () => {
    const { offered, steps } = recording(1);
    const { turn } = await setup(steps);

    await turn({ deniedTools: ["web"] });

    expect(offered[0]).toEqual(ALL_BUILD);
  });

  test("a model that calls a denied tool gets an error: nothing runs and nothing is asked", async () => {
    const { turn } = await setup([bashCall(), fauxAssistantMessage([fauxText("ok")])]);

    const { asks, tools } = await turn({ deniedTools: ["bash"] });

    expect(asks).toEqual([]);
    expect(existsSync(made())).toBe(false);
    expect(tools.map((tool) => [tool.toolName, tool.state])).toEqual([["bash", "error"]]);
  });

  test("the tools that are left still ask", async () => {
    const { turn } = await setup([toolCall("write", { path: made(), content: "x" }), fauxAssistantMessage([fauxText("ok")])]);

    const { asks } = await turn({ deniedTools: ["bash"] });

    expect(asks.map((ask) => ask.toolName)).toEqual(["write"]);
  });

  test("a build agent with `bash: false` cannot run bash even when the user would allow it [invariant]", async () => {
    const { turn } = await setup([bashCall(), fauxAssistantMessage([fauxText("ok")])]);

    await turn({ mode: Mode.BUILD, deniedTools: ["bash"] });

    expect(existsSync(made())).toBe(false);
  });

  test("an MCP-style tool (mcp__server__tool) is offered, and taken away by the mcp group", async () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "mcp-like.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: "mcp__srv__tool", label: "m", description: "m", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "ran" }] }; } });
}
`,
    );
    const first = recording(1);
    const second = recording(1);
    const { turn } = await setup([...first.steps, ...second.steps]);

    await turn();
    await turn({ deniedTools: ["mcp"] });

    expect(first.offered[0]).toContain("mcp__srv__tool");
    expect(second.offered[0]).not.toContain("mcp__srv__tool");
    expect(second.offered[0]).toEqual(without(first.offered[0]!, "mcp__srv__tool"));
  });
});

describe("pi plan turns with denied tool groups", () => {
  test("plan mode offers the read-only tools, the question tool and Task; a denied group only narrows that", async () => {
    const plain = recording(1);
    const narrowed = recording(1);
    const { turn } = await setup([...plain.steps, ...narrowed.steps]);

    await turn({ mode: Mode.PLAN });
    await turn({ mode: Mode.PLAN, deniedTools: ["read", "task"] });

    expect(plain.offered[0]).toEqual(["AskUserQuestion", "Task", "find", "grep", "ls", "read"]);
    expect(narrowed.offered[0]).toEqual(["AskUserQuestion"]);
  });

  test("a read-only agent whose `tools` lists bash (so no denial reaches the engine) still cannot run bash [invariant]", async () => {
    const { turn } = await setup([bashCall(), fauxAssistantMessage([fauxText("ok")])]);

    const { asks, tools } = await turn({ mode: Mode.PLAN });

    expect(asks).toEqual([]);
    expect(existsSync(made())).toBe(false);
    expect(tools.map((tool) => tool.state)).toEqual(["error"]);
  });

  test("a read-only agent with denied tools cannot call them either", async () => {
    writeFileSync(join(cwd, "notes.txt"), "secret");
    const { turn } = await setup([toolCall("read", { path: join(cwd, "notes.txt") }), fauxAssistantMessage([fauxText("ok")])]);

    const { tools } = await turn({ mode: Mode.PLAN, deniedTools: ["read"] });

    expect(tools.map((tool) => [tool.toolName, tool.state])).toEqual([["read", "error"]]);
  });
});

describe("pi resumed sessions with denied tool groups", () => {
  test("the narrowing is kept turn after turn, and lifted when the next agent has none", async () => {
    const one = recording(1);
    const two = recording(1);
    const three = recording(1);
    const four = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps, ...three.steps, ...four.steps]);

    const first = await turn({ deniedTools: ["bash"] });
    const second = await turn({ deniedTools: ["bash"], resumeRef: first.ref });
    const third = await turn({ resumeRef: second.ref });
    await turn({ deniedTools: ["edit"], resumeRef: third.ref });

    expect(one.offered[0]).toEqual(without(ALL_BUILD, "bash"));
    expect(second.errors).toEqual([]);
    expect(two.offered[0]).toEqual(without(ALL_BUILD, "bash"));
    // Another agent without a restriction gets the tools back: the narrowing was the last agent's, not the conversation's.
    expect(three.offered[0]).toEqual(ALL_BUILD);
    expect(four.offered[0]).toEqual(without(ALL_BUILD, "edit", "write"));
  });

  test("an unrestricted turn narrows on resume when the next agent denies tools", async () => {
    const one = recording(1);
    const two = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps]);

    const first = await turn();
    await turn({ deniedTools: ["read", "bash"], resumeRef: first.ref });

    expect(one.offered[0]).toEqual(ALL_BUILD);
    expect(two.offered[0]).toEqual(without(ALL_BUILD, "bash", "find", "grep", "ls", "read"));
  });

  test("a plan turn then a narrowed build turn: build tools come back, minus the denied ones", async () => {
    const one = recording(1);
    const two = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps]);

    const plan = await turn({ mode: Mode.PLAN });
    await turn({ deniedTools: ["bash"], resumeRef: plan.ref });

    expect(two.offered[0]).toEqual(without(ALL_BUILD, "bash"));
  });
});

describe("pi Task subagents with denied tool groups", () => {
  const taskCall = () => toolCall(TASK_TOOL, { description: "Look around", prompt: "go" }, "task-1");

  test("the child of a narrowed build turn has the same narrowing", async () => {
    const kid: string[][] = [];
    const childStep: FauxResponseStep = (context) => {
      kid.push(names(context.messages));
      return fauxAssistantMessage([fauxText("child answer")]);
    };
    const { turn } = await setup([taskCall(), childStep, fauxAssistantMessage([fauxText("ok")])]);

    const { errors } = await turn({ deniedTools: ["bash", "edit"] });

    expect(errors).toEqual([]);
    expect(kid[0]).toEqual(["find", "grep", "ls", "read"]);
  });

  test("the child of a plan turn has the read-only tools minus the denied ones", async () => {
    const kid: string[][] = [];
    const childStep: FauxResponseStep = (context) => {
      kid.push(names(context.messages));
      return fauxAssistantMessage([fauxText("child answer")]);
    };
    const { turn } = await setup([taskCall(), childStep, fauxAssistantMessage([fauxText("ok")])]);

    await turn({ mode: Mode.PLAN, deniedTools: ["bash", "web"] });
    expect(kid[0]).toEqual(["find", "grep", "ls", "read"]);
  });

  test("a child whose parent has no denial keeps pi's default tools", async () => {
    const kid: string[][] = [];
    const childStep: FauxResponseStep = (context) => {
      kid.push(names(context.messages));
      return fauxAssistantMessage([fauxText("child answer")]);
    };
    const { turn } = await setup([taskCall(), childStep, fauxAssistantMessage([fauxText("ok")])]);

    await turn();

    expect(kid[0]).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
  });
});

describe("createDeniedToolsExtension", () => {
  // The handlers the extension registers, run against a stand-in for pi's extension API.
  function load(denied: Parameters<typeof createDeniedToolsExtension>[0], active: string[]) {
    const handlers = new Map<string, (event: any) => any>();
    let current = [...active];
    createDeniedToolsExtension(denied)({
      on: (event: string, handler: (event: any) => any) => void handlers.set(event, handler),
      getActiveTools: () => current,
      setActiveTools: (next: string[]) => void (current = [...next]),
    } as any);
    return { handlers, active: () => current };
  }

  test("a call to a denied tool is blocked with the reason, and any other call passes", () => {
    const { handlers } = load(["bash"], []);

    expect(handlers.get("tool_call")!({ toolName: "bash", input: {} })).toEqual({ block: true, reason: "bash is not available to this agent" });
    expect(handlers.get("tool_call")!({ toolName: "powershell", input: {} })).toEqual({ block: true, reason: "powershell is not available to this agent" });
    expect(handlers.get("tool_call")!({ toolName: "read", input: {} })).toBeUndefined();
    expect(handlers.get("tool_call")!({ toolName: "AskUserQuestion", input: {} })).toBeUndefined();
  });

  test("the active tools are narrowed before the agent starts and on every turn", () => {
    const { handlers, active } = load(["bash", "mcp"], ["read", "bash", "mcp__a__b", "write"]);

    handlers.get("before_agent_start")!({});
    expect(active()).toEqual(["read", "write"]);

    // A tool registered later is activated by pi, and removed again at the next turn.
    handlers.get("turn_start")!({});
    expect(active()).toEqual(["read", "write"]);
  });

  test("the request's declared tools are filtered to the active ones", () => {
    const { handlers } = load(["bash"], ["read"]);
    const declared = [{ name: "read" }, { name: "bash" }];

    const result = handlers.get("context_with_system")!({ messages: [{ role: "system", toolsAdded: declared }, { role: "user", content: "hi" }] });

    expect(result.messages[0].toolsAdded).toEqual([{ name: "read" }]);
    expect(result.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("marcsh's Task is named Task for the group mapping (TASK_TOOL)", () => {
    expect(TASK_TOOL).toBe("Task");
  });
});
