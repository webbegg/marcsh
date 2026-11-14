import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

/**
 * Snapshots of a project's files, kept in a shadow git repo that has its own git dir under `root` and the project as its work tree.
 * The project's own `.git` is never read or written: every git call names the shadow dir explicitly and the inherited git
 * environment is dropped. A snapshot is a git tree hash; nothing is ever committed.
 */
export type SnapshotStore = {
  /**
   * Stages every file (the project's `.gitignore` is honored; `.git`, the shadow repo and marcsh's own data are never included) and returns
   * the resulting tree hash. Aborting `signal` kills the git process that is running, so a snapshot given up on stops copying files.
   */
  track(signal?: AbortSignal): Promise<string>;
  /**
   * Paths (relative to the project, `/`-separated) that differ between two trees; `to` defaults to the current files. A rename shows as one deleted and one added path.
   * Reading the current files stages them, so `signal` can stop that as it does for `track`.
   */
  changedFiles(from: string, to?: string, signal?: AbortSignal): Promise<string[]>;
  /** Unified diff text between two trees; `to` defaults to the current files (staged under `signal`, as for `track`). Empty when nothing changed. */
  diff(from: string, to?: string, signal?: AbortSignal): Promise<string>;
  /**
   * Writes exactly `files` to their content in `tree`; a file that is absent from `tree` is deleted. Throws before writing anything
   * when a path is absolute, contains `..`, goes through `.git` or through a symlinked directory.
   */
  restore(tree: string, files: string[]): Promise<{ written: string[]; deleted: string[] }>;
  /** The subset of `files` whose current content differs from `tree` (a missing file counts when `tree` has it, a present one when `tree` lacks it). Ignored files never count. Staging the current files stops under `signal`, as for `track`. */
  modifiedSince(tree: string, files: string[], signal?: AbortSignal): Promise<string[]>;
};

export type SnapshotStoreResult = { available: true; store: SnapshotStore } | { available: false; reason: string };

export type SnapshotStoreOptions = {
  /** The project directory. */
  cwd: string;
  /** Where shadow git dirs live. Defaults to `~/.marcsh/snapshots`. */
  root?: string;
  /** Files or folders (absolute) that are never part of a snapshot, restore or change list when they are inside the project: marcsh's own data. The shadow root is always left out. */
  exclude?: string[];
};

export const defaultSnapshotRoot = () => join(homedir(), ".marcsh", "snapshots");

/**
 * How old an `index.lock` must be to be taken for one a killed process left behind. A git that is alive is stopped after 10 s
 * (see `SNAPSHOT_TIMEOUT_MS`), so none holds a lock this long.
 */
const STALE_LOCK_MS = 2 * 60_000;

const TREE_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A line of the block `configure` appends (the first of `SAFE_CONFIG`): what says the repo's config has it. */
const CONFIGURED = "hooksPath = /dev/null";
const decoder = new TextDecoder();

/** Per-call options that switch off everything a user's or a project's git configuration could add. */
const SAFE_CONFIG: [string, string][] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.autocrlf", "false"],
  ["core.safecrlf", "false"],
  ["core.quotepath", "false"],
  ["core.symlinks", "true"],
  ["core.untrackedCache", "false"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["gc.auto", "0"],
  ["diff.external", ""],
];

/** The environment for git: nothing inherited from `GIT_*` (so a surrounding `GIT_DIR` and friends cannot redirect it), no user or system config, a fixed identity. */
const gitEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "marcsh",
    GIT_AUTHOR_EMAIL: "marcsh@localhost",
    GIT_COMMITTER_NAME: "marcsh",
    GIT_COMMITTER_EMAIL: "marcsh@localhost",
  };
};

const requireTree = (tree: string): string => {
  if (!TREE_HASH.test(tree)) throw new Error(`snapshot: not a tree hash: ${JSON.stringify(tree)}`);
  return tree;
};

/** A project-relative path in its normal form. Anything that could leave the project or reach a `.git` is refused. */
const normalizeRelative = (file: string): string => {
  const refuse = () => new Error(`snapshot: refusing path outside the project: ${JSON.stringify(file)}`);
  if (file.includes("\0") || isAbsolute(file)) throw refuse();
  const segments = file.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) throw refuse();
  // Case-insensitive: on a case-insensitive file system `.GIT` is the project's `.git`.
  if (segments.some((segment) => segment === ".." || segment.toLowerCase() === ".git")) throw refuse();
  return segments.join("/");
};

type TreeEntry = { mode: string; hash: string };

