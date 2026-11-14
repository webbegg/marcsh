// Recognises risky shell commands by their executable form, for the auto and yolo approval modes (see approval-policy).
// Best effort, not a sandbox: it does not expand variables, load scripts or follow aliases, and a shape it does not know
// is an ordinary command. Ported from brigadev-pi-harness `lib/command-classifier.ts` (MIT, Marcos Juan).
//
// The command is split into simple commands on `;` `&&` `||` `|` `&` newlines, parentheses and backticks outside quotes.
// Command substitutions inside double quotes (`"$(...)"`, "`...`") are read as commands of their own; `bash -c` and
// `eval` scripts too. Heredoc bodies and the text of `[[ ]]` / `(( ))` are data.
//
// A `cd`, `pushd` or `popd` counts for the rest of the line, subshells and nested scripts included: relative redirect
// targets are read from the folder it moves to, and a git command after one that leaves the checkout is run elsewhere.

import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const CommandKind = {
  DESTRUCTIVE: "destructive",
  /** A commit made in the checkout the session works in. */
  COMMIT: "commit",
  /** Reaches a remote: a push that is not destructive, `gh pr|issue` writes, `gh api` writes. */
  REMOTE: "remote",
  /** Leaves the branch the session works on or writes another one: a switch or checkout, git run in another directory, a new worktree, a fetch into or a forced move of a branch. */
  LEAVING: "leaving",
  PUBLISH: "publish",
  PRIVILEGED: "privileged",
  /** Changes installed dependencies or the environment (npm install, pip install, brew upgrade). */
  DEPENDENCY: "dependency",
  /** A quote or substitution is left open: nothing about the command is known. */
  UNREADABLE: "unreadable",
} as const;
export type CommandKindType = (typeof CommandKind)[keyof typeof CommandKind];

export type CommandMatch = {
  kind: CommandKindType;
  reason: string;
  /** Catastrophic forms that are never allowed, whatever the mode. */
  hardDeny?: boolean;
};

export type CommandAnalysis = {
  matches: CommandMatch[];
  /** Targets of output redirections (`>`, `>>`, `&>`…); file-descriptor duplications such as `2>&1` are left out. */
  writes: string[];
};

type Redirect = { op: string; target: string };
type Segment = { argv: string[]; before: string; redirects: Redirect[] };

export type AnalyzeOptions = {
  /** Whether a `cd` to `dir` (as written, or joined onto an earlier `cd`) stays in the checkout the session works in. Without it, every `cd` leaves. */
  stays?: (dir: string) => boolean;
};

/** Where the line has moved to so far: `dir` is the folder relative targets are read from ("" for the session's), `left` the first `cd` that left the checkout. */
type Context = AnalyzeOptions & { dir: string; left?: string };

const SEPARATORS = new Set([";", "|", "&", "\n", "(", ")", "`"]);
// Syntax words that can lead a segment (`then rm -rf x`, `{ git push; }`); the command follows them.
const RESERVED_WORDS = new Set(["{", "}", "!", "if", "then", "elif", "else", "fi", "while", "until", "do", "done"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "time", "nice", "exec", "xargs", "timeout", "caffeinate"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Variables that point git at another repository or working tree.
const GIT_LOCATION_VARIABLE = /^GIT_(DIR|WORK_TREE)=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
// Commands whose arguments are data (search patterns, text), not actions.
const TEXT_COMMANDS = new Set(["grep", "rg", "ag", "echo", "printf", "cat", "less", "head", "tail", "sed", "awk", "jq", "wc"]);
const PROTECTED_NAMES = new Set(["main", "master"]);
const CATASTROPHIC_RM_TARGETS = new Set(["/", "/*", "~", "~/", "~/*", "$HOME", "${HOME}", "$HOME/", "${HOME}/", ".", "./", "..", "../", "*", "/Users", "/home", "/usr", "/etc", "/var", "/System"]);
// Nested scripts (`bash -c`, substitutions) deeper than this are not read.
const MAX_DEPTH = 8;
const UNREADABLE: CommandMatch = { kind: CommandKind.UNREADABLE, reason: "a command marcsh cannot read" };

/** Literal heredoc bodies are data, not commands. */
function blankHeredocs(command: string): string {
  return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (raw) => {
    const header = raw.slice(0, raw.indexOf("\n") + 1);
    return header + " ".repeat(raw.length - header.length);
  });
}

/** Index just past the `))` closing an arithmetic expression whose `((` ends at `from`, or -1. */
function arithmeticEnd(text: string, from: number): number {
  let depth = 2;
  let loweredToOneAt = -1;
  for (let j = from; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")") {
      depth--;
      if (depth === 1) loweredToOneAt = j;
      else if (depth === 0) return loweredToOneAt === j - 1 ? j + 1 : -1;
    }
  }
  return -1;
}

