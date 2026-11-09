// S8 regression: pi approvals through real pi tools, extensions and parallel calls (faux provider, no network).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import type { ChatMessage } from "../chat-types";
import { Mode } from "../modes";
import { openStorage, type Storage } from "../storage";
import { createPiEngine } from "./pi";
import type { EngineEvent, PermissionAsk, PermissionDecision, TurnHost, TurnRequest } from "./types";

let dir: string, agentDir: string, cwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-s8-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

async function setup(responses: FauxResponseStep[], rules: Storage = openStorage(":memory:")) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  return { engine: createPiEngine({ agentDir, modelRuntime, permissionRules: rules }), faux, rules };
}

type Run = { events: EngineEvent[]; asks: PermissionAsk[]; reply: ChatMessage; errors: string[] };
function start(engine: ReturnType<typeof createPiEngine>, req: Partial<TurnRequest>, ask: (a: PermissionAsk, s: AbortSignal) => Promise<PermissionDecision>) {
  const events: EngineEvent[] = [];
  const asks: PermissionAsk[] = [];
  const controller = new AbortController();
  const host: TurnHost = {
    emit: (e) => events.push(e),
    askPermission: (a, s) => {
      asks.push(structuredClone(a));
      return ask(a, s);
    },
    askQuestions: async () => null,
  };
  const turn = engine.startTurn({ prompt: "go", cwd, mode: Mode.BUILD, model: "faux/faux-1", signal: controller.signal, ...req }, host);
  const result = async (): Promise<Run> => {
    await turn.done;
    let reply: ChatMessage = { id: "r", role: "assistant", parts: [] };
    for (const e of events) if (e.type === "reply") reply = e.update(reply);
    return { events, asks, reply, errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])) };
  };
  return { turn, controller, result };
}
const run = (engine: any, req: Partial<TurnRequest>, ask: (a: PermissionAsk, s: AbortSignal) => Promise<PermissionDecision>) => start(engine, req, ask).result();
const always = (d: PermissionDecision) => async () => d;
const tools = (r: ChatMessage) => r.parts.flatMap((p: any) => (p.type === "tool" ? [p] : []));
const call = (name: string, args: Record<string, any>, id = "c1") =>
  fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const done = () => fauxAssistantMessage([fauxText("done")]);
const offered = (messages: Message[]) => messages.flatMap((m: any) => (m.role === "system" ? (m.toolsAdded ?? []).map((t: any) => t.name) : []));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function writeExtension(base: string, name: string, source: string) {
  mkdirSync(join(base, "extensions"), { recursive: true });
  writeFileSync(join(base, "extensions", `${name}.ts`), source);
}

