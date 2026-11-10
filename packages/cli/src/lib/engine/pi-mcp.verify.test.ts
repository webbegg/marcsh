// S14 verifier probes: user extensions and MCP on pi (faux provider, no network).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import type { ChatMessage } from "../chat-types";
import { Mode } from "../modes";
import { openStorage, type Storage } from "../storage";
import { createPiEngine } from "./pi";
import type { EngineEvent, PermissionAsk, PermissionDecision, TurnHost, TurnRequest } from "./types";

let dir: string, agentDir: string, cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-s14-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
});
afterEach(() => {
  for (const pid of pids()) try { process.kill(pid, "SIGKILL"); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

// stdio MCP server: newline JSON-RPC, tool `echo`; logs its pid at start and its calls.
const SERVER = `import { appendFileSync } from "node:fs";
const [callsPath, pidsPath] = process.argv.slice(2);
appendFileSync(pidsPath, process.pid + "\\n");
let buffer = "";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
function handle(r) {
  if (r.id === undefined) return;
  if (r.method === "initialize") { setTimeout(() => send({ method: "notifications/message", params: { level: "info", data: "fixture log line" } }), 50); return send({ id: r.id, result: { protocolVersion: r.params.protocolVersion, capabilities: { tools: {}, logging: {} }, serverInfo: { name: "fx", version: "1" } } }); }
  if (r.method === "tools/list") return send({ id: r.id, result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  if (r.method === "tools/call") { appendFileSync(callsPath, JSON.stringify(r.params.arguments) + "\\n"); return send({ id: r.id, result: { content: [{ type: "text", text: "echo: " + r.params.arguments.text }] } }); }
  return send({ id: r.id, result: {} });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buffer += c; for (let e = buffer.indexOf("\\n"); e >= 0; e = buffer.indexOf("\\n")) { const l = buffer.slice(0, e); buffer = buffer.slice(e + 1); if (l.trim()) handle(JSON.parse(l)); } });
`;
const callsFile = () => join(dir, "calls.log");
const pidsFile = () => join(dir, "pids.log");
function serverConfig(name = "fx", extra: Record<string, unknown> = { exposure: "direct" }) {
  const script = join(dir, "server.ts");
  writeFileSync(script, SERVER);
  return { mcpServers: { [name]: { command: process.execPath, args: [script, callsFile(), pidsFile()], ...extra } } };
}
function writeConfig(path: string, config: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config));
}
const pids = () => (existsSync(pidsFile()) ? readFileSync(pidsFile(), "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const callsMade = () => (existsSync(callsFile()) ? readFileSync(callsFile(), "utf8").trim().split("\n").filter(Boolean) : []);
const offered = (messages: Message[]) => messages.flatMap((m: any) => (m.role === "system" ? (m.toolsAdded ?? []).map((t: any) => t.name) : []));
const call = (name: string, args: Record<string, any>, id = "c1") => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const done = () => fauxAssistantMessage([fauxText("done")]);
const TOOL = "mcp__fx__echo";

async function setup(responses: FauxResponseStep[], rules: Storage = openStorage(":memory:")) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  return { engine: createPiEngine({ agentDir, modelRuntime, permissionRules: rules, pluginPath: null, projectTrust: { getProjectTrust: () => "trusted", setProjectTrust: () => {} } }), faux, rules };
}
function start(engine: any, req: Partial<TurnRequest>, ask: (a: PermissionAsk) => Promise<PermissionDecision> | PermissionDecision) {
  const events: EngineEvent[] = [];
  const asks: PermissionAsk[] = [];
  const notes: string[] = [];
  const controller = new AbortController();
  const host = {
    emit: (e: EngineEvent) => events.push(e),
    askPermission: (a: PermissionAsk, s: AbortSignal) => {
      asks.push(structuredClone(a));
      return new Promise<PermissionDecision>((resolve) => {
        s.addEventListener("abort", () => resolve("deny"), { once: true });
        Promise.resolve(ask(a)).then(resolve);
      });
    },
    askQuestions: async () => null,
    notify: (m: string) => notes.push(m),
  } as unknown as TurnHost;
  const turn = engine.startTurn({ prompt: "go", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: controller.signal, ...req }, host);
  const result = async () => {
    await turn.done;
    let reply: ChatMessage = { id: "r", role: "assistant", parts: [] };
    for (const e of events) if (e.type === "reply") reply = e.update(reply);
    return { events, asks, notes, reply, errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])) };
  };
  return { turn, controller, result, asks };
}
const run = (engine: any, req: Partial<TurnRequest>, d: PermissionDecision) => start(engine, req, () => d).result();
const tools = (r: ChatMessage) => r.parts.flatMap((p: any) => (p.type === "tool" ? [p] : []));
const recorder = (into: string[][], next: FauxResponseStep): FauxResponseStep => (ctx: any, ...rest: any[]) => {
  into.push(offered(ctx.messages));
  return typeof next === "function" ? (next as any)(ctx, ...rest) : next;
};

