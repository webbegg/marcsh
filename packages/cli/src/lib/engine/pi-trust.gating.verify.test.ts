import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import { Mode } from "../modes";
import { openStorage, type Storage } from "../storage";
import { createPiEngine } from "./pi";
import type { TrustAnswer } from "./pi-trust";
import type { TurnHost } from "./types";

// S18: nothing of an untrusted or undecided project loads or runs (extension, MCP server, shellCommandPrefix, SYSTEM.md,
// skills incl. a parent folder's .agents/skills), in turns, warm-up and Task children; after "trust" everything does.
let dir: string;
let project: string;
let markers: string;
let storage: Storage;

const MCP_SERVER = `import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], "x");
process.stdin.on("data", (c) => { for (const line of String(c).split("\\n")) { if (!line.trim()) continue; const r = JSON.parse(line); if (r.id === undefined) continue;
  const result = r.method === "initialize" ? { protocolVersion: r.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "f", version: "1" } } : r.method === "tools/list" ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\\n"); } });
process.stdin.on("end", () => process.exit(0));`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-trust-gating-"));
  const parent = join(dir, "parent");
  project = join(parent, "project");
  markers = join(dir, "markers");
  mkdirSync(markers, { recursive: true });
  const m = (name: string) => JSON.stringify(join(markers, name));
  mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(project, ".pi/extensions/marker.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${m("ext")}, "x");\nexport default function () {}\n`);
  writeFileSync(join(dir, "server.ts"), MCP_SERVER);
  writeFileSync(join(project, ".pi/mcp.json"), JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [join(dir, "server.ts"), join(markers, "mcp")] } } }));
  writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ shellCommandPrefix: `touch ${join(markers, "prefix")};` }));
  writeFileSync(join(project, ".pi/SYSTEM.md"), "SYSMARK\n");
  mkdirSync(join(parent, ".agents/skills/parskill"), { recursive: true });
  writeFileSync(join(parent, ".agents/skills/parskill/SKILL.md"), "---\nname: parskill\ndescription: PARENTSKILLMARK\n---\nbody\n");
  storage = openStorage(join(dir, "db.sqlite"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const loaded = () => (existsSync(markers) ? readdirSync(markers).sort() : []);
const bash = (command: string, id: string) => fauxAssistantMessage([fauxToolCall("bash", { command }, { id })], { stopReason: "toolUse" });

async function engineWith(steps: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const contexts: string[] = [];
  faux.setResponses(steps.map((step) => (context: unknown) => (contexts.push(JSON.stringify(context)), step as never)));
  return { engine: createPiEngine({ agentDir: join(dir, "agent"), modelRuntime, permissionRules: storage, projectTrust: storage, pluginPath: null }), contexts };
}

async function turn(engine: ReturnType<typeof createPiEngine>, answer?: TrustAnswer) {
  const host: TurnHost = {
    emit: () => {},
    askPermission: async () => "allow",
    askQuestions: async () => null,
    ...(answer ? { askProjectTrust: async () => answer } : {}),
  };
  await engine.startTurn({ prompt: "go", cwd: project, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal }, host).done;
  await new Promise((r) => setTimeout(r, 200));
}

describe("project trust gating (S18)", () => {
  for (const answer of ["skip", "distrust", undefined] as const) {
    test(`${answer ?? "no host to ask"}: nothing of the project loads or runs, also in a Task child`, async () => {
      const task = fauxAssistantMessage([fauxToolCall("Task", { description: "c", prompt: "c" }, { id: "t1" })], { stopReason: "toolUse" });
      const { engine, contexts } = await engineWith([bash("echo hi", "c1"), task, bash("echo child", "c2"), fauxAssistantMessage([fauxText("child")]), fauxAssistantMessage([fauxText("done")])]);
      await turn(engine, answer);
      expect(loaded()).toEqual([]);
      expect(contexts.join("").includes("SYSMARK")).toBe(false);
      expect(contexts.join("").includes("PARENTSKILLMARK")).toBe(false);
      expect(storage.getProjectTrust(project)).toBe(answer === "distrust" ? "untrusted" : null);
    }, 30000);
  }

  test("trust: extension, MCP server, prefix, SYSTEM.md and the parent's .agents/skills all load", async () => {
    const { engine, contexts } = await engineWith([bash("echo hi", "c1"), fauxAssistantMessage([fauxText("done")])]);
    await turn(engine, "trust");
    expect(loaded()).toEqual(["ext", "mcp", "prefix"]);
    expect(contexts.join("").includes("SYSMARK")).toBe(true);
    expect(contexts.join("").includes("PARENTSKILLMARK")).toBe(true);
  }, 30000);

  test("warm-up of an undecided project loads nothing of it", async () => {
    const { engine } = await engineWith([]);
    await engine.warmUpCommands({ cwd: project, save: () => {} });
    await new Promise((r) => setTimeout(r, 200));
    expect(loaded()).toEqual([]);
  }, 30000);
});
