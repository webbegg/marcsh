/** What the status bar shows of the project's git state: the branch (a short SHA when HEAD is detached) and how many files changed. */
export type GitStatus = {
  branch: string;
  changed: number;
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

/** e.g. `main`, `main · 1 file changed`, `feat/x · 3 files changed`. */
export function formatGit(status: GitStatus): string {
  if (status.changed === 0) return status.branch;
  return `${status.branch} · ${status.changed} ${status.changed === 1 ? "file" : "files"} changed`;
}

/**
 * The git state of `cwd`, from one `git status` call that takes no optional locks (so it never gets in the way of the user's own
 * git commands). Null outside a repo, when git fails, or when it does not answer within `timeoutMs` (it is then killed).
 */
export async function readGitStatus(cwd: string, { timeoutMs = 2000 }: { timeoutMs?: number } = {}): Promise<GitStatus | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain=v2", "--branch"], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        proc.kill();
        resolve(null);
      }, timeoutMs);
    });
    const finished = Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out, code]) =>
      code === 0 ? parseGitStatus(out) : null,
    );
    return await Promise.race([finished, timedOut]);
  } catch {
    // A folder that does not exist, or no git on PATH.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
