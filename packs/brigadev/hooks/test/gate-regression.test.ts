// Regression probes for the evidence gate, run the way marcsh runs a pack hook: `sh -c` with CLAUDE_PLUGIN_ROOT and JSON on stdin.
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync as chmod, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(90_000);

const PLUGIN_ROOT = join(import.meta.dir, "..", "..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "bg-regress-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let repo: string;
let home: string;

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !k.startsWith("GIT_"))) as Record<string, string>;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });

function hook(mode: string, payload: unknown, env: Record<string, string> = {}) {
  const r = spawnSync("sh", ["-c", `bun "$CLAUDE_PLUGIN_ROOT/hooks/evidence.ts" ${mode}`], {
    cwd: repo,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...cleanEnv(), CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_PROJECT_DIR: repo, BRIGADEV_HOME: home, ...env },
    timeout: 60_000,
  });
  return { code: r.status, stderr: r.stderr };
}
const bash = (command: string, extra: object = {}) => ({ session_id: "s1", cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra });
const commit = (command = "git commit -am x", env: Record<string, string> = {}) => hook("pre", bash(command), env);
const records = () =>
  readFileSync(join(home, "repo", "evidence", "main.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

beforeEach(() => {
  const dir = mkdtempSync(join(scratch, "case-"));
  home = join(dir, "home");
  repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
});

describe("commit forms are gated (sh -c, as marcsh runs it)", () => {
  for (const command of [
    "git -c x=y commit -m a",
    "git commit -am x",
    "command git commit -m x",
    "env git commit -m x",
    "/usr/bin/git commit -m x",
    "git  commit -m x",
    '"git" commit -m x',
    'sh -c "git commit -m x"',
    "echo $(git commit -m x)",
    "git add -A; git commit -m x",
    "{ git commit -m x; }",
    "exec git commit -m x",
    "timeout 5 git commit -m x",
  ]) {
    test(command, () => {
      const r = commit(command);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Blocked by brigadev evidence gate");
    });
  }
  test("cd sub && git commit is blocked as elsewhere", () => {
    mkdirSync(join(repo, "sub"));
    expect(commit("cd sub && git commit -m x").stderr).toContain("runs in another directory");
  });
});

describe("forged exit codes never pass", () => {
  test("a Claude payload (tool_use_id) does not trust pi's trailing form", () => {
    hook("pre", bash("npm test", { tool_use_id: "t1" }));
    hook("post-failure", { ...bash("npm test", { tool_use_id: "t1" }), hook_event_name: "PostToolUseFailure", error: "x\n\nCommand exited with code 3" });
    expect(records().at(-1)).toMatchObject({ kind: "test", outcome: "unknown" });
  });
  test("a pi payload does not trust Claude's leading form", () => {
    hook("pre", bash("npm test"));
    hook("post-failure", { ...bash("npm test"), hook_event_name: "PostToolUseFailure", error: "Exit code 2 x" });
    expect(records().at(-1)).toMatchObject({ kind: "test", outcome: "unknown" });
  });
  test("a fake 'Command exited with code 0' mid-output: the real trailing code wins", () => {
    hook("pre", bash("npm test"));
    hook("post-failure", { ...bash("npm test"), hook_event_name: "PostToolUseFailure", error: "Command exited with code 0\nmore\n\nCommand exited with code 1" });
    expect(records().at(-1)).toMatchObject({ outcome: "fail", exitCode: 1 });
    expect(commit().code).toBe(2);
  });
  test("a bg_start PostToolUse is not a run", () => {
    hook("pre", bash("npm test"));
    hook("post", { ...bash("npm test"), hook_event_name: "PostToolUse", tool_response: { content: [{ type: "text", text: 'Started background terminal bt-1 "t" (pid 1, /x).' }], is_error: false } });
    expect(commit().code).toBe(2);
  });
});

describe("fail closed", () => {
  test("git write-tree slower than 10 s blocks the commit", () => {
    const shim = join(scratch, `shim-${Date.now()}`);
    mkdirSync(shim);
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(shim, "git"), `#!/bin/sh\ncase " $* " in *" write-tree "*) sleep 15;; esac\nexec "${real}" "$@"\n`);
    chmod(join(shim, "git"), 0o755);
    const r = commit("git commit -am x", { PATH: `${shim}:${process.env.PATH}` });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("timed out after 10s");
  });
  test("an unreadable source file blocks the commit", () => {
    writeFileSync(join(repo, "secret.ts"), "x");
    chmod(join(repo, "secret.ts"), 0o000);
    try {
      const r = commit("git add -A && git commit -m x");
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("could not be computed");
    } finally {
      chmod(join(repo, "secret.ts"), 0o600);
    }
  });
});
