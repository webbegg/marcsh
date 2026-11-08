// Pure decision logic for the marcsh PreToolUse guard on Bash. No I/O: the caller supplies the branch lookup.
//
// The command is split into simple commands (on `;` `&&` `||` `|` `&` newlines, subshell parentheses and backticks outside
// quotes) and each one is read word by word, so text inside quotes (`echo "git push"`) is data and never matches.
//
// Known false negatives: indirection is not followed (`bash -c "git push"`, `eval "..."`, git aliases, scripts, `$(...)` or
// backticks inside double quotes).
//
// The branch a commit lands on is tracked per target directory (the hook's cwd or the `git -C` directory) while the simple
// commands are walked in order: `git switch -c|-C <b>`, `git checkout -b|-B <b>` and `git switch <b>` set it to `<b>`, and
// `git checkout <name>` sets it only when `<name>` is an existing local branch (`git checkout -- <path>` and
// `git checkout <path>` are not switches). `git switch -` / `git checkout -` make it unknown, and an unknown branch falls back
// to the branch the command started on. Known gaps: a `cd` in the same command is not tracked; every simple command is
// assumed to run (`||`, `if` and `&&` short-circuits are not modeled); a branch made by `git branch <b>` earlier in the
// command is not known to `git checkout <b>`; `git checkout <b>` of a remote-only branch is not a switch.

export type BranchInfo = {
  branch: string;
  defaultBranch: string | null;
  /** Whether `name` is an existing local branch of the same repository. */
  isLocalBranch: (name: string) => boolean;
};
export type Decision = { decision: "deny" | "ask"; reason: string };
/** Looks up the current and default branch of the repository at `dir` (null = the hook's cwd). Null = unknown. */
export type BranchLookup = (dir: string | null) => BranchInfo | null;

type Action =
  | { type: "commit"; dir: string | null }
  // `name` null = the branch becomes unknown; `ifLocal` = only when `name` is an existing local branch.
  | { type: "switch"; dir: string | null; name: string | null; ifLocal: boolean }
  | { type: "ship"; name: string };

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

/** What `git switch|checkout <rest>` does to the current branch, or null when it does not switch. */
function branchSwitch(sub: "switch" | "checkout", rest: string[]): { name: string | null; ifLocal: boolean } | null {
  const createFlags = sub === "switch" ? ["c", "C"] : ["b", "B"];
  const positional: string[] = [];
  let pathMode = false;
  let track = false;
  for (let k = 0; k < rest.length; k++) {
    const word = rest[k]!;
    if (pathMode || !word.startsWith("-") || word === "-") {
      positional.push(word);
    } else if (word === "--") {
      pathMode = true;
    } else if (word.startsWith("--")) {
      const [flag, value] = word.split(/=(.*)/s, 2) as [string, string | undefined];
      if (flag === "--create" || flag === "--force-create" || flag === "--orphan") {
        return { name: value ?? rest[k + 1] ?? null, ifLocal: false };
      }
      if (flag === "--detach") return { name: null, ifLocal: false };
      if (flag === "--patch") return null;
      if (flag === "--track") track = true;
      else if ((flag === "--conflict" || flag === "--pathspec-from-file") && value === undefined) k++;
    } else if (createFlags.includes(word[1]!)) {
      return { name: word.length > 2 ? word.slice(2) : (rest[k + 1] ?? null), ifLocal: false };
    } else if (word[1] === "d") {
      return { name: null, ifLocal: false };
    } else if (word[1] === "p") {
      return null;
    } else if (word[1] === "t") {
      track = true;
    }
  }
  if (sub === "checkout" && rest.includes("--")) return null;
  // `git switch <b>` takes one branch; `git checkout <x>` is a switch only for one word, and only if it is a branch.
  if (positional.length !== 1) return null;
  const target = positional[0]!;
  if (target === "-") return { name: null, ifLocal: false };
  // `git switch -t origin/b` creates the local branch `b`.
  if (track) return { name: target.replace(/^[^/]+\//, ""), ifLocal: false };
  return { name: target, ifLocal: sub === "checkout" };
}

function findActions(segments: string[][]): Action[] {
  const actions: Action[] = [];

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
      if (sub === "commit") actions.push({ type: "commit", dir });
      else if (sub === "push") actions.push({ type: "ship", name: "git push" });
      else if (sub === "switch" || sub === "checkout") {
        const target = branchSwitch(sub, rest);
        if (target) actions.push({ type: "switch", dir, ...target });
      }
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

const isDefaultBranch = (branch: string, defaultBranch: string | null) =>
  defaultBranch ? branch === defaultBranch : branch === "main" || branch === "master";

/** The guard's verdict for a Bash command, or null for no decision (anything unclear never blocks). */
export function decide(command: string, lookup: BranchLookup): Decision | null {
  const segments = split(command);
  if (!segments) return null;
  const actions = findActions(segments);

  // Per target directory: what git reported at the start, and the branch the walked switches moved to (absent = unknown).
  const infos = new Map<string | null, BranchInfo | null>();
  const tracked = new Map<string | null, string>();
  const infoFor = (dir: string | null) => {
    if (!infos.has(dir)) {
      try {
        infos.set(dir, lookup(dir));
      } catch {
        infos.set(dir, null);
      }
    }
    return infos.get(dir) ?? null;
  };

  for (const action of actions) {
    if (action.type === "switch") {
      if (action.name === null) {
        tracked.delete(action.dir);
      } else if (!action.ifLocal) {
        tracked.set(action.dir, action.name);
      } else {
        const info = infoFor(action.dir);
        let exists = false;
        try {
          exists = info?.isLocalBranch(action.name) ?? false;
        } catch {
          // Not known to exist: not a switch.
        }
        if (exists) tracked.set(action.dir, action.name);
      }
    } else if (action.type === "commit") {
      const info = infoFor(action.dir);
      if (!info) continue;
      const branch = tracked.get(action.dir) ?? info.branch;
      if (isDefaultBranch(branch, info.defaultBranch)) {
        return {
          decision: "deny",
          reason: `marcsh: commits on ${branch} are blocked; create a branch first (git switch -c <type>/<description>)`,
        };
      }
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
