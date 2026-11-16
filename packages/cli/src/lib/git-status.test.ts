import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatGit, parseGitStatus, readGitBranchState, readGitStatus, readGitWorktree } from "./git-status";

// S6: the status bar shows the branch (or short SHA when detached), read from HEAD alone; how many files changed only in a
// trusted project, from one `git status` call (which can run the repo's filter drivers).

describe("parseGitStatus", () => {
  test("reads the branch and counts the changed entries", () => {
    const output = [
      "# branch.oid 1234567890abcdef1234567890abcdef12345678",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +1 -0",
      "1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
      "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts\tsrc/old.ts",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/c.ts",
      "? notes.txt",
      "",
    ].join("\n");

    expect(parseGitStatus(output)).toEqual({ branch: "main", changed: 4 });
  });

  test("names a detached HEAD by its short SHA", () => {
    const output = "# branch.oid 1234567890abcdef1234567890abcdef12345678\n# branch.head (detached)\n";

    expect(parseGitStatus(output)).toEqual({ branch: "1234567", changed: 0 });
  });

  test("keeps the branch name of a repo with no commit yet", () => {
    expect(parseGitStatus("# branch.oid (initial)\n# branch.head main\n? a.txt\n")).toEqual({ branch: "main", changed: 1 });
  });

  test("is null for output that is not git's", () => {
    expect(parseGitStatus("")).toBeNull();
    expect(parseGitStatus("fatal: not a git repository\n")).toBeNull();
  });
});

describe("formatGit", () => {
  test("shows the branch and the changed files when there are any", () => {
    expect(formatGit({ branch: "main", changed: 0 })).toBe("main");
    expect(formatGit({ branch: "main", changed: 1 })).toBe("main · 1 file changed");
    expect(formatGit({ branch: "feat/x", changed: 3 })).toBe("feat/x · 3 files changed");
  });

  test("shows the branch alone when the files were not counted", () => {
    expect(formatGit({ branch: "main", changed: null })).toBe("main");
  });

  // M5: a linked worktree is named after the branch, before the count.
  test("names a linked worktree after the branch", () => {
    expect(formatGit({ branch: "feat/x", changed: null, worktree: "pack-integration" })).toBe("feat/x · wt pack-integration");
    expect(formatGit({ branch: "feat/x", changed: 2, worktree: "pack-integration" })).toBe("feat/x · wt pack-integration · 2 files changed");
  });
});

