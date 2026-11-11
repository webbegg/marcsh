import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { openStorage } from "../storage";
import {
  diffReview,
  isProjectTrusted,
  resolveProjectTrust,
  reviewProject,
  sameReview,
  unreadableResources,
  type ProjectTrustAsk,
  type TrustAnswer,
} from "./pi-trust";

let root: string;
let project: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-pi-review-")));
  project = join(root, "work", "project");
  home = join(root, "home");
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
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
const mcp = (server: unknown) => write(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fx: server } }));
const record = () => reviewProject(project).record;

describe("the review record (S1)", () => {
  test("the same files give an equal record, run after run", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "export default 1");
    mcp({ command: "node", args: ["s.js"] });

    expect(sameReview(record(), record())).toBe(true);
  });

  test("it has one entry per listed path, in path order", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "export default 1");
    mcp({ command: "node", args: ["s.js"], env: { A: "1" } });

    expect(record().map((entry) => entry.path)).toEqual([".pi/extensions/foo.ts", ".pi/mcp.json"]);
  });

  test("a changed file content is a different record", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "export default 1");
    const before = record();

    write(join(project, ".pi", "extensions", "foo.ts"), "export default 2");

    expect(sameReview(before, record())).toBe(false);
  });

  test("a new file is a different record", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "x");
    const before = record();

    write(join(project, ".pi", "extensions", "bar.ts"), "y");

    expect(sameReview(before, record())).toBe(false);
  });

  test("a removed file is a different record", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "x");
    write(join(project, ".pi", "extensions", "bar.ts"), "y");
    const before = record();

    rmSync(join(project, ".pi", "extensions", "bar.ts"));

    expect(sameReview(before, record())).toBe(false);
  });

  test("a change in what mcp.json shows (the command's arguments) is a different record", () => {
    mcp({ command: "node", args: ["a.js"] });
    const before = record();

    mcp({ command: "node", args: ["b.js"] });

    expect(sameReview(before, record())).toBe(false);
  });

  test("a change to a value mcp.json does not show is still a different record (the content hash)", () => {
    mcp({ command: "node", timeout: 1 });
    const before = record();

    mcp({ command: "node", timeout: 2 });

    expect(sameReview(before, record())).toBe(false);
  });

  test("a change deep inside a listed folder is a different record", () => {
    write(join(project, ".pi", "skills", "review", "SKILL.md"), "---\nname: review\n---\n");
    write(join(project, ".pi", "skills", "review", "scripts", "run.sh"), "echo 1");
    const before = record();

    write(join(project, ".pi", "skills", "review", "scripts", "run.sh"), "echo 2");

    expect(sameReview(before, record())).toBe(false);
  });

  test("a new file deep inside a listed folder is a different record", () => {
    write(join(project, ".pi", "skills", "review", "SKILL.md"), "x");
    const before = record();

    write(join(project, ".pi", "skills", "review", "extra.sh"), "echo");

    expect(sameReview(before, record())).toBe(false);
  });

  test("a symlinked folder is followed: changes behind it count", () => {
    write(join(root, "shared", "SKILL.md"), "v1");
    mkdirSync(join(project, ".pi", "skills"), { recursive: true });
    symlinkSync(join(root, "shared"), join(project, ".pi", "skills", "linked"));
    const before = record();

    write(join(root, "shared", "SKILL.md"), "v2");

    expect(sameReview(before, record())).toBe(false);
  });

  test("only paths and hashes are stored: no contents, commands or env values appear anywhere in the record", () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "SECRET-EXTENSION-BODY");
    mcp({ command: "SECRET-COMMAND", args: ["SECRET-ARG"], env: { TOKEN: "SECRET-ENV-VALUE" } });

    const json = JSON.stringify(record());

    for (const secret of ["SECRET-EXTENSION-BODY", "SECRET-COMMAND", "SECRET-ARG", "SECRET-ENV-VALUE", "TOKEN"]) expect(json.includes(secret)).toBe(false);
    for (const entry of record()) {
      expect(Object.keys(entry).sort()).toEqual(["content", "path", "shown"]);
      expect(entry.shown).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.content).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("a child file marcsh cannot read safely is listed as unreadable, so trusting stays impossible", () => {
    write(join(project, ".pi", "extensions", "big.ts"), "x".repeat(1024 * 1024 + 1));

    const { resources } = reviewProject(project);

    expect(resources).toEqual([{ path: ".pi/extensions/big.ts", detail: "could not be read: larger than 1 MB", unreadable: true }]);
  });

  test("a folder with a child it cannot read is unreadable as a whole, naming the child", () => {
    write(join(project, ".pi", "skills", "s", "SKILL.md"), "x");
    write(join(project, ".pi", "skills", "s", "data", "huge.bin"), "x".repeat(1024 * 1024 + 1));

    const { resources } = reviewProject(project);

    expect(resources).toEqual([{ path: ".pi/skills/s/", detail: "could not be read: data/huge.bin: larger than 1 MB", unreadable: true }]);
  });

  test("a folder with too many files is unreadable (the scan stays bounded)", () => {
    for (let i = 0; i < 1100; i++) write(join(project, ".pi", "skills", "s", `f${i}.md`), "x");

    const { resources } = reviewProject(project);

    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ path: ".pi/skills/s/", unreadable: true });
  });

  // R4-003: the caps count every listed entry and every file, not only the children of folders, so tiny top-level files cannot make a review unbounded.
  test("many tiny top-level files are unreadable past the cap, so trust is impossible", () => {
    for (let i = 0; i < 1100; i++) write(join(project, ".pi", "extensions", `e${String(i).padStart(4, "0")}.ts`), "x");

    const { resources } = reviewProject(project);

    expect(resources).toHaveLength(1100);
    expect(unreadableResources(resources).length).toBeGreaterThan(0);
    expect(resources.filter((resource) => !resource.unreadable)).toHaveLength(1000);
    expect(unreadableResources(resources)[0]).toMatchObject({ detail: expect.stringContaining("more than 1000 files to review") });
  });

  test("entries of different kinds share the one cap, and a folder's files count as well", () => {
    for (let i = 0; i < 600; i++) write(join(project, ".pi", "extensions", `e${i}.ts`), "x");
    for (let i = 0; i < 300; i++) write(join(project, ".pi", "skills", "s", `f${i}.md`), "x");
    expect(unreadableResources(reviewProject(project).resources)).toHaveLength(0);

    for (let i = 0; i < 200; i++) write(join(project, ".pi", "prompts", `p${i}.md`), "x");

    expect(unreadableResources(reviewProject(project).resources).length).toBeGreaterThan(0);
  });

  test("a project just under the cap is still reviewed in full", () => {
    for (let i = 0; i < 900; i++) write(join(project, ".pi", "extensions", `e${i}.ts`), "x");

    const { resources, record: reviewed } = reviewProject(project);

    expect(unreadableResources(resources)).toHaveLength(0);
    expect(reviewed).toHaveLength(900);
  });

  test("an unreadable child (no permission) makes its entry unreadable", () => {
    write(join(project, ".pi", "extensions", "locked.ts"), "x");
    chmodSync(join(project, ".pi", "extensions", "locked.ts"), 0o000);

    try {
      expect(reviewProject(project).resources).toEqual([{ path: ".pi/extensions/locked.ts", detail: "could not be read: cannot be opened or read", unreadable: true }]);
    } finally {
      chmodSync(join(project, ".pi", "extensions", "locked.ts"), 0o600);
    }
  });
});

