import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatGit, parseGitStatus, readGitStatus } from "./git-status";

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
