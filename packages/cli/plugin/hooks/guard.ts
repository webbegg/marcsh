// marcsh PreToolUse hook for Bash: reads the hook JSON on stdin and prints a decision (or nothing) on stdout.
// Never blocks on its own errors: any failure ends with no output and exit code 0.
import { resolve } from "node:path";
import { decide, toHookOutput, type BranchInfo } from "./guard-lib";

function git(cwd: string, ...args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 5000 });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

function gitSucceeds(cwd: string, ...args: string[]): boolean {
  try {
    return Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore", timeout: 5000 }).exitCode === 0;
  } catch {
    return false;
  }
}

function lookupBranch(cwd: string, dir: string | null): BranchInfo | null {
  const where = dir ? resolve(cwd, dir) : cwd;
  const branch = git(where, "symbolic-ref", "--short", "HEAD");
  if (!branch) return null;
  const origin = git(where, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  return {
    branch,
    defaultBranch: origin ? origin.replace(/^origin\//, "") : null,
    isLocalBranch: (name) => gitSucceeds(where, "show-ref", "--verify", "--quiet", `refs/heads/${name}`),
  };
}

async function main() {
  try {
    const input = JSON.parse(await Bun.stdin.text());
    const command = input?.tool_input?.command;
    if (typeof command !== "string") return;
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
    const decision = decide(command, (dir) => lookupBranch(cwd, dir));
    if (decision) console.log(JSON.stringify(toHookOutput(decision)));
  } catch {
    // No decision.
  }
}

await main();
