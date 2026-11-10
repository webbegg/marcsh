// S14 recheck probes (a2864a5): MCP shutdown and direct exposure default (faux provider, no network).
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
  dir = mkdtempSync(join(tmpdir(), "recheck-s14-"));
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
const waitFor = async (cond: () => boolean, ms = 10000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(20); return cond(); };
const ext = (name: string, src: string, base = agentDir) => { mkdirSync(join(base, "extensions"), { recursive: true }); writeFileSync(join(base, "extensions", name), src); };

describe("R shutdown paths (no exposure in config)", () => {
  beforeEach(() => writeConfig(join(agentDir, "mcp.json"), serverConfig("fx", {})));

  test("R1 request signal aborted while the MCP call waits for approval: server gone", async () => {
    const { engine } = await setup([call(TOOL, { text: "1" }), done()]);
    const s = start(engine, {}, () => new Promise(() => {}));
    expect(await waitFor(() => s.asks.length > 0)).toBe(true);
    const t0 = Date.now();
    s.controller.abort();
    await s.result();
    const took = Date.now() - t0;
    await Bun.sleep(800);
    console.log("R1 took", took, "pids", pids(), "alive", pids().filter(alive));
    expect(took).toBeLessThan(3000);
    expect(pids()).toHaveLength(1);
    expect(pids().filter(alive)).toEqual([]);
    expect(callsMade()).toEqual([]);
  }, 30000);

  test("R2 interrupt right after start (servers still connecting): no server survives", async () => {
    const { engine } = await setup([async () => { await Bun.sleep(2000); return done(); }]);
    const s = start(engine, {}, () => "allow");
    // wait until the server process exists, then interrupt immediately
    await waitFor(() => pids().length > 0);
    s.turn.interrupt();
    await s.result();
    await Bun.sleep(1500);
    console.log("R2 pids", pids(), "alive", pids().filter(alive));
    expect(pids().filter(alive)).toEqual([]);
  }, 30000);

  test("R2b interrupt at 0 ms and pre-aborted signal: no server survives", async () => {
    for (const how of ["now", "pre"] as const) {
      const { engine } = await setup([done(), done()]);
      const controller = new AbortController();
      if (how === "pre") controller.abort();
      const host = { emit() {}, askPermission: async () => "allow", askQuestions: async () => null, notify() {} } as unknown as TurnHost;
      const turn = engine.startTurn({ prompt: "go", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: controller.signal }, host);
      if (how === "now") turn.interrupt();
      await turn.done;
    }
    await Bun.sleep(1500);
    console.log("R2b pids", pids(), "alive", pids().filter(alive));
    expect(pids().filter(alive)).toEqual([]);
  }, 30000);

  test("R3 turn with a Task subagent: one server (child has no MCP), gone after the turn", async () => {
    const { engine } = await setup([call("Task", { description: "d", prompt: "p" }), fauxAssistantMessage([fauxText("child done")]), done()]);
    const r = await run(engine, {}, "allow");
    await Bun.sleep(800);
    console.log("R3 tools", JSON.stringify(tools(r.reply).map((t: any) => [t.name ?? t.toolName, t.state])), "errors", r.errors, "pids", pids(), "alive", pids().filter(alive));
    expect(r.errors).toEqual([]);
    expect(pids()).toHaveLength(1);
    expect(pids().filter(alive)).toEqual([]);
  }, 30000);

  // Known gap (feature doc L22, advisory A1): pi runs session_shutdown handlers in order and user extensions come
  // before marcsh's MCP extension, so a handler that never resolves keeps the server open. Fails until that is fixed.
  test.failing("R4 hung user-extension session_shutdown: turn ends within the bound and the MCP server still closes", async () => {
    ext("hung.ts", `export default function (pi) { pi.on("session_shutdown", () => new Promise(() => {})); }\n`);
    const { engine } = await setup([done()]);
    const s = start(engine, {}, () => "allow");
    await waitFor(() => pids().length > 0);
    const t0 = Date.now();
    await s.result();
    const took = Date.now() - t0;
    await Bun.sleep(1500);
    console.log("R4 turn end after", took, "ms; alive servers", pids().filter(alive));
    expect(took).toBeLessThan(4500);
    expect(pids().filter(alive)).toEqual([]);
  }, 30000);

  test("R4b slow (1.5 s) user-extension shutdown: server still closes", async () => {
    ext("slow.ts", `export default function (pi) { pi.on("session_shutdown", () => new Promise((r) => setTimeout(r, 1500))); }\n`);
    const { engine } = await setup([done()]);
    const t0 = Date.now();
    await run(engine, {}, "allow");
    const took = Date.now() - t0;
    await Bun.sleep(1500);
    console.log("R4b took", took, "alive", pids().filter(alive));
    expect(pids().filter(alive)).toEqual([]);
  }, 30000);

  test("R5 throwing user-extension shutdown: server still closes", async () => {
    ext("throw.ts", `export default function (pi) { pi.on("session_shutdown", () => { throw new Error("boom-shutdown"); }); }\n`);
    const { engine } = await setup([done()]);
    const r = await run(engine, {}, "allow");
    await Bun.sleep(1000);
    console.log("R5 notes", JSON.stringify(r.notes), "alive", pids().filter(alive));
    expect(pids().filter(alive)).toEqual([]);
  }, 30000);
});