describe("S8: nothing but read, grep, find, ls runs without an allow", () => {
  test("edit denied: file byte-identical", async () => {
    const f = join(cwd, "a.txt");
    writeFileSync(f, "one\n");
    const before = sha(f);
    const { engine } = await setup([call("edit", { path: f, edits: [{ oldText: "one", newText: "two" }] }), done()]);
    const r = await run(engine, {}, always("deny"));
    expect(r.asks.map((a) => a.toolName)).toEqual(["edit"]);
    expect(sha(f)).toBe(before);
    expect(tools(r.reply)[0]?.errorText).toContain("The user denied this tool call.");
  });

  test("write denied: no file", async () => {
    const f = join(cwd, "w.txt");
    const { engine } = await setup([call("write", { path: f, content: "x" }), done()]);
    const r = await run(engine, {}, always("deny"));
    expect(r.asks.map((a) => a.toolName)).toEqual(["write"]);
    expect(existsSync(f)).toBe(false);
  });

  test("parallel calls in one message: each asks, denied ones never run, allowed run", async () => {
    const a = join(cwd, "pa.txt"), b = join(cwd, "pb.txt"), c = join(cwd, "pc.txt");
    const { engine } = await setup([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: `echo a > ${a}` }, { id: "p1" }),
          fauxToolCall("write", { path: b, content: "b" }, { id: "p2" }),
          fauxToolCall("bash", { command: `echo c > ${c}` }, { id: "p3" }),
        ],
        { stopReason: "toolUse" },
      ),
      done(),
    ]);
    const answers: PermissionDecision[] = ["allow", "deny", "deny"];
    const r = await run(engine, {}, async () => answers.shift()!);
    expect(r.asks.map((x) => x.toolName)).toEqual(["bash", "write", "bash"]);
    expect([existsSync(a), existsSync(b), existsSync(c)]).toEqual([true, false, false]);
  });

  test("parallel calls: asks are serialized (never two pending at once)", async () => {
    const { engine } = await setup([
      fauxAssistantMessage(
        [fauxToolCall("bash", { command: "true" }, { id: "s1" }), fauxToolCall("bash", { command: "false" }, { id: "s2" })],
        { stopReason: "toolUse" },
      ),
      done(),
    ]);
    let pending = 0, maxPending = 0;
    await run(engine, {}, async () => {
      pending++; maxPending = Math.max(maxPending, pending);
      await new Promise((r) => setTimeout(r, 20));
      pending--;
      return "deny";
    });
    expect(maxPending).toBe(1);
  });

  test("extension tool from agentDir asks; deny never runs it", async () => {
    const f = join(cwd, "ext.txt");
    writeExtension(agentDir, "danger", `
      import { Type } from "typebox";
      export default function (pi) {
        pi.registerTool({ name: "danger", label: "d", description: "writes", parameters: Type.Object({ p: Type.String() }),
          async execute(_id, params) { require("node:fs").writeFileSync(params.p, "x"); return { content: [{ type: "text", text: "ok" }] }; } });
      }`);
    const { engine } = await setup([call("danger", { p: f }), done()]);
    const r = await run(engine, {}, always("deny"));
    expect(r.errors).toEqual([]);
    expect(r.asks.map((a) => a.toolName)).toEqual(["danger"]);
    expect(existsSync(f)).toBe(false);
  });

  test("extension tool from <project>/.pi asks; deny never runs it", async () => {
    const f = join(cwd, "proj.txt");
    writeExtension(join(cwd, ".pi"), "proj", `
      import { Type } from "typebox";
      export default function (pi) {
        pi.registerTool({ name: "proj_tool", label: "d", description: "writes", parameters: Type.Object({ p: Type.String() }),
          async execute(_id, params) { require("node:fs").writeFileSync(params.p, "x"); return { content: [{ type: "text", text: "ok" }] }; } });
      }`);
    const { engine } = await setup([call("proj_tool", { p: f }), done()]);
    const r = await run(engine, {}, always("deny"));
    expect(r.asks.map((a) => a.toolName)).toEqual(["proj_tool"]);
    expect(existsSync(f)).toBe(false);
  });

  test("nested ctx.executeTool('bash') from an allowed extension tool still asks; deny blocks it", async () => {
    const f = join(cwd, "nested.txt");
    writeExtension(agentDir, "runner", `
      import { Type } from "typebox";
      export default function (pi) {
        pi.registerTool({ name: "runner", label: "r", description: "runs", parameters: Type.Object({}),
          async execute(_id, _params, _signal, _u, ctx) {
            const out = await ctx.executeTool("bash", { command: "echo n > ${f}" });
            return { content: [{ type: "text", text: out.isError ? "blocked" : "ran" }] };
          } });
      }`);
    const { engine } = await setup([call("runner", {}), done()]);
    const answers: PermissionDecision[] = ["always", "deny"];
    const r = await run(engine, {}, async () => answers.shift() ?? "deny");
    expect(r.asks.map((a) => a.toolName)).toEqual(["runner", "bash"]);
    expect(existsSync(f)).toBe(false);
  });

  test("interrupt while an ask is pending, then answering allow: never runs", async () => {
    const f = join(cwd, "int.txt");
    const { engine } = await setup([call("bash", { command: `echo x > ${f}` }), done()]);
    let answer!: (d: PermissionDecision) => void;
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    const s = start(engine, {}, () => new Promise((r) => { answer = r; asked(); }));
    await askedP;
    s.turn.interrupt();
    answer("allow");
    await s.result();
    expect(existsSync(f)).toBe(false);
  });

  test("abort (request signal) while pending: ask signal aborts and call never runs", async () => {
    const f = join(cwd, "abort.txt");
    const { engine } = await setup([call("bash", { command: `echo x > ${f}` }), done()]);
    let sig!: AbortSignal;
    let asked!: () => void;
    const askedP = new Promise<void>((r) => (asked = r));
    let answer!: (d: PermissionDecision) => void;
    const s = start(engine, {}, (_a, signal) => new Promise((r) => { sig = signal; answer = r; asked(); }));
    await askedP;
    s.controller.abort();
    expect(sig.aborted).toBe(true);
    answer("always");
    await s.result();
    expect(existsSync(f)).toBe(false);
  });

  test("askPermission throwing blocks", async () => {
    const f = join(cwd, "throw.txt");
    const { engine } = await setup([call("bash", { command: `echo x > ${f}` }), done()]);
    const r = await run(engine, {}, async () => { throw new Error("boom"); });
    expect(existsSync(f)).toBe(false);
    expect(tools(r.reply)[0]?.state).toBe("error");
  });
});

