import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { BranchState } from "./git-branch";
import { readOnlyGitArgs, readOnlyGitEnv } from "./git-safe";

/**
 * What the status bar shows of the project's git state: the branch (a short SHA when HEAD is detached) and how many files changed;
 * `changed` is null when the files were not counted (a project the user has not trusted). `worktree` is the folder name of a
 * linked git worktree, absent in the main checkout.
 */
export type GitStatus = {
  branch: string;
  changed: number | null;
  worktree?: string;
};

/**
 * Reads `git status --porcelain=v2 --branch`: the `# branch.head` header names the branch, or `(detached)` with the commit in
 * `# branch.oid`; every other non-empty line is one changed, unmerged or untracked entry. Null when the header is missing.
 */
export function parseGitStatus(output: string): GitStatus | null {
  let head: string | undefined;
  let oid: string | undefined;
  let changed = 0;

  for (const line of output.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("# ")) {
      if (line.startsWith("# branch.head ")) head = line.slice("# branch.head ".length);
      else if (line.startsWith("# branch.oid ")) oid = line.slice("# branch.oid ".length);
      continue;
    }
    // Ignored files are only listed with --ignored; never count them.
    if (!line.startsWith("! ")) changed += 1;
  }

  if (head === undefined) return null;
  const branch = head === "(detached)" ? (oid && oid !== "(initial)" ? oid.slice(0, 7) : "detached") : head;
  return { branch, changed };
}

/**
 * e.g. `main`, `main · 1 file changed`, `feat/x · wt pack-integration · 3 files changed`; the branch (and worktree) alone when nothing
 * changed or nothing was counted.
 */
export function formatGit(status: GitStatus): string {
  const place = status.worktree ? `${status.branch} · wt ${status.worktree}` : status.branch;
  if (!status.changed) return place;
  return `${place} · ${status.changed} ${status.changed === 1 ? "file" : "files"} changed`;
}

type GitRun = { code: number; out: string };

/**
 * One hardened, read-only git call (see `git-safe.ts`) in `cwd`: its exit code and output. Null when it cannot start (a folder
 * that does not exist, no git on PATH) or does not answer within `timeoutMs` (it is then killed).
 */
