import { resolve } from "node:path";
import { decide, type BranchInfo, type Decision } from "../../../plugin/hooks/guard-lib";
import type { ToolSource } from "./pi-permissions";

export type { Decision };

/** The branch/ship guard's verdict for a shell command run in `cwd`; null = no decision. */
export type Guard = (command: string, cwd: string) => Decision | null;

// plugin/hooks/guard.ts is the Claude hook: it reads stdin when loaded, so its git lookup cannot be imported and is repeated here.
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

/**
 * The decision Claude's PreToolUse hook makes for a Bash command (`guard-lib`'s `decide`, with the session's
 * cwd as the hook's `cwd`).
 *
 * Fails open exactly like the hook, which ends with no output and exit code 0 on any error: a git that cannot
 * run, a directory that is not a repository, or an error thrown anywhere in the decision is no decision, and
 * the call goes through the normal approval.
 */
export const guardBashCommand: Guard = (command, cwd) => {
  try {
    return decide(command, (dir) => lookupBranch(cwd, dir));
  } catch {
    return null;
  }
};

/** The guard covers pi's own `bash` tool; an extension tool named `bash` is just another extension tool. */
export function isBuiltinBash(tool: ToolSource): boolean {
  return tool.name === "bash" && tool.sourceInfo.path === "builtin:bash";
}
