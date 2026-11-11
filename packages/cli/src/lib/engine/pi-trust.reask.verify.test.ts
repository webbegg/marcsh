import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import { Mode } from "../modes";
import { openStorage, type Storage } from "../storage";
import { createPiEngine } from "./pi";
import type { ProjectTrustAsk, TrustAnswer } from "./pi-trust";
import type { TurnHost } from "./types";

// S1 (verifier): every change to a trusted project's pi files: after trusting, every change re-asks on the next pi turn and blocks project code until re-trusted.
let dir: string;
let parent: string;
let project: string;
let markers: string;
let storage: Storage;
let savedHome: string | undefined;

const MCP_SERVER = `import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], "x");
process.stdin.on("data", (c) => { for (const line of String(c).split("\\n")) { if (!line.trim()) continue; const r = JSON.parse(line); if (r.id === undefined) continue;
  const result = r.method === "initialize" ? { protocolVersion: r.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "f", version: "1" } } : r.method === "tools/list" ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\\n"); } });
process.stdin.on("end", () => process.exit(0));`;

const ext = (tag: string) => `import { writeFileSync } from "node:fs";\n// ${tag}\nexport default function () { writeFileSync(${JSON.stringify(join(markers, "ext"))}, "x"); }\n`;
const mcpJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ mcpServers: { fx: { command: process.execPath, args: [join(dir, "server.ts"), join(markers, "mcp")], env: { TOKEN: "SECRETENVVALUE42" }, ...extra } } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-verify-reask-"));
  savedHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home"), { recursive: true });
  parent = join(dir, "parent");
  project = join(parent, "project");
  markers = join(dir, "markers");
  mkdirSync(markers, { recursive: true });
  mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(project, ".pi/extensions/marker.ts"), ext("AAAA"));
  writeFileSync(join(project, ".pi/extensions/other.ts"), "export default function () {}\n");
  writeFileSync(join(dir, "server.ts"), MCP_SERVER);
  writeFileSync(join(project, ".pi/mcp.json"), mcpJson());
  writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ shellCommandPrefix: `touch ${join(markers, "prefix")};`, packages: [] }));
  mkdirSync(join(parent, ".agents/skills/parskill"), { recursive: true });
  writeFileSync(join(parent, ".agents/skills/parskill/SKILL.md"), "---\nname: parskill\ndescription: PARENTSKILLMARK\n---\nbody\n");
  storage = openStorage(join(dir, "db.sqlite"));
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

const loaded = () => (existsSync(markers) ? readdirSync(markers).sort() : []);
const clear = () => { for (const f of readdirSync(markers)) unlinkSync(join(markers, f)); };
const bash = (command: string, id: string) => fauxAssistantMessage([fauxToolCall("bash", { command }, { id })], { stopReason: "toolUse" });

async function turn(answer: TrustAnswer | undefined) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const contexts: string[] = [];
  const steps: FauxResponseStep[] = [bash("echo hi", "c1"), fauxAssistantMessage([fauxText("done")])];
  faux.setResponses(steps.map((step) => (context: unknown) => (contexts.push(JSON.stringify(context)), step as never)));
  const engine = createPiEngine({ agentDir: join(dir, "agent"), modelRuntime, permissionRules: storage, projectTrust: storage, pluginPath: null });
  const asks: ProjectTrustAsk[] = [];
  const host: TurnHost = {
    emit: () => {},
    askPermission: async () => "allow",
    askQuestions: async () => null,
    askProjectTrust: async (ask) => (asks.push(ask), answer ?? "skip"),
  };
  await engine.startTurn({ prompt: "go", cwd: project, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal }, host).done;
  await new Promise((r) => setTimeout(r, 200));
  const result = { asks, loaded: loaded(), skill: contexts.join("").includes("PARENTSKILLMARK") };
  clear();
  return result;
}