describe("S14 user extensions", () => {
  const ext = (marker: string) => `export default function (pi) { pi.registerTool({ name: "fx_tool", label: "f", description: "f", parameters: { type: "object", properties: {} }, async execute() { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); return { content: [{ type: "text", text: "ran" }] }; } }); }\n`;
  for (const [label, base] of [["agentDir", () => agentDir], ["project .pi", () => join(cwd, ".pi")]] as const) {
    test(`${label}/extensions: loads, asks, deny blocks, allow runs, plan blocks with always rule`, async () => {
      const marker = join(dir, "ext-ran");
      mkdirSync(join(base(), "extensions"), { recursive: true });
      writeFileSync(join(base(), "extensions", "fx.ts"), ext(marker));
      const seen: string[][] = [];
      let { engine } = await setup([recorder(seen, call("fx_tool", {})), done()]);
      let r = await run(engine, {}, "deny");
      expect(seen[0]).toContain("fx_tool");
      expect(r.asks.map((a) => a.toolName)).toEqual(["fx_tool"]);
      expect(existsSync(marker)).toBe(false);
      ({ engine } = await setup([call("fx_tool", {}), done()]));
      r = await run(engine, {}, "allow");
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      const rules = openStorage(":memory:");
      rules.addPermissionRule({ cwd, toolName: "fx_tool" });
      const seenPlan: string[][] = [];
      ({ engine } = await setup([recorder(seenPlan, call("fx_tool", {})), done()], rules));
      r = await run(engine, { mode: Mode.PLAN }, "allow");
      expect(seenPlan[0]).not.toContain("fx_tool");
      expect(r.asks).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    });
  }
});

