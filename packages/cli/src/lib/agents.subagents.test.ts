import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSubagentFile } from "./agent-file";
import { availableSubagents, loadAgents, loadSubagents, parseAgentFile, turnSubagents, BUILTIN_AGENTS } from "./agents";
import { Mode } from "./modes";

// M1: an agent file with `mode: subagent` is a named subagent, addressed by its file name without `.md`; never a primary agent.

describe("parseSubagentFile", () => {
  const refuter = [
    "---",
    "name: Security refuter",
    "description: Tries to break the change's security claims",
    "mode: subagent",
    "permission: read-only",
    "model: anthropic/claude-sonnet-5-5",
    "tools: Read, Grep, Bash",
    "---",
    "You refute security claims.",
  ].join("\n");

  test("reads a `mode: subagent` file: its address is the file name, `name` is the label, and the rest are the agent fields", () => {
    const sub = parseSubagentFile(refuter, { pack: "acme/flows", file: "refuter-security.md" });
    expect(sub).toMatchObject({
      address: "refuter-security",
      name: "Security refuter",
      description: "Tries to break the change's security claims",
      mode: Mode.PLAN,
      prompt: "You refute security claims.",
      model: "anthropic/claude-sonnet-5-5",
      pack: "acme/flows",
      ignored: [],
    });
    expect(sub?.tools?.deny).toEqual(["edit", "web", "task", "mcp"]);
  });

  test("the same file is still not a primary agent", () => {
    expect(parseAgentFile(refuter, { pack: "user", file: "refuter-security.md" })).toBeNull();
  });

  test("a primary agent (no mode, primary or all) is not a subagent", () => {
    for (const text of ["Just do it.", "---\nmode: primary\n---\nP", "---\nmode: all\n---\nA"]) {
      expect(parseSubagentFile(text, { pack: "user", file: "x.md" })).toBeNull();
    }
  });

  test("defaults: the label is the address, build permission, no model, no restriction", () => {
    const sub = parseSubagentFile("---\nmode: subagent\n---\nHelp.", { pack: "user", file: "helper.md" });
    expect(sub).toMatchObject({ address: "helper", name: "helper", mode: Mode.BUILD, prompt: "Help." });
    expect(sub?.model).toBeUndefined();
    expect(sub?.tools).toBeUndefined();
  });

  test("a file name that cannot be a tool argument (spaces, a leading dot or dash, control characters) is not loaded", () => {
    for (const file of ["my agent.md", ".hidden.md", "-x.md", "a\u001bb.md", `${"a".repeat(65)}.md`]) {
      expect(parseSubagentFile("---\nmode: subagent\n---\nX", { pack: "user", file })).toBeNull();
    }
    expect(parseSubagentFile("---\nmode: subagent\n---\nX", { pack: "user", file: "Task_2.v1.md" })?.address).toBe("Task_2.v1");
  });
});

describe("loadSubagents and availableSubagents", () => {
  let dir: string;
  let user: string;
  let packs: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-subagents-"));
    user = join(dir, "agents");
    packs = join(dir, "packs");
    mkdirSync(user, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const install = (id: string, files: Record<string, string>) => {
    mkdirSync(join(packs, id, "src", "agents"), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(packs, id, "src", "agents", file), text);
    const lockFile = join(packs, "packs.json");
    let lock: { packs: unknown[] } = { packs: [] };
    try {
      lock = JSON.parse(readFileSync(lockFile, "utf8"));
    } catch {}
    lock.packs.push({ id, url: `https://github.com/${id}.git`, commit: "c", installedAt: "t" });
    writeFileSync(lockFile, JSON.stringify(lock));
  };
  const sub = (label: string, extra = "") => `---\nname: ${label}\nmode: subagent\n${extra}---\n${label} prompt`;

  beforeEach(() => {
    writeFileSync(join(user, "mine.md"), sub("Mine"));
    writeFileSync(join(user, "reviewer.md"), sub("User reviewer"));
    writeFileSync(join(user, "primary.md"), "---\nname: Primary\n---\nP");
    install("acme/flows", {
      "ftd.md": "---\nname: FTD\n---\nF",
      "reviewer.md": sub("Pack reviewer", "permission: read-only\n"),
      "developer.md": sub("Developer", "tools:\n  bash: false\n"),
    });
    install("zed/other", { "lead.md": "---\nname: Lead\n---\nL", "outsider.md": sub("Outsider") });
  });

  test("loads the user's and every pack's subagents; none of them is a primary agent (not in Tab or the /agents list)", () => {
    const subs = loadSubagents(user, packs);
    expect(subs.map((s) => `${s.pack}:${s.address}`)).toEqual(["user:mine", "user:reviewer", "acme/flows:developer", "acme/flows:reviewer", "zed/other:outsider"]);
    expect(subs.find((s) => s.pack === "acme/flows")!.pluginDir).toBe(join(packs, "acme", "flows", "plugin"));
    expect(subs.find((s) => s.pack === "user")!.pluginDir).toBeUndefined();

    const agents = loadAgents(user, packs).map((agent) => agent.name);
    expect(agents).toEqual(["Build", "Plan", "Primary", "FTD", "Lead"]);
  });

  test("Build, Plan and a user primary agent get only the user's subagents", () => {
    const subs = loadSubagents(user, packs);
    const primary = loadAgents(user, packs).find((agent) => agent.name === "Primary")!;
    for (const agent of [...BUILTIN_AGENTS, primary]) {
      expect(availableSubagents(agent, subs).map((s) => `${s.pack}:${s.address}`)).toEqual(["user:mine", "user:reviewer"]);
    }
  });

  test("a pack agent gets the user's subagents and its own pack's, never another pack's; on a name clash the pack's wins", () => {
    const subs = loadSubagents(user, packs);
    const ftd = loadAgents(user, packs).find((agent) => agent.name === "FTD")!;
    const available = availableSubagents(ftd, subs);
    expect(available.map((s) => `${s.pack}:${s.address}`)).toEqual(["acme/flows:developer", "user:mine", "acme/flows:reviewer"]);
    expect(available.find((s) => s.address === "reviewer")!.name).toBe("Pack reviewer");
  });

  test("turnSubagents maps them for the engine: read-only from permission, the denied groups, the pack's view", () => {
    const ftd = loadAgents(user, packs).find((agent) => agent.name === "FTD")!;
    const turn = turnSubagents(ftd, loadSubagents(user, packs));
    expect(turn).toEqual([
      { name: "developer", description: undefined, prompt: "Developer prompt", readOnly: false, deniedTools: ["bash"], pluginDir: join(packs, "acme", "flows", "plugin") },
      { name: "mine", description: undefined, prompt: "Mine prompt", readOnly: false },
      { name: "reviewer", description: undefined, prompt: "Pack reviewer prompt", readOnly: true, pluginDir: join(packs, "acme", "flows", "plugin") },
    ]);
  });

  test("a pack's subagent texts are made printable, like its agents'", () => {
    install("evil/pack", { "lead.md": "---\nname: L\n---\nL", "x.md": "---\nname: Bad\u001b[2J\ndescription: d\u001b]0;t\u0007\nmode: subagent\n---\nX" });
    const x = loadSubagents(user, packs).find((s) => s.pack === "evil/pack")!;
    expect(x.name).not.toContain("\u001b");
    expect(x.description).not.toContain("\u001b");
  });
});
