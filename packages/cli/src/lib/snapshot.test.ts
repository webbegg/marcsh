import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSnapshotStore, defaultSnapshotRoot, type SnapshotStore } from "./snapshot";

let base: string;
let root: string;
let project: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "marcsh-snapshot-"));
  root = join(base, "snapshots");
  project = join(base, "project");
  mkdirSync(project);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const put = (dir: string, path: string, content: string) => {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

/** Runs the real git on the project itself, with a clean environment so the test never depends on the developer's config. */
const projectGit = (cwd: string, ...args: string[]) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
    cwd,
    env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
};

const open = (cwd = project): SnapshotStore => {
  const created = createSnapshotStore({ cwd, root });
  if (!created.available) throw new Error(`snapshot store unavailable: ${created.reason}`);
  return created.store;
};

/** Every file under a directory with its size and mtime, to prove nothing in it was written. */
const fingerprint = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${full}:${statSync(full).size}:${statSync(full).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort();
};

describe("snapshot store", () => {
  test("track returns a tree hash that is stable for equal content and changes with content", async () => {
    put(project, "a.txt", "one");
    const store = open();

    const first = await store.track();
    const again = await store.track();
    put(project, "a.txt", "two");
    const changed = await store.track();

    expect(first).toMatch(/^[0-9a-f]{40,64}$/);
    expect(again).toBe(first);
    expect(changed).not.toBe(first);
  });

  test("keeps the shadow git dir under root, named by a 16-hex hash of the real project path", async () => {
    put(project, "a.txt", "one");
    await open().track();

    const entries = readdirSync(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(existsSync(join(project, ".git"))).toBe(false);
  });

  test("two projects get separate shadow git dirs", async () => {
    const other = join(base, "other");
    mkdirSync(other);
    put(project, "a.txt", "one");
    put(other, "a.txt", "one");

    await open(project).track();
    await open(other).track();

    expect(readdirSync(root)).toHaveLength(2);
  });

  test("changedFiles lists added, modified and deleted paths between two trees", async () => {
    put(project, "keep.txt", "same");
    put(project, "edit.txt", "old");
    put(project, "gone.txt", "bye");
    const store = open();
    const before = await store.track();

    put(project, "edit.txt", "new");
    rmSync(join(project, "gone.txt"));
    put(project, "src/added.ts", "x");
    const after = await store.track();

    expect((await store.changedFiles(before, after)).sort()).toEqual(["edit.txt", "gone.txt", "src/added.ts"]);
  });

  test("changedFiles without `to` compares against the current work tree", async () => {
    put(project, "a.txt", "one");
    const store = open();
    const before = await store.track();
    expect(await store.changedFiles(before)).toEqual([]);

    put(project, "a.txt", "two");
    put(project, "b.txt", "new");

    expect((await store.changedFiles(before)).sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("a rename shows as one deleted and one added path", async () => {
    put(project, "old.txt", "some content that is long enough to be detected as a rename");
    const store = open();
    const before = await store.track();
    rmSync(join(project, "old.txt"));
    put(project, "new.txt", "some content that is long enough to be detected as a rename");

    expect((await store.changedFiles(before)).sort()).toEqual(["new.txt", "old.txt"]);
  });

  test("honors the project's .gitignore", async () => {
    put(project, ".gitignore", "node_modules/\n*.log\n");
    put(project, "a.txt", "one");
    const store = open();
    const before = await store.track();

    put(project, "node_modules/pkg/index.js", "x");
    put(project, "debug.log", "x");
    put(project, "b.txt", "two");

    expect(await store.changedFiles(before)).toEqual(["b.txt"]);
  });

  test("diff returns unified diff text, empty when nothing changed", async () => {
    put(project, "a.txt", "one\n");
    const store = open();
    const before = await store.track();
    expect(await store.diff(before)).toBe("");

    put(project, "a.txt", "two\n");
    put(project, "b.txt", "new\n");
    const text = await store.diff(before);

    expect(text).toContain("diff --git a/a.txt b/a.txt");
    expect(text).toContain("-one");
    expect(text).toContain("+two");
    expect(text).toContain("+++ b/b.txt");
    const after = await store.track();
    expect(await store.diff(before, after)).toBe(text);
  });

  test("diff uses real paths for unicode names", async () => {
    put(project, "café/ñandú.txt", "a\n");
    const store = open();
    const before = await store.track();
    put(project, "café/ñandú.txt", "b\n");

    expect(await store.diff(before)).toContain("café/ñandú.txt");
  });

  test("restore writes the tree's content, deletes files absent from it and reports both", async () => {
    put(project, "edit.txt", "old");
    put(project, "gone.txt", "bye");
    const store = open();
    const before = await store.track();

    put(project, "edit.txt", "new");
    rmSync(join(project, "gone.txt"));
    put(project, "created.txt", "turn made me");

    const result = await store.restore(before, ["edit.txt", "gone.txt", "created.txt"]);

    expect(read(project, "edit.txt")).toBe("old");
    expect(read(project, "gone.txt")).toBe("bye");
    expect(existsSync(join(project, "created.txt"))).toBe(false);
    expect([...result.written].sort()).toEqual(["edit.txt", "gone.txt"]);
    expect(result.deleted).toEqual(["created.txt"]);
  });

  test("restore touches only the listed files", async () => {
    put(project, "a.txt", "a0");
    put(project, "b.txt", "b0");
    const store = open();
    const before = await store.track();
    put(project, "a.txt", "a1");
    put(project, "b.txt", "b1");
    put(project, "c.txt", "c1");

    await store.restore(before, ["a.txt"]);

    expect(read(project, "a.txt")).toBe("a0");
    expect(read(project, "b.txt")).toBe("b1");
    expect(read(project, "c.txt")).toBe("c1");
  });

  test("undo then redo round trip: restore the pre-turn tree, then the post-turn tree", async () => {
    put(project, "a.txt", "before");
    const store = open();
    const pre = await store.track();
    put(project, "a.txt", "after");
    put(project, "new.txt", "created");
    const post = await store.track();
    const files = await store.changedFiles(pre, post);

    await store.restore(pre, files);
    expect(read(project, "a.txt")).toBe("before");
    expect(existsSync(join(project, "new.txt"))).toBe(false);

    await store.restore(post, files);
    expect(read(project, "a.txt")).toBe("after");
    expect(read(project, "new.txt")).toBe("created");
  });

  test("restore recreates missing parent directories and keeps the executable bit", async () => {
    put(project, "bin/run.sh", "#!/bin/sh\n");
    chmodSync(join(project, "bin/run.sh"), 0o755);
    const store = open();
    const before = await store.track();
    rmSync(join(project, "bin"), { recursive: true });

    await store.restore(before, ["bin/run.sh"]);

    expect(read(project, "bin/run.sh")).toBe("#!/bin/sh\n");
    expect(statSync(join(project, "bin/run.sh")).mode & 0o111).not.toBe(0);
  });

  test("restore preserves binary content", async () => {
    const bytes = Uint8Array.from([0, 255, 1, 254, 10, 13, 0]);
    writeFileSync(join(project, "blob.bin"), bytes);
    const store = open();
    const before = await store.track();
    writeFileSync(join(project, "blob.bin"), "text");

    await store.restore(before, ["blob.bin"]);

    expect(new Uint8Array(readFileSync(join(project, "blob.bin")))).toEqual(bytes);
  });

  test("restore handles a file replaced by a directory and the reverse", async () => {
    put(project, "swap", "was a file");
    put(project, "dir/inner.txt", "was in a dir");
    const store = open();
    const before = await store.track();
    rmSync(join(project, "swap"));
    put(project, "swap/child.txt", "now a dir");
    rmSync(join(project, "dir"), { recursive: true });
    put(project, "dir", "now a file");

    await store.restore(before, await store.changedFiles(before));

    expect(read(project, "swap")).toBe("was a file");
    expect(read(project, "dir/inner.txt")).toBe("was in a dir");
  });

  test("restore does not write through a symlink standing where the file was", async () => {
    put(project, "a.txt", "original");
    const store = open();
    const before = await store.track();
    const outside = join(base, "outside.txt");
    writeFileSync(outside, "outside");
    rmSync(join(project, "a.txt"));
    symlinkSync(outside, join(project, "a.txt"));

    await store.restore(before, ["a.txt"]);

    expect(read(base, "outside.txt")).toBe("outside");
    expect(lstatSync(join(project, "a.txt")).isSymbolicLink()).toBe(false);
    expect(read(project, "a.txt")).toBe("original");
  });

  test("restore to a tree that never had the file deletes it, even from an empty project", async () => {
    const store = open();
    const empty = await store.track();
    put(project, "x.txt", "x");

    const result = await store.restore(empty, ["x.txt"]);

    expect(result).toEqual({ written: [], deleted: ["x.txt"] });
    expect(existsSync(join(project, "x.txt"))).toBe(false);
  });

  test("restore of an already-absent, unknown file is a no-op", async () => {
    const store = open();
    const empty = await store.track();

    expect(await store.restore(empty, ["never.txt"])).toEqual({ written: [], deleted: [] });
  });

  test("modifiedSince returns only the listed files whose content differs from the tree", async () => {
    put(project, "same.txt", "same");
    put(project, "edited.txt", "old");
    put(project, "removed.txt", "x");
    const store = open();
    const before = await store.track();
    put(project, "edited.txt", "new");
    rmSync(join(project, "removed.txt"));
    put(project, "created.txt", "x");
    put(project, "unlisted.txt", "x");

    const modified = await store.modifiedSince(before, ["same.txt", "edited.txt", "removed.txt", "created.txt"]);

    expect([...modified].sort()).toEqual(["created.txt", "edited.txt", "removed.txt"]);
  });

  test("modifiedSince is empty when the listed files still match", async () => {
    put(project, "a.txt", "a");
    const store = open();
    const before = await store.track();
    put(project, "b.txt", "other");

    expect(await store.modifiedSince(before, ["a.txt"])).toEqual([]);
  });

  test("paths with spaces and unicode work in the project path and the file names", async () => {
    const odd = join(base, "mi proyecto ñ");
    mkdirSync(odd);
    put(odd, "sub dir/archivo ñandú 日本.txt", "uno");
    const store = open(odd);
    const before = await store.track();
    put(odd, "sub dir/archivo ñandú 日本.txt", "dos");
    put(odd, "otro archivo.txt", "nuevo");

    const files = (await store.changedFiles(before)).sort();
    expect(files).toEqual(["otro archivo.txt", "sub dir/archivo ñandú 日本.txt"]);
    expect(await store.modifiedSince(before, files)).toEqual(files);

    await store.restore(before, files);
    expect(read(odd, "sub dir/archivo ñandú 日本.txt")).toBe("uno");
    expect(existsSync(join(odd, "otro archivo.txt"))).toBe(false);
  });

  test("a file name that looks like a pathspec or an option is taken literally", async () => {
    put(project, "-n", "dash");
    put(project, "*.txt", "star");
    put(project, "real.txt", "real");
    const store = open();
    const before = await store.track();
    put(project, "-n", "dash2");
    put(project, "*.txt", "star2");
    put(project, "real.txt", "real2");

    await store.restore(before, ["*.txt"]);

    expect(read(project, "*.txt")).toBe("star");
    expect(read(project, "real.txt")).toBe("real2");
    expect(read(project, "-n")).toBe("dash2");
  });

  test("concurrent track calls all succeed", async () => {
    put(project, "a.txt", "a");
    const store = open();

    const trees = await Promise.all([store.track(), store.track(), store.track(), store.track()]);

    expect(new Set(trees).size).toBe(1);
  });
});

describe("restore path safety", () => {
  const refused = ["../outside.txt", "a/../../outside.txt", "a/../b.txt", "/etc/hosts", "", ".", "..", ".git/config", "sub/.git/hooks/pre-commit", ".git"];

  for (const bad of refused) {
    test(`refuses ${JSON.stringify(bad)} and writes nothing, not even the valid files in the same call`, async () => {
      put(project, "ok.txt", "before");
      const store = open();
      const before = await store.track();
      put(project, "ok.txt", "after");

      await expect(store.restore(before, ["ok.txt", bad])).rejects.toThrow();

      expect(read(project, "ok.txt")).toBe("after");
      expect(existsSync(join(base, "outside.txt"))).toBe(false);
    });
  }

  test("refuses a path that goes through a symlinked directory out of the project", async () => {
    const outside = join(base, "outside-dir");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "keep me");
    put(project, "ok.txt", "x");
    symlinkSync(outside, join(project, "link"));
    const store = open();
    const before = await store.track();

    await expect(store.restore(before, ["link/secret.txt"])).rejects.toThrow();

    expect(read(outside, "secret.txt")).toBe("keep me");
  });

  test("modifiedSince refuses paths that escape too", async () => {
    const store = open();
    const before = await store.track();

    await expect(store.modifiedSince(before, ["../x"])).rejects.toThrow();
  });

  test("refuses a tree argument that is not a hash", async () => {
    const store = open();
    await store.track();

    await expect(store.restore("--help", ["a.txt"])).rejects.toThrow();
    await expect(store.changedFiles("--output=/tmp/x")).rejects.toThrow();
    await expect(store.diff("HEAD")).rejects.toThrow();
  });
});

describe("a project that is itself a git repo", () => {
  const initRepo = () => {
    projectGit(project, "init", "-q");
    put(project, "tracked.txt", "committed");
    put(project, ".gitignore", "ignored.log\n");
    projectGit(project, "add", "-A");
    projectGit(project, "commit", "-q", "-m", "init");
  };

  test("track and restore leave the project's .git untouched", async () => {
    initRepo();
    put(project, "untracked.txt", "u");
    const gitDir = join(project, ".git");
    const headBefore = readFileSync(join(gitDir, "HEAD"), "utf8");
    const indexBefore = readFileSync(join(gitDir, "index"));
    const filesBefore = fingerprint(gitDir);
    const statusBefore = projectGit(project, "status", "--porcelain");
    const filesAfterStatus = fingerprint(gitDir);

    const store = open();
    const pre = await store.track();
    put(project, "tracked.txt", "edited by the turn");
    put(project, "new.txt", "created by the turn");
    const post = await store.track();
    await store.diff(pre, post);
    await store.modifiedSince(pre, ["tracked.txt"]);
    await store.restore(pre, await store.changedFiles(pre, post));

    expect(fingerprint(gitDir)).toEqual(filesAfterStatus);
    expect(filesAfterStatus.length).toBe(filesBefore.length);
    expect(readFileSync(join(gitDir, "HEAD"), "utf8")).toBe(headBefore);
    expect(Buffer.compare(readFileSync(join(gitDir, "index")), indexBefore)).toBe(0);
    expect(read(project, "tracked.txt")).toBe("committed");
    expect(projectGit(project, "status", "--porcelain")).toBe(statusBefore);
  });

  test("the project's .git is never part of a snapshot, nor are nested repos' or worktree .git files", async () => {
    initRepo();
    mkdirSync(join(project, "vendor/lib"), { recursive: true });
    projectGit(join(project, "vendor/lib"), "init", "-q");
    put(project, "vendor/lib/code.txt", "nested repo file");
    mkdirSync(join(project, "vendor/done"), { recursive: true });
    projectGit(join(project, "vendor/done"), "init", "-q");
    put(project, "vendor/done/code.txt", "committed nested repo file");
    projectGit(join(project, "vendor/done"), "add", "-A");
    projectGit(join(project, "vendor/done"), "commit", "-q", "-m", "nested");
    put(project, "wt/.git", "gitdir: /somewhere/else\n");
    const store = open();
    const before = await store.track();

    put(project, "tracked.txt", "edited");
    put(project, "vendor/lib/code.txt", "edited");
    put(project, "vendor/done/code.txt", "edited");
    projectGit(join(project, "vendor/done"), "commit", "-q", "-am", "moves the nested HEAD");
    projectGit(project, "commit", "-q", "-am", "moves .git/refs and objects");
    put(project, "wt/.git", "gitdir: /another\n");

    const changed = await store.changedFiles(before);
    expect(changed.some((path) => path.split("/").includes(".git"))).toBe(false);
    expect(changed).toEqual(["tracked.txt"]);
    expect(await store.diff(before)).not.toContain(".git/");
    expect(await store.diff(before)).not.toContain("Subproject");
  });

  test("inherited GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE do not reach the spawned git", async () => {
    initRepo();
    const gitDir = join(project, ".git");
    const decoy = join(base, "decoy");
    mkdirSync(decoy);
    put(decoy, "decoy.txt", "decoy");
    put(project, "a.txt", "a");
    const inherited = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_CEILING_DIRECTORIES", "GIT_PARAMETERS", "GIT_CONFIG_PARAMETERS"];
    const saved = Object.fromEntries(inherited.map((key) => [key, process.env[key]]));
    process.env.GIT_DIR = gitDir;
    process.env.GIT_WORK_TREE = decoy;
    process.env.GIT_INDEX_FILE = join(gitDir, "index");
    process.env.GIT_OBJECT_DIRECTORY = join(gitDir, "objects");
    process.env.GIT_COMMON_DIR = gitDir;
    process.env.GIT_CONFIG_PARAMETERS = "'core.bare'='true'";
    const filesBefore = fingerprint(gitDir);

    try {
      const store = open();
      const pre = await store.track();
      put(project, "a.txt", "changed");
      const changed = await store.changedFiles(pre);
      await store.restore(pre, changed);

      expect(changed).toEqual(["a.txt"]);
      expect(read(project, "a.txt")).toBe("a");
      expect(existsSync(join(decoy, "a.txt"))).toBe(false);
      expect(fingerprint(gitDir)).toEqual(filesBefore);
    } finally {
      for (const key of inherited) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe("shadow repo configuration", () => {
  const shadowDir = () => join(root, readdirSync(root)[0]!);
  const shadowGit = (...args: string[]) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const result = Bun.spawnSync(["git", "--git-dir", shadowDir(), ...args], { env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    return result.stdout.toString().trim();
  };

  test("hooks and signing are off and no sample hooks are installed", async () => {
    put(project, "a.txt", "a");
    await open().track();

    expect(shadowGit("config", "--local", "commit.gpgsign")).toBe("false");
    expect(shadowGit("config", "--local", "tag.gpgsign")).toBe("false");
    expect(shadowGit("config", "--local", "core.hooksPath")).toBe("/dev/null");
    expect(existsSync(join(shadowDir(), "hooks")) ? readdirSync(join(shadowDir(), "hooks")) : []).toEqual([]);
  });

  test("a hook in the user's global hooks path does not run", async () => {
    const marker = join(base, "hook-ran");
    const hooks = join(base, "hooks");
    mkdirSync(hooks);
    for (const name of ["pre-commit", "post-index-change", "reference-transaction", "post-commit"]) {
      writeFileSync(join(hooks, name), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
      chmodSync(join(hooks, name), 0o755);
    }
    const home = join(base, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgsign = true\n`);
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    delete process.env.XDG_CONFIG_HOME;
    try {
      put(project, "a.txt", "a");
      const store = open();
      const pre = await store.track();
      put(project, "a.txt", "b");
      await store.restore(pre, ["a.txt"]);
    } finally {
      if (saved.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = saved.HOME;
      if (saved.XDG_CONFIG_HOME !== undefined) process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
    }

    expect(existsSync(marker)).toBe(false);
  });
});

describe("marcsh's own data inside the project", () => {
  test("folders and files named in `exclude` are not snapshotted, listed, diffed or restored, and a tree from before is cleaned", async () => {
    put(project, "keep.txt", "k0");
    put(project, "data/marcsh.db", "d0");
    put(project, "data/sub/x", "x0");
    put(project, "prefs.json", "p0");
    const plain = createSnapshotStore({ cwd: project, root });
    if (!plain.available) throw new Error(plain.reason);
    const old = await plain.store.track();

    const created = createSnapshotStore({ cwd: project, root, exclude: [join(project, "data"), join(project, "prefs.json")] });
    if (!created.available) throw new Error(created.reason);
    const store = created.store;
    const before = await store.track();
    put(project, "keep.txt", "k1");
    put(project, "data/marcsh.db", "d1");
    put(project, "prefs.json", "p1");
    const after = await store.track();

    expect(await store.changedFiles(old, before)).toEqual([]);
    expect(await store.changedFiles(before, after)).toEqual(["keep.txt"]);
    expect(await store.diff(before, after)).not.toContain("marcsh.db");
    expect(await store.diff(old, after)).not.toContain("prefs.json");
    await store.restore(old, ["data/marcsh.db", "prefs.json", "keep.txt"]);
    expect(read(project, "data/marcsh.db")).toBe("d1");
    expect(read(project, "prefs.json")).toBe("p1");
    expect(read(project, "keep.txt")).toBe("k0");
  });

  test("an aborted track rejects, and the next one still works", async () => {
    put(project, "a.txt", "a");
    const store = open();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(store.track(cancelled.signal)).rejects.toThrow();

    const running = new AbortController();
    for (let i = 0; i < 600; i += 1) put(project, `many/${i}.txt`, String(i));
    const slow = store.track(running.signal);
    setTimeout(() => running.abort(), 5);
    await slow.then(() => undefined, () => undefined);
    expect(await store.track()).toMatch(/^[0-9a-f]{40,64}$/);
  }, 30_000);

  test("the shadow root and its folders are private to the user", async () => {
    put(project, "a.txt", "a");
    await open().track();

    expect(statSync(root).mode & 0o777).toBe(0o700);
    const [shadow] = readdirSync(root);
    expect(statSync(join(root, shadow!)).mode & 0o777).toBe(0o700);
  });
});

describe("availability", () => {
  test("reports unavailable, without throwing, when git is not installed", () => {
    const saved = process.env.PATH;
    process.env.PATH = join(base, "no-such-bin");
    try {
      const created = createSnapshotStore({ cwd: project, root });
      expect(created.available).toBe(false);
      if (!created.available) expect(created.reason).toContain("git");
    } finally {
      process.env.PATH = saved;
    }
  });

  test("reports unavailable when the project directory does not exist", () => {
    const created = createSnapshotStore({ cwd: join(base, "missing"), root });

    expect(created.available).toBe(false);
  });

  test("is off in the home folder and in /, with the reason", () => {
    // `homedir()` is fixed when the process starts, so the home folder is chosen in a child process.
    const script = `import { createSnapshotStore } from ${JSON.stringify(join(import.meta.dir, "snapshot"))}; console.log(JSON.stringify(createSnapshotStore({ cwd: process.env.HOME!, root: process.argv[1]! })));`;
    const child = Bun.spawnSync([process.execPath, "-e", script, root], { env: { ...process.env, HOME: project }, cwd: base });
    expect(JSON.parse(child.stdout.toString())).toEqual({ available: false, reason: "snapshots are off in your home folder" });
    const top = createSnapshotStore({ cwd: "/", root });
    expect(top.available).toBe(false);
    if (!top.available) expect(top.reason).toContain("root folder");
  });

  test("root defaults to ~/.marcsh/snapshots under the home directory", () => {
    expect(defaultSnapshotRoot()).toBe(join(homedir(), ".marcsh", "snapshots"));
  });
});
