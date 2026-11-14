import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchState, resolveBranch } from "./git-branch";

const root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-branch-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A real repository on `branch`, with one commit so that other branches and refs can be made. */
function repo(branch = "main"): string {
  const dir = join(root, `repo-${count++}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", branch);
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

describe("branchState", () => {
  test("a branch other than main or master is a feature branch", () => {
    const dir = repo();
    git(dir, "switch", "-q", "-c", "feat/x");

    expect(branchState(dir)).toEqual({ kind: "feature", branch: "feat/x" });
  });

  test("main and master are the default branch when origin/HEAD is unknown", () => {
    expect(branchState(repo("main"))).toEqual({ kind: "default", branch: "main" });
    expect(branchState(repo("master"))).toEqual({ kind: "default", branch: "master" });
  });

  test("a repository with no commit yet is read by its branch name", () => {
    const dir = join(root, `repo-${count++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "feat/new");

    expect(branchState(dir)).toEqual({ kind: "feature", branch: "feat/new" });
  });

  test("a subfolder of the repository has the repository's branch", () => {
    const dir = repo();
    git(dir, "switch", "-q", "-c", "feat/x");
    mkdirSync(join(dir, "src"));

    expect(branchState(join(dir, "src"))).toEqual({ kind: "feature", branch: "feat/x" });
  });

  test("the branch origin/HEAD points at is the default, and main is then an ordinary branch", () => {
    const dir = repo("main");
    git(dir, "update-ref", "refs/remotes/origin/develop", "HEAD");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect(branchState(dir)).toEqual({ kind: "feature", branch: "main" });

    git(dir, "switch", "-q", "-c", "develop");
    expect(branchState(dir)).toEqual({ kind: "default", branch: "develop" });
  });

  test("a detached HEAD is none", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "--detach");

    expect(branchState(dir)).toEqual({ kind: "none", reason: "detached HEAD" });
  });

  test("a folder that is not a repository is none", () => {
    const dir = join(root, "plain");
    mkdirSync(dir);

    expect(branchState(dir)).toEqual({ kind: "none", reason: "not a git repository" });
  });

  test("a folder that does not exist is none", () => {
    expect(branchState(join(root, "missing")).kind).toBe("none");
  });

  test("a switch between two calls shows in the second", () => {
    const dir = repo();
    expect(branchState(dir).kind).toBe("default");

    git(dir, "switch", "-q", "-c", "feat/x");
    expect(branchState(dir).kind).toBe("feature");
  });
});

describe("resolveBranch", () => {
  test("returns a given state as it is and calls a lookup", () => {
    const feature = { kind: "feature", branch: "feat/x" } as const;
    expect(resolveBranch(feature)).toBe(feature);
    expect(resolveBranch(() => feature)).toBe(feature);
  });

  test("a lookup that throws is none", () => {
    expect(
      resolveBranch(() => {
        throw new Error("boom");
      }).kind,
    ).toBe("none");
  });
});