async function runGit(cwd: string, args: string[], timeoutMs: number): Promise<GitRun | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(["git", ...readOnlyGitArgs(), ...args], { cwd, env: readOnlyGitEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        proc.kill();
        resolve(null);
      }, timeoutMs);
    });
    const finished = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out, code]) => ({ code, out }));
    return await Promise.race([finished, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The full ref, not `--short`: when a tag shares the branch's name, `--short` names it `heads/main`.
const HEADS = "refs/heads/";

/**
 * The branch `cwd` is on, or the short SHA of a detached HEAD, read from HEAD alone: `git symbolic-ref` and `git rev-parse` never
 * look at the work tree or refresh the index, so no filter driver, fsmonitor or hook of the repo runs. `detached` for a detached
 * HEAD whose commit cannot be read. Null outside a repo, when git fails, or when a call does not answer within `timeoutMs`.
 */
export async function readGitBranch(cwd: string, { timeoutMs = 2000 }: { timeoutMs?: number } = {}): Promise<string | null> {
  // `-q`: a detached HEAD exits 1 without a message; not a repository exits 128.
  const head = await runGit(cwd, ["symbolic-ref", "-q", "HEAD"], timeoutMs);
  if (!head) return null;
  const ref = head.out.trim();
  if (head.code === 0) return ref.startsWith(HEADS) && ref.length > HEADS.length ? ref.slice(HEADS.length) : ref || null;
  if (head.code !== 1) return null;
  const sha = await runGit(cwd, ["rev-parse", "--short", "HEAD"], timeoutMs);
  if (!sha) return null;
  return sha.code === 0 && sha.out.trim() ? sha.out.trim() : "detached";
}

const realOrNull = async (path: string) => {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
};

/**
 * One read of the worktree: its folder name, null in the main checkout, undefined when git's answer cannot be read. `--git-dir` and
 * `--git-common-dir` may be relative to `cwd` (no `--path-format`, which git before 2.31 does not know and echoes back as a line);
 * the answer must be exactly three paths, none of them an echoed option, so a newline in a path is refused rather than misread.
 */
async function readWorktreeOnce(cwd: string, timeoutMs: number): Promise<string | null | undefined> {
  const paths = await runGit(cwd, ["rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"], timeoutMs);
  if (!paths || paths.code !== 0 || !paths.out.endsWith("\n")) return undefined;
  const lines = paths.out.slice(0, -1).split("\n");
  if (lines.length !== 3 || lines.some((line) => line === "" || line.startsWith("--"))) return undefined;
  const [gitDir, commonDir, top] = lines as [string, string, string];
  if (!isAbsolute(top)) return undefined;
  const [git, common] = await Promise.all([realOrNull(resolve(cwd, gitDir)), realOrNull(resolve(cwd, commonDir))]);
  if (git === null || common === null) return undefined;
  // A linked worktree's git dir is `<common dir>/worktrees/<id>`; a submodule's (`.git/modules/x`) is its own common dir.
  if (git === common || dirname(git) !== join(common, "worktrees")) return null;
  return basename(top) || null;
}

/** What `readGitWorktree` found per folder: a folder's worktree does not change, so it is read once. Oldest entries go first. */
const worktrees = new Map<string, string | null>();
const MAX_WORKTREES = 64;

/**
 * The folder name of the linked worktree `cwd` is in, or null in the main checkout (or while it cannot be read). Linked when the
 * git dir is one of the common dir's `worktrees/`; one `git rev-parse`, which reads the repo's paths but never the work tree or the
 * index, so nothing the repo names runs. Read once per folder; an answer that cannot be read is not kept, so the next call tries again.
 * The name is the folder's as it is: escape it before showing it.
 */
export async function readGitWorktree(cwd: string, { timeoutMs = 2000 }: { timeoutMs?: number } = {}): Promise<string | null> {
  if (worktrees.has(cwd)) return worktrees.get(cwd)!;
  const found = await readWorktreeOnce(cwd, timeoutMs);
  if (found === undefined) return null;
  if (worktrees.size >= MAX_WORKTREES) worktrees.delete(worktrees.keys().next().value!);
  worktrees.set(cwd, found);
  return found;
}

/**
 * Where the checkout at `cwd` stands, as `branchState` (git-branch) says for the approval policy, read asynchronously with the
 * hardened, read-only git calls of the status line (HEAD and `origin/HEAD` alone). The default branch is the one `origin/HEAD` points
 * at, else `main` or `master`. Fails closed: a git that fails or does not answer within `timeoutMs` is `none`, never a feature branch.
 */
export async function readGitBranchState(cwd: string, { timeoutMs = 2000 }: { timeoutMs?: number } = {}): Promise<BranchState> {
  const unreadable: BranchState = { kind: "none", reason: "the branch cannot be read" };
  const head = await runGit(cwd, ["symbolic-ref", "-q", "HEAD"], timeoutMs);
  if (!head) return unreadable;
  if (head.code === 1) return { kind: "none", reason: "detached HEAD" };
  if (head.code === 128) return { kind: "none", reason: "not a git repository" };
  const ref = head.out.trim();
  if (head.code !== 0 || !ref.startsWith(HEADS) || ref.length === HEADS.length) return unreadable;
  const branch = ref.slice(HEADS.length);
  const origin = await runGit(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"], timeoutMs);
  const ORIGIN = "refs/remotes/origin/";
  const originRef = origin && origin.code === 0 ? origin.out.trim() : "";
  const defaultBranch = originRef.startsWith(ORIGIN) && originRef.length > ORIGIN.length ? originRef.slice(ORIGIN.length) : null;
  const isDefault = defaultBranch ? branch === defaultBranch : branch === "main" || branch === "master";
  return isDefault ? { kind: "default", branch } : { kind: "feature", branch };
}

const withWorktree = (status: GitStatus, worktree: string | null): GitStatus => (worktree ? { ...status, worktree } : status);

export type ReadGitStatusOptions = {
  timeoutMs?: number;
  /**
   * Whether the user trusted the project. Only then are the changed files counted: `git status` hashes stat-dirty and racy files
   * through the repo's own filter drivers (`filter.<name>.clean` / `.process`), which are programs the repo names.
   */
  trusted?: boolean;
};

/**
 * The git state of `cwd`, with the linked worktree's name (`readGitWorktree`, trusted or not). Not trusted (the default): the
 * branch from HEAD alone (`readGitBranch`), and no count. Trusted: one
 * `git status` call that takes no optional locks (so it never gets in the way of the user's own git commands), hardened like the
 * HEAD reads (no fsmonitor, hooks or pager; submodules not entered), but it may run the repo's filter drivers. Null outside a
 * repo, when git fails, or when it does not answer within `timeoutMs` (it is then killed).
 */
export async function readGitStatus(cwd: string, { timeoutMs = 2000, trusted = false }: ReadGitStatusOptions = {}): Promise<GitStatus | null> {
  let status: GitStatus | null;
  if (!trusted) {
    const branch = await readGitBranch(cwd, { timeoutMs });
    status = branch === null ? null : { branch, changed: null };
  } else {
    const run = await runGit(cwd, ["status", "--porcelain=v2", "--branch", "--ignore-submodules=all"], timeoutMs);
    status = run && run.code === 0 ? parseGitStatus(run.out) : null;
  }
  return status === null ? null : withWorktree(status, await readGitWorktree(cwd, { timeoutMs }));
}