describe("S8: other extensions' tool_call handlers", () => {
  test("a synchronous mutation by another handler is visible in the ask (marcsh runs last)", async () => {
    const f = join(cwd, "mut.txt");
    writeExtension(agentDir, "mutate", `
      export default function (pi) {
        pi.on("tool_call", (e) => { if (e.toolName === "bash") e.input.command = "echo mutated > ${f}"; });
      }`);
    const { engine } = await setup([call("bash", { command: "echo original" }), done()]);
    const r = await run(engine, {}, always("allow"));
    expect(r.asks[0]?.input).toEqual({ command: `echo mutated > ${f}` });
  });

  test("another handler blocking first: marcsh never asks, call never runs", async () => {
    const f = join(cwd, "blk.txt");
    writeExtension(agentDir, "blocker", `
      export default function (pi) { pi.on("tool_call", () => ({ block: true, reason: "nope" })); }`);
    const { engine } = await setup([call("bash", { command: `echo x > ${f}` }), done()]);
    const r = await run(engine, {}, always("allow"));
    expect(r.asks).toEqual([]);
    expect(existsSync(f)).toBe(false);
  });

  test("another handler returning {block:false} does not skip marcsh", async () => {
    const f = join(cwd, "nb.txt");
    writeExtension(agentDir, "noblock", `
      export default function (pi) { pi.on("tool_call", () => ({ block: false })); }`);
    const { engine } = await setup([call("bash", { command: `echo x > ${f}` }), done()]);
    const r = await run(engine, {}, always("deny"));
    expect(r.asks).toHaveLength(1);
    expect(existsSync(f)).toBe(false);
  });
});

describe("S8: always rules", () => {
  test("bash exact match: chained, whitespace, prefix variants all ask", async () => {
    const rules = openStorage(":memory:");
    const base = "echo ok";
    const variants = [`${base}; touch ${join(cwd, "x")}`, `${base} `, ` ${base}`, `${base}\ntouch y`, `${base} && rm -rf z`, "echo  ok", "ECHO ok", "echo"];
    const { engine } = await setup([call("bash", { command: base }), done(), ...variants.flatMap((v, i) => [call("bash", { command: v }, `v${i}`), done()])], rules);
    await run(engine, {}, always("always"));
    expect(rules.hasPermissionRule({ cwd, toolName: "bash", command: base })).toBe(true);
    for (const v of variants) {
      const r = await run(engine, {}, always("deny"));
      expect(r.asks.map((a) => a.input.command)).toEqual([v]);
    }
    expect(existsSync(join(cwd, "x"))).toBe(false);
  });

  test("deny and allow-once store no rule; always stores exactly one", async () => {
    const rules = openStorage(":memory:");
    const { engine } = await setup([call("bash", { command: "true" }), done(), call("bash", { command: "true" }, "c2"), done(), call("bash", { command: "true" }, "c3"), done()], rules);
    await run(engine, {}, always("deny"));
    await run(engine, {}, always("allow"));
    expect(rules.hasPermissionRule({ cwd, toolName: "bash", command: "true" })).toBe(false);
    await run(engine, {}, always("always"));
    expect(rules.hasPermissionRule({ cwd, toolName: "bash", command: "true" })).toBe(true);
  });
});

describe("S8: plan mode", () => {
  test("extension tools (even mcp__-named) are neither offered nor callable in plan mode", async () => {
    const marker = join(cwd, "mcp.txt");
    writeExtension(agentDir, "planext", `
      import { Type } from "typebox";
      export default function (pi) {
        pi.registerTool({ name: "my_tool", label: "m", description: "m", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "m" }] }; } });
        pi.registerTool({ name: "mcp__fake__write", label: "m", description: "m", parameters: Type.Object({}), async execute() { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"); return { content: [{ type: "text", text: "m" }] }; } });
      }`);
    let names: string[] = [];
    const step: FauxResponseStep = (ctx) => { names = offered(ctx.messages); return call("mcp__fake__write", {}); };
    const { engine } = await setup([step, call("my_tool", {}, "m2"), done()]);
    const r = await run(engine, { mode: Mode.PLAN }, always("allow"));
    expect(names.sort()).toEqual(["AskUserQuestion", "Task", "find", "grep", "ls", "read"]);
    expect(r.asks).toEqual([]);
    expect(tools(r.reply).map((t: any) => t.state)).toEqual(["error", "error"]);
    expect(existsSync(marker)).toBe(false);
  });
});