/** Index just past the `]]` closing a `[[` whose opening ends at `from`, or -1. */
function conditionalEnd(text: string, from: number): number {
  let quote: "'" | '"' | null = null;
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (quote) {
      if (ch === "\\" && quote === '"') j++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") j++;
    else if (ch === "]" && text[j + 1] === "]" && /\s/.test(text[j - 1] ?? "") && (j + 2 >= text.length || /[\s;&|)]/.test(text[j + 2] ?? ""))) return j + 2;
  }
  return -1;
}

/** Index just past the `)` closing a `$(` whose opening ends at `from`, or -1. */
function substitutionEnd(text: string, from: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (quote) {
      if (ch === "\\" && quote === '"') j++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") j++;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return j + 1;
  }
  return -1;
}

/** Blanks a conditional's text (newlines kept), leaving its `$( )` substitutions, which run as commands. */
function blankAroundSubstitutions(region: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let j = 0; j < region.length; j++) {
    const ch = region[j]!;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        out += region.slice(j, j + 2).replace(/[^\n]/g, " ");
        j++;
        continue;
      }
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") {
      out += region.slice(j, j + 2).replace(/[^\n]/g, " ");
      j++;
      continue;
    }
    if (quote !== "'" && ch === "$" && region[j + 1] === "(" && region[j + 2] !== "(") {
      const end = substitutionEnd(region, j + 2);
      if (end !== -1) {
        out += blankConditionals(region.slice(j, end));
        j = end - 1;
        continue;
      }
    }
    out += ch === "\n" ? ch : " ";
  }
  return out;
}

/**
 * `(( ))`, `$(( ))` and `[[ ]]` hold comparisons, where `>` is not a redirection. Blanks them (newlines kept) so
 * offsets and line structure stay, except for the `$( )` substitutions inside, which still run.
 */
function blankConditionals(command: string): string {
  let out = command;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    const atWordStart = i === 0 || /[\s;&|(){]/.test(command[i - 1] ?? "");
    let end = -1;
    if (ch === "$" && command.startsWith("((", i + 1)) end = arithmeticEnd(command, i + 3);
    else if (ch === "(" && command[i + 1] === "(" && (i === 0 || !/[\w$]/.test(command[i - 1] ?? ""))) end = arithmeticEnd(command, i + 2);
    else if (ch === "[" && command[i + 1] === "[" && atWordStart && /\s/.test(command[i + 2] ?? "")) end = conditionalEnd(command, i + 2);
    if (end > i) {
      out = out.slice(0, i) + blankAroundSubstitutions(out.slice(i, end)) + out.slice(end);
      i = end - 1;
    }
  }
  return out;
}

/**
 * Splits a command into segments of words, with output redirections (`>`, `>>`, `>|`, `>&`, `&>`, an optional fd
 * prefix) and their target moved out of argv. Substitutions inside double quotes are returned in `nested`.
 * Null when a quote or a substitution is left open.
 */
function tokenize(command: string): { segments: Segment[]; nested: string[] } | null {
  const segments: Segment[] = [];
  const nested: string[] = [];
  let argv: string[] = [];
  let redirects: Redirect[] = [];
  let pendingOp: string | null = null;
  let before = "";
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;

  const pushToken = () => {
    if (inToken) {
      if (pendingOp !== null) redirects.push({ op: pendingOp, target: current });
      else argv.push(current);
      pendingOp = null;
    }
    current = "";
    inToken = false;
  };
  const pushSegment = (separator: string) => {
    pushToken();
    if (argv.length > 0 || redirects.length > 0) segments.push({ argv, before, redirects });
    argv = [];
    redirects = [];
    pendingOp = null;
    before = separator;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < command.length) current += command[++i];
      else if (ch === "$" && command[i + 1] === "(" && command[i + 2] !== "(") {
        const end = substitutionEnd(command, i + 2);
        if (end === -1) return null;
        nested.push(command.slice(i + 2, end - 1));
        current += command.slice(i, end);
        i = end - 1;
      } else if (ch === "`") {
        const end = command.indexOf("`", i + 1);
        if (end === -1) return null;
        nested.push(command.slice(i + 1, end));
        current += command.slice(i, end + 1);
        i = end;
      } else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      if (command[i + 1] !== "\n") {
        current += command[i + 1];
        inToken = true;
      }
      i++;
      continue;
    }
    if (ch === ">" || (ch === "&" && command[i + 1] === ">")) {
      // A word of digits right before ">" is the file descriptor, not an argument.
      if (ch === ">" && inToken && /^\d+$/.test(current)) {
        current = "";
        inToken = false;
      } else pushToken();
      let op: string = ch;
      let next = i + 1;
      if (ch === "&") {
        op += ">";
        next++;
      }
      if (command[next] === ">") {
        op += ">";
        next++;
      } else if (ch === ">" && (command[next] === "|" || command[next] === "&")) {
        op += command[next];
        next++;
      }
      pendingOp = op;
      i = next - 1;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      pushSegment(two);
      i++;
      continue;
    }
    if (SEPARATORS.has(ch)) {
      pushSegment(ch);
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      pushToken();
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) return null;
  pushSegment("");
  return { segments, nested };
}

