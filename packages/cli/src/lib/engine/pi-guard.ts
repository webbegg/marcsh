import { resolve } from "node:path";
import { decide, type BranchInfo, type Decision } from "../../../plugin/hooks/guard-lib";
import { git, gitSucceeds, originDefaultBranch } from "../git-branch";
import type { ToolSource } from "./pi-permissions";

export type { Decision };

/** The branch/ship guard's verdict for a shell command run in `cwd`; null = no decision. */
export type Guard = (command: string, cwd: string) => Decision | null;

// plugin/hooks/guard.ts is the Claude hook: it reads stdin when loaded, so its branch lookup cannot be imported and is repeated here (on the shared git helpers).
function lookupBranch(cwd: string, dir: string | null): BranchInfo | null {
  const where = dir ? resolve(cwd, dir) : cwd;
  const branch = git(where, "symbolic-ref", "--short", "HEAD");
  if (!branch) return null;
  return {
    branch,
    defaultBranch: originDefaultBranch(where),
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
