import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// S12: the branch guard follows branch switches in a command against real repositories (main + feat/x).
const GUARD = join(import.meta.dir, "guard.ts");
const root = mkdtempSync(join(tmpdir(), "marcsh-guard-switch-"));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};
const repo = (name: string, defaultBranch: string, start: string) => {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", defaultBranch);
  writeFileSync(join(dir, "file.txt"), "a\n");
  git(dir, "add", "file.txt");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "branch", "feat/x");
  git(dir, "switch", "-q", start);
  return dir;
};
const run = (cwd: string, command: string) => {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });
  const result = Bun.spawnSync(["bun", GUARD], { cwd: tmpdir(), env, stdin: new TextEncoder().encode(input) });
  expect(result.exitCode).toBe(0);
  const out = result.stdout.toString();
  return out === "" ? "none" : JSON.parse(out).hookSpecificOutput.permissionDecision;
};

let onFeat: string, onMain: string, masterOnFeat: string, other: string;
beforeAll(() => {
  onFeat = repo("on-feat", "main", "feat/x");
  onMain = repo("on-main", "main", "main");
  masterOnFeat = repo("master-on-feat", "master", "feat/x");
  other = repo("other", "main", "main");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("branch guard in real repositories", () => {
  test("switching to the default branch before committing is denied", () => {
    expect(run(onFeat, 'git checkout main && git merge --squash feat/x && git commit -m "feat: x"')).toBe("deny");
    expect(run(onFeat, "git switch main && git commit -m x")).toBe("deny");
    expect(run(masterOnFeat, "git checkout master && git commit -m x")).toBe("deny");
    expect(run(onMain, "git switch -c x; git switch main; git commit -m x")).toBe("deny");
  });

  test("switching to an existing feature branch or restoring files does not deny", () => {
    expect(run(onMain, "git switch feat/x && git commit -m x")).toBe("none");
    expect(run(onFeat, "git checkout main -- file.txt && git commit -m x")).toBe("none");
    expect(run(onMain, "git checkout -- file.txt && git commit -m x")).toBe("deny");
    expect(run(onMain, "git checkout file.txt && git commit -m x")).toBe("deny");
  });

  test("switches are tracked per git -C directory", () => {
    expect(run(onFeat, `git -C ${other} switch feat/x; git switch main; git commit -m x`)).toBe("deny");
    expect(run(onFeat, `git -C ${other} switch main && git commit -m x`)).toBe("none");
    expect(run(onMain, `git -C ${onFeat} checkout main && git -C ${onFeat} commit -m x`)).toBe("deny");
  });
});
