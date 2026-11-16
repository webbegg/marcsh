// Edit surfaces for a writer subagent: the child session's `edit`/`write` (and the literal writes of `bash`) outside the surfaces the
// parent gave `Task` are denied without a prompt, and the working tree is compared before and after each `bash` call and after the run
// to flag what an interpreter or a script wrote anyway (after the fact: nothing is reverted). Surfaces only narrow: a call inside them
// still goes through the normal approval, which runs after this guard (see `runChild` in pi.ts).
//
// The pure parts are `lib/edit-surfaces.ts` and `lib/bash-writes.ts`; the working-tree snapshot is ported from brigadev's
// worktree-snapshot.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { writesOutsideSurfaces } from "../bash-writes";
import { isWithinSurfaces, normalizeSurfaces } from "../edit-surfaces";
import { readOnlyGitArgs, readOnlyGitEnv } from "../git-safe";
import { realTarget } from "../real-path";

/** Project-relative path (forward slashes) to a content marker; "-" means the path does not exist. */
export type Snapshot = ReadonlyMap<string, string>;

/** Runs git in `cwd`; null when it cannot run or does not answer in time. */
export type RunGit = (cwd: string, args: string[]) => Promise<{ out: string; code: number } | null>;

const GIT_TIMEOUT_MS = 15_000;
// Beyond this size a file is marked by size and mtime instead of being read.
const MAX_HASHED_BYTES = 64 * 1024 * 1024;
const MISSING = "-";

/** Git as marcsh runs it in a folder: hardened like the status line's reads (no hooks, fsmonitor or pager). */
export const runGitHardened: RunGit = async (cwd, args) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(["git", ...readOnlyGitArgs(), ...args], { cwd, env: readOnlyGitEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timedOut = new Promise<null>((done) => {
      timer = setTimeout(() => {
        proc.kill();
        done(null);
      }, GIT_TIMEOUT_MS);
    });
    const finished = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out, code]) => ({ out, code }));
    return await Promise.race([finished, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Paths from `git status --porcelain=v1 -z`; a rename or copy lists its original path too. */
export function parsePorcelain(output: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    paths.push(field.slice(3));
    if (/[RC]/.test(field.slice(0, 2)) && fields[i + 1]) paths.push(fields[++i]!);
  }
  return paths;
}

/** Sorted paths whose marker differs between the snapshots, including paths that appear or disappear. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changed: string[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(path) ?? MISSING) !== (after.get(path) ?? MISSING) || before.has(path) !== after.has(path)) changed.push(path);
  }
  return changed.sort();
}

/** The paths that are outside every surface. */
export function outsideSurfaces(paths: readonly string[], surfaces: readonly string[]): string[] {
  return paths.filter((path) => !isWithinSurfaces(path, surfaces));
}

function contentMarker(absolute: string): string {
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return `link:${readlinkSync(absolute)}`;
    if (stat.isDirectory()) return "dir";
    if (stat.size > MAX_HASHED_BYTES) return `big:${stat.size}:${stat.mtimeMs}`;
    return createHash("sha1").update(readFileSync(absolute)).digest("hex");
  } catch {
    return MISSING;
  }
}

/**
 * Snapshot of the dirty files under `root` (their content, so a further change to a file that was already dirty shows): undefined when
 * git is missing, `root` is not in a repository, or git fails. Files git ignores are not covered.
 */