describe("S14 MCP config locations", () => {
  test("agentDir/mcp.json and project .pi/mcp.json load; ~/.pi/agent/mcp.json and a decoy PI_CODING_AGENT_DIR do not", async () => {
    // Bun caches the real HOME: only write ~/.pi when the run's home is a throwaway temp dir.
    const home = homedir();
    const isolatedHome = home.startsWith(tmpdir()) || home.startsWith(realpathSync(tmpdir()));
    const decoy = join(dir, "decoy");
    if (isolatedHome) writeConfig(join(home, ".pi", "agent", "mcp.json"), serverConfig("homepi"));
    writeConfig(join(decoy, "mcp.json"), serverConfig("decoy"));
    writeConfig(join(agentDir, "mcp.json"), serverConfig("agentcfg"));
    writeConfig(join(cwd, ".pi", "mcp.json"), serverConfig("projcfg"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = decoy;
    try {
      const seen: string[][] = [];
      const { engine } = await setup([recorder(seen, done())]);
      await run(engine, {}, "deny");
      expect(seen[0]!.filter((n) => n.startsWith("mcp__")).sort()).toEqual(["mcp__agentcfg__echo", "mcp__projcfg__echo"]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      if (isolatedHome) rmSync(join(home, ".pi"), { recursive: true, force: true });
    }
  }, 30000);

  test("mcp.log is written under the agent dir, not ~/.pi/agent", async () => {
    const homeLog = join(homedir(), ".pi", "agent", "mcp.log");
    const before = existsSync(homeLog) ? statSync(homeLog).mtimeMs : null;
    writeConfig(join(agentDir, "mcp.json"), serverConfig());
    const { engine } = await setup([call(TOOL, { text: "x" }), async () => { await Bun.sleep(300); return done(); }]);
    await run(engine, {}, "allow");
    expect(readFileSync(join(agentDir, "mcp.log"), "utf8")).toContain("fixture log line");
    expect(existsSync(homeLog) ? statSync(homeLog).mtimeMs : null).toBe(before);
  }, 30000);
});

describe("S14 MCP approval", () => {
  beforeEach(() => writeConfig(join(agentDir, "mcp.json"), serverConfig()));
  test("ask with input; deny never calls the server; allow does", async () => {
    let { engine } = await setup([call(TOOL, { text: "a" }), done()]);
    let r = await run(engine, {}, "deny");
    expect(r.asks).toEqual([{ toolName: TOOL, input: { text: "a" } }]);
    expect(callsMade()).toEqual([]);
    ({ engine } = await setup([call(TOOL, { text: "b" }), done()]));
    r = await run(engine, {}, "allow");
    expect(callsMade()).toEqual([JSON.stringify({ text: "b" })]);
  }, 30000);

  test("plan mode with an always rule: not offered, not called, no ask", async () => {
    const rules = openStorage(":memory:");
    rules.addPermissionRule({ cwd, toolName: TOOL });
    const seen: string[][] = [];
    const { engine } = await setup([recorder(seen, call(TOOL, { text: "p" })), done()], rules);
    const r = await run(engine, { mode: Mode.PLAN }, "allow");
    expect(seen[0]).not.toContain(TOOL);
    expect(r.asks).toEqual([]);
    expect(callsMade()).toEqual([]);
    expect(tools(r.reply)[0]?.state).toBe("error");
  }, 30000);

  test("marcsh's approval stays the last tool_call handler: an extension rewriting the input is seen in the ask", async () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(join(agentDir, "extensions", "rewrite.ts"), `export default function (pi) { pi.on("tool_call", (e) => { if (e.toolName === ${JSON.stringify(TOOL)}) e.input.text = "rewritten"; }); }\n`);
    const { engine } = await setup([call(TOOL, { text: "orig" }), done()]);
    const r = await run(engine, {}, "allow");
    console.log("ORDER asks", JSON.stringify(r.asks), callsMade());
    expect(r.asks[0]?.input).toEqual({ text: "rewritten" });
    expect(callsMade()).toEqual([JSON.stringify({ text: "rewritten" })]);
  }, 30000);
});

describe("S14 MCP processes", () => {
  beforeEach(() => writeConfig(join(agentDir, "mcp.json"), serverConfig()));
  test("warm-up starts no server", async () => {
    const { engine } = await setup([]);
    await engine.warmUpCommands({ cwd, save: () => {} });
    await Bun.sleep(500);
    expect(pids()).toEqual([]);
  }, 30000);

  test("after each finished turn the server process is gone", async () => {
    const { engine } = await setup([call(TOOL, { text: "1" }), done(), call(TOOL, { text: "2" }), done(), done()]);
    await run(engine, {}, "allow");
    await Bun.sleep(1000);
    const afterOne = pids().filter(alive);
    await run(engine, {}, "allow");
    await run(engine, {}, "allow");
    await Bun.sleep(1000);
    console.log("PROC started", pids(), "alive after 1 turn", afterOne, "alive after 3 turns", pids().filter(alive));
    expect(pids()).toHaveLength(3);
    expect(pids().filter(alive)).toEqual([]);
  }, 30000);

  test("after an interrupted turn the server process is gone", async () => {
    const { engine } = await setup([call(TOOL, { text: "1" }), done()]);
    const s = start(engine, {}, () => new Promise(() => {}));
    const end = Date.now() + 10000;
    while (s.asks.length === 0 && Date.now() < end) await Bun.sleep(20);
    s.turn.interrupt();
    await s.result();
    await Bun.sleep(1000);
    console.log("PROC interrupt started", pids(), "alive", pids().filter(alive));
    expect(pids().filter(alive)).toEqual([]);
  }, 30000);
});

describe("S14 MCP and process exit", () => {
  // marcsh quits with renderer.destroy() and lets the event loop drain: an open MCP connection must not keep it alive.
  test("a process that ran a pi turn with an MCP server drains and exits on its own", async () => {
    writeConfig(join(agentDir, "mcp.json"), serverConfig());
    const script = join(dir, "turn-then-drain.ts");
    writeFileSync(script, `
import { ModelRuntime } from ${JSON.stringify(Bun.resolveSync("@earendil-works/pi-coding-agent", import.meta.dir))};
import { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore } from ${JSON.stringify(Bun.resolveSync("@earendil-works/pi-ai", import.meta.dir))};
import { openStorage } from ${JSON.stringify(join(import.meta.dir, "../storage"))};
import { createPiEngine } from ${JSON.stringify(join(import.meta.dir, "pi"))};
const faux = fauxProvider({ models: [{ id: "faux-1" }] });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
modelRuntime.registerNativeProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
const engine = createPiEngine({ agentDir: ${JSON.stringify(agentDir)}, modelRuntime, permissionRules: openStorage(":memory:"), pluginPath: null, projectTrust: { getProjectTrust: () => "trusted", setProjectTrust: () => {} } });
await engine.startTurn({ prompt: "go", cwd: ${JSON.stringify(cwd)}, mode: "BUILD", model: "faux/faux-1", signal: new AbortController().signal }, { emit() {}, askPermission: async () => "allow", askQuestions: async () => null }).done;
console.log("turn done");
`);
    const child = Bun.spawn([process.execPath, script], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10000).then(() => false)]);
    if (!exited) child.kill("SIGKILL");
    console.log("DRAIN exited", exited, "out", await new Response(child.stdout).text(), "err", (await new Response(child.stderr).text()).slice(0, 400), "servers", pids(), "alive", pids().filter(alive));
    expect(pids()).toHaveLength(1);
    expect(exited).toBe(true);
  }, 30000);
});