describe("readGitStatus", () => {
  let dir: string;
  let repo: string;
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-git-status-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    git("init", "--quiet", "--initial-branch=trunk");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "--quiet", "-m", "first");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads the branch of a clean repo, and counts its files only when trusted", async () => {
    expect(await readGitStatus(repo)).toEqual({ branch: "trunk", changed: null });
    expect(await readGitStatus(repo, { trusted: true })).toEqual({ branch: "trunk", changed: 0 });
  });

  test("counts modified and untracked files in a trusted project, and none in an untrusted one", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "b.txt"), "new\n");
    try {
      expect(await readGitStatus(repo, { trusted: true })).toEqual({ branch: "trunk", changed: 2 });
      expect(await readGitStatus(repo)).toEqual({ branch: "trunk", changed: null });
    } finally {
      git("checkout", "--quiet", "--", "a.txt");
      rmSync(join(repo, "b.txt"));
    }
  });

  test("names a detached HEAD by its short SHA", async () => {
    const sha = git("rev-parse", "HEAD");
    git("checkout", "--quiet", "--detach");
    try {
      expect(await readGitStatus(repo)).toEqual({ branch: sha.slice(0, 7), changed: null });
      expect(await readGitStatus(repo, { trusted: true })).toEqual({ branch: sha.slice(0, 7), changed: 0 });
    } finally {
      git("checkout", "--quiet", "trunk");
    }
  });

  test("is null outside a repo and for a folder that does not exist", async () => {
    for (const trusted of [false, true]) {
      expect(await readGitStatus(dir, { trusted })).toBeNull();
      expect(await readGitStatus(join(dir, "missing"), { trusted })).toBeNull();
    }
  });

  test("is null when git does not answer in time", async () => {
    expect(await readGitStatus(repo, { timeoutMs: 0 })).toBeNull();
    expect(await readGitStatus(repo, { timeoutMs: 0, trusted: true })).toBeNull();
  });

  // R1-1: the status line reads any folder, trusted or not, so nothing in the repo's own config may run a program.
  test("never runs a program the repo's config names (core.fsmonitor)", async () => {
    const marker = join(dir, "fsmonitor-ran");
    const hook = join(dir, "fsmonitor.sh");
    writeFileSync(hook, `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(hook, 0o755);
    git("config", "core.fsmonitor", hook);
    try {
      expect(await readGitStatus(repo)).toEqual({ branch: "trunk", changed: null });
      expect(await readGitStatus(repo, { trusted: true })).toEqual({ branch: "trunk", changed: 0 });
      expect(existsSync(marker)).toBe(false);
    } finally {
      git("config", "--unset", "core.fsmonitor");
    }
  });
});

// M5: in a linked worktree (`--git-dir` differs from `--git-common-dir`) the status names the worktree's folder; the main
// checkout gets no name. Read from HEAD-only git calls, so it shows in untrusted folders and runs nothing the repo names.
describe("readGitStatus in a linked worktree", () => {
  let dir: string;
  let repo: string;
  let linked: string;
  const gitIn = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-git-worktree-"));
    repo = join(dir, "repo");
    linked = join(dir, "pack-integration");
    mkdirSync(repo);
    gitIn(repo, "init", "--quiet", "--initial-branch=trunk");
    writeFileSync(join(repo, "a.txt"), "a\n");
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "b.txt"), "b\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "--quiet", "-m", "first");
    gitIn(repo, "worktree", "add", "--quiet", "-b", "feat/x", linked);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("an untrusted linked worktree: the branch and the worktree's folder name", async () => {
    expect(await readGitStatus(linked)).toEqual({ branch: "feat/x", changed: null, worktree: "pack-integration" });
  });

  test("a trusted linked worktree: the count as well", async () => {
    expect(await readGitStatus(linked, { trusted: true })).toEqual({ branch: "feat/x", changed: 0, worktree: "pack-integration" });
  });

  test("from a subfolder of the worktree, still the worktree's own folder name", async () => {
    expect(await readGitStatus(join(linked, "sub"))).toEqual({ branch: "feat/x", changed: null, worktree: "pack-integration" });
  });

  test("the main checkout gets no worktree name", async () => {
    expect(await readGitStatus(repo)).toEqual({ branch: "trunk", changed: null });
    expect(await readGitStatus(repo, { trusted: true })).toEqual({ branch: "trunk", changed: 0 });
    expect(await readGitStatus(join(repo, "sub"))).toEqual({ branch: "trunk", changed: null });
  });

  test("an untrusted linked worktree runs no fsmonitor or filter driver its config names", async () => {
    const marker = join(dir, "ran");
    const script = join(dir, "evil.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`);
    chmodSync(script, 0o755);
    writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=evil\n");
    gitIn(repo, "config", "core.fsmonitor", script);
    gitIn(repo, "config", "filter.evil.clean", script);
    gitIn(repo, "config", "filter.evil.process", script);
    gitIn(repo, "config", "filter.evil.required", "true");
    const later = new Date(Date.now() + 120_000);
    utimesSync(join(linked, "a.txt"), later, later);
    try {
      const status = await readGitStatus(linked);
      expect(existsSync(marker)).toBe(false);
      expect(status).toEqual({ branch: "feat/x", changed: null, worktree: "pack-integration" });
    } finally {
      for (const key of ["core.fsmonitor", "filter.evil.clean", "filter.evil.process", "filter.evil.required"]) gitIn(repo, "config", "--unset", key);
      rmSync(join(repo, ".git", "info", "attributes"));
    }
  });
});