const basename = (executable: string) => executable.slice(executable.lastIndexOf("/") + 1);

// Wrapper options that take a separate value, so the value is not mistaken for the wrapped command. The `--opt=value` form takes
// nothing extra, and neither does an attached value (`-n10`). Options whose value can only be attached (`xargs -i`, `--replace`, `--eof`) are not here.
const WRAPPER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  xargs: new Set(["-I", "-J", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--max-chars", "--delimiter", "--arg-file", "--process-slot-var"]),
  nice: new Set(["-n", "--adjustment"]),
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-U", "-r", "-t", "-D", "--user", "--group", "--host", "--prompt", "--close-from", "--other-user", "--role", "--type", "--chdir"]),
  doas: new Set(["-u", "-C"]),
  exec: new Set(["-a"]),
  time: new Set(["-f", "-o", "--format", "--output"]),
  caffeinate: new Set(["-t", "-w"]),
};

/** Whether the wrapper option `token` is followed by its value: the exact option, or a short group that ends in a value option (`sudo -Hu bob`). */
function takesNextValue(wrapper: string, token: string): boolean {
  const options = WRAPPER_VALUE_OPTIONS[wrapper];
  if (!options) return false;
  if (options.has(token)) return true;
  if (!/^-[A-Za-z]{2,}$/.test(token)) return false;
  return [...token.slice(1)].findIndex((letter) => options.has(`-${letter}`)) === token.length - 2;
}

/** The command line `env -S` / `--split-string` carries (its value, then the arguments after it), or undefined when the option is not one. */
function envSplitString(rest: string[]): { script: string; consumed: number } | undefined {
  const option = rest[0]!;
  if (option === "-S" || option === "--split-string") return { script: rest[1] ?? "", consumed: 2 };
  if (option.startsWith("--split-string=")) return { script: option.slice("--split-string=".length), consumed: 1 };
  if (/^-S./.test(option)) return { script: option.slice(2), consumed: 1 };
  return undefined;
}

/**
 * Strips leading reserved words, env assignments and wrapper commands (and their options, with the values they take); reports whether
 * sudo or doas was used, and the assignments it stripped. `env -S 'cmd args'` leaves the command line it splits as `script`.
 */
function unwrap(argv: string[]): { argv: string[]; privileged: boolean; viaXargs: boolean; assignments: string[]; script?: string } {
  let rest = argv;
  let privileged = false;
  let viaXargs = false;
  const assignments: string[] = [];
  while (rest.length > 0) {
    const head = rest[0]!;
    if (RESERVED_WORDS.has(head) || ASSIGNMENT.test(head)) {
      if (ASSIGNMENT.test(head)) assignments.push(head);
      rest = rest.slice(1);
      continue;
    }
    const name = basename(head);
    if (!WRAPPERS.has(name)) break;
    if (name === "sudo" || name === "doas") privileged = true;
    if (name === "xargs") viaXargs = true;
    rest = rest.slice(1);
    // Skip the wrapper's options with their values, then the timeout duration.
    while (rest.length > 0 && rest[0]!.startsWith("-")) {
      const split = name === "env" ? envSplitString(rest) : undefined;
      if (split) return { argv: [], privileged, viaXargs, assignments, script: [split.script, ...rest.slice(split.consumed)].join(" ") };
      rest = rest.slice(takesNextValue(name, rest[0]!) ? 2 : 1);
    }
    if (name === "timeout") rest = rest.slice(1);
  }
  return { argv: rest, privileged, viaXargs, assignments };
}

const hasShortFlag = (args: string[], letter: string) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));

/**
 * Whether `args` hold one of `flags`: a short flag (`-f`) alone or inside a group (`-fu`), a long flag (`--force`) alone or as `--force=value`,
 * any other word exactly.
 */
const hasAny = (args: string[], ...flags: string[]) =>
  args.some((a) =>
    flags.some((f) => (/^-[A-Za-z]$/.test(f) ? /^-[A-Za-z]+$/.test(a) && a.includes(f[1]!) : f.startsWith("--") ? a === f || a.startsWith(`${f}=`) : a === f)),
  );

/** The directories whose contents are scratch: the system temp dir, and `/tmp` (`/private/tmp` on macOS). */
export function scratchRoots(): string[] {
  return [...new Set([tmpdir().replace(/\/+$/, ""), "/tmp", "/private/tmp"])];
}

/**
 * True for an absolute, literal path strictly inside a scratch root. Rejects the root itself, "." / ".." / empty
 * segments, and anything the shell could expand (globs, variables, substitutions, tilde).
 */