async function trustFirst() {
  const first = await turn("trust");
  expect(first.asks.length).toBe(1);
  expect(first.loaded).toEqual(["ext", "mcp", "prefix"]);
  const again = await turn(undefined);
  expect(again.asks.length).toBe(0); // (b) unchanged: no prompt, loads
  expect(again.loaded).toEqual(["ext", "mcp", "prefix"]);
  expect(again.skill).toBe(true);
}

const sameSizeEdit = (path: string, from: string, to: string, keepMtime = true) => {
  const before = statSync(path);
  const text = readFileSync(path, "utf8");
  expect(text.includes(from)).toBe(true);
  writeFileSync(path, text.replace(from, to));
  if (keepMtime) utimesSync(path, before.atime, before.mtime);
  expect(statSync(path).size).toBe(before.size);
};

const mutations: Record<string, () => void> = {
  "extension code edited, same size, mtime kept (git pull style)": () => sameSizeEdit(join(project, ".pi/extensions/marker.ts"), "AAAA", "BBBB"),
  "extension added": () => writeFileSync(join(project, ".pi/extensions/new.ts"), "export default function () {}\n"),
  "extension removed": () => unlinkSync(join(project, ".pi/extensions/other.ts")),
  "extension folder added": () => { mkdirSync(join(project, ".pi/extensions/pkg")); writeFileSync(join(project, ".pi/extensions/pkg/index.ts"), "export default function () {}\n"); },
  "MCP command changed": () => writeFileSync(join(project, ".pi/mcp.json"), mcpJson({ command: "/bin/sh", args: ["-c", "true"] }).replace("/bin/sh", process.execPath)),
  "MCP arg changed": () => writeFileSync(join(project, ".pi/mcp.json"), mcpJson({ args: [join(dir, "server.ts"), join(markers, "mcp"), "--x"] })),
  "MCP env value changed (same size)": () => sameSizeEdit(join(project, ".pi/mcp.json"), "SECRETENVVALUE42", "SECRETENVVALUE43"),
  "skill added in .pi/skills": () => { mkdirSync(join(project, ".pi/skills/s1"), { recursive: true }); writeFileSync(join(project, ".pi/skills/s1/SKILL.md"), "---\nname: s1\ndescription: d\n---\n"); },
  "prompt added in .pi/prompts": () => { mkdirSync(join(project, ".pi/prompts"), { recursive: true }); writeFileSync(join(project, ".pi/prompts/p.md"), "hi"); },
  "skill added in project .agents/skills": () => { mkdirSync(join(project, ".agents/skills/s2"), { recursive: true }); writeFileSync(join(project, ".agents/skills/s2/SKILL.md"), "---\nname: s2\ndescription: d\n---\n"); },
  "skill added in parent .agents/skills": () => { mkdirSync(join(parent, ".agents/skills/s3"), { recursive: true }); writeFileSync(join(parent, ".agents/skills/s3/SKILL.md"), "---\nname: s3\ndescription: d\n---\n"); },
  "parent skill edited in place, same size, mtime kept": () => sameSizeEdit(join(parent, ".agents/skills/parskill/SKILL.md"), "body", "BODY"),
  "settings.json packages changed": () => (mkdirSync(join(project, "localpkg"), { recursive: true }), writeFileSync(join(project, "localpkg/package.json"), JSON.stringify({ name: "localpkg", version: "1.0.0" })), writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ shellCommandPrefix: `touch ${join(markers, "prefix")};`, packages: ["../localpkg"] }))),
  "settings.json shellCommandPrefix changed": () => writeFileSync(join(project, ".pi/settings.json"), JSON.stringify({ shellCommandPrefix: `touch ${join(markers, "prefix")}; true;`, packages: [] })),
  "SYSTEM.md added": () => writeFileSync(join(project, ".pi/SYSTEM.md"), "sys"),
  "extension file replaced by a symlink to different code": () => { writeFileSync(join(dir, "evil.ts"), ext("EVIL")); unlinkSync(join(project, ".pi/extensions/marker.ts")); symlinkSync(join(dir, "evil.ts"), join(project, ".pi/extensions/marker.ts")); },
};

