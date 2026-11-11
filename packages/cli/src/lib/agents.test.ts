import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_AGENTS,
  agentLabel,
  agentWarnings,
  agentsDir,
  findAgent,
  loadAgents,
  nextAgent,
  parseAgentFile,
} from "./agents";
import { Mode } from "./modes";

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
    expect(agent?.ignored).toEqual(["tools", "temperature", "permission"]);
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

  test("CRLF files parse the same", () => {
    const agent = parseAgentFile("---\r\nname: Win\r\npermission: read-only\r\n---\r\nBody\r\n", { pack: "user", file: "w.md" });
    expect(agent?.name).toBe("Win");
    expect(agent?.mode).toBe(Mode.PLAN);
    expect(agent?.prompt).toBe("Body");
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

describe("agentWarnings", () => {
  test("built-ins never warn", () => {
    expect(agentWarnings(BUILTIN_AGENTS[0]!, "claude")).toEqual([]);
    expect(agentWarnings(BUILTIN_AGENTS[1]!, "pi")).toEqual([]);
  });

  test("ignored fields are named in one line", () => {
    const agent = parseAgentFile("---\nname: X\ntools:\n  bash: false\nhooks: x\n---\nP", { pack: "user", file: "x.md" })!;
    expect(agentWarnings(agent, "claude")).toEqual(["X: ignored tools, hooks"]);
  });

  test("a model the engine cannot use is reported: pi takes provider/id, Claude does not", () => {
    const piModel = parseAgentFile("---\nname: P\nmodel: openai/gpt-5\n---\nP", { pack: "user", file: "p.md" })!;
    const claudeModel = parseAgentFile("---\nname: C\nmodel: opus\n---\nP", { pack: "user", file: "c.md" })!;
    expect(agentWarnings(piModel, "pi")).toEqual([]);
    expect(agentWarnings(piModel, "claude")).toEqual(['P: model "openai/gpt-5" is ignored on claude; the session model is used']);
    expect(agentWarnings(claudeModel, "claude")).toEqual([]);
    expect(agentWarnings(claudeModel, "pi")).toEqual(['C: model "opus" is ignored on pi; the session model is used']);
  });
});