export function isScratchPath(target: string, roots: readonly string[] = scratchRoots()): boolean {
  if (/[*?[\]{}()$`~\\!<>@+^#]/.test(target)) return false;
  return roots.some((root) => {
    if (!root.startsWith("/") || root.split("/").some((seg) => seg === "." || seg === "..")) return false;
    if (!target.startsWith(`${root}/`)) return false;
    const segments = target.slice(root.length + 1).replace(/\/$/, "").split("/");
    return segments.every((seg) => seg !== "" && seg !== "." && seg !== "..");
  });
}

// Options that take a separate value, per manager, so the value is not mistaken for the subcommand.
const VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["--prefix", "-w", "--workspace", "--registry", "-C"]),
  pnpm: new Set(["--filter", "-F", "-C", "--dir", "--registry"]),
  yarn: new Set(["--cwd", "--registry"]),
  bun: new Set(["--cwd", "--registry"]),
};
const JS_DEPENDENCY_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "remove", "rm", "uninstall", "update", "upgrade", "up"]);

/** First argument that is not an option (or an option's value). */
function firstSubcommand(args: string[], valueOptions: ReadonlySet<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (valueOptions.has(args[i]!)) i++;
    else if (!args[i]!.startsWith("-")) return args[i];
  }
  return undefined;
}

// After one of these words `publish` names a script or a lookup, not the command (as in plugin/hooks/guard-lib.ts).
const NOT_PUBLISH = new Set(["run", "run-script", "exec", "x", "dlx", "create", "init", "help", "view", "info", "search"]);

/** The publish-like subcommand (`publish`, `unpublish`, `dist-tag` other than `ls`) anywhere among the words, past options and their values (`npm -w pkg publish`, `yarn npm publish`). */
function publishWord(name: string, args: string[]): string | undefined {
  const valueOptions = VALUE_OPTIONS[name] ?? new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (valueOptions.has(word)) i++;
    else if (NOT_PUBLISH.has(word)) return undefined;
    else if (word === "publish" || word === "unpublish") return word;
    else if (word === "dist-tag") return args[i + 1] === "ls" ? undefined : word;
  }
  return undefined;
}

const dependency = (command: string): CommandMatch => ({ kind: CommandKind.DEPENDENCY, reason: `${command} changes installed dependencies` });

function classifyJsPackageManager(name: string, args: string[]): CommandMatch | undefined {
  const sub = firstSubcommand(args, VALUE_OPTIONS[name] ?? new Set());
  if (sub === undefined) {
    // `yarn` alone installs; `yarn --version` and friends do not.
    return name === "yarn" && !hasAny(args, "--version", "-v", "--help", "-h") ? dependency("yarn install") : undefined;
  }
  return JS_DEPENDENCY_SUBCOMMANDS.has(sub) ? dependency(`${name} ${sub}`) : undefined;
}

function classifyPip(label: string, args: string[]): CommandMatch | undefined {
  return args[0] === "install" || args[0] === "uninstall" ? dependency(`${label} ${args[0]}`) : undefined;
}

/** A target with trailing slashes, `/.` and `/*` removed (`/.` is `/`, `~/.` and `$HOME/*` are the home directory); empty is the root. */
function rootedTarget(target: string): string {
  let current = target;
  for (let previous = ""; previous !== current; ) {
    previous = current;
    current = current.replace(/\/+$/, "").replace(/\/(\.|\*)$/, "");
  }
  return current || "/";
}

function classifyRm(args: string[], viaXargs: boolean): CommandMatch | undefined {
  const recursive = hasShortFlag(args, "r") || hasShortFlag(args, "R") || hasAny(args, "--recursive");
  const force = hasShortFlag(args, "f") || hasAny(args, "--force");
  if (!recursive && !force) return undefined;
  // Everything after "--" is a target, even when it starts with a dash.
  const endOfOptions = args.indexOf("--");
  const targets = args.filter((a, i) => (endOfOptions === -1 || i < endOfOptions ? !a.startsWith("-") : i > endOfOptions));
  if (recursive && targets.some((t) => CATASTROPHIC_RM_TARGETS.has(rootedTarget(t)) || CATASTROPHIC_RM_TARGETS.has(t))) {
    return { kind: CommandKind.DESTRUCTIVE, reason: `rm on a root, home or wildcard target (${targets.join(" ")})`, hardDeny: true };
  }
  // xargs appends targets from stdin, so the visible ones are not the full list.
  if (!viaXargs && targets.length > 0 && targets.every((t) => isScratchPath(t))) return undefined;
  return { kind: CommandKind.DESTRUCTIVE, reason: `rm ${recursive ? "recursive" : "forced"} removal` };
}

/**
 * Reads git's global options: the subcommand index (-1 when there is none), the first one that points git at another directory
 * (`-C <dir>`, `--git-dir`, `--work-tree`, `-c core.worktree=…`), as the text to show, and the first alias set on the command line.
 */
function gitGlobals(args: string[]): { index: number; elsewhere?: string; alias?: string } {
  let elsewhere: string | undefined;
  let alias: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C" || a === "--git-dir" || a === "--work-tree") {
      elsewhere ??= `${a} ${args[i + 1] ?? ""}`.trim();
      i++;
    } else if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) {
      elsewhere ??= a;
    } else if (a === "-c" || a === "--config-env") {
      const setting = args[i + 1] ?? "";
      if (/^core\.worktree=/i.test(setting)) elsewhere ??= `${a} ${setting}`;
      if (/^alias\./i.test(setting)) alias ??= setting;
      i++;
    } else if (/^--config-env=core\.worktree=/i.test(a)) {
      elsewhere ??= a;
    } else if (/^--config-env=alias\./i.test(a)) {
      alias ??= a.slice("--config-env=".length);
    } else if (a === "--namespace" || a === "--super-prefix") {
      i++;
    } else if (!a.startsWith("-")) {
      return { index: i, elsewhere, alias };
    }
  }
  return { index: -1, elsewhere, alias };
}

