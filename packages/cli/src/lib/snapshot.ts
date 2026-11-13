import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Snapshots of a project's files, kept in a shadow git repo that has its own git dir under `root` and the project as its work tree.
 * The project's own `.git` is never read or written: every git call names the shadow dir explicitly and the inherited git
 * environment is dropped. A snapshot is a git tree hash; nothing is ever committed.
 */
export type SnapshotStore = {
  /** Stages every file (the project's `.gitignore` is honored, `.git` is never included) and returns the resulting tree hash. */
  track(): Promise<string>;
  /** Paths (relative to the project, `/`-separated) that differ between two trees; `to` defaults to the current files. A rename shows as one deleted and one added path. */
  changedFiles(from: string, to?: string): Promise<string[]>;
  /** Unified diff text between two trees; `to` defaults to the current files. Empty when nothing changed. */
  diff(from: string, to?: string): Promise<string>;
  /**
   * Writes exactly `files` to their content in `tree`; a file that is absent from `tree` is deleted. Throws before writing anything
   * when a path is absolute, contains `..`, goes through `.git` or through a symlinked directory.
   */
  restore(tree: string, files: string[]): Promise<{ written: string[]; deleted: string[] }>;
  /** The subset of `files` whose current content differs from `tree` (a missing file counts when `tree` has it, a present one when `tree` lacks it). Ignored files never count. */
  modifiedSince(tree: string, files: string[]): Promise<string[]>;
};

export type SnapshotStoreResult = { available: true; store: SnapshotStore } | { available: false; reason: string };

export type SnapshotStoreOptions = {
  /** The project directory. */
  cwd: string;
  /** Where shadow git dirs live. Defaults to `~/.marcsh/snapshots`. */
  root?: string;
};

export const defaultSnapshotRoot = () => join(homedir(), ".marcsh", "snapshots");

const TREE_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
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

export function createSnapshotStore(options: SnapshotStoreOptions): SnapshotStoreResult {
  const git = Bun.which("git", { PATH: process.env.PATH ?? "" });
  if (!git) return { available: false, reason: "git is not installed or not on PATH" };
  let workTree: string;
  try {
    workTree = realpathSync(options.cwd);
  } catch (error) {
    return { available: false, reason: `cannot resolve ${options.cwd}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const gitDir = join(options.root ?? defaultSnapshotRoot(), createHash("sha256").update(workTree).digest("hex").slice(0, 16));

  const run = async (args: string[], mode: "shadow" | "init" | "pathspec-magic" = "shadow"): Promise<Uint8Array> => {
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
    const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`snapshot: git ${args[0]} failed (${code}): ${err.trim()}`);
    return new Uint8Array(out);
  };
  const text = async (args: string[]) => decoder.decode(await run(args));

  // Everything touches the one shadow index, so calls run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(job: () => Promise<T>): Promise<T> => {
    const result = queue.then(job);
    queue = result.catch(() => undefined);
    return result;
  };

  let ready: Promise<void> | undefined;
  const ensureInit = () => {
    ready ??= (async () => {
      if (existsSync(join(gitDir, "HEAD"))) return;
      mkdirSync(gitDir, { recursive: true });
      // An empty template: no sample hooks are copied in.
      await run(["init", "--quiet", "--template="], "init");
      // Written straight to the config file: a `git config` spawn per key made the first use slow.
      const config = SAFE_CONFIG.map(([key, value]) => {
        const dot = key.indexOf(".");
        return `[${key.slice(0, dot)}]\n\t${key.slice(dot + 1)} = ${value}\n`;
      });
      appendFileSync(join(gitDir, "config"), `[core]\n\tbare = false\n${config.join("")}`);
      mkdirSync(join(gitDir, "info"), { recursive: true });
      // `.git` (a folder or a worktree's file, at any depth) is never snapshotted, so nested repos are not recorded as submodules either.
      writeFileSync(join(gitDir, "info", "exclude"), ".git\n");
    })().catch((error) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };

  const trackNow = async (): Promise<string> => {
    await ensureInit();
    await addAll();
    await dropGitlinks();
    return decoder.decode(await run(["write-tree"])).trim();
  };

  /** Stages everything. A nested repo with no commit makes `add` fail as a whole, so such folders are left out and `add` is retried. */
  const addAll = async () => {
    const nested: string[] = [];
    for (;;) {
      try {
        await run(["add", "-A", "--", ".", ...nested.map((dir) => `:(exclude,literal)${dir}`)], "pathspec-magic");
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

  const treeOrCurrent = async (to: string | undefined) => (to === undefined ? trackNow() : requireTree(to));

  const changedNow = async (from: string, to?: string): Promise<string[]> => {
    const fromTree = requireTree(from);
    const toTree = await treeOrCurrent(to);
    const out = decoder.decode(await run(["diff-tree", "-r", "-z", "--name-only", "--no-renames", fromTree, toTree]));
    return out.split("\0").filter((path) => path !== "");
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
    const wanted = [...new Set(files.map(normalizeRelative))];
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
    track: () => exclusive(trackNow),
    changedFiles: (from, to) => exclusive(() => changedNow(from, to)),
    diff: (from, to) =>
      exclusive(async () => {
        const fromTree = requireTree(from);
        const toTree = await treeOrCurrent(to);
        return text(["diff-tree", "-p", "-r", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", fromTree, toTree]);
      }),
    restore: (tree, files) => exclusive(() => restoreNow(tree, files)),
    modifiedSince: (tree, files) =>
      exclusive(async () => {
        const wanted = [...new Set(files.map(normalizeRelative))];
        const changed = new Set(await changedNow(tree));
        return wanted.filter((file) => changed.has(file));
      }),
  };
  return { available: true, store };
}