const settings = (value: unknown) => write(join(project, ".pi", "settings.json"), JSON.stringify(value));
const listed = () => reviewProject(project).resources.filter((resource) => resource.path !== ".pi/settings.json");

describe("files that .pi/settings.json makes pi load (S1)", () => {
  test("an extensions path is read from the .pi folder, so ../tools/ext.ts is the project's tools folder: listed, and a change is a different record", () => {
    write(join(project, "tools", "ext.ts"), "v1");
    settings({ extensions: ["../tools/ext.ts"] });
    const before = record();

    expect(listed()).toEqual([{ path: "tools/ext.ts", detail: "named by .pi/settings.json (extensions: ../tools/ext.ts)" }]);
    expect(before.map((entry) => entry.path)).toEqual([".pi/settings.json", "tools/ext.ts"]);

    write(join(project, "tools", "ext.ts"), "v2");
    expect(sameReview(before, record())).toBe(false);
  });

  test("a target outside the project folder is listed with its resolved path; ~ is the user's home", () => {
    write(join(root, "work", "outside", "ext.ts"), "v1");
    write(join(home, "home-ext.ts"), "v1");
    settings({ extensions: ["../../outside/ext.ts", "~/home-ext.ts", ` ${join(home, "home-ext.ts")} `] });
    const before = record();

    expect(listed().map((resource) => resource.path)).toEqual([join(root, "work", "outside", "ext.ts"), join(home, "home-ext.ts")]);

    write(join(root, "work", "outside", "ext.ts"), "v2");
    expect(sameReview(before, record())).toBe(false);
  });

  for (const key of ["skills", "prompts", "themes"]) {
    test(`a ${key} path outside .pi: its folder is listed, and a changed or added file is a different record`, () => {
      write(join(project, "shared", "a", "one.md"), "v1");
      settings({ [key]: ["../shared"] });
      const before = record();

      expect(listed()).toEqual([{ path: "shared/a/", detail: `named by .pi/settings.json (${key}: ../shared)` }]);

      write(join(project, "shared", "a", "one.md"), "v2");
      const edited = record();
      expect(sameReview(before, edited)).toBe(false);
      write(join(project, "shared", "b", "two.md"), "v1");
      expect(sameReview(edited, record())).toBe(false);
    });
  }

  test("the old skills format ({ customDirectories }) is read as pi reads it", () => {
    write(join(project, "old", "s", "SKILL.md"), "v1");
    settings({ skills: { customDirectories: ["../old"] } });

    expect(listed().map((resource) => resource.path)).toEqual(["old/s/"]);
  });

  test("pattern entries (!, +, -, * and ?) are filters, not paths; a missing path is not listed until it exists", () => {
    write(join(project, "tools", "ext.ts"), "v1");
    settings({ extensions: ["-../tools/ext.ts", "+../tools/ext.ts", "!../tools/ext.ts", "../tools/*.ts", "../tools/e?t.ts", "../missing.ts", 7, null] });
    const before = record();

    expect(listed()).toEqual([]);

    write(join(project, "missing.ts"), "v1");
    expect(listed().map((resource) => resource.path)).toEqual(["missing.ts"]);
    expect(diffReview(before, record()).status.get("missing.ts")).toBe("added");
  });

  test("a local package is its folder, resolved from .pi: its files are listed and a change deep inside is a different record", () => {
    write(join(project, "localpkg", "package.json"), JSON.stringify({ name: "localpkg", pi: { extensions: ["./extensions"] } }));
    write(join(project, "localpkg", "extensions", "e.ts"), "v1");
    settings({ packages: ["../localpkg", { source: "../localpkg", skills: [] }] });
    const before = record();

    expect(listed().map((resource) => resource.path)).toEqual(["localpkg/extensions/", "localpkg/package.json"]);
    expect(listed()[0]?.detail).toBe("named by .pi/settings.json (packages: ../localpkg)");

    write(join(project, "localpkg", "extensions", "e.ts"), "v2");
    expect(sameReview(before, record())).toBe(false);
  });

  test("a package.json that points outside its package: the target is part of the review", () => {
    write(join(project, "localpkg", "package.json"), JSON.stringify({ name: "p", pi: { extensions: ["../shared/ext.ts", "../globbed/*.ts", "!../shared/ext.ts"] } }));
    write(join(project, "shared", "ext.ts"), "v1");
    write(join(project, "globbed", "g.ts"), "v1");
    settings({ packages: ["../localpkg"] });
    const before = record();

    expect(listed().map((resource) => resource.path)).toEqual(["localpkg/package.json", "shared/ext.ts", "globbed/g.ts"]);
    expect(listed()[1]?.detail).toBe("named by localpkg/package.json");

    write(join(project, "shared", "ext.ts"), "v2");
    const edited = record();
    expect(sameReview(before, edited)).toBe(false);
    write(join(project, "globbed", "new.ts"), "v1");
    expect(sameReview(edited, record())).toBe(false);
  });

  test("an extension folder under .pi/extensions whose package.json points outside it: the target is part of the review", () => {
    write(join(project, ".pi", "extensions", "pkg", "package.json"), JSON.stringify({ pi: { extensions: ["../../../tools/e.ts"] } }));
    write(join(project, "tools", "e.ts"), "v1");
    const before = record();

    expect(reviewProject(project).resources.map((resource) => resource.path)).toEqual([".pi/extensions/pkg/", "tools/e.ts"]);

    write(join(project, "tools", "e.ts"), "v2");
    expect(sameReview(before, record())).toBe(false);
  });

  test("an npm package pi installed into the project is listed, in the place pi installs it; one that is not installed is covered by the settings entry", () => {
    settings({ packages: ["npm:@scope/x@1.2.3", "npm:y"] });
    expect(listed()).toEqual([]);
    write(join(project, ".pi", "npm", "node_modules", "unrelated", "index.ts"), "v1");
    expect(listed()).toEqual([]);
    const before = record();

    write(join(project, ".pi", "npm", "node_modules", "@scope", "x", "index.ts"), "v1");
    write(join(project, ".pi", "npm", "node_modules", "y", "package.json"), "{}");
    const installed = record();

    expect(listed()).toEqual([
      { path: ".pi/npm/node_modules/@scope/x/index.ts", detail: "named by .pi/settings.json (packages: npm:@scope/x@1.2.3)" },
      { path: ".pi/npm/node_modules/y/package.json", detail: "named by .pi/settings.json (packages: npm:y)" },
    ]);
    expect(diffReview(before, installed).status.get(".pi/npm/node_modules/@scope/x/index.ts")).toBe("added");

    write(join(project, ".pi", "npm", "node_modules", "@scope", "x", "index.ts"), "v2");
    expect(sameReview(installed, record())).toBe(false);
  });

  test("git packages pi cloned into the project are listed with the clone's files but not its .git folder", () => {
    settings({ packages: ["github:owner/repo"] });
    write(join(project, ".pi", "git", "github.com", "owner", "repo", "ext.ts"), "v1");
    write(join(project, ".pi", "git", "github.com", "owner", "repo", ".git", "HEAD"), "ref: a");
    const before = record();

    expect(listed().map((resource) => resource.path)).toEqual([".pi/git/github.com/"]);
    expect(listed()[0]?.detail).toBe("named by .pi/settings.json (packages: github:owner/repo)");

    write(join(project, ".pi", "git", "github.com", "owner", "repo", ".git", "HEAD"), "ref: b");
    expect(sameReview(before, record())).toBe(true);
    write(join(project, ".pi", "git", "github.com", "owner", "repo", "ext.ts"), "v2");
    expect(sameReview(before, record())).toBe(false);
  });

  test("without a git package in the settings, a .pi/git folder is not part of the review", () => {
    settings({ packages: ["npm:y"] });
    write(join(project, ".pi", "git", "github.com", "owner", "repo", "ext.ts"), "v1");

    expect(listed()).toEqual([]);
  });

  test("a source pi cannot parse as git is a path under .pi, as pi reads it", () => {
    write(join(project, ".pi", "https:", "foo", "index.ts"), "v1");
    settings({ packages: ["https://foo"] });

    expect(listed().map((resource) => resource.path)).toEqual([".pi/https:/foo/index.ts"]);
  });

  test("a target marcsh cannot read in full is unreadable, so trusting stays impossible", () => {
    write(join(project, "tools", "big.ts"), "x".repeat(1024 * 1024 + 1));
    settings({ extensions: ["../tools/big.ts"] });

    expect(listed()).toEqual([{ path: "tools/big.ts", detail: "could not be read: larger than 1 MB", unreadable: true }]);
  });

  test("the target's name is shown escaped", () => {
    write(join(project, "tools", "a\nb.ts"), "v1");
    settings({ extensions: ["../tools"] });

    expect(listed().map((resource) => resource.path)).toEqual(["tools/a\\nb.ts"]);
  });

  test("everything pi resolves for the project is covered by the review (pi's own package manager, offline)", async () => {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    write(join(project, "tools", "ext.ts"), "x");
    write(join(project, "tools", "dir-ext", "index.ts"), "x");
    write(join(project, "myskills", "a", "SKILL.md"), "---\nname: a\ndescription: d\n---\n");
    write(join(project, "myprompts", "p.md"), "x");
    write(join(project, "mythemes", "t.json"), "{}");
    write(join(root, "work", "outside", "o.ts"), "x");
    write(join(project, "localpkg", "package.json"), JSON.stringify({ pi: { extensions: ["./ext", "../shared/s.ts"], skills: ["./sk"] } }));
    write(join(project, "localpkg", "ext", "e.ts"), "x");
    write(join(project, "localpkg", "sk", "b", "SKILL.md"), "---\nname: b\ndescription: d\n---\n");
    write(join(project, "shared", "s.ts"), "x");
    write(join(project, "filelocal.ts"), "x");
    write(join(project, ".pi", "npm", "node_modules", "npmpkg", "package.json"), JSON.stringify({ version: "1.0.0", pi: { extensions: ["./index.ts"] } }));
    write(join(project, ".pi", "npm", "node_modules", "npmpkg", "index.ts"), "x");
    write(join(project, ".pi", "git", "github.com", "owner", "repo", "extensions", "g.ts"), "x");
    write(join(project, ".pi", "extensions", "auto.ts"), "x");
    write(join(project, ".agents", "skills", "c", "SKILL.md"), "---\nname: c\ndescription: d\n---\n");
    settings({
      extensions: ["../tools/ext.ts", "../tools/dir-ext", "../../outside/o.ts"],
      skills: ["../myskills"],
      prompts: ["../myprompts"],
      themes: ["../mythemes"],
      packages: ["../localpkg", "../filelocal.ts", "npm:npmpkg", "github:owner/repo"],
    });
    const savedOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    try {
      const settingsManager = SettingsManager.create(project, agentDir);
      const resolved = await new DefaultPackageManager({ cwd: project, agentDir, settingsManager }).resolve();
      const covered = reviewProject(project).resources.map((resource) => (isAbsolute(resource.path) ? resource.path : join(project, resource.path)).replace(/\/$/, ""));
      const viaProject = [...resolved.extensions, ...resolved.skills, ...resolved.prompts, ...resolved.themes].filter((entry) => entry.metadata.scope === "project");

      expect(viaProject.length).toBeGreaterThan(8);
      for (const { path } of viaProject) expect({ path, covered: covered.some((entry) => path === entry || path.startsWith(`${entry}${sep}`)) }).toEqual({ path, covered: true });
    } finally {
      if (savedOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = savedOffline;
    }
  });
});

describe("diffReview", () => {
  test("marks each entry added, changed or unchanged, and lists removed paths", () => {
    write(join(project, ".pi", "extensions", "same.ts"), "1");
    write(join(project, ".pi", "extensions", "edit.ts"), "1");
    write(join(project, ".pi", "extensions", "gone.ts"), "1");
    const before = record();

    write(join(project, ".pi", "extensions", "edit.ts"), "2");
    write(join(project, ".pi", "extensions", "new.ts"), "1");
    rmSync(join(project, ".pi", "extensions", "gone.ts"));

    const changes = diffReview(before, record());

    expect(changes.known).toBe(true);
    expect(Object.fromEntries(changes.status)).toEqual({
      ".pi/extensions/edit.ts": "changed",
      ".pi/extensions/new.ts": "added",
      ".pi/extensions/same.ts": "unchanged",
    });
    expect(changes.removed).toEqual([".pi/extensions/gone.ts"]);
  });

  test("with no earlier record nothing can be compared", () => {
    write(join(project, ".pi", "extensions", "a.ts"), "1");

    const changes = diffReview(null, record());

    expect(changes.known).toBe(false);
    expect(changes.status.size).toBe(0);
    expect(changes.removed).toEqual([]);
  });
});

/** A project with one extension, trusted as it is now. */
function trustedProject() {
  write(join(project, ".pi", "extensions", "foo.ts"), "v1");
  const storage = openStorage(":memory:");
  storage.setProjectTrust(project, "trusted", record());
  return storage;
}

function resolveWith(storage: ReturnType<typeof openStorage>, answer?: TrustAnswer | (() => TrustAnswer)) {
  const asks: ProjectTrustAsk[] = [];
  const ask = answer
    ? async (request: ProjectTrustAsk) => {
        asks.push(request);
        return typeof answer === "function" ? answer() : answer;
      }
    : undefined;
  const resolve = () => resolveProjectTrust({ cwd: project, records: () => storage, ask, signal: new AbortController().signal });
  return { asks, resolve };
}

describe("a stored 'trusted' counts only while the files are as reviewed", () => {
  test("unchanged: trusted without asking, in the turn and in warm-up", async () => {
    const storage = trustedProject();
    const { asks, resolve } = resolveWith(storage, "skip");

    expect(await resolve()).toBe(true);
    expect(isProjectTrusted(project, () => storage)).toBe(true);
    expect(asks).toEqual([]);
  });

  for (const [label, change] of [
    ["a file changed", () => write(join(project, ".pi", "extensions", "foo.ts"), "v2")],
    ["a file added", () => write(join(project, ".pi", "extensions", "new.ts"), "x")],
    ["a file removed", () => (write(join(project, ".pi", "extensions", "other.ts"), "x"), rmSync(join(project, ".pi", "extensions", "foo.ts")))],
    ["an mcp.json appears", () => mcp({ command: "node" })],
  ] as const) {
    test(`${label}: warm-up does not trust, and the turn asks with the changes`, async () => {
      const storage = trustedProject();
      change();
      const { asks, resolve } = resolveWith(storage, "skip");

      expect(isProjectTrusted(project, () => storage)).toBe(false);
      expect(await resolve()).toBe(false);

      expect(asks).toHaveLength(1);
      expect(asks[0]!.changes?.known).toBe(true);
      // Esc stores nothing: the stored row is as it was.
      expect(storage.getProjectTrust(project)).toBe("trusted");
    });
  }

  test("the ask names what changed", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    write(join(project, ".pi", "extensions", "new.ts"), "x");
    const { asks, resolve } = resolveWith(storage, "skip");

    await resolve();

    expect(Object.fromEntries(asks[0]!.changes!.status)).toEqual({ ".pi/extensions/foo.ts": "changed", ".pi/extensions/new.ts": "added" });
  });

  test("a removed entry is named in the ask", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "other.ts"), "x");
    storage.setProjectTrust(project, "trusted", record());
    rmSync(join(project, ".pi", "extensions", "foo.ts"));
    const { asks, resolve } = resolveWith(storage, "skip");

    await resolve();

    expect(asks[0]!.changes!.removed).toEqual([".pi/extensions/foo.ts"]);
  });

  test("'trust' stores the new record, so the next turn and warm-up trust without asking", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    const { asks, resolve } = resolveWith(storage, "trust");

    expect(await resolve()).toBe(true);
    expect(await resolve()).toBe(true);

    expect(asks).toHaveLength(1);
    expect(isProjectTrusted(project, () => storage)).toBe(true);
    expect(sameReview(storage.getProjectReview(project)!, record())).toBe(true);
  });

  test("'trust' is not stored when the files change while the question is open", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    const { resolve } = resolveWith(storage, () => (write(join(project, ".pi", "extensions", "foo.ts"), "v3"), "trust"));

    expect(await resolve()).toBe(false);

    expect(isProjectTrusted(project, () => storage)).toBe(false);
  });

  test("'distrust' stores untrusted and drops the record; it is not asked about again", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    const { asks, resolve } = resolveWith(storage, "distrust");

    expect(await resolve()).toBe(false);
    expect(await resolve()).toBe(false);

    expect(storage.getProjectTrust(project)).toBe("untrusted");
    expect(storage.getProjectReview(project)).toBeNull();
    expect(asks).toHaveLength(1);
  });

  test("a stored 'untrusted' stays untrusted without asking, whatever changes", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "v1");
    const storage = openStorage(":memory:");
    storage.setProjectTrust(project, "untrusted");
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    const { asks, resolve } = resolveWith(storage, "trust");

    expect(await resolve()).toBe(false);

    expect(asks).toEqual([]);
  });

  test("a 'trusted' row that has no record (stored before reviews existed) asks again, with nothing to compare", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "v1");
    const storage = openStorage(":memory:");
    storage.setProjectTrust(project, "trusted");
    const { asks, resolve } = resolveWith(storage, "skip");

    expect(isProjectTrusted(project, () => storage)).toBe(false);
    expect(await resolve()).toBe(false);

    expect(asks).toHaveLength(1);
    expect(asks[0]!.changes?.known).toBe(false);
  });

  test("with nobody to ask, a changed project is untrusted", async () => {
    const storage = trustedProject();
    write(join(project, ".pi", "extensions", "foo.ts"), "v2");
    const { resolve } = resolveWith(storage);

    expect(await resolve()).toBe(false);
  });

  test("a store without review support never trusts a 'trusted' row", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "v1");
    const records = { getProjectTrust: () => "trusted" as const, setProjectTrust: () => {} };

    expect(isProjectTrusted(project, () => records)).toBe(false);
  });

  test("a record that cannot be read from the store never trusts", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "v1");
    const records = {
      getProjectTrust: () => "trusted" as const,
      getProjectReview: () => {
        throw new Error("disk is gone");
      },
      setProjectTrust: () => {},
    };

    expect(isProjectTrusted(project, () => records)).toBe(false);
    expect(await resolveProjectTrust({ cwd: project, records: () => records, signal: new AbortController().signal })).toBe(false);
  });

  test("an undecided project asks without changes, and 'trust' stores the record with the decision", async () => {
    write(join(project, ".pi", "extensions", "foo.ts"), "v1");
    const storage = openStorage(":memory:");
    const { asks, resolve } = resolveWith(storage, "trust");

    expect(await resolve()).toBe(true);

    expect(asks[0]!.changes).toBeUndefined();
    expect(sameReview(storage.getProjectReview(project)!, record())).toBe(true);
  });
});