describe("R warm-up", () => {
  test("R6 warm-up with MCP config starts no server", async () => {
    writeConfig(join(agentDir, "mcp.json"), serverConfig("fx", {}));
    const marker = join(dir, "shutdown-called");
    ext("mark.ts", `export default function (pi) { pi.on("session_start", () => require("node:fs").appendFileSync(${JSON.stringify(marker)}, "start\\n")); pi.on("session_shutdown", () => require("node:fs").appendFileSync(${JSON.stringify(marker)}, "shutdown\\n")); }\n`);
    const { engine } = await setup([]);
    let saved: unknown;
    await engine.warmUpCommands({ cwd, save: (c: unknown) => (saved = c) });
    await Bun.sleep(800);
    console.log("R6 pids", pids(), "marker", existsSync(marker) ? JSON.stringify(readFileSync(marker, "utf8")) : "none", "saved", Array.isArray(saved) ? (saved as any[]).length : saved);
    expect(pids()).toEqual([]);
  }, 30000);

  test("R6b warm-up with a hung shutdown extension finishes within the bound and still saves", async () => {
    ext("hung.ts", `export default function (pi) { pi.on("session_shutdown", () => new Promise(() => {})); }\n`);
    const { engine } = await setup([]);
    let saved = false;
    const t0 = Date.now();
    await engine.warmUpCommands({ cwd, save: () => (saved = true) });
    console.log("R6b took", Date.now() - t0);
    expect(saved).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4500);
  }, 30000);
});

describe("R exposure default", () => {
  test("R7 no exposure: offered, deny asks and never calls; plan + always rule: not offered, not asked, not called", async () => {
    writeConfig(join(agentDir, "mcp.json"), serverConfig("fx", {}));
    const seen: string[][] = [];
    let { engine } = await setup([recorder(seen, call(TOOL, { text: "d" })), done()]);
    let r = await run(engine, {}, "deny");
    expect(seen[0]).toContain(TOOL);
    expect(r.asks).toEqual([{ toolName: TOOL, input: { text: "d" } }]);
    expect(callsMade()).toEqual([]);
    expect(tools(r.reply)[0]?.state).toBe("error");
    const rules = openStorage(":memory:");
    rules.addPermissionRule({ cwd, toolName: TOOL });
    // build + always rule runs without asking (S8 normal)
    ({ engine } = await setup([call(TOOL, { text: "a" }), done()], rules));
    r = await run(engine, {}, "deny");
    expect(r.asks).toEqual([]);
    expect(callsMade()).toEqual([JSON.stringify({ text: "a" })]);
    const seenPlan: string[][] = [];
    ({ engine } = await setup([recorder(seenPlan, call(TOOL, { text: "p" })), done()], rules));
    r = await run(engine, { mode: Mode.PLAN }, "allow");
    expect(seenPlan[0]).not.toContain(TOOL);
    expect(r.asks).toEqual([]);
    expect(callsMade()).toEqual([JSON.stringify({ text: "a" })]);
    expect(tools(r.reply)[0]?.state).toBe("error");
  }, 30000);

  for (const [label, extra, offeredExpected] of [
    ["hidden", { exposure: "hidden" }, false],
    ["deferred", { exposure: "deferred" }, false],
    ["codemode", { exposure: "codemode" }, false],
    ["direct", { exposure: "direct" }, true],
    ["toolExposure echo=codemode, no server exposure", { toolExposure: { echo: "codemode" } }, false],
    ["toolExposure echo=direct, server codemode", { exposure: "codemode", toolExposure: { echo: "direct" } }, true],
  ] as const) {
    test(`R8 ${label}: offered=${offeredExpected}`, async () => {
      writeConfig(join(agentDir, "mcp.json"), serverConfig("fx", extra as any));
      const seen: string[][] = [];
      const { engine } = await setup([recorder(seen, call(TOOL, { text: "x" })), done()]);
      const r = await run(engine, {}, "allow");
      console.log("R8", label, "offered", seen[0]?.includes(TOOL), "asks", r.asks.length, "calls", callsMade().length, "notes", JSON.stringify(r.notes));
      expect(seen[0]?.includes(TOOL)).toBe(offeredExpected);
      expect(callsMade().length).toBe(offeredExpected ? 1 : 0);
      expect(r.asks.length).toBe(offeredExpected ? 1 : 0);
    }, 30000);
  }
});