/** The first refspec among a fetch's or pull's words that writes a local ref (`main:main`, `+feat/x:main`); the first word is the repository. */
function refspecWithDestination(rest: string[]): string | undefined {
  const words = rest.filter((a) => !a.startsWith("-"));
  return words.slice(1).find((word) => {
    const colon = word.indexOf(":");
    return colon !== -1 && colon < word.length - 1;
  });
}

/**
 * What a git command does. Run in another directory (`-C`, `--git-dir`, `--work-tree`, `GIT_DIR=`, `GIT_WORK_TREE=`, or after a `cd` that left the checkout)
 * it leaves the branch the session works on, whatever the subcommand: a commit there is that, not a local commit. An alias set on the command
 * line (`-c alias.p=push`) can stand for any subcommand, so the command cannot be read.
 */
function classifyGit(args: string[], assignments: string[], left: string | undefined): CommandMatch[] {
  const { index, elsewhere: viaOptions, alias } = gitGlobals(args);
  if (alias) return [{ kind: CommandKind.UNREADABLE, reason: `a git alias set on the command line (${alias})` }];
  if (index === -1) return [];
  const sub = args[index]!;
  const found = classifyGitSubcommand(sub, args.slice(index + 1));
  const elsewhere = viaOptions ?? assignments.find((a) => GIT_LOCATION_VARIABLE.test(a)) ?? (left && `after ${left}`);
  if (!elsewhere) return found ? [found] : [];
  const away: CommandMatch = { kind: CommandKind.LEAVING, reason: `git ${sub} elsewhere (${elsewhere})` };
  return found && found.kind !== CommandKind.COMMIT && found.kind !== CommandKind.LEAVING ? [found, away] : [away];
}

function classifyGitSubcommand(sub: string, rest: string[]): CommandMatch | undefined {
  const destructive = (reason: string): CommandMatch => ({ kind: CommandKind.DESTRUCTIVE, reason: `git ${reason}` });
  const leaving = (reason: string): CommandMatch => ({ kind: CommandKind.LEAVING, reason: `git ${reason}` });

  switch (sub) {
    case "reset":
      return hasAny(rest, "--hard", "--merge", "--keep") ? destructive("reset discards work") : undefined;
    case "clean":
      return (hasShortFlag(rest, "f") || hasAny(rest, "--force")) && !(hasShortFlag(rest, "n") || hasAny(rest, "--dry-run"))
        ? destructive("clean deletes untracked files")
        : undefined;
    case "checkout":
      if (hasAny(rest, "--", ".", "-f", "--force")) return destructive("checkout discards changes");
      return rest.length > 0 ? leaving("checkout") : undefined;
    case "restore": {
      const onlyStaged = hasAny(rest, "--staged", "-S") && !hasAny(rest, "--worktree", "-W");
      return onlyStaged ? undefined : destructive("restore discards working-tree changes");
    }
    case "switch":
      if (hasAny(rest, "--discard-changes", "-f", "--force")) return destructive("switch discards changes");
      return rest.length > 0 ? leaving("switch") : undefined;
    case "branch": {
      if (hasAny(rest, "-D") || (hasAny(rest, "--delete", "-d") && hasAny(rest, "--force", "-f"))) return destructive("branch force-delete");
      // `-f` and `-C` point an existing branch, possibly main, somewhere else.
      if (hasAny(rest, "-f", "--force")) return leaving("branch --force moves a branch");
      if (hasAny(rest, "-C")) return leaving("branch -C overwrites a branch");
      // One name renames the current branch, which may be main or master.
      const names = rest.filter((a) => !a.startsWith("-"));
      const renames = hasAny(rest, "--move") || hasShortFlag(rest, "m") || hasShortFlag(rest, "M");
      return renames && (names.length === 1 || names.some((n) => PROTECTED_NAMES.has(n))) ? destructive("branch rename of main, master or the current branch") : undefined;
    }
    case "symbolic-ref": {
      // Two names write the ref (`-m` takes a message); one only reads it.
      const names = rest.filter((a, i) => !a.startsWith("-") && rest[i - 1] !== "-m");
      return hasAny(rest, "-d", "--delete") || names.length >= 2 ? destructive("symbolic-ref rewrites a ref") : undefined;
    }
    case "remote":
      return rest.find((a) => !a.startsWith("-")) === "set-head" ? destructive("remote set-head rewrites origin/HEAD") : undefined;
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear" ? destructive(`stash ${rest[0]}`) : undefined;
    case "rebase":
      return destructive("rebase rewrites history");
    case "filter-branch":
    case "filter-repo":
      return destructive(`${sub} rewrites history`);
    case "reflog":
      return rest[0] === "expire" || rest[0] === "delete" ? destructive(`reflog ${rest[0]}`) : undefined;
    case "gc":
      return rest.some((a) => a.startsWith("--prune")) ? destructive("gc prune") : undefined;
    case "update-ref":
      return destructive(hasAny(rest, "-d") ? "update-ref delete" : "update-ref rewrites a ref");
    case "worktree":
      if (rest[0] === "add" || rest[0] === "move") return leaving(`worktree ${rest[0]}`);
      return rest[0] === "remove" && hasAny(rest, "-f", "--force") ? destructive("worktree force-remove") : undefined;
    case "push": {
      const forced = hasAny(rest, "--force", "-f", "--force-with-lease", "--mirror", "--delete", "-d", "--prune");
      const forcedRefspec = rest.some((a) => !a.startsWith("-") && (a.startsWith("+") || a.startsWith(":")));
      return forced || forcedRefspec ? destructive("push rewrites or deletes remote refs") : { kind: CommandKind.REMOTE, reason: "git push" };
    }
    case "commit":
      return { kind: CommandKind.COMMIT, reason: hasAny(rest, "--amend") ? "git commit --amend" : "git commit" };
    case "fetch":
    case "pull": {
      const refspec = refspecWithDestination(rest);
      return refspec ? leaving(`${sub} writes a local branch (${refspec})`) : undefined;
    }
    // Pushes under another name.
    case "send-pack":
    case "http-push":
      return { kind: CommandKind.REMOTE, reason: `git ${sub}` };
    case "subtree":
      return rest.includes("push") ? { kind: CommandKind.REMOTE, reason: "git subtree push" } : undefined;
    case "svn":
      return rest[0] === "dcommit" ? { kind: CommandKind.REMOTE, reason: "git svn dcommit" } : undefined;
    case "p4":
      return rest[0] === "submit" ? { kind: CommandKind.REMOTE, reason: "git p4 submit" } : undefined;
    default:
      return undefined;
  }
}