export async function takeSnapshot(runGit: RunGit, root: string): Promise<Snapshot | undefined> {
  try {
    const top = await runGit(root, ["rev-parse", "--show-toplevel"]);
    if (!top || top.code !== 0 || !top.out.trim()) return undefined;
    const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
    if (!status || status.code !== 0) return undefined;

    const toplevel = realTarget(top.out.trim()) ?? top.out.trim();
    const projectRoot = realTarget(root) ?? root;
    const snapshot = new Map<string, string>();
    for (const path of parsePorcelain(status.out)) {
      const absolute = join(toplevel, path);
      snapshot.set(relative(projectRoot, absolute).split(sep).join("/"), contentMarker(absolute));
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

// Every space separator (no-break, en/em, narrow, ideographic…) is a plain space, as pi's own path handling reads it.
const UNICODE_SPACES = /\p{Zs}/gu;

/**
 * The path a file tool names, as pi resolves it (a leading `@` dropped, `~` expanded, odd spaces normalized), against `cwd`. Null for a
 * dangling symlink, whose target cannot be told.
 */
function resolveToolPath(raw: string, cwd: string): string | null {
  const cleaned = raw.replace(UNICODE_SPACES, " ").replace(/^@/, "");
  const home = process.env.HOME;
  const expanded = home && (cleaned === "~" || cleaned.startsWith("~/")) ? `${home}${cleaned.slice(1)}` : cleaned;
  return realTarget(resolve(cwd, expanded));
}

/** What to show for a path the surfaces rule out: its project-relative name, or the path as given when it is outside the project. */
function outsideName(raw: string, cwd: string, root: string, surfaces: readonly string[]): string | undefined {
  const real = resolveToolPath(raw, cwd);
  if (real === null) return raw;
  const rel = relative(root, real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return raw;
  const path = rel.split(sep).join("/");
  return isWithinSurfaces(path, surfaces) ? undefined : path;
}

const listed = (surfaces: readonly string[]) => surfaces.join(", ");

export const surfaceBlockReason = (paths: readonly string[], surfaces: readonly string[], how: "edit" | "command") =>
  how === "edit"
    ? `Blocked: ${paths.join(", ")} is outside the allowed edit surfaces (${listed(surfaces)}). Stop and report the path you need to the parent instead of editing it.`
    : `Blocked: this command writes ${paths.join(", ")}, outside the allowed edit surfaces (${listed(surfaces)}). Use edit or write inside your surfaces, or stop and report the path you need to the parent.`;

export const surfaceChangedNotice = (paths: readonly string[]) =>
  `[marcsh] This command changed files outside your allowed edit surfaces: ${paths.join(", ")}. Do not change files through bash; report these paths to the parent.`;

export type SurfaceGuardOptions = {
  /** The turn's directory: the surfaces are resolved against it, and it is the project root of the working-tree comparison. */
  cwd: string;
  /** The repository-relative paths or globs the child may write (already validated). */
  surfaces: readonly string[];
  /** The surfaces of the other writers running now: their edits are not this child's. Read at each comparison. */
  others?: () => readonly string[];
  /** For tests: git. Default: `runGitHardened`. */
  runGit?: RunGit;
};

export type SurfaceGuard = {
  /** Denies, without a prompt, a write outside the surfaces. Goes before the approval extension. */
  gate: ExtensionFactory;
  /** Flags the files a `bash` call changed outside the surfaces. Goes after the approval extension, so a call waiting to be approved is not counted. */
  watch: ExtensionFactory;
  /**
   * The files changed outside the surfaces since the first `bash` call began (the whole run); empty when it ran none or the tree cannot be
   * compared. Git runs only around a `bash` call the user approved: `edit` and `write` cannot reach outside the surfaces.
   */
  outside(): Promise<string[]>;
};

/** The tools that run a shell command. `bg_start` runs it in the background, so only its literal writes can be judged. */
const SHELL_TOOLS = new Set(["bash", "bg_start"]);
const FILE_TOOLS = new Set(["edit", "write"]);

export function createSurfaceGuard(options: SurfaceGuardOptions): SurfaceGuard {
  const surfaces = normalizeSurfaces(options.surfaces);
  const cwd = options.cwd;
  const root = realTarget(cwd) ?? cwd;
  const runGit = options.runGit ?? runGitHardened;
  const others = () => normalizeSurfaces(options.others?.() ?? []);
  const take = () => takeSnapshot(runGit, cwd);
  // The tree as it was when the first `bash` call began: nothing else can change a file outside the surfaces, so the run starts there.
  let runStart: Snapshot | undefined;
  const outsideNow = (before: Snapshot, after: Snapshot) => outsideSurfaces(diffSnapshots(before, after), [...surfaces, ...others()]);

  const gate: ExtensionFactory = (pi) => {
    pi.on("tool_call", (event) => {
      const input = (event.input ?? {}) as Record<string, unknown>;
      if (FILE_TOOLS.has(event.toolName)) {
        if (typeof input.path !== "string" || input.path === "") return undefined;
        const outside = outsideName(input.path, cwd, root, surfaces);
        return outside === undefined ? undefined : { block: true, reason: surfaceBlockReason([outside], surfaces, "edit") };
      }
      if (SHELL_TOOLS.has(event.toolName)) {
        if (typeof input.command !== "string") return undefined;
        const dir = event.toolName === "bg_start" && typeof input.working_dir === "string" && input.working_dir !== "" ? resolve(cwd, input.working_dir) : cwd;
        const outside = writesOutsideSurfaces(input.command, dir, root, surfaces);
        return outside.length === 0 ? undefined : { block: true, reason: surfaceBlockReason(outside, surfaces, "command") };
      }
      return undefined;
    });
  };

  const before = new Map<string, Snapshot>();
  const watch: ExtensionFactory = (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolName !== "bash") return undefined;
      const snapshot = await take();
      if (snapshot) {
        before.set(event.toolCallId, snapshot);
        runStart ??= snapshot;
      }
      return undefined;
    });
    pi.on("tool_result", async (event) => {
      const start = before.get(event.toolCallId);
      if (!start) return undefined;
      before.delete(event.toolCallId);
      const after = await take();
      if (!after) return undefined;
      const outside = outsideNow(start, after);
      if (outside.length === 0) return undefined;
      return { content: [...event.content, { type: "text" as const, text: surfaceChangedNotice(outside) }], isError: true };
    });
  };

  return {
    gate,
    watch,
    async outside() {
      if (!runStart) return [];
      const after = await take();
      return after ? outsideNow(runStart, after) : [];
    },
  };
}