/** An absolute path with its symlinks resolved as far as it exists (the rest is kept as given), so it compares with the real project path. */
const resolveLoose = (path: string): string => {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
};

/** The `.marcsh` folder that `path` is in, when there is one: it is marcsh's data folder, and holds the database and settings next to the shadow repos. */
const marcshFolderOf = (path: string): string[] => {
  const at = path.lastIndexOf("/.marcsh/");
  return at < 0 ? [] : [path.slice(0, at + "/.marcsh".length)];
};

/** A line for the shadow repo's `info/exclude` that names exactly `rel` (anchored at the project, glob characters escaped). */
const excludeLine = (rel: string): string => `/${rel.replace(/[\\*?[\]]/g, "\\$&").replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "))}`;

export function createSnapshotStore(options: SnapshotStoreOptions): SnapshotStoreResult {
  const git = Bun.which("git", { PATH: process.env.PATH ?? "" });
  if (!git) return { available: false, reason: "git is not installed or not on PATH" };
  let workTree: string;
  try {
    workTree = realpathSync(options.cwd);
  } catch (error) {
    return { available: false, reason: `cannot resolve ${options.cwd}: ${error instanceof Error ? error.message : String(error)}` };
  }
  // The whole home folder (or `/`) is not a project: it holds marcsh's own data, other projects and the user's private files.
  if (workTree === resolveLoose(homedir())) return { available: false, reason: "snapshots are off in your home folder" };
  if (workTree === parse(workTree).root) return { available: false, reason: "snapshots are off in the root folder" };
  const root = resolveLoose(options.root ?? defaultSnapshotRoot());
  const gitDir = join(root, createHash("sha256").update(workTree).digest("hex").slice(0, 16));

  // Never part of a snapshot: the shadow repo, the `.marcsh` folder it lives in, and what the caller names (marcsh's data). Only those inside the project count.
  const excluded = [...new Set([root, ...(options.exclude ?? []), ...marcshFolderOf(root)].map(resolveLoose))]
    .map((path) => relative(workTree, path))
    .filter((rel) => rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) && !rel.includes("\n"));
  const isExcluded = (file: string) => excluded.some((rel) => file === rel || file.startsWith(`${rel}/`));

  const runOnce = async (args: string[], mode: "shadow" | "init" | "pathspec-magic", signal?: AbortSignal): Promise<Uint8Array> => {
    const config = SAFE_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
    const target = mode === "init" ? ["--git-dir", gitDir] : ["--git-dir", gitDir, "--work-tree", workTree];
    // Paths are file names, never patterns; only the `add` that excludes nested repos needs pathspec magic.
    const literal = mode === "pathspec-magic" ? [] : ["--literal-pathspecs"];
    const proc = Bun.spawn([git, ...target, ...literal, ...config, ...args], {
      cwd: workTree,
      env: gitEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stop = () => void proc.kill();
    if (signal?.aborted) stop();
    signal?.addEventListener("abort", stop, { once: true });
    let out: ArrayBuffer;
    let err: string;
    let code: number | null;
    try {
      [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
    } finally {
      signal?.removeEventListener("abort", stop);
    }
    if (code !== 0) throw new Error(`snapshot: git ${args[0]} failed (${code}): ${err.trim()}`);
    return new Uint8Array(out);
  };
  /** Removes the shadow index's lock when it is old enough to be a dead process's; whether it was removed. */
  const removeStaleLock = (): boolean => {
    const lock = join(gitDir, "index.lock");
    try {
      if (Date.now() - statSync(lock).mtimeMs < STALE_LOCK_MS) return false;
      rmSync(lock, { force: true });
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Runs git on the shadow repo. Several marcsh processes in one project share it, and one killed during `add` leaves `index.lock`
   * behind, which would fail every later snapshot: a lock that old is removed and the command is tried once more. A recent one may be
   * a live git's, so that failure is reported.
   */
  const run = async (args: string[], mode: "shadow" | "init" | "pathspec-magic" = "shadow", signal?: AbortSignal): Promise<Uint8Array> => {
    try {
      return await runOnce(args, mode, signal);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("index.lock") || !removeStaleLock()) throw error;
      return runOnce(args, mode, signal);
    }
  };

  // Everything touches the one shadow index, so calls run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
    const result = queue.then(job);
    queue = result.catch(() => undefined);
    return result;
  };

  /**
   * The repo's own configuration, written straight to the config file (a `git config` spawn per key made the first use slow). Checked
   * before it is appended, with no await in between, so a repo that two processes initialized together gets the block once.
   */
  const configure = () => {
    const file = join(gitDir, "config");
    if (readFileSync(file, "utf8").includes(CONFIGURED)) return;
    const config = SAFE_CONFIG.map(([key, value]) => {
      const dot = key.indexOf(".");
      return `[${key.slice(0, dot)}]\n\t${key.slice(dot + 1)} = ${value}\n`;
    });
    appendFileSync(file, `[core]\n\tbare = false\n${config.join("")}`);
  };

  let ready: Promise<void> | undefined;
  const ensureInit = () => {
    ready ??= (async () => {
      if (!existsSync(join(gitDir, "HEAD"))) {
        // Private: the shadow repos hold copies of project files, so only the user may enter them.
        mkdirSync(root, { recursive: true, mode: 0o700 });
        mkdirSync(gitDir, { recursive: true, mode: 0o700 });
        try {
          // An empty template: no sample hooks are copied in.
          await run(["init", "--quiet", "--template="], "init");
        } catch (error) {
          // Another marcsh process in this project made the repo first (git refuses to init over its finished config).
          if (!existsSync(join(gitDir, "HEAD"))) throw error;
        }
      }
      configure();
      mkdirSync(join(gitDir, "info"), { recursive: true });
      // `.git` (a folder or a worktree's file, at any depth) is never snapshotted, so nested repos are not recorded as submodules either.
      // Brought up to date on every start (a shadow repo made before marcsh's data was left out gets the new lines too), but only written
      // when it differs, and by renaming a finished file over it: another process's `add` must never read it half written, or empty.
      const exclude = [".git", ...excluded.map(excludeLine)].join("\n") + "\n";
      const excludeFile = join(gitDir, "info", "exclude");
      let present: string | undefined;
      try {
        present = readFileSync(excludeFile, "utf8");
      } catch {}
      if (present !== exclude) {
        const temporary = `${excludeFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
        writeFileSync(temporary, exclude);
        renameSync(temporary, excludeFile);
      }
      await unstageExcluded();
    })().catch((error) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };

  /** An excluded path that an earlier snapshot staged stays in the index (ignore rules only stop new files), so it is unstaged. */
  const unstageExcluded = async () => {
    if (excluded.length === 0) return;
    const staged = decoder.decode(await run(["ls-files", "-z", "--", ...excluded])).split("\0").filter((path) => path !== "");
    for (let start = 0; start < staged.length; start += 200) {
      await run(["update-index", "--force-remove", "--", ...staged.slice(start, start + 200)]);
    }
  };

  const trackNow = async (signal?: AbortSignal): Promise<string> => {
    await ensureInit();
    await addAll(signal);
    await dropGitlinks();
    return decoder.decode(await run(["write-tree"])).trim();
  };

  /** Stages everything. A nested repo with no commit makes `add` fail as a whole, so such folders are left out and `add` is retried. */
  const addAll = async (signal?: AbortSignal) => {
    const nested: string[] = [];
    for (;;) {
      try {
        await run(["add", "-A", "--", ".", ...nested.map((dir) => `:(exclude,literal)${dir}`)], "pathspec-magic", signal);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const dir = /'(.+)\/' does not have a commit checked out/.exec(message)?.[1];
        if (!dir || nested.includes(dir) || nested.length >= 100) throw error;
        nested.push(dir);
      }
    }
  };

  /** A nested repo that has commits is staged as a gitlink (a bare commit id, no files); it is not project content, so it is unstaged. */
  const dropGitlinks = async () => {
    const out = decoder.decode(await run(["ls-files", "--stage", "-z"]));
    const links = out.split("\0").flatMap((record) => {
      const tab = record.indexOf("\t");
      return tab > 0 && record.startsWith("160000 ") ? [record.slice(tab + 1)] : [];
    });
    for (let start = 0; start < links.length; start += 200) {
      await run(["update-index", "--force-remove", "--", ...links.slice(start, start + 200)]);
    }
  };

  const treeOrCurrent = async (to: string | undefined, signal?: AbortSignal) => (to === undefined ? trackNow(signal) : requireTree(to));

  const changedNow = async (from: string, to?: string, signal?: AbortSignal): Promise<string[]> => {
    const fromTree = requireTree(from);
    const toTree = await treeOrCurrent(to, signal);
    const out = decoder.decode(await run(["diff-tree", "-r", "-z", "--name-only", "--no-renames", fromTree, toTree]));
    // A tree taken before marcsh's data was left out may still hold it.
    return out.split("\0").filter((path) => path !== "" && !isExcluded(path));
  };

  /** What `tree` holds at each of `files` (a file only; a folder or nothing at the path is absent). */
  const entriesIn = async (tree: string, files: string[]): Promise<Map<string, TreeEntry>> => {
    const entries = new Map<string, TreeEntry>();
    for (let start = 0; start < files.length; start += 200) {
      const out = decoder.decode(await run(["ls-tree", "-z", "--full-tree", tree, "--", ...files.slice(start, start + 200)]));
      for (const record of out.split("\0")) {
        const tab = record.indexOf("\t");
        if (tab < 0) continue;
        const [mode, type, hash] = record.slice(0, tab).split(" ");
        if (type === "blob" && mode && hash) entries.set(record.slice(tab + 1), { mode, hash });
      }
    }
    return entries;
  };

  /** Refuses a path whose parent directories include a symlink, so a write can never land outside the project. */
  const assertNoSymlinkParent = (file: string) => {
    const segments = file.split("/");
    let current = workTree;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      let stat;
      try {
        stat = lstatSync(current);
      } catch {
        return; // Missing from here on: it will be created as a real directory.
      }
      if (stat.isSymbolicLink()) throw new Error(`snapshot: refusing path through a symlink: ${JSON.stringify(file)}`);
    }
  };

  const clearTarget = (target: string) => {
    let stat;
    try {
      stat = lstatSync(target);
    } catch {
      return;
    }
    // A directory in the way must already be empty (its files were part of the restore); a symlink is removed, never followed.
    if (stat.isDirectory()) rmdirSync(target);
    else rmSync(target, { force: true });
  };

  const restoreNow = async (tree: string, files: string[]) => {
    const treeHash = requireTree(tree);
    const wanted = [...new Set(files.map(normalizeRelative))].filter((file) => !isExcluded(file));
    for (const file of wanted) assertNoSymlinkParent(file);
    await ensureInit();
    const entries = await entriesIn(treeHash, wanted);

    const deleted: string[] = [];
    const written: string[] = [];
    // Deletions first, so a file can make way for a directory of the same name.
    for (const file of wanted) {
      if (entries.has(file)) continue;
      assertNoSymlinkParent(file);
      const target = join(workTree, file);
      let stat;
      try {
        stat = lstatSync(target);
      } catch {
        continue;
      }
      if (stat.isDirectory()) continue;
      rmSync(target, { force: true });
      deleted.push(file);
    }
    for (const file of wanted) {
      const entry = entries.get(file);
      if (!entry) continue;
      assertNoSymlinkParent(file);
      const target = join(workTree, file);
      const content = await run(["cat-file", "blob", entry.hash]);
      mkdirSync(dirname(target), { recursive: true });
      clearTarget(target);
      if (entry.mode === "120000") symlinkSync(decoder.decode(content), target);
      else {
        writeFileSync(target, content);
        chmodSync(target, entry.mode === "100755" ? 0o755 : 0o644);
      }
      written.push(file);
    }
    return { written, deleted };
  };

  const store: SnapshotStore = {
    track: (signal) =>
      exclusive(async () => {
        if (signal?.aborted) throw new Error("snapshot: cancelled");
        return trackNow(signal);
      }),
    changedFiles: (from, to, signal) =>
      exclusive(async () => {
        if (signal?.aborted) throw new Error("snapshot: cancelled");
        return changedNow(from, to, signal);
      }),
    diff: (from, to, signal) =>
      exclusive(async () => {
        if (signal?.aborted) throw new Error("snapshot: cancelled");
        const fromTree = requireTree(from);
        const toTree = await treeOrCurrent(to, signal);
        const left = excluded.map((rel) => `:(exclude,literal)${rel}`);
        const args = ["diff-tree", "-p", "-r", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", fromTree, toTree];
        return decoder.decode(await run(left.length > 0 ? [...args, "--", ".", ...left] : args, left.length > 0 ? "pathspec-magic" : "shadow"));
      }),
    restore: (tree, files) => exclusive(() => restoreNow(tree, files)),
    modifiedSince: (tree, files, signal) =>
      exclusive(async () => {
        if (signal?.aborted) throw new Error("snapshot: cancelled");
        const wanted = [...new Set(files.map(normalizeRelative))];
        const changed = new Set(await changedNow(tree, undefined, signal));
        return wanted.filter((file) => changed.has(file));
      }),
  };
  return { available: true, store };
}