/** The HTTP method of `gh api` arguments: `-X PUT`, `-XPUT`, `--method PUT` or `--method=PUT`. */
function ghApiMethod(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X" || a === "--method") return args[i + 1]?.toUpperCase();
    if (a.startsWith("--method=")) return a.slice("--method=".length).toUpperCase();
    if (/^-X./.test(a)) return a.slice(2).replace(/^=/, "").toUpperCase();
  }
  return undefined;
}

// Ways `gh api` lands work on a branch other people use, the same as `gh pr merge`: merging a PR or a branch, enabling
// auto-merge, moving a branch ref, or committing a file through the contents API.
const GH_API_MERGES: Array<[RegExp, string]> = [
  [/\/pulls\/[^/\s]+\/merge\b/, "gh api merges a pull request"],
  [/(^|\/)repos\/[^/\s]+\/[^/\s]+\/merges\b/, "gh api merges a branch"],
  [/\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/, "gh api merges through GraphQL"],
  [/\/git\/refs\b/, "gh api writes a branch ref"],
  [/\/contents\//, "gh api commits a file"],
];

function classifyGh(args: string[]): CommandMatch | undefined {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-R" || args[i] === "--repo") i++;
    else if (!args[i]!.startsWith("-")) positional.push(args[i]!);
  }
  const [group, action] = positional;
  if (group === "repo" && (action === "delete" || action === "archive")) return { kind: CommandKind.DESTRUCTIVE, reason: `gh repo ${action}` };
  if ((group === "pr" && action === "merge") || (group === "release" && ["create", "delete", "upload", "edit"].includes(action ?? ""))) {
    return { kind: CommandKind.PUBLISH, reason: `gh ${group} ${action}` };
  }
  if ((group === "pr" || group === "issue") && ["create", "comment", "review", "edit", "close", "reopen"].includes(action ?? "")) {
    return { kind: CommandKind.REMOTE, reason: `gh ${group} ${action}` };
  }
  if (group === "api") {
    const all = args.slice(args.indexOf("api") + 1);
    const method = ghApiMethod(all);
    if (method === "DELETE") return { kind: CommandKind.DESTRUCTIVE, reason: "gh api DELETE" };
    // A body (fields or a file) makes gh send a POST.
    const writes = (method !== undefined && method !== "GET") || all.some((a) => /^-[fF]/.test(a)) || hasAny(all, "--field", "--raw-field", "--input");
    if (!writes) return undefined;
    const merge = GH_API_MERGES.find(([pattern]) => all.some((a) => pattern.test(a)));
    if (merge) return { kind: CommandKind.PUBLISH, reason: merge[1] };
    return { kind: CommandKind.REMOTE, reason: method && method !== "GET" ? `gh api ${method}` : "gh api write (POST)" };
  }
  return undefined;
}