describe("R project mcp.json", () => {
  test("R9 project definition without exposure: direct, asks", async () => {
    writeConfig(join(cwd, ".pi", "mcp.json"), serverConfig("fx", {}));
    const seen: string[][] = [];
    const { engine } = await setup([recorder(seen, call(TOOL, { text: "pj" })), done()]);
    const r = await run(engine, {}, "deny");
    expect(seen[0]).toContain(TOOL);
    expect(r.asks.map((a) => a.toolName)).toEqual([TOOL]);
    expect(callsMade()).toEqual([]);
  }, 30000);

  test("R10 project overrides: enabled-only keeps direct; exposure codemode respected; enabled false disables", async () => {
    const results: Record<string, boolean | undefined> = {};
    for (const [label, override] of [["enabled", { enabled: true }], ["codemode", { exposure: "codemode" }], ["off", { enabled: false }]] as const) {
      writeConfig(join(agentDir, "mcp.json"), serverConfig("fx", {}));
      writeConfig(join(cwd, ".pi", "mcp.json"), { mcpServers: { fx: override } });
      const seen: string[][] = [];
      const { engine } = await setup([recorder(seen, done())]);
      const r = await run(engine, {}, "deny");
      results[label] = seen[0]?.includes(TOOL);
      console.log("R10", label, results[label], JSON.stringify(r.notes));
    }
    expect(results).toEqual({ enabled: true, codemode: false, off: false });
  }, 60000);

  test("R11 project file cannot set auth (url server with auth, or an override with auth): rejected with pi's error", async () => {
    writeConfig(join(cwd, ".pi", "mcp.json"), { mcpServers: { web: { url: "http://127.0.0.1:9/mcp", auth: { provider: "anthropic" } } } });
    const seen: string[][] = [];
    let { engine } = await setup([recorder(seen, done())]);
    let r = await run(engine, {}, "deny");
    console.log("R11a notes", JSON.stringify(r.notes), "offered", JSON.stringify(seen[0]));
    expect(r.notes.join("\n")).toContain("auth is only allowed in the global mcp.json");
    writeConfig(join(agentDir, "mcp.json"), serverConfig("fx", {}));
    writeConfig(join(cwd, ".pi", "mcp.json"), { mcpServers: { fx: { auth: { provider: "anthropic" } } } });
    ({ engine } = await setup([done()]));
    r = await run(engine, {}, "deny");
    console.log("R11b notes", JSON.stringify(r.notes));
    expect(r.notes.join("\n")).toContain("an override can only set");
  }, 30000);
});

describe("R importLoadMcpConfig fallback", () => {
  for (const variant of ["missing", "noexport", "throws"] as const) {
    test(`F ${variant} config module: undefined, no throw`, async () => {
      const pkg = join(dir, variant, "node_modules", "@earendil-works", "pi-coding-agent");
      mkdirSync(join(pkg, "dist", "extensions", "mcp"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", main: "dist/index.js", exports: { ".": "./dist/index.js" } }));
      writeFileSync(join(pkg, "dist", "index.js"), "export const x = 1;\n");
      if (variant === "noexport") writeFileSync(join(pkg, "dist", "extensions", "mcp", "config.js"), "export const other = 1;\n");
      if (variant === "throws") writeFileSync(join(pkg, "dist", "extensions", "mcp", "config.js"), "throw new Error('boom');\n");
      writeFileSync(join(dir, variant, "pi-mcp.ts"), readFileSync(join(import.meta.dir, "pi-mcp.ts"), "utf8"));
      writeFileSync(join(dir, variant, "e.ts"), 'import { importLoadMcpConfig } from "./pi-mcp"; console.log(String(await importLoadMcpConfig()));\n');
      const child = Bun.spawn([process.execPath, "e.ts"], { cwd: join(dir, variant), stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(0);
      expect((await new Response(child.stdout).text()).trim()).toBe("undefined");
    }, 30000);
  }
});
