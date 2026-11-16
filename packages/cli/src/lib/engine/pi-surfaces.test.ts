import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createSurfaceGuard, diffSnapshots, outsideSurfaces, parsePorcelain, runGitHardened, type RunGit, type Snapshot, takeSnapshot } from "./pi-surfaces";

// The surfaces guard on its own: the working-tree snapshot (ported from brigadev's worktree-snapshot) and the two extensions, driven
// through a stand-in for pi's extension API.

const snap = (entries: Record<string, string>): Snapshot => new Map(Object.entries(entries));

describe("diffSnapshots", () => {
  test("a new untracked file, a first change to a tracked file, a further change to a dirty one", () => {
    expect(diffSnapshots(snap({}), snap({ "src/new.ts": "h1" }))).toEqual(["src/new.ts"]);
    expect(diffSnapshots(snap({}), snap({ "src/a.ts": "h1" }))).toEqual(["src/a.ts"]);
    expect(diffSnapshots(snap({ "src/a.ts": "h1" }), snap({ "src/a.ts": "h2" }))).toEqual(["src/a.ts"]);
  });

  test("a deletion, and both sides of a rename", () => {
    expect(diffSnapshots(snap({ "src/a.ts": "h1" }), snap({ "src/a.ts": "-" }))).toEqual(["src/a.ts"]);
    expect(diffSnapshots(snap({ "src/new.ts": "h1" }), snap({}))).toEqual(["src/new.ts"]);
    expect(diffSnapshots(snap({}), snap({ "src/new.ts": "h1", "src/old.ts": "-" }))).toEqual(["src/new.ts", "src/old.ts"]);
  });

  test("an unchanged dirty file is not reported, and the paths come sorted", () => {
    expect(diffSnapshots(snap({ "src/a.ts": "h1", "b.ts": "h2" }), snap({ "src/a.ts": "h1", "b.ts": "h2" }))).toEqual([]);
    expect(diffSnapshots(snap({}), snap({ b: "1", a: "1" }))).toEqual(["a", "b"]);
  });
});

describe("outsideSurfaces", () => {
  test("keeps only the paths outside every surface", () => {
    expect(outsideSurfaces(["src/a.ts", "tests/a.test.ts", "README.md"], ["src", "tests/*.test.ts"])).toEqual(["README.md"]);
  });
});

describe("parsePorcelain", () => {
  test("modified, untracked and deleted entries; a rename with its original path; nothing for empty output", () => {
    expect(parsePorcelain(" M src/a.ts\0?? new.ts\0 D gone.ts\0")).toEqual(["src/a.ts", "new.ts", "gone.ts"]);
    expect(parsePorcelain("R  new.ts\0old.ts\0 M a.ts\0")).toEqual(["new.ts", "old.ts", "a.ts"]);
    expect(parsePorcelain("")).toEqual([]);
  });
});

describe("takeSnapshot against a real repository", () => {
  let root: string;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-snap-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("detects new, further-modified, deleted and renamed files, and ignores a file that was already dirty and did not change", async () => {
    git(root, "init", "-q");
    mkdirSync(join(root, "src"));
    for (const [file, content] of [["src/a.ts", "one\n"], ["src/b.ts", "b\n"], ["keep.txt", "keep\n"]] as const) writeFileSync(join(root, file), content);
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    writeFileSync(join(root, "src", "a.ts"), "two\n");
    writeFileSync(join(root, "keep.txt"), "dirty\n");

    const before = await takeSnapshot(runGitHardened, root);
    expect(before).toBeDefined();
    expect([...before!.keys()].sort()).toEqual(["keep.txt", "src/a.ts"]);

    writeFileSync(join(root, "src", "a.ts"), "three\n");
    writeFileSync(join(root, "new.txt"), "new\n");
    rmSync(join(root, "src", "b.ts"));
    const after = await takeSnapshot(runGitHardened, root);
    expect(diffSnapshots(before!, after!)).toEqual(["new.txt", "src/a.ts", "src/b.ts"]);

    renameSync(join(root, "new.txt"), join(root, "moved.txt"));
    expect(diffSnapshots(after!, (await takeSnapshot(runGitHardened, root))!)).toEqual(["moved.txt", "new.txt"]);
  });

  test("is limited to the project root inside a larger repository, with paths relative to it", async () => {
    git(root, "init", "-q");
    mkdirSync(join(root, "pkg"));
    const before = await takeSnapshot(runGitHardened, join(root, "pkg"));
    writeFileSync(join(root, "pkg", "x.txt"), "x\n");
    writeFileSync(join(root, "other.txt"), "o\n");
    appendFileSync(join(root, "pkg", "x.txt"), "more\n");
    const after = await takeSnapshot(runGitHardened, join(root, "pkg"));
    expect(diffSnapshots(before!, after!)).toEqual(["x.txt"]);
  });

  test("a symlink is marked by where it points, and an odd file name survives", async () => {
    git(root, "init", "-q");
    const before = await takeSnapshot(runGitHardened, root);
    symlinkSync("target-a", join(root, "link"));
    writeFileSync(join(root, "a b\nc.txt"), "x");
    const first = await takeSnapshot(runGitHardened, root);
    expect(diffSnapshots(before!, first!)).toEqual(["a b\nc.txt", "link"]);
    rmSync(join(root, "link"));
    symlinkSync("target-b", join(root, "link"));
    expect(diffSnapshots(first!, (await takeSnapshot(runGitHardened, root))!)).toEqual(["link"]);
  });

  test("returns undefined outside a repository, or when git cannot run", async () => {
    expect(await takeSnapshot(runGitHardened, root)).toBeUndefined();
    expect(await takeSnapshot(async () => null, root)).toBeUndefined();
    expect(await takeSnapshot(async () => { throw new Error("no git"); }, root)).toBeUndefined();
  });
});