describe("S14 exposure default", () => {
  // marcsh adds neither codemode nor tool_search, so a server with no `exposure` is exposed `direct` (pi's own default, codemode, is unreachable here).
  test("a Claude-style mcp.json (no exposure) exposes the tools directly: asks, and runs on allow", async () => {
    writeConfig(join(agentDir, "mcp.json"), serverConfig("fx", {}));
    const seen: string[][] = [];
    const { engine } = await setup([recorder(seen, call(TOOL, { text: "c" })), done()]);
    const r = await run(engine, {}, "allow");
    expect(seen[0]).toContain(TOOL);
    expect(r.asks).toEqual([{ toolName: TOOL, input: { text: "c" } }]);
    expect(r.notes.join("\n")).not.toContain("they cannot be called");
    expect(callsMade()).toEqual([JSON.stringify({ text: "c" })]);
  }, 30000);

  test("an explicit codemode exposure is respected: not offered, one notice, never called", async () => {
    writeConfig(join(agentDir, "mcp.json"), serverConfig("fx", { exposure: "codemode" }));
    const seen: string[][] = [];
    const { engine } = await setup([recorder(seen, call(TOOL, { text: "c" })), done()]);
    const r = await run(engine, {}, "allow");
    expect(seen[0]).not.toContain(TOOL);
    expect(r.notes.filter((note) => note.includes("they cannot be called"))).toHaveLength(1);
    expect(callsMade()).toEqual([]);
  }, 30000);
});
