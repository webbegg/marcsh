import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ApprovalMode, decideApproval } from "./approval-policy";
import { guardBashCommand } from "./engine/pi-guard";
import { branchState } from "./git-branch";

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-sandbox-")));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
const feature = { kind: "feature", branch: "feat/x" } as const;
const shell = (mode: ApprovalMode, command: string) => decideApproval(mode, { kind: "shell", command }, cwd, feature).action;

describe("S13: nothing outside the feature branch runs unasked in auto or yolo", () => {
  test("local writes to another branch ask (B1)", () => {
    for (const command of ["git fetch . feat/x:main", "git fetch origin main:main", "git branch -f main HEAD", "git branch --force main HEAD", "git branch -C feat/x main"]) {
      for (const mode of ["auto", "yolo"] as const) expect([mode, command, shell(mode, command)]).toEqual([mode, command, "ask"]);
    }
  });

  test("a push without the word push asks (B2)", () => {
    for (const command of ["git send-pack origin HEAD:main", "git subtree push --prefix x origin main", "git -c alias.p=push p origin HEAD:main"]) {
      for (const mode of ["auto", "yolo"] as const) expect([mode, command, shell(mode, command)]).toEqual([mode, command, "ask"]);
    }
  });

  test("a commit or merge after cd elsewhere is not a local commit (B3)", () => {
    for (const command of ["cd ../other && git commit -m x", "(cd ../other && git commit -m x)", "pushd ../other && git commit -m x", "cd ../other && git merge main"]) {
      expect([command, shell("yolo", command)]).toEqual([command, "ask"]);
    }
  });
});

describe("S13: what stays on the feature branch still runs", () => {
  test("fetches and pulls without a local destination, new branches, cd inside the checkout", () => {
    mkdirSync(join(cwd, "src", "lib"), { recursive: true });
    for (const command of [
      "git fetch origin",
      "git fetch --all --prune",
      "git fetch git@github.com:a/b.git",
      "git pull --rebase origin main",
      "git branch feat/y",
      "git branch -vv",
      `cd ${cwd} && git status`,
      "cd src && git commit -m x",
      "cd src/lib && cd .. && git commit -m x",
      "cd src && echo x > out.txt",
    ]) {
      expect([command, shell("yolo", command)]).toEqual([command, "allow"]);
    }
  });

  test("a cd into a nested checkout, back out of the folder, or to a folder only the shell knows leaves it", () => {
    mkdirSync(join(cwd, "vendor", "lib", ".git"), { recursive: true });
    for (const command of ["cd vendor/lib && git commit -m x", "cd .. && git status", "cd && git commit -m x", "cd - && git commit -m x", "popd && git commit -m x", "bash -c 'cd /tmp/x && git commit -m y'"]) {
      expect([command, shell("yolo", command)]).toEqual([command, "ask"]);
    }
  });

  test("a redirect after a cd is read from the folder it moved to", () => {
    for (const command of ["cd ../other && echo x > f.ts", "cd src && echo x > ../../f.ts"]) expect([command, shell("auto", command)]).toEqual([command, "ask"]);
  });

  test("any alias set on the command line asks", () => {
    expect(shell("yolo", "git -c alias.st=status st")).toBe("ask");
    expect(shell("yolo", "git -c user.name=x commit -m y")).toBe("allow");
  });
});

describe("S13: the default branch is recognised when a tag shares its name (B4)", () => {
  test("main with a tag named main is the default branch", () => {
    const run = (...args: string[]) => expect(Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" }).exitCode).toBe(0);
    run("init", "-q", "-b", "main");
    writeFileSync(join(cwd, "f"), "1");
    run("add", ".");
    run("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
    run("tag", "main");
    expect(branchState(cwd)).toEqual({ kind: "default", branch: "main" });
    expect(decideApproval("yolo", { kind: "shell", command: "git commit -m x" }, cwd).action).toBe("unchanged");
    expect(guardBashCommand("git commit -m x", cwd)?.decision).toBe("deny");
  }, 30000);
});
