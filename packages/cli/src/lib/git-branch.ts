// The branch a folder's checkout is on, for the auto and yolo approval modes (see approval-policy) and for the branch/ship guard.
// The default branch follows the guard's rule: the branch `origin/HEAD` points at, else `main` or `master`.

/** `feature`: a branch that is not the default one. `none`: no branch to work on, and `reason` says why in a few words. */
export type BranchState = { kind: "feature"; branch: string } | { kind: "default"; branch: string } | { kind: "none"; reason: string };

/** A branch state, or a function that reads it when needed (so that a mode that needs no branch never runs git). */
export type BranchSource = BranchState | (() => BranchState);

type GitResult = { code: number; out: string; err: string };

function run(cwd: string, args: string[]): GitResult | null {
  try {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 5000 });
    return { code: result.exitCode ?? -1, out: result.stdout.toString().trim(), err: result.stderr.toString() };
  } catch {
    return null;
  }
}

/** The trimmed output of a git command run in `cwd`; null when it fails, prints nothing, or git cannot run. */
export function git(cwd: string, ...args: string[]): string | null {
  const result = run(cwd, args);
  return result && result.code === 0 ? result.out || null : null;
}

/** Whether a git command run in `cwd` succeeds. */
export function gitSucceeds(cwd: string, ...args: string[]): boolean {
  return run(cwd, args)?.code === 0;
}

/** The branch `origin/HEAD` points at in the repository at `dir` (`origin/develop` is `develop`), or null when it is not set. */
export function originDefaultBranch(dir: string): string | null {
  const origin = git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  return origin ? origin.replace(/^origin\//, "") : null;
}

/**
 * Where the checkout at `cwd` stands. Fails closed: a git that cannot run, a folder that is not a repository, a detached
 * HEAD or any other error is `none`, never a feature branch.
 */
export function branchState(cwd: string): BranchState {
  try {
    // `-q`: a detached HEAD exits 1 without a message; a fatal error (not a repository) exits 128.
    const head = run(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (!head) return { kind: "none", reason: "the branch cannot be read" };
    if (head.code === 1) return { kind: "none", reason: "detached HEAD" };
    if (head.code !== 0 || !head.out) {
      return { kind: "none", reason: /not a git repository/i.test(head.err) ? "not a git repository" : "the branch cannot be read" };
    }
    const branch = head.out;
    const defaultBranch = originDefaultBranch(cwd);
    const isDefault = defaultBranch ? branch === defaultBranch : branch === "main" || branch === "master";
    return isDefault ? { kind: "default", branch } : { kind: "feature", branch };
  } catch {
    return { kind: "none", reason: "the branch cannot be read" };
  }
}

/** The branch state of a source; a lookup that throws is `none`. */
export function resolveBranch(source: BranchSource): BranchState {
  if (typeof source !== "function") return source;
  try {
    return source();
  } catch {
    return { kind: "none", reason: "the branch cannot be read" };
  }
}
