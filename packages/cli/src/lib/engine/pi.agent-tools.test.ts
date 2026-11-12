import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
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

describe("one agent's narrowing never reaches the next agent's resumed turn [S15 regression]", () => {
  test("Task comes back for an unrestricted build turn after a resumed `task: false` turn", async () => {
    const one = recording(1);
    const two = recording(1);
    const three = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps, ...three.steps]);

    const first = await turn();
    const second = await turn({ deniedTools: ["task"], resumeRef: first.ref });
    await turn({ resumeRef: second.ref });

    expect(two.offered[0]).toEqual(without(ALL_BUILD, "Task"));
    expect(three.offered[0]).toEqual(ALL_BUILD);
  });

  test("an extension tool comes back for an unrestricted build turn after a resumed `mcp: false` turn", async () => {
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
    const one = recording(1);
    const two = recording(1);
    const three = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps, ...three.steps]);

    const first = await turn();
    const second = await turn({ deniedTools: ["mcp"], resumeRef: first.ref });
    await turn({ resumeRef: second.ref });

    expect(two.offered[0]).not.toContain("mcp__srv__tool");
    expect(three.offered[0]).toEqual(one.offered[0]!);
  });

  test("a narrowing that continues is not lifted, and a different one lifts the old and applies the new", async () => {
    const one = recording(1);
    const two = recording(1);
    const three = recording(1);
    const four = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps, ...three.steps, ...four.steps]);

    const first = await turn({ deniedTools: ["task"] });
    const second = await turn({ deniedTools: ["task"], resumeRef: first.ref });
    const third = await turn({ deniedTools: ["bash"], resumeRef: second.ref });
    await turn({ resumeRef: third.ref });

    expect(two.offered[0]).toEqual(without(ALL_BUILD, "Task"));
    expect(three.offered[0]).toEqual(without(ALL_BUILD, "bash"));
    expect(four.offered[0]).toEqual(ALL_BUILD);
  });

  test("an agent without `tools` resumes with the tools pi restored, as before S15 (a loadout without write is kept)", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));
    const one = recording(1);
    const two = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps]);

    const first = await turn();
    rmSync(join(agentDir, "settings.json"));
    await turn({ resumeRef: first.ref });

    // The same list as on 28474e7 (the baseline): no narrowing of marcsh's was recorded, so none is undone.
    expect(two.offered[0]).toEqual(["AskUserQuestion", "Task", "bash", "find", "grep", "ls", "read"]);
  });

  test("a lifted narrowing does not bring back a tool a user extension turns off", async () => {
    const one = recording(1);
    const { turn } = await setup([...one.steps, toolCall("write", { path: made(), content: "x" }), fauxAssistantMessage([fauxText("ok")])]);
    const first = await turn({ deniedTools: ["edit"] });
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "no-write.ts"),
      `export default function (pi) { pi.on("session_start", () => { pi.setActiveTools(pi.getActiveTools().filter((n) => n !== "write")); }); }\n`,
    );
    const { tools } = await turn({ resumeRef: first.ref });
    expect(existsSync(made())).toBe(false);
    expect(tools.map((t) => [t.toolName, t.state])).toEqual([["write", "error"]]);
  });

  // The record is the session file's, so a user (or a bug) can write anything in it: only tools a fresh unrestricted session offers come back.
  const forge = (ref: string | undefined, data: { denied: string[]; removed: string[] }) => SessionManager.open(ref!).appendCustomEntry("marcsh-agent-tools", data);

  test("a recorded name outside the user's `defaultTools` does not come back (write and edit under read, bash)", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));
    const one = recording(1);
    const two = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps]);

    const first = await turn();
    forge(first.ref, { denied: ["edit"], removed: ["write", "edit"] });
    await turn({ resumeRef: first.ref });

    expect(one.offered[0]).toEqual(["AskUserQuestion", "Task", "bash", "read"]);
    expect(two.offered[0]).toEqual(one.offered[0]!);
  });

  test("a recorded `bash` never reaches an agent that denies bash, nor a session whose `defaultTools` has no bash", async () => {
    const one = recording(1);
    const two = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps]);
    const first = await turn();
    forge(first.ref, { denied: ["read"], removed: ["bash"] });
    await turn({ deniedTools: ["bash"], resumeRef: first.ref });
    expect(two.offered[0]).toEqual(without(ALL_BUILD, "bash"));

    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
    const three = recording(2);
    const narrowed = await setup(three.steps);
    const second = await narrowed.turn();
    forge(second.ref, { denied: ["bash"], removed: ["bash"] });
    await narrowed.turn({ deniedTools: ["edit"], resumeRef: second.ref });
    expect(three.offered[1]).toEqual(["AskUserQuestion", "Task", "read"]);
  });

  test("a recorded name never activates an extension tool that is not active by default", async () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "opt-in.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: "optin_tool", label: "o", description: "o", parameters: Type.Object({}), defaultActive: false,
    async execute() { return { content: [{ type: "text", text: "ran" }] }; } });
}
`,
    );
    const one = recording(1);
    const two = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps]);

    const first = await turn();
    forge(first.ref, { denied: ["edit"], removed: ["optin_tool"] });
    await turn({ resumeRef: first.ref });

    expect(one.offered[0]).not.toContain("optin_tool");
    expect(two.offered[0]).toEqual(one.offered[0]!);
  });
});

describe("pi's MCP resource tools leave with the mcp group [S15 regression]", () => {
  test("a server with resources: `mcp: false` offers none of its tools and its resources cannot be read", async () => {
    const readMarker = join(dir, "resource-read");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-resource-server.ts", import.meta.url)), readMarker] } } }),
    );
    const offered: string[][] = [];
    const { turn } = await setup([
      (context) => {
        offered.push(names(context.messages));
        return toolCall("read_mcp_resource", { server: "fx", uri: "file:///secret" });
      },
      fauxAssistantMessage([fauxText("ok")]),
    ]);

    const { asks } = await turn({ deniedTools: ["mcp"] });

    expect(offered[0]!.filter((name) => name.startsWith("mcp__") || name.includes("mcp_resource"))).toEqual([]);
    expect(asks).toEqual([]);
    expect(existsSync(readMarker)).toBe(false);
  });

  test("marcsh's MCP tools come back for an unrestricted build turn after a resumed `mcp: false` turn", async () => {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-resource-server.ts", import.meta.url))] } } }),
    );
    const one = recording(1);
    const two = recording(1);
    const three = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps, ...three.steps]);

    const first = await turn();
    const second = await turn({ deniedTools: ["mcp"], resumeRef: first.ref });
    await turn({ resumeRef: second.ref });

    expect(one.offered[0]).toContain("mcp__fx__echo");
    expect(two.offered[0]!.filter((name) => name.startsWith("mcp__"))).toEqual([]);
    expect(three.offered[0]).toEqual(one.offered[0]!);
  });

  test("an extension tool named like a denied group (`Bash`, `shell`) is removed and blocked with it", async () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "shells.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  for (const name of ["Bash", "shell"]) pi.registerTool({ name, label: name, description: name, parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "ran" }] }; } });
}
`,
    );
    const one = recording(1);
    const two = recording(1);
    const { turn } = await setup([...one.steps, ...two.steps]);

    await turn();
    await turn({ deniedTools: ["bash"] });

    expect(one.offered[0]).toEqual(expect.arrayContaining(["Bash", "shell"]));
    expect(two.offered[0]).not.toContain("Bash");
    expect(two.offered[0]).not.toContain("shell");
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

  test("tools to restore come back when they register, and what is removed is reported [S15 regression]", () => {
    const handlers = new Map<string, (event: any) => any>();
    let active = ["read", "bash"];
    let registered = ["read", "bash"];
    const removed: string[] = [];
    const source = (name: string) => ({ name, sourceInfo: { path: name.startsWith("mcp__") ? "<inline:marcsh-mcp>" : "<extension>" } });
    createDeniedToolsExtension(["bash"], { restore: ["mcp__late__tool", "mcp__user__tool"], onRemoved: (names) => removed.push(...names) })({
      on: (event: string, handler: (event: any) => any) => void handlers.set(event, handler),
      getActiveTools: () => active,
      setActiveTools: (next: string[]) => void (active = [...next]),
      getAllTools: () => registered.map(source),
    } as any);

    handlers.get("before_agent_start")!({});
    expect(active).toEqual(["read"]);
    expect(removed).toEqual(["bash"]);

    // The MCP tool registers (and pi activates it) later in the turn.
    registered = [...registered, "mcp__late__tool"];
    active = [...active, "mcp__late__tool"];
    handlers.get("turn_start")!({});
    expect(active).toEqual(["read", "mcp__late__tool"]);
  });

  test("only a tool marcsh's MCP extension registered comes back late, never another extension's tool of the same name", () => {
    const handlers = new Map<string, (event: any) => any>();
    let active = ["read"];
    createDeniedToolsExtension([], { restore: ["mcp__user__tool", "optin"] })({
      on: (event: string, handler: (event: any) => any) => void handlers.set(event, handler),
      getActiveTools: () => active,
      setActiveTools: (next: string[]) => void (active = [...next]),
      getAllTools: () => ["read", "mcp__user__tool", "optin"].map((name) => ({ name, sourceInfo: { path: "/home/u/ext.ts" } })),
    } as any);

    handlers.get("before_agent_start")!({});

    expect(active).toEqual(["read"]);
  });

  test("marcsh's Task is named Task for the group mapping (TASK_TOOL)", () => {
    expect(TASK_TOOL).toBe("Task");
  });
});