// R3-1: git before 2.31 has no `--path-format` and `rev-parse` echoes an option it does not know as a line of its output (exit 0).
// A fake git that does exactly that, in front of the real one, must never make the main checkout look like a linked worktree.
describe("readGitStatus with a git that echoes options it does not know (git < 2.31)", () => {
  let dir: string;
  let repo: string;
  let linked: string;
  let bin: string;
  let log: string;
  let path: string | undefined;
  const realGit = Bun.which("git")!;
  const gitIn = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync([realGit, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-git-old-"));
    repo = join(dir, "repo");
    linked = join(dir, "old-linked");
    bin = join(dir, "bin");
    log = join(dir, "calls.log");
    mkdirSync(repo);
    mkdirSync(bin);
    gitIn(repo, "init", "--quiet", "--initial-branch=trunk");
    writeFileSync(join(repo, "a.txt"), "a\n");
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "b.txt"), "b\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "--quiet", "-m", "first");
    gitIn(repo, "worktree", "add", "--quiet", "-b", "feat/old", linked);
    // Logs each call, prints every `--path-format=...` as old git's rev-parse does, and runs the real git without it.
    writeFileSync(
      join(bin, "git"),
      [
        "#!/bin/sh",
        `echo "$*" >> '${log}'`,
        "for arg; do",
        "  shift",
        '  case "$arg" in --path-format=*) echo "$arg"; continue;; esac',
        '  set -- "$@" "$arg"',
        "done",
        `exec '${realGit}' "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "git"), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
  });
  afterAll(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => rmSync(log, { force: true }));

  test("the main checkout gets no worktree name, from its top and from a subfolder", async () => {
    expect(await readGitStatus(repo)).toEqual({ branch: "trunk", changed: null });
    expect(await readGitStatus(join(repo, "sub"), { trusted: true })).toEqual({ branch: "trunk", changed: 0 });
    // The fake git was the one that ran.
    expect(existsSync(log)).toBe(true);
  });

  test("a linked worktree is still named", async () => {
    expect(await readGitStatus(linked)).toEqual({ branch: "feat/old", changed: null, worktree: "old-linked" });
  });

  // R4-8: the worktree of a folder does not change, so it is read once per folder, not at every poll.
  test("the worktree is read once per folder", async () => {
    const sub = join(linked, "sub");
    for (let i = 0; i < 3; i++) expect(await readGitWorktree(sub)).toBe("old-linked");
    const calls = Bun.file(log).size > 0 ? (await Bun.file(log).text()).split("\n").filter((line) => line.includes("rev-parse")) : [];
    expect(calls.length).toBe(1);
  });
});

// R1-8: a folder name may hold any character but `/`; a newline in one of the paths would shift the lines git prints.
describe("readGitWorktree with a newline in a path", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-git-nl-"));
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const run = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
    run(repo, "init", "--quiet", "--initial-branch=trunk");
    writeFileSync(join(repo, "a.txt"), "a\n");
    run(repo, "add", ".");
    run(repo, "commit", "--quiet", "-m", "first");
    run(repo, "worktree", "add", "--quiet", "-b", "feat/nl", join(dir, "evil\nname"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("is refused: no name rather than a wrong one", async () => {
    const worktree = join(dir, "evil\nname");
    expect(existsSync(worktree)).toBe(true);
    expect(await readGitWorktree(worktree)).toBeNull();
  });
});

// R3-2: the status line's paused mode comes from an async read of where the checkout stands, the same states as `branchState`.
describe("readGitBranchState", () => {
  let dir: string;
  const gitIn = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-git-state-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a feature branch, the default branch (main, or origin/HEAD's), a detached HEAD, no repository", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    gitIn(repo, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "--quiet", "-m", "first");
    expect(await readGitBranchState(repo)).toEqual({ kind: "default", branch: "main" });
    gitIn(repo, "checkout", "--quiet", "-b", "develop");
    expect(await readGitBranchState(repo)).toEqual({ kind: "feature", branch: "develop" });
    gitIn(repo, "update-ref", "refs/remotes/origin/develop", "HEAD");
    gitIn(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect(await readGitBranchState(repo)).toEqual({ kind: "default", branch: "develop" });
    gitIn(repo, "checkout", "--quiet", "--detach");
    expect(await readGitBranchState(repo)).toEqual({ kind: "none", reason: "detached HEAD" });
    expect((await readGitBranchState(dir)).kind).toBe("none");
    expect((await readGitBranchState(repo, { timeoutMs: 0 })).kind).toBe("none");
  });
});

// R1-1b: `git status` re-hashes a stat-dirty or racy file through the repo's filter drivers (`filter.<name>.clean` / `.process`),
// named by `.git/config` and switched on by `.gitattributes` or `.git/info/attributes`. In a folder that is not trusted the status
// line reads HEAD alone, so none of them runs.
describe("readGitStatus with a repo's filter drivers", () => {
  let dir: string;
  let marker: string;
  const gitIn = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };

  /** A committed repo whose files all go through the `evil` filter once its config is written (after the commit, so setup runs none). */
  function filterRepo(name: string, attributes: "tracked" | "info", { process = true } = {}) {
    const repo = join(dir, name);
    mkdirSync(repo);
    gitIn(repo, "init", "--quiet", "--initial-branch=trunk");
    writeFileSync(join(repo, "a.txt"), "a\n");
    if (attributes === "tracked") writeFileSync(join(repo, ".gitattributes"), "* filter=evil\n");
    gitIn(repo, "add", ".");
    gitIn(repo, "commit", "--quiet", "-m", "first");
    if (attributes === "info") writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=evil\n");
    const script = join(dir, `${name}-filter.sh`);
    // Writes the marker, then passes the content through unchanged.
    writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`);
    chmodSync(script, 0o755);
    gitIn(repo, "config", "filter.evil.clean", script);
    if (process) gitIn(repo, "config", "filter.evil.process", script);
    gitIn(repo, "config", "filter.evil.required", "true");
    return repo;
  }

  /** The tracked file's stat no longer matches the index (same content), so `git status` must hash it again. */
  const touch = (repo: string) => {
    const later = new Date(Date.now() + 120_000);
    utimesSync(join(repo, "a.txt"), later, later);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-git-filter-"));
    marker = join(dir, "filter-ran");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(() => rmSync(marker, { force: true }));

  // The marker is checked first: it is what must never happen, whatever git answered.
  test("an untrusted folder: the branch, no count, and no filter runs (.gitattributes, stat-dirty file)", async () => {
    const repo = filterRepo("tracked", "tracked");
    touch(repo);

    const status = await readGitStatus(repo);
    expect(existsSync(marker)).toBe(false);
    expect(status).toEqual({ branch: "trunk", changed: null });
  });

  test("an untrusted folder: no clean filter runs either (no process filter configured)", async () => {
    const repo = filterRepo("clean-only", "tracked", { process: false });
    touch(repo);

    const status = await readGitStatus(repo);
    expect(existsSync(marker)).toBe(false);
    expect(status).toEqual({ branch: "trunk", changed: null });
  });

  test("an untrusted folder: no filter runs for a racy file rewritten in the same second", async () => {
    const repo = filterRepo("racy", "tracked", { process: false });
    // Same content, written right after the index: its mtime is not older than the index's, so git cannot trust the stat.
    writeFileSync(join(repo, "a.txt"), "a\n");

    const status = await readGitStatus(repo);
    expect(existsSync(marker)).toBe(false);
    expect(status).toEqual({ branch: "trunk", changed: null });
  });

  test("an untrusted folder: no filter runs when the attributes are in .git/info/attributes", async () => {
    const repo = filterRepo("info", "info");
    touch(repo);

    const status = await readGitStatus(repo);
    expect(existsSync(marker)).toBe(false);
    expect(status).toEqual({ branch: "trunk", changed: null });
  });

  test("an untrusted detached HEAD: the short SHA, and no filter runs", async () => {
    const repo = filterRepo("detached", "tracked");
    const sha = gitIn(repo, "rev-parse", "HEAD");
    gitIn(repo, "-c", "filter.evil.required=false", "-c", "filter.evil.clean=", "-c", "filter.evil.process=", "checkout", "--quiet", "--detach");
    rmSync(marker, { force: true });
    touch(repo);

    const status = await readGitStatus(repo);
    expect(existsSync(marker)).toBe(false);
    expect(status).toEqual({ branch: sha.slice(0, 7), changed: null });
  });

  test("a trusted folder gets the count (its filters may run: the user trusted them)", async () => {
    const repo = filterRepo("trusted", "tracked", { process: false });
    touch(repo);

    const status = await readGitStatus(repo, { trusted: true });
    expect(status?.branch).toBe("trunk");
    expect(typeof status?.changed).toBe("number");
    rmSync(marker, { force: true });
  });
});
