// Pure decision logic for the marcsh PreToolUse guard on Bash. No I/O: the caller supplies the branch lookup.
//
// The command is split into simple commands (on `;` `&&` `||` `|` `&` newlines, subshell parentheses and backticks outside
// quotes) and each one is read word by word, so text inside quotes (`echo "git push"`) is data and never matches.
//
// Known false negatives: indirection is not followed (`bash -c "git push"`, `eval "..."`, git aliases, scripts, `$(...)` or
// backticks inside double quotes). Known false positives: a `cd` in the same command is not tracked (the branch is read in
// the hook's cwd or the `git -C` directory), and `git commit` after a branch-creating `git switch -c` / `git checkout -b`
// earlier in the same command is let through, even when that creation happened in another directory.

export type BranchInfo = { branch: string; defaultBranch: string | null };
export type Decision = { decision: "deny" | "ask"; reason: string };
/** Looks up the current and default branch of the repository at `dir` (null = the hook's cwd). Null = unknown. */
export type BranchLookup = (dir: string | null) => BranchInfo | null;

type Action = { type: "commit"; dir: string | null; branchCreated: boolean } | { type: "ship"; name: string };

const SEPARATORS = new Set([";", "|", "&", "\n", "(", ")", "`"]);
// Words that can sit in front of the real command in a simple command.
const PREFIXES = new Set(["env", "command", "time", "exec", "nohup", "sudo", "!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_OPTIONS_WITH_VALUE = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
// After one of these the word `publish` names a script or a lookup, not the publish command.
const NOT_PUBLISH = new Set(["run", "run-script", "exec", "x", "dlx", "create", "init", "help", "view", "info", "search"]);

/** Splits a command into simple commands made of words. Null when a quote is left open. */
function split(command: string): string[][] | null {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      inWord = true;
      let closed = false;
      for (i++; i < command.length; i++) {
        const d = command[i]!;
        if (d === "\\" && i + 1 < command.length) {
          i++;
          word += command[i]!;
        } else if (d === '"') {
          closed = true;
          break;
        } else {
          word += d;
        }
      }
      if (!closed) return null;
    } else if (c === "\\") {
      i++;
      if (i < command.length && command[i] !== "\n") {
        word += command[i]!;
        inWord = true;
      }
    } else if (c === "#" && !inWord) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (SEPARATORS.has(c)) {
      endSegment();
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

function createsBranch(sub: string, rest: string[]): boolean {
  const flags = sub === "switch" ? ["c", "C"] : ["b", "B"];
  return rest.some((word) => {
    if (word === "--create" || word === "--force-create") return sub === "switch";
    return word.startsWith("-") && !word.startsWith("--") && flags.some((f) => word[1] === f);
  });
}

function findActions(segments: string[][]): Action[] {
  const actions: Action[] = [];
  let branchCreated = false;

  for (const words of segments) {
    let i = 0;
    while (i < words.length && (ENV_ASSIGNMENT.test(words[i]!) || PREFIXES.has(words[i]!))) {
      const wasEnv = words[i] === "env";
      i++;
      if (wasEnv) while (i < words.length && words[i]!.startsWith("-")) i++;
    }
    const program = words[i] === undefined ? "" : basename(words[i]!);
    const args = words.slice(i + 1);

    if (program === "git") {
      let dir: string | null = null;
      let j = 0;
      while (j < args.length && args[j]!.startsWith("-")) {
        if (args[j] === "-C") {
          dir = args[j + 1] ?? dir;
          j += 2;
        } else if (GIT_OPTIONS_WITH_VALUE.has(args[j]!)) {
          j += 2;
        } else {
          j++;
        }
      }
      const sub = args[j];
      const rest = args.slice(j + 1);
      if (sub === "commit") actions.push({ type: "commit", dir, branchCreated });
      else if (sub === "push") actions.push({ type: "ship", name: "git push" });
      else if ((sub === "switch" || sub === "checkout") && createsBranch(sub, rest)) branchCreated = true;
    } else if (program === "gh") {
      const positional: string[] = [];
      for (let j = 0; j < args.length; j++) {
        if (args[j] === "-R" || args[j] === "--repo") j++;
        else if (!args[j]!.startsWith("-")) positional.push(args[j]!);
      }
      if (positional[0] === "pr" && (positional[1] === "create" || positional[1] === "merge")) {
        actions.push({ type: "ship", name: `gh pr ${positional[1]}` });
      }
    } else if (program === "npm" || program === "pnpm" || program === "yarn" || program === "bun") {
      for (const word of args) {
        if (NOT_PUBLISH.has(word)) break;
        if (word === "publish") {
          actions.push({ type: "ship", name: `${program} publish` });
          break;
        }
      }
    }
  }
  return actions;
}

const isDefaultBranch = ({ branch, defaultBranch }: BranchInfo) =>
  defaultBranch ? branch === defaultBranch : branch === "main" || branch === "master";

/** The guard's verdict for a Bash command, or null for no decision (anything unclear never blocks). */
export function decide(command: string, lookup: BranchLookup): Decision | null {
  const segments = split(command);
  if (!segments) return null;
  const actions = findActions(segments);

  for (const action of actions) {
    if (action.type !== "commit" || action.branchCreated) continue;
    let info: BranchInfo | null = null;
    try {
      info = lookup(action.dir);
    } catch {
      continue;
    }
    if (info && isDefaultBranch(info)) {
      return {
        decision: "deny",
        reason: `marcsh: commits on ${info.branch} are blocked; create a branch first (git switch -c <type>/<description>)`,
      };
    }
  }

  const ship = actions.find((action) => action.type === "ship");
  if (ship?.type === "ship") return { decision: "ask", reason: `marcsh: ${ship.name} needs your approval` };
  return null;
}

export function toHookOutput({ decision, reason }: Decision) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}
