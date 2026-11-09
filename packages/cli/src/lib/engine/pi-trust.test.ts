import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorage } from "../storage";
import { findProjectResources, isProjectTrusted, resolveProjectTrust, type ProjectTrustAsk, type TrustAnswer } from "./pi-trust";

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

  test("lists .pi/settings.json with the keys it sets and its shellCommandPrefix", () => {
    write(join(project, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "source ./env.sh", packages: ["npm:x"], defaultTools: ["read"] }));

    expect(findProjectResources(project)).toEqual([
      { path: ".pi/settings.json", detail: "shellCommandPrefix: source ./env.sh; sets packages, defaultTools" },
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

  test("a long folder lists the first entries and counts the rest", () => {
    for (let i = 0; i < 25; i++) write(join(project, ".pi", "prompts", `p${String(i).padStart(2, "0")}.md`));

    const resources = findProjectResources(project);

    expect(resources).toHaveLength(21);
    expect(resources.at(-1)).toEqual({ path: ".pi/prompts/", detail: "and 5 more" });
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
