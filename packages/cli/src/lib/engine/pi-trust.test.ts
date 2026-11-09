import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../storage";
import { escapeProjectText, findProjectResources, isProjectTrusted, resolveProjectTrust, type ProjectTrustAsk, type TrustAnswer } from "./pi-trust";

let root: string;
let project: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-pi-trust-")));
  project = join(root, "work", "project");
  home = join(root, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  // pi (and the detection that mirrors it) reads HOME to tell the user's own ~/.agents/skills from a project's.
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const write = (path: string, content = "") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

const cp = (code: number) => String.fromCodePoint(code);

describe("findProjectResources", () => {
  test("a project with no pi files has nothing to ask about", () => {
    write(join(project, "src", "index.ts"));

    expect(findProjectResources(project)).toEqual([]);
  });

  test("AGENTS.md and CLAUDE.md are not gated by pi, so they are not listed", () => {
    write(join(project, "AGENTS.md"), "# rules");
    write(join(project, "CLAUDE.md"), "# rules");

    expect(findProjectResources(project)).toEqual([]);
  });

  test("lists each project extension by path", () => {
    write(join(project, ".pi", "extensions", "foo.ts"));
    mkdirSync(join(project, ".pi", "extensions", "bar"));

    expect(findProjectResources(project)).toEqual([{ path: ".pi/extensions/bar/" }, { path: ".pi/extensions/foo.ts" }]);
  });

  test("lists each MCP server in .pi/mcp.json with its command, or its URL", () => {
    write(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { fixture: { command: "node", args: ["server.js", "--port", "1"] }, docs: { url: "https://example.com/mcp" } } }),
    );

    expect(findProjectResources(project)).toEqual([
      { path: ".pi/mcp.json", detail: "server fixture: node server.js --port 1" },
      { path: ".pi/mcp.json", detail: "server docs: https://example.com/mcp" },
    ]);
  });

  test("an mcp.json that cannot be read or has no servers is still listed", () => {
    write(join(project, ".pi", "mcp.json"), "{ not json");
    expect(findProjectResources(project)).toEqual([{ path: ".pi/mcp.json", detail: "could not be read" }]);

    write(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {} }));
    expect(findProjectResources(project)).toEqual([{ path: ".pi/mcp.json", detail: "no servers" }]);
  });

  test("lists .pi/settings.json with the values pi runs or installs, and the names of the other keys it sets", () => {
    write(
      join(project, ".pi", "settings.json"),
      JSON.stringify({
        shellCommandPrefix: "source ./env.sh",
        packages: ["npm:x", { source: "git:github.com/a/b", extensions: ["ext/a.ts"], autoload: false }],
        extensions: ["./local-ext.ts"],
        npmCommand: ["npx", "--yes"],
        defaultTools: ["read"],
        theme: "dark",
      }),
    );

    expect(findProjectResources(project)).toEqual([
      { path: ".pi/settings.json", detail: "shellCommandPrefix: source ./env.sh" },
      { path: ".pi/settings.json", detail: "npmCommand: npx --yes" },
      { path: ".pi/settings.json", detail: "packages: npm:x" },
      { path: ".pi/settings.json", detail: "packages: git:github.com/a/b (extensions: ext/a.ts; autoload: false)" },
      { path: ".pi/settings.json", detail: "extensions: ./local-ext.ts" },
      { path: ".pi/settings.json", detail: "sets defaultTools, theme" },
    ]);
  });

  test("shell, editor, update and proxy settings are listed with their values; skills, prompts and themes paths too", () => {
    write(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ shellPath: "/tmp/sh", externalEditor: "evil-editor", selfUpdateCommand: "curl x | sh", httpProxy: "http://p:1", skills: ["../s"], prompts: ["../p"], themes: ["../t"] }),
    );

    expect(findProjectResources(project).map((r) => r.detail)).toEqual([
      "shellPath: /tmp/sh",
      "selfUpdateCommand: curl x | sh",
      "externalEditor: evil-editor",
      "httpProxy: http://p:1",
      "skills: ../s",
      "prompts: ../p",
      "themes: ../t",
    ]);
  });

  test("an MCP server lists its command with every argument, its working folder, each env entry and each header, whole", () => {
    const long = `${"a".repeat(150)} ${"b".repeat(150)} tail`;
    write(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["s.js", long], cwd: "/tmp/x", env: { NODE_OPTIONS: "--require /tmp/evil.js", A: "1" } },
          remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
        },
      }),
    );

    expect(findProjectResources(project).map((r) => r.detail)).toEqual([
      `server local: node s.js ${long}`,
      "server local runs in: /tmp/x",
      "server local env: NODE_OPTIONS=--require /tmp/evil.js",
      "server local env: A=1",
      "server remote: https://example.com/mcp",
      "server remote header: Authorization: Bearer ${TOKEN}",
    ]);
  });

  test("most dangerous first: MCP servers and executable settings, then extensions, then everything else", () => {
    write(join(project, ".pi", "APPEND_SYSTEM.md"));
    write(join(project, ".pi", "skills", "s", "SKILL.md"));
    write(join(project, ".pi", "prompts", "p.md"));
    write(join(project, ".pi", "extensions", "e.ts"));
    write(join(project, ".pi", "settings.json"), JSON.stringify({ theme: "dark", shellCommandPrefix: "x" }));
    write(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { m: { command: "c" } } }));

    expect(findProjectResources(project).map((r) => [r.path, r.detail])).toEqual([
      [".pi/mcp.json", "server m: c"],
      [".pi/settings.json", "shellCommandPrefix: x"],
      [".pi/extensions/e.ts", undefined],
      [".pi/settings.json", "sets theme"],
      [".pi/skills/s/", undefined],
      [".pi/prompts/p.md", undefined],
      [".pi/APPEND_SYSTEM.md", "changes the system prompt"],
    ]);
  });

  test("lists skills, prompt templates, themes and the system prompt files", () => {
    write(join(project, ".pi", "skills", "review", "SKILL.md"));
    write(join(project, ".pi", "prompts", "fix.md"));
    write(join(project, ".pi", "themes", "dark.json"));
    write(join(project, ".pi", "SYSTEM.md"));
    write(join(project, ".pi", "APPEND_SYSTEM.md"));

    expect(findProjectResources(project).map((r) => r.path)).toEqual([
      ".pi/skills/review/",
      ".pi/prompts/fix.md",
      ".pi/themes/dark.json",
      ".pi/SYSTEM.md",
      ".pi/APPEND_SYSTEM.md",
    ]);
  });

  test("an empty resource folder is listed as itself", () => {
    mkdirSync(join(project, ".pi", "extensions"), { recursive: true });

    expect(findProjectResources(project)).toEqual([{ path: ".pi/extensions/" }]);
  });

  test("a long folder lists every entry: nothing is hidden behind a count", () => {
    for (let i = 0; i < 200; i++) write(join(project, ".pi", "prompts", `p${String(i).padStart(3, "0")}.md`));

    const resources = findProjectResources(project);

    expect(resources).toHaveLength(200);
    expect(resources.at(-1)).toEqual({ path: ".pi/prompts/p199.md" });
    expect(resources.some((r) => r.detail?.includes("more"))).toBe(false);
  });

  test("a project-supplied string is one escaped line: newlines, controls, bidi and invisible characters show as escapes", () => {
    const classes: [string, string, string][] = [
      ["newline", "\n", "\\n"],
      ["carriage return", "\r", "\\r"],
      ["tab", "\t", "\\t"],
      ["escape", "\u001b", "\\u001b"],
      ["C0 bell", "\u0007", "\\u0007"],
      ["delete", "\u007f", "\\u007f"],
      ["C1 CSI", "\u009b", "\\u009b"],
      ["zero width space", cp(0x200b), "\\u200b"],
      ["right-to-left mark", cp(0x200f), "\\u200f"],
      ["right-to-left override", cp(0x202e), "\\u202e"],
      ["left-to-right embedding", cp(0x202a), "\\u202a"],
      ["word joiner", cp(0x2060), "\\u2060"],
      ["unassigned in the invisible block", cp(0x2065), "\\u2065"],
      ["bidi isolate", cp(0x2069), "\\u2069"],
      ["byte order mark", cp(0xfeff), "\\ufeff"],
      ["soft hyphen", cp(0xad), "\\u00ad"],
      ["line separator", cp(0x2028), "\\u2028"],
      ["paragraph separator", cp(0x2029), "\\u2029"],
      ["tag character", "\u{e0041}", "\\u{e0041}"],
    ];
    for (const [label, raw, escaped] of classes) {
      expect([label, escapeProjectText(`a${raw}b`)]).toEqual([label, `a${escaped}b`]);
    }
    expect(escapeProjectText("plain é 日本 😀 text/with-dashes_and spaces")).toBe("plain é 日本 😀 text/with-dashes_and spaces");
    expect(escapeProjectText(escapeProjectText(`a\nb${cp(0x202e)}c`))).toBe(escapeProjectText(`a\nb${cp(0x202e)}c`));
  });

  test("every place a project string reaches the listing is escaped: file names, MCP command, args, env, settings values", () => {
    const nasty = `x\nt  press Enter to trust  FAKE${cp(0x202e)}${cp(0x1b)}[2J`;
    write(join(project, ".pi", "prompts", `${nasty}.md`));
    write(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { [`n${nasty}`]: { command: `c${nasty}`, args: [`a${nasty}`], env: { [`K${nasty}`]: `v${nasty}` } } } }),
    );
    write(join(project, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: `p${nasty}`, packages: [`k${nasty}`] }));

    const resources = findProjectResources(project);

    expect(resources.length).toBeGreaterThanOrEqual(5);
    for (const { path, detail } of resources) expect(`${path}${detail ?? ""}`).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(resources.map((r) => r.detail).join("\n")).toContain("env: K" + escapeProjectText(nasty) + "=v" + escapeProjectText(nasty));
    expect(resources.map((r) => r.path).join("\n")).toContain(`${escapeProjectText(nasty)}.md`);
  });

  test(".agents/skills in the project or a parent folder is listed, relative to the project", () => {
    write(join(project, ".agents", "skills", "mine", "SKILL.md"));
    write(join(root, "work", ".agents", "skills", "shared", "SKILL.md"));

    expect(findProjectResources(project).map((r) => r.path)).toEqual([".agents/skills/mine/", "../.agents/skills/shared/"]);
  });

  test("the user's own ~/.agents/skills is not a project resource, even when the project is inside HOME", () => {
    write(join(home, ".agents", "skills", "personal", "SKILL.md"));
    const inHome = join(home, "code", "app");
    mkdirSync(inHome, { recursive: true });

    expect(findProjectResources(inHome)).toEqual([]);
  });

  test("agrees with pi's own check for what needs project trust", async () => {
    const { hasTrustRequiringProjectResources } = await import("@earendil-works/pi-coding-agent");
    const fixtures: [string, (dir: string) => void][] = [
      ["nothing", () => {}],
      ["AGENTS.md", (dir) => write(join(dir, "AGENTS.md"))],
      ["an empty .pi", (dir) => mkdirSync(join(dir, ".pi"), { recursive: true })],
      ["settings.json", (dir) => write(join(dir, ".pi", "settings.json"), "{}")],
      ["mcp.json", (dir) => write(join(dir, ".pi", "mcp.json"), "{}")],
      ["extensions", (dir) => mkdirSync(join(dir, ".pi", "extensions"), { recursive: true })],
      ["skills", (dir) => mkdirSync(join(dir, ".pi", "skills"), { recursive: true })],
      ["prompts", (dir) => mkdirSync(join(dir, ".pi", "prompts"), { recursive: true })],
      ["themes", (dir) => mkdirSync(join(dir, ".pi", "themes"), { recursive: true })],
      ["SYSTEM.md", (dir) => write(join(dir, ".pi", "SYSTEM.md"))],
      ["APPEND_SYSTEM.md", (dir) => write(join(dir, ".pi", "APPEND_SYSTEM.md"))],
      ["a sessions folder only", (dir) => mkdirSync(join(dir, ".pi", "sessions"), { recursive: true })],
      [".agents/skills", (dir) => mkdirSync(join(dir, ".agents", "skills"), { recursive: true })],
      ["a parent .agents/skills", (dir) => mkdirSync(join(dir, "..", ".agents", "skills"), { recursive: true })],
    ];

    for (const [label, build] of fixtures) {
      const dir = join(root, "fixture", label.replace(/\W+/g, "-"), "project");
      mkdirSync(dir, { recursive: true });
      build(dir);

      expect([label, findProjectResources(dir).length > 0]).toEqual([label, hasTrustRequiringProjectResources(dir)]);
    }
  });
});

