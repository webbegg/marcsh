// "Allow `rm` under /tmp/x": the folder rules behind the permission prompt's path choice. Pure and best effort, not a
// sandbox: a command only counts when it is made of one path program (rm, mv, cp...) and every target is a literal path,
// so what a rule covers can be told from the command text alone. Paths are compared as text; symlinks are not followed.

import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { analyzeCommand, simpleCommands } from "./command-classifier";
import { type PermissionDecision, pathAnswerDir } from "./engine/types";
import type { PathRule, Storage } from "./storage";

/** The programs a path rule can cover. `find` only with `-delete` (its start folders are the targets). */
const PATH_PROGRAMS = new Set(["rm", "rmdir", "unlink", "mv", "cp", "mkdir", "touch", "find"]);

/** Substitutions, variables, redirections, subshells, braces and escapes: a word with one is not the literal text it shows. */
const NOT_LITERAL = /[$`<>(){}\\]/;
const GLOB = /[*?[\]]/;

// Options that take a value (`cp -t DIR`, `touch -d DATE`): the value would be read as a target, so such a command is not offered.
const VALUE_OPTIONS: Record<string, { short: string; long: string[] }> = {
  mv: { short: "tS", long: ["--target-directory", "--suffix"] },
  cp: { short: "tS", long: ["--target-directory", "--suffix"] },
  mkdir: { short: "mZ", long: ["--mode", "--context"] },
  touch: { short: "dtr", long: ["--date", "--reference", "--time"] },
};
// `find` predicates that run other commands or write files.
const FIND_UNSAFE = new Set(["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

export type PathRuleCandidate = { program: string; dirs: string[] };

/** The part of the storage the engines use for path rules. */
export type PathRuleStore = Pick<Storage, "addPathRule" | "pathRulesFor">;

type ParsedCommand = { program: string; targets: string[] };

const takesValue = (program: string, option: string) => {
  const spec = VALUE_OPTIONS[program];
  if (!spec) return false;
  if (option.startsWith("--")) return spec.long.some((name) => option === name || option.startsWith(`${name}=`));
  return /^-[A-Za-z]+$/.test(option) && [...spec.short].some((letter) => option.includes(letter));
};

/** The path words of a command's arguments: everything that is not an option, and everything after `--`. Null when an option takes a value. */
function pathArguments(program: string, args: string[]): string[] | null {
  const words: string[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") options = false;
    else if (options && arg.startsWith("-") && arg !== "-") {
      if (takesValue(program, arg)) return null;
    } else words.push(arg);
  }
  return words;
}

/** The start folders of a `find` that deletes (`find <dir>... <tests> -delete`); null for any other `find`. */
function findStartFolders(args: string[]): string[] | null {
  const end = args.findIndex((arg) => arg.startsWith("-") || arg === "!");
  const rest = end === -1 ? [] : args.slice(end);
  if (!rest.includes("-delete") || rest.some((arg) => FIND_UNSAFE.has(arg))) return null;
  return args.slice(0, end);
}

/** The absolute path of a literal target, or null when it could mean something else (empty, `~`, `..`, a glob before the last segment, `.git`). */
function resolveTarget(word: string, cwd: string): string | null {
  if (word === "" || word.startsWith("~") || word.startsWith("#")) return null;
  if (word.split("/").includes("..")) return null;
  if (word.replace(/\/+$/, "").split("/").pop() === ".") return null;
  const absolute = resolve(cwd, word);
  if (absolute === "/") return null;
  const segments = absolute.split("/");
  const last = segments.pop()!;
  if (segments.some((segment) => GLOB.test(segment) || segment === ".git") || last === ".git") return null;
  // `.*` can match `.` and `..`.
  if (GLOB.test(last) && last.startsWith(".")) return null;
  return absolute;
}

/** The program and the resolved targets when every simple command is that one path program with literal targets; null otherwise, and for catastrophic commands. */
function parse(command: string, cwd: string): ParsedCommand | null {
  if (NOT_LITERAL.test(command)) return null;
  const commands = simpleCommands(command);
  const program = commands?.[0]?.argv[0];
  if (!commands || !program || !PATH_PROGRAMS.has(program)) return null;

  const targets: string[] = [];
  for (const { argv, redirected } of commands) {
    if (redirected || argv[0] !== program) return null;
    const words = program === "find" ? findStartFolders(argv.slice(1)) : pathArguments(program, argv.slice(1));
    if (!words || words.length === 0) return null;
    for (const word of words) {
      const target = resolveTarget(word, cwd);
      if (!target) return null;
      targets.push(target);
    }
  }
  if (analyzeCommand(command).matches.some((match) => match.hardDeny)) return null;
  return { program, targets };
}

/** `/`, the home directory and what contains it are too wide to be a rule folder. */
function usableDir(dir: string): boolean {
  const home = homedir().replace(/\/+$/, "");
  return dir !== "/" && dir !== home && !home.startsWith(`${dir}/`);
}

/** The deepest folder that holds every path. */
function commonParent(paths: string[]): string {
  const split = paths.map((path) => dirname(path).split("/").filter(Boolean));
  const common: string[] = [];
  for (const [index, segment] of split[0]!.entries()) {
    if (!split.every((segments) => segments[index] === segment)) break;
    common.push(segment);
  }
  return `/${common.join("/")}`;
}

/**
 * What the prompt can offer for a command: the program and the folders to allow it under, narrowest first (the common parent of
 * the targets, then each parent up to, but excluding, `/` and the home directory). Null when the command is not a path command
 * (see `matchesPathRule`) or no folder is wide enough to be offered.
 */
export function pathRuleCandidate(command: string, cwd: string): PathRuleCandidate | null {
  const parsed = parse(command, cwd);
  if (!parsed) return null;
  const dirs: string[] = [];
  for (let dir = commonParent(parsed.targets); usableDir(dir); dir = dirname(dir)) dirs.push(dir);
  return dirs.length > 0 ? { program: parsed.program, dirs } : null;
}

/** True when a path rule stored for the project covers the command. */
export function hasMatchingPathRule(store: Pick<Storage, "pathRulesFor">, command: string, cwd: string): boolean {
  return store.pathRulesFor(cwd).some((rule) => matchesPathRule(command, cwd, rule));
}

/** The rule a prompt answer picked, or null when the answer is not a path answer or names a folder that was not offered. */
export function answeredPathRule(decision: PermissionDecision, cwd: string, candidate: PathRuleCandidate | null | undefined): PathRule | null {
  const dir = pathAnswerDir(decision);
  if (dir === null || !candidate?.dirs.includes(dir)) return null;
  return { cwd, program: candidate.program, dir };
}

/**
 * True when every simple command of the command is `rule.program` and every target is strictly inside `rule.dir`. Targets must
 * be literal (no variables, `~`, substitutions or `..`), globs only in the last segment; never with sudo, redirects, `cd` or
 * another command in the line, and never for catastrophic commands.
 */
export function matchesPathRule(command: string, cwd: string, rule: { program: string; dir: string }): boolean {
  if (!isAbsolute(rule.dir)) return false;
  const dir = resolve(rule.dir);
  if (!usableDir(dir)) return false;
  const parsed = parse(command, cwd);
  return parsed !== null && parsed.program === rule.program && parsed.targets.every((target) => target.startsWith(`${dir}/`));
}