const SQL_PATTERNS: Array<[RegExp, string]> = [
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW|INDEX|COLLECTION)\b/i, "SQL DROP"],
  [/\bTRUNCATE\s+(TABLE\s+)?[`"\w]/i, "SQL TRUNCATE"],
  [/\bDELETE\s+FROM\s+[`"\w.]+\s*(;|$)(?![\s\S]*\bWHERE\b)/i, "SQL DELETE without WHERE"],
  [/\.dropDatabase\s*\(|\.drop\s*\(\s*\)/, "MongoDB drop"],
  [/\bFLUSH(ALL|DB)\b/i, "Redis flush"],
];

const DIRECTORY_COMMANDS = new Set(["cd", "pushd", "popd"]);

/**
 * Follows a `cd`, `pushd` or `popd` in `ctx`. The folder it moves to is the one relative targets are read from; where it cannot be told
 * (`cd` alone, `cd -`, `popd`, `pushd +1`) it is written as the shell would know it (`~`, `$OLDPWD`, `$DIRSTACK`), which is never inside the project.
 */
function changeDirectory(name: string, args: string[], ctx: Context): void {
  const words = args.filter((a) => a === "-" || !a.startsWith("-") || /^-\d+$/.test(a));
  const target = words[0];
  let dir: string;
  if (name === "popd" || (name === "pushd" && (target === undefined || /^[+-]\d+$/.test(target)))) dir = "$DIRSTACK";
  else if (target === undefined) dir = "~";
  else if (target === "-") dir = "$OLDPWD";
  else dir = isAbsolute(target) || /^[~$]/.test(target) ? target : join(ctx.dir || ".", target);
  ctx.dir = dir;
  if (!ctx.left && !ctx.stays?.(dir)) ctx.left = [name, ...args].join(" ");
}

function classifySegment(rawArgv: string[], before: string, depth: number, ctx: Context): CommandAnalysis {
  const { argv, privileged, viaXargs, assignments, script: splitScript } = unwrap(rawArgv);
  const matches: CommandMatch[] = [];
  const writes: string[] = [];
  if (privileged) matches.push({ kind: CommandKind.PRIVILEGED, reason: "elevated privileges (sudo)" });
  if (splitScript) {
    const nested = analyze(splitScript, depth + 1, ctx);
    matches.push(...nested.matches);
    writes.push(...nested.writes);
  }
  // `GIT_DIR=… ` on its own, or `export GIT_DIR=…`, points the git commands that follow at another repository.
  const location = argv.length === 0 ? assignments : basename(argv[0] ?? "") === "export" ? argv.slice(1) : [];
  const moved = location.find((a) => GIT_LOCATION_VARIABLE.test(a));
  if (moved) matches.push({ kind: CommandKind.LEAVING, reason: `git pointed elsewhere (${moved})` });
  if (argv.length === 0) return { matches, writes };

  const name = basename(argv[0]!);
  const args = argv.slice(1);

  if (DIRECTORY_COMMANDS.has(name)) {
    changeDirectory(name, args, ctx);
    return { matches, writes };
  }

  if (SHELLS.has(name) || name === "eval") {
    const scriptIndex = name === "eval" ? 0 : args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    const script = name === "eval" ? args.join(" ") : scriptIndex >= 0 ? args[scriptIndex + 1] : undefined;
    if (script) {
      const nested = analyze(script, depth + 1, ctx);
      matches.push(...nested.matches);
      writes.push(...nested.writes);
    } else if (before === "|") {
      matches.push({ kind: CommandKind.PRIVILEGED, reason: `piping into ${name} runs downloaded or generated code` });
    }
    return { matches, writes };
  }

  if (TEXT_COMMANDS.has(name)) return { matches, writes };

  let match: CommandMatch | undefined;
  switch (name) {
    case "rm":
      match = classifyRm(args, viaXargs);
      break;
    case "git":
      matches.push(...classifyGit(args, assignments, ctx.left));
      break;
    case "gh":
      match = classifyGh(args);
      break;
    case "find":
      if (args.includes("-delete") || args.some((a, i) => (a === "-exec" || a === "-execdir") && basename(args[i + 1] ?? "") === "rm")) {
        match = { kind: CommandKind.DESTRUCTIVE, reason: "find deletes files" };
      }
      break;
    case "shred":
    case "wipefs":
    case "truncate":
      match = { kind: CommandKind.DESTRUCTIVE, reason: `${name} destroys file contents` };
      break;
    case "dd":
      if (args.some((a) => a.startsWith("of=/dev/"))) match = { kind: CommandKind.DESTRUCTIVE, reason: "dd writes to a device", hardDeny: true };
      else if (args.some((a) => a.startsWith("of="))) match = { kind: CommandKind.DESTRUCTIVE, reason: "dd overwrites a file" };
      break;
    case "diskutil":
      if (args.some((a) => /^(erase|zero|secureErase|partitionDisk)/i.test(a))) match = { kind: CommandKind.DESTRUCTIVE, reason: "diskutil erases a disk", hardDeny: true };
      break;
    case "dropdb":
      match = { kind: CommandKind.DESTRUCTIVE, reason: "dropdb" };
      break;
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      {
        const published = publishWord(name, args);
        match = published ? { kind: CommandKind.PUBLISH, reason: `${name} ${published}` } : classifyJsPackageManager(name, args);
      }
      break;
    case "pip":
    case "pip3":
      match = classifyPip(name, args);
      break;
    case "python":
    case "python3":
      if (args[0] === "-m" && (args[1] === "pip" || args[1] === "pip3")) match = classifyPip(`${name} -m ${args[1]}`, args.slice(2));
      break;
    case "uv":
      if (args[0] === "pip") match = classifyPip("uv pip", args.slice(1));
      else if (["add", "remove", "sync"].includes(args[0] ?? "")) match = dependency(`uv ${args[0]}`);
      break;
    case "poetry":
      if (["add", "remove", "install", "update"].includes(args[0] ?? "")) match = dependency(`poetry ${args[0]}`);
      break;
    case "go":
      if (args[0] === "get" || args[0] === "install") match = dependency(`go ${args[0]}`);
      break;
    case "brew":
      if (["install", "uninstall", "upgrade"].includes(args[0] ?? "")) match = dependency(`brew ${args[0]}`);
      break;
    case "gem":
      if (args[0] === "install") match = dependency("gem install");
      break;
    case "cargo":
      if (args[0] === "publish" || args[0] === "yank") match = { kind: CommandKind.PUBLISH, reason: `cargo ${args[0]}` };
      else if (["add", "remove", "install"].includes(args[0] ?? "")) match = dependency(`cargo ${args[0]}`);
      break;
    case "twine":
      if (args[0] === "upload") match = { kind: CommandKind.PUBLISH, reason: "twine upload" };
      break;
    case "docker":
    case "podman":
      if (args[0] === "push") match = { kind: CommandKind.PUBLISH, reason: `${name} push` };
      else if (args[0] === "system" && args[1] === "prune") match = { kind: CommandKind.DESTRUCTIVE, reason: `${name} system prune` };
      break;
    case "prisma":
      if (args[0] === "migrate" && args[1] === "reset") match = { kind: CommandKind.DESTRUCTIVE, reason: "prisma migrate reset" };
      break;
    case "rails":
    case "rake":
      if (args.some((a) => /^db:(drop|reset|purge)/.test(a))) match = { kind: CommandKind.DESTRUCTIVE, reason: `${name} ${args.find((a) => a.startsWith("db:"))}` };
      break;
    default:
      if (/^mkfs(\.|$)/.test(name)) match = { kind: CommandKind.DESTRUCTIVE, reason: "mkfs formats a filesystem", hardDeny: true };
  }
  if (match) matches.push(match);

  const text = argv.join(" ");
  const sql = SQL_PATTERNS.find(([pattern]) => pattern.test(text));
  if (sql) matches.push({ kind: CommandKind.DESTRUCTIVE, reason: sql[1] });
  return { matches, writes };
}

/** A redirect target read from the folder the line has moved to. */
const fromDirectory = (target: string, ctx: Context) => (ctx.dir === "" || isAbsolute(target) || /^[~$]/.test(target) ? target : join(ctx.dir, target));

function analyze(command: string, depth: number, ctx: Context): CommandAnalysis {
  if (depth > MAX_DEPTH) return { matches: [UNREADABLE], writes: [] };
  const tokens = tokenize(blankConditionals(blankHeredocs(command)));
  if (!tokens) return { matches: [UNREADABLE], writes: [] };
  const matches: CommandMatch[] = [];
  const writes: string[] = [];
  for (const segment of tokens.segments) {
    const found = classifySegment(segment.argv, segment.before, depth, ctx);
    matches.push(...found.matches);
    writes.push(...found.writes);
    // `>&1`, `2>&-`: a descriptor, not a file.
    for (const { op, target } of segment.redirects) if (!(op.endsWith("&") && /^(\d+|-)$/.test(target))) writes.push(fromDirectory(target, ctx));
  }
  for (const body of tokens.nested) {
    const found = analyze(body, depth + 1, ctx);
    matches.push(...found.matches);
    writes.push(...found.writes);
  }
  return { matches, writes };
}

/** One simple command of a command line: its words as the shell would pass them (quotes removed), and whether it redirects output. */
export type SimpleCommand = { argv: string[]; redirected: boolean };

/**
 * The simple commands of a command line, in order. For callers that read a command's own words (path rules): wrappers,
 * assignments and nested scripts are left as they are. Null when a quote or substitution is left open.
 */
export function simpleCommands(command: string): SimpleCommand[] | null {
  const tokens = tokenize(command);
  return tokens ? tokens.segments.map(({ argv, redirects }) => ({ argv, redirected: redirects.length > 0 })) : null;
}

/** The risky parts of a shell command and the files it redirects output to (relative ones as seen from the session's folder). */
export function analyzeCommand(command: string, options: AnalyzeOptions = {}): CommandAnalysis {
  return analyze(command, 0, { ...options, dir: "" });
}