/** A project with a file to ask about, and a store that records what happens to it. */
function setup(answer?: TrustAnswer | ((ask: ProjectTrustAsk, signal: AbortSignal) => Promise<TrustAnswer>)) {
  write(join(project, ".pi", "extensions", "foo.ts"));
  const storage = openStorage(":memory:");
  const asks: ProjectTrustAsk[] = [];
  const ask = answer
    ? async (request: ProjectTrustAsk, signal: AbortSignal) => {
        asks.push(request);
        return typeof answer === "function" ? answer(request, signal) : answer;
      }
    : undefined;
  const resolve = (signal = new AbortController().signal) => resolveProjectTrust({ cwd: project, records: () => storage, ask, signal });
  return { storage, asks, resolve };
}

describe("resolveProjectTrust", () => {
  test("a project with no pi files is not asked about and nothing is stored or even opened", async () => {
    let opened = false;
    const asks: unknown[] = [];

    const trusted = await resolveProjectTrust({
      cwd: project,
      records: () => {
        opened = true;
        throw new Error("must not be opened");
      },
      ask: async (request) => {
        asks.push(request);
        return "trust";
      },
      signal: new AbortController().signal,
    });

    expect(trusted).toBe(false);
    expect(asks).toEqual([]);
    expect(opened).toBe(false);
  });

  test("an undecided project asks once with the folder and what was found, and 'trust' is stored and trusts", async () => {
    const { storage, asks, resolve } = setup("trust");

    expect(await resolve()).toBe(true);

    expect(asks).toEqual([{ cwd: project, resources: [{ path: ".pi/extensions/foo.ts" }] }]);
    expect(storage.getProjectTrust(project)).toBe("trusted");
  });

  test("'distrust' is stored and does not trust", async () => {
    const { storage, resolve } = setup("distrust");

    expect(await resolve()).toBe(false);

    expect(storage.getProjectTrust(project)).toBe("untrusted");
  });

  test("'skip' (Esc) does not trust this turn and stores nothing, so the next turn asks again", async () => {
    const { storage, asks, resolve } = setup("skip");

    expect(await resolve()).toBe(false);
    expect(storage.getProjectTrust(project)).toBeNull();
    expect(await resolve()).toBe(false);

    expect(asks).toHaveLength(2);
  });

  test("a stored decision is used and not asked again", async () => {
    const { storage, asks, resolve } = setup("distrust");
    storage.setProjectTrust(project, "trusted");
    expect(await resolve()).toBe(true);

    storage.setProjectTrust(project, "untrusted");
    expect(await resolve()).toBe(false);

    expect(asks).toEqual([]);
  });

  test("with nobody to ask, an undecided project is untrusted and nothing is stored", async () => {
    const { storage, resolve } = setup();

    expect(await resolve()).toBe(false);

    expect(storage.getProjectTrust(project)).toBeNull();
  });

  test("an aborted turn never asks", async () => {
    const { storage, asks, resolve } = setup("trust");
    const controller = new AbortController();
    controller.abort();

    expect(await resolve(controller.signal)).toBe(false);

    expect(asks).toEqual([]);
    expect(storage.getProjectTrust(project)).toBeNull();
  });

  test("an abort while the question is open trusts nothing and stores nothing, even if the answer was 'trust'", async () => {
    const controller = new AbortController();
    const { storage, resolve } = setup(async () => {
      controller.abort();
      return "trust";
    });

    expect(await resolve(controller.signal)).toBe(false);

    expect(storage.getProjectTrust(project)).toBeNull();
  });

  test("a store that cannot be read never trusts", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"));

    const trusted = await resolveProjectTrust({
      cwd: project,
      records: () => ({
        getProjectTrust: () => {
          throw new Error("disk is gone");
        },
        setProjectTrust: () => {},
      }),
      ask: async () => "trust",
      signal: new AbortController().signal,
    });

    expect(trusted).toBe(false);
  });

  test("an answer that cannot be saved still applies to this turn", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"));

    const trusted = await resolveProjectTrust({
      cwd: project,
      records: () => ({
        getProjectTrust: () => null,
        setProjectTrust: () => {
          throw new Error("read-only");
        },
      }),
      ask: async () => "trust",
      signal: new AbortController().signal,
    });

    expect(trusted).toBe(true);
  });
});

describe("isProjectTrusted (warm-up: never asks)", () => {
  test("only a stored 'trusted' on a project with pi files counts", () => {
    const { storage } = setup();
    expect(isProjectTrusted(project, () => storage)).toBe(false);

    storage.setProjectTrust(project, "untrusted");
    expect(isProjectTrusted(project, () => storage)).toBe(false);

    storage.setProjectTrust(project, "trusted");
    expect(isProjectTrusted(project, () => storage)).toBe(true);
  });

  test("a project without pi files is false and does not open the store", () => {
    expect(isProjectTrusted(project, () => {
      throw new Error("must not be opened");
    })).toBe(false);
  });
});
