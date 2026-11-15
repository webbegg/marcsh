import { basename } from "node:path";
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

/**
 * The folder name of the linked worktree `cwd` is in, or null in the main checkout (or when it cannot be read). Linked when
 * `--git-dir` differs from `--git-common-dir`; one `git rev-parse`, which reads HEAD and the repo's paths but never the work tree or
 * the index, so nothing the repo names runs.
 */
export async function readGitWorktree(cwd: string, { timeoutMs = 2000 }: { timeoutMs?: number } = {}): Promise<string | null> {
  const paths = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"], timeoutMs);
  if (!paths || paths.code !== 0) return null;
  const [gitDir, commonDir, top] = paths.out.split("\n");
  if (!gitDir || !commonDir || !top || gitDir === commonDir) return null;
  return basename(top) || null;
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
