// The files a shell command writes by their literal names, for a writer subagent's edit surfaces. Best effort, like the command
// classifier it reads through: variables, substitutions, globs, and scripts run by an interpreter are not expanded or followed.
// Those writes are caught after the fact by the working-tree comparison (see `engine/pi-surfaces.ts`).
//
// Ported from brigadev's bash-writes. The shell parsing is marcsh's own `analyzeCommand` (redirections, tee, touch, mkdir, cp/mv/
// install/ln, `sed -i`, rm, curl and wget outputs, `cd` tracking, `sh -c` and wrappers); this module adds `truncate` (which the
// classifier only flags as destructive) and turns the result into absolute paths and surface violations. Unlike brigadev's, a `cd`
// inside a subshell `( )` is not scoped to it, so a later relative target may be read from the wrong folder.

import { statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { analyzeCommand, simpleCommands } from "./command-classifier";
import { isWithinSurfaces } from "./edit-surfaces";
import { realTarget } from "./real-path";

// Anything the shell would expand before opening the file.
const UNRESOLVABLE = /[$`*?[\]{}]/;
const DEVICE_SINKS = /^\/dev\//;
// Words in front of a command that do not change which command runs (a launcher, or a `NAME=value` assignment).
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "time", "nice", "exec", "xargs", "timeout", "caffeinate"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DIRECTORY_COMMANDS = new Set(["cd", "pushd", "popd"]);

const baseName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** `~` and `~/…` as the shell would expand them. */
function expandHome(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  if (path === "~") return home;
  return path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

/** The absolute path a literal target names, or undefined when the shell would expand it or it is no file (`-`, a device). */
function resolveTarget(raw: string, cwd: string): string | undefined {
  if (raw === "" || raw === "-" || UNRESOLVABLE.test(raw)) return undefined;
  const expanded = expandHome(raw);
  if (DEVICE_SINKS.test(expanded)) return undefined;
  return resolve(cwd, expanded);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(realTarget(path) ?? path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The files of `truncate` calls, which the classifier does not report as writes. Read from the command's simple commands as written:
 * a `truncate` inside `sh -c '…'` is not seen, and after a `cd` a relative file is not guessed at (only absolute ones are kept).
 */
function truncateTargets(command: string): string[] {
  const commands = simpleCommands(command);
  if (!commands) return [];
  const raw: string[] = [];
  let moved = false;
  for (const { argv } of commands) {
    if (argv.length === 0) continue;
    if (DIRECTORY_COMMANDS.has(baseName(argv[0]!))) {
      moved = true;
      continue;
    }
    let at = 0;
    while (at < argv.length && (WRAPPERS.has(baseName(argv[at]!)) || ASSIGNMENT.test(argv[at]!) || argv[at]!.startsWith("-"))) at++;
    if (baseName(argv[at] ?? "") !== "truncate") continue;
    const files: string[] = [];
    const args = argv.slice(at + 1);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--") {
        files.push(...args.slice(i + 1));
        break;
      }
      if (arg.startsWith("--")) {
        // --size and --reference take a value, as `--size=0` or as the next word.
        if (!arg.includes("=") && (arg === "--size" || arg === "--reference")) i++;
      } else if (arg.length > 1 && arg.startsWith("-")) {
        // -s SIZE and -r FILE, alone or last in a cluster (`-cs 0`); attached values (`-s0`) take no further word.
        const valueAt = arg.search(/[sr]/);
        if (valueAt !== -1 && valueAt === arg.length - 1) i++;
      } else files.push(arg);
    }
    for (const file of files) if (!moved || file.startsWith("/") || file.startsWith("~")) raw.push(file);
  }
  return raw;
}

/**
 * The classifier reads `< file` (with a space) as two words of the command: `tee a < in.txt` would write `<` and `in.txt`. The input
 * operator and the word after it are dropped; `cat <in` (no space) is already one word it leaves alone.
 */
function withoutInputRedirects(analysis: ReturnType<typeof analyzeCommand>) {
  const files: typeof analysis.files = [];
  let skipNext = false;
  for (const entry of analysis.files) {
    if (skipNext) {
      skipNext = false;
      if (entry.into === undefined) continue;
    }
    if (entry.into === undefined && /^(<|<<|<<<|<>)$/.test(entry.path)) {
      skipNext = true;
      continue;
    }
    files.push(entry);
  }
  return { writes: analysis.writes, files };
}

/**
 * Absolute paths of the files the command writes by literal name (redirections, `tee`, `touch`, `mkdir`, `truncate`, `sed -i`, the
 * files `cp`/`mv`/`install`/`ln` write or move, `rm`, and the output of `curl`/`wget`). Relative names resolve against `cwd`,
 * following literal `cd` commands. Targets the shell would expand are skipped, as are `/dev/*` sinks and descriptor duplication such
 * as `2>&1`. A copy or move into an existing folder is the name it lands on, not the folder.
 */
export function extractWriteTargets(command: string, cwd: string): string[] {
  const { writes, files } = withoutInputRedirects(analyzeCommand(command));
  const found: string[] = [];
  const add = (raw: string | undefined) => {
    const target = raw === undefined ? undefined : resolveTarget(raw, cwd);
    if (target !== undefined && !found.includes(target)) found.push(target);
  };

  const folders = new Set<string>();
  for (const { into } of files) {
    const folder = into === undefined ? undefined : resolveTarget(into, cwd);
    if (folder !== undefined && isDirectory(folder)) folders.add(folder);
  }
  for (const target of writes) add(target);
  for (const { path, into } of files) {
    if (into !== undefined) {
      // The name a copy or move lands on is a write only when the destination is a folder.
      const folder = resolveTarget(into, cwd);
      if (folder !== undefined && folders.has(folder)) add(path);
    } else {
      // The destination folder itself is not written: the names inside it are.
      const own = resolveTarget(path, cwd);
      if (own === undefined || !folders.has(own)) add(path);
    }
  }
  for (const target of truncateTargets(command)) add(target);
  return found;
}

/**
 * Project-relative paths the command writes by literal name that are inside `root` but outside `surfaces`. Targets outside the root
 * (the system temp folder, another project) are not judged here.
 */
export function writesOutsideSurfaces(command: string, cwd: string, root: string, surfaces: readonly string[]): string[] {
  const canonicalRoot = realTarget(root) ?? root;
  const violations: string[] = [];
  for (const target of extractWriteTargets(command, cwd)) {
    const absolute = realTarget(target);
    if (absolute === null) continue;
    const rel = relative(canonicalRoot, absolute);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    const path = rel.split(sep).join("/");
    if (!isWithinSurfaces(path, surfaces) && !violations.includes(path)) violations.push(path);
  }
  return violations;
}