describe("S1 re-ask after trust (verifier)", () => {
  for (const [name, mutate] of Object.entries(mutations)) {
    test(name, async () => {
      await trustFirst();
      mutate();
      const after = await turn("skip");
      expect(after.asks.length).toBe(1);
      expect(after.asks[0]!.changes?.known).toBe(true);
      // blocked: nothing of the project ran on the skipped turn
      expect(after.loaded).toEqual([]);
      expect(after.skill).toBe(false);
      // still asks on the next turn (skip stored nothing)
      const again = await turn("trust");
      expect(again.asks.length).toBe(1);
      expect(again.loaded.includes("prefix")).toBe(true);
      const settled = await turn(undefined);
      expect(settled.asks.length).toBe(0);
    }, 60000);
  }

  test("d stores untrusted; a stored untrusted stays untrusted without asking even after changes", async () => {
    await trustFirst();
    writeFileSync(join(project, ".pi/extensions/new.ts"), "export default function () {}\n");
    const d = await turn("distrust");
    expect(d.asks.length).toBe(1);
    expect(d.loaded).toEqual([]);
    expect(storage.getProjectTrust(project)).toBe("untrusted");
    expect(storage.getProjectReview(project)).toBeNull();
    writeFileSync(join(project, ".pi/extensions/new2.ts"), "export default function () {}\n");
    const later = await turn(undefined);
    expect(later.asks.length).toBe(0);
    expect(later.loaded).toEqual([]);
  }, 60000);

  test("warm-up never loads project code for a changed project (c)", async () => {
    await trustFirst();
    sameSizeEdit(join(project, ".pi/extensions/marker.ts"), "AAAA", "CCCC");
    const faux = fauxProvider({ models: [{ id: "faux-1" }] });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const engine = createPiEngine({ agentDir: join(dir, "agent"), modelRuntime, permissionRules: storage, projectTrust: storage, pluginPath: null });
    await engine.warmUpCommands({ cwd: project, save: () => {} });
    await new Promise((r) => setTimeout(r, 300));
    expect(loaded()).toEqual([]);
    // unchanged trusted project: warm-up does load (sanity)
    sameSizeEdit(join(project, ".pi/extensions/marker.ts"), "CCCC", "AAAA");
    await engine.warmUpCommands({ cwd: project, save: () => {} });
    await new Promise((r) => setTimeout(r, 300));
    expect(loaded().includes("ext")).toBe(true);
  }, 60000);

  test("a trust answered while files changed during the prompt stores no stale record (g)", async () => {
    await trustFirst();
    writeFileSync(join(project, ".pi/extensions/new.ts"), "export default function () {}\n");
    const rowBefore = JSON.stringify(storage.getProjectReview(project));
    const faux = fauxProvider({ models: [{ id: "faux-1" }] });
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
    const engine = createPiEngine({ agentDir: join(dir, "agent"), modelRuntime, permissionRules: storage, projectTrust: storage, pluginPath: null });
    const host: TurnHost = {
      emit: () => {},
      askPermission: async () => "allow",
      askQuestions: async () => null,
      askProjectTrust: async () => {
        writeFileSync(join(project, ".pi/extensions/marker.ts"), ext("ZZZZ"));
        return "trust";
      },
    };
    await engine.startTurn({ prompt: "go", cwd: project, mode: Mode.BUILD, model: "faux/faux-1", signal: new AbortController().signal }, host).done;
    await new Promise((r) => setTimeout(r, 200));
    expect(loaded()).toEqual([]);
    expect(JSON.stringify(storage.getProjectReview(project))).toBe(rowBefore);
    const next = await turn("skip");
    expect(next.asks.length).toBe(1);
  }, 60000);
});