type Handler = (event: Record<string, unknown>) => unknown;

/** The handlers an extension registers on a stand-in for pi's API. */
function load(factory: ExtensionFactory) {
  const handlers: Record<string, Handler[]> = {};
  factory({ on: (name: string, handler: Handler) => (handlers[name] ??= []).push(handler) } as unknown as ExtensionAPI);
  const emit = async (name: string, event: Record<string, unknown>) => {
    let result: unknown;
    for (const handler of handlers[name] ?? []) result = (await handler(event)) ?? result;
    return result as { block?: boolean; reason?: string; content?: { type: string; text: string }[]; isError?: boolean } | undefined;
  };
  return { handlers, emit };
}

describe("the gate", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-gate-")));
    mkdirSync(join(root, "src"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const gateFor = (surfaces: string[]) => load(createSurfaceGuard({ cwd: root, surfaces, runGit: async () => null }).gate);
  const call = (toolName: string, input: Record<string, unknown>) => ({ toolName, toolCallId: "c1", input });

  test("edit and write: a path inside the surfaces passes, one outside is blocked with a reason that names the path and the surfaces", async () => {
    const { emit } = gateFor(["src/a.ts", "tests/**"]);
    for (const tool of ["write", "edit"]) {
      expect(await emit("tool_call", call(tool, { path: "src/a.ts" }))).toBeUndefined();
      expect(await emit("tool_call", call(tool, { path: join(root, "tests", "deep", "x.ts") }))).toBeUndefined();
      const blocked = await emit("tool_call", call(tool, { path: "src/b.ts" }));
      expect(blocked?.block).toBe(true);
      expect(blocked?.reason).toContain("src/b.ts is outside the allowed edit surfaces (src/a.ts, tests/**)");
    }
  });

  test("a path outside the project root is blocked as given; the project root itself too", async () => {
    const { emit } = gateFor(["src/a.ts"]);
    expect((await emit("tool_call", call("write", { path: "../elsewhere.txt" })))?.reason).toContain("../elsewhere.txt is outside");
    expect((await emit("tool_call", call("write", { path: "/etc/hosts" })))?.block).toBe(true);
    expect((await emit("tool_call", call("write", { path: "." })))?.block).toBe(true);
    expect((await emit("tool_call", call("write", { path: "~/x.txt" })))?.block).toBe(true);
  });

  test("a symlink inside the surfaces that leads outside them is judged by where it leads", async () => {
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other", "f.txt"), "x");
    symlinkSync(join(root, "other", "f.txt"), join(root, "src", "a.ts"));
    const { emit } = gateFor(["src/a.ts"]);
    const blocked = await emit("tool_call", call("write", { path: "src/a.ts" }));
    expect(blocked?.reason).toContain("other/f.txt is outside");
    // A dangling link cannot be told: refused.
    symlinkSync(join(root, "missing", "x"), join(root, "src", "dangling"));
    expect((await gateFor(["src/dangling"]).emit("tool_call", call("write", { path: "src/dangling" })))?.block).toBe(true);
  });

  test("a call with no path, and tools it does not judge, pass", async () => {
    const { emit } = gateFor(["src/a.ts"]);
    expect(await emit("tool_call", call("write", {}))).toBeUndefined();
    expect(await emit("tool_call", call("read", { path: "README.md" }))).toBeUndefined();
    expect(await emit("tool_call", call("todo", { action: "list" }))).toBeUndefined();
  });

  test("bash: a literal write outside the surfaces is blocked, a write inside or a read passes", async () => {
    const { emit } = gateFor(["src/a.ts"]);
    expect(await emit("tool_call", call("bash", { command: "echo x > src/a.ts" }))).toBeUndefined();
    expect(await emit("tool_call", call("bash", { command: "cat README.md | grep x" }))).toBeUndefined();
    expect(await emit("tool_call", call("bash", { command: "echo x > /tmp/scratch.txt" }))).toBeUndefined();
    const blocked = await emit("tool_call", call("bash", { command: "echo x > src/b.ts && touch README.md" }));
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("this command writes src/b.ts, README.md, outside the allowed edit surfaces (src/a.ts)");
  });

  test("bg_start runs in its working_dir: the same judgement from there", async () => {
    const { emit } = gateFor(["src/a.ts"]);
    expect(await emit("tool_call", call("bg_start", { command: "echo x > a.ts", working_dir: "src" }))).toBeUndefined();
    expect((await emit("tool_call", call("bg_start", { command: "echo x > b.ts", working_dir: "src" })))?.reason).toContain("writes src/b.ts");
  });
});

describe("the watch", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-watch-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A git that answers `status` with the files `trees.shift()` lists (path to content marker), so the tree "changes" between calls. */
  const fakeGit = (trees: Record<string, string>[]): RunGit => {
    let current: Record<string, string> = {};
    return async (_cwd, args) => {
      if (args[0] === "rev-parse") return { out: `${root}\n`, code: 0 };
      current = trees.shift() ?? current;
      for (const [path, content] of Object.entries(current)) writeFileSync(join(root, path), content);
      return { out: Object.keys(current).map((path) => ` M ${path}\0`).join(""), code: 0 };
    };
  };

  const bashCall = { toolName: "bash", toolCallId: "b1", input: { command: "make" } };
  const result = { toolName: "bash", toolCallId: "b1", content: [{ type: "text", text: "built" }], isError: false };

  test("a bash call that changed a file outside the surfaces gets a notice and is marked as an error", async () => {
    mkdirSync(join(root, "src"));
    const guard = createSurfaceGuard({ cwd: root, surfaces: ["src/a.ts"], runGit: fakeGit([{}, { "src/b.ts": "NEW" }]) });
    const { emit } = load(guard.watch);
    expect(await emit("tool_call", bashCall)).toBeUndefined();
    const flagged = await emit("tool_result", result);
    expect(flagged?.isError).toBe(true);
    expect(flagged?.content?.map((block) => block.text)).toEqual(["built", "[marcsh] This command changed files outside your allowed edit surfaces: src/b.ts. Do not change files through bash; report these paths to the parent."]);
  });

  test("a change inside the surfaces, or none, leaves the result alone", async () => {
    mkdirSync(join(root, "src"));
    const inside = createSurfaceGuard({ cwd: root, surfaces: ["src/a.ts"], runGit: fakeGit([{}, { "src/a.ts": "NEW" }]) });
    const watched = load(inside.watch);
    await watched.emit("tool_call", bashCall);
    expect(await watched.emit("tool_result", result)).toBeUndefined();
    expect(await inside.outside()).toEqual([]);
  });

  test("other writers' surfaces are not counted against this one", async () => {
    mkdirSync(join(root, "docs"));
    const guard = createSurfaceGuard({ cwd: root, surfaces: ["src/a.ts"], others: () => ["docs/**"], runGit: fakeGit([{}, { "docs/x.md": "NEW" }]) });
    const watched = load(guard.watch);
    await watched.emit("tool_call", bashCall);
    expect(await watched.emit("tool_result", result)).toBeUndefined();
  });

  test("only bash is watched, and a result with no recorded start is left alone", async () => {
    const guard = createSurfaceGuard({ cwd: root, surfaces: ["src/a.ts"], runGit: async () => null });
    const { emit } = load(guard.watch);
    await emit("tool_call", { toolName: "write", toolCallId: "w1", input: { path: "src/a.ts" } });
    expect(await emit("tool_result", { ...result, toolName: "write", toolCallId: "w1" })).toBeUndefined();
    expect(await emit("tool_result", result)).toBeUndefined();
    expect(await guard.outside()).toEqual([]);
  });

  test("outside() is the whole run since the first bash call; without a bash call, or without git, it is empty", async () => {
    mkdirSync(join(root, "src"));
    const trees: Record<string, string>[] = [{}, { "src/a.ts": "ONE", "README.md": "X" }];
    const guard = createSurfaceGuard({ cwd: root, surfaces: ["src/a.ts"], runGit: fakeGit(trees) });
    expect(await guard.outside()).toEqual([]);
    const { emit } = load(guard.watch);
    await emit("tool_call", bashCall);
    expect(await guard.outside()).toEqual(["README.md"]);

    const noGit = createSurfaceGuard({ cwd: root, surfaces: ["src/a.ts"], runGit: async () => null });
    await load(noGit.watch).emit("tool_call", bashCall);
    expect(await noGit.outside()).toEqual([]);
  });
});
