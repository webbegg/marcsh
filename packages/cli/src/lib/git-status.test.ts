import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatGit, parseGitStatus, readGitStatus } from "./git-status";

// S6: the status bar shows the branch (or short SHA when detached) and how many files changed, from one `git status` call.

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

  test("reads the branch of a clean repo", async () => {
    expect(await readGitStatus(repo)).toEqual({ branch: "trunk", changed: 0 });
  });

  test("counts modified and untracked files", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "b.txt"), "new\n");
    try {
      expect(await readGitStatus(repo)).toEqual({ branch: "trunk", changed: 2 });
    } finally {
      git("checkout", "--quiet", "--", "a.txt");
      rmSync(join(repo, "b.txt"));
    }
  });

  test("names a detached HEAD by its short SHA", async () => {
    const sha = git("rev-parse", "HEAD");
    git("checkout", "--quiet", "--detach");
    try {
      expect(await readGitStatus(repo)).toEqual({ branch: sha.slice(0, 7), changed: 0 });
    } finally {
      git("checkout", "--quiet", "trunk");
    }
  });

  test("is null outside a repo and for a folder that does not exist", async () => {
    expect(await readGitStatus(dir)).toBeNull();
    expect(await readGitStatus(join(dir, "missing"))).toBeNull();
  });

  test("is null when git does not answer in time", async () => {
    expect(await readGitStatus(repo, { timeoutMs: 0 })).toBeNull();
  });
});
