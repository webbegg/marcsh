// The session's approval mode, and what it decides about a tool call before the engine's own approval flow.
//
// - normal: today's flow for everything (every tool except reads asks, the branch/ship guard asks or denies). Only
//   catastrophic commands are decided here: they are blocked.
// - auto: on a feature branch, edits inside the project and ordinary shell commands run; commits, anything remote (push,
//   PR/issue writes, gh api writes), leaving the branch (switch, checkout, git run elsewhere, a new worktree) and the floor ask.
// - yolo: as auto, and local commits run; remote, leaving the branch and the floor still ask.
//
// auto and yolo relax only while the folder's checkout is on a feature branch (see git-branch). On the default branch, a
// detached HEAD, outside a repository or when the branch cannot be read they act exactly like normal: each prompt is the
// user's bypass. A guard ask (push, PR, merge, publish) is never skipped by a mode.
//
// The floor, in every mode: destructive, publish, privileged and dependency commands, commands marcsh cannot read,
// edits outside the project, to secret-looking files or to `.git/`. These asks never offer "always". Catastrophic
// commands are blocked. Tools the policy does not know (MCP, web, extension tools) keep the existing flow, and the
// branch guard runs before this policy: a commit on the default branch stays denied in every mode.

import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CommandKind, analyzeCommand, isScratchPath } from "./command-classifier";
import { type BranchSource, type BranchState, branchState, resolveBranch } from "./git-branch";
import { realTarget } from "./real-path";

export const APPROVAL_MODES = ["normal", "auto", "yolo"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "normal";

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return (APPROVAL_MODES as readonly unknown[]).includes(value);
}

/** Why auto and yolo are paused on `branch`, in a few words. */
function pausedReason(branch: Exclude<BranchState, { kind: "feature" }>): string {
  return branch.kind === "default" ? `on the default branch ${branch.branch}` : branch.reason;
}

/** One line for the system prompt, so the agent knows what needs no confirmation in chat. None in normal mode. */
export function approvalModeLine(mode: ApprovalMode, branch: BranchState): string | undefined {
  if (mode === "normal") return undefined;
  const name = mode === "auto" ? "AUTO" : "YOLO";
  if (branch.kind !== "feature") {
    return `Approval mode ${name} is paused: this folder is not on a feature branch (${pausedReason(branch)}), so marcsh asks as in normal mode. Start the work on its own feature branch, preferably in a git worktree, before changing code.`;
  }
  if (mode === "auto") {
    return `Approval mode AUTO on feature branch ${branch.branch}: file edits inside this folder and ordinary shell commands run without asking; commits, anything remote (push, PR/issue, gh api writes), leaving the branch, and destructive, publish, privileged, or dependency commands ask the user through marcsh. Run the command; don't ask in chat first.`;
  }
  return `Approval mode YOLO on feature branch ${branch.branch}: file edits inside this folder, ordinary shell commands and local commits run without asking, so they need no confirmation in chat; anything remote (push, PR/issue, gh api writes), leaving the branch, and destructive, publish or merge, privileged, and dependency commands still ask the user through marcsh.`;
}

/** The mode that applies to a call: auto and yolo only on a feature branch, normal anywhere else (a branch that cannot be read is not a feature branch). */
function effectiveMode(mode: ApprovalMode, cwd: string, branch: BranchSource | undefined): ApprovalMode {
  if (mode === "normal") return mode;
  return resolveBranch(branch ?? (() => branchState(cwd))).kind === "feature" ? mode : "normal";
}

/** What the policy needs to know about a call: a shell command, a file edit, or anything else. */
export type ToolCall = { kind: "shell"; command: string } | { kind: "edit"; path: string } | { kind: "other" };

/** `unchanged`: the engine's existing flow decides. `ask`: ask with this reason, never offering "always". */
export type Verdict = { action: "unchanged" } | { action: "allow" } | { action: "ask"; reason: string } | { action: "block"; reason: string };

const UNCHANGED: Verdict = { action: "unchanged" };
const ALLOW: Verdict = { action: "allow" };

const SENSITIVE_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)credentials\.json$/,
];
const EXAMPLE_ENV = /(^|\/)\.env\.(example|sample|template)$/;
const DEVICE_WRITES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

/** The path relative to the project, or null when it is outside it (after symlinks) or cannot be resolved literally. */
function insideProject(path: string, cwd: string): string | null {
  if (path === "" || /^~|\$|`/.test(path)) return null;
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return null;
  }
  const real = realTarget(resolve(cwd, path));
  if (real === null) return null;
  const rel = relative(root, real);
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

/**
 * Whether a `cd` to `dir` stays in the checkout at `cwd`: a folder inside the project with no other checkout (a nested repository,
 * submodule or worktree, which has its own `.git`) on the way down.
 */
function staysInCheckout(dir: string, cwd: string): boolean {
  const rel = insideProject(dir, cwd);
  if (rel === null) return false;
  let current = realpathSync(cwd);
  for (const segment of rel.split("/").filter(Boolean)) {
    current = join(current, segment);
    if (existsSync(join(current, ".git"))) return false;
  }
  return true;
}

/** Why a write to `path` (`what`: "an edit", "a redirect" or "a write by <program>") must ask, or null when it may run. */
function editProblem(path: string, cwd: string, what = "an edit"): string | null {
  const rel = insideProject(path, cwd);
  if (rel === null) return `${what} outside the project (${path})`;
  const normalized = rel.replace(/\\/g, "/");
  if (/(^|\/)\.git(\/|$)/.test(normalized)) return `${what} inside .git (${path})`;
  if (!EXAMPLE_ENV.test(normalized) && SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return `${what} to a secret-looking file (${path})`;
  return null;
}

/** Why a shell write to `target` must ask, or null: a scratch path or a device such as /dev/null, or a file inside the project that is not secret-looking or in `.git`. */
function writeProblem(target: string, cwd: string, what: string): string | null {
  if (DEVICE_WRITES.has(target) || isScratchPath(target)) return null;
  return editProblem(target, cwd, what);
}

// The branch guard's asks read `marcsh: <action> needs your approval`. No mode skips one.
const GUARD_ASK = /^marcsh: .+ needs your approval$/;

/** True when `reason` is a branch-guard ask (push, PR, merge, publish): it keeps asking in every mode, with no always-allow. */
export function isGuardAsk(reason: string | undefined): boolean {
  return reason !== undefined && GUARD_ASK.test(reason);
}

const askFor = (reasons: string[]): Verdict => ({ action: "ask", reason: `marcsh: ${[...new Set(reasons)].join("; ")} needs your approval` });

/**
 * Decides a call under `mode` for the project at `cwd`. Auto and yolo count only on a feature branch: `branch` is the checkout's state, or
 * a function that reads it when needed; without it the branch of `cwd` is looked up. Anywhere else the mode is normal.
 */
export function decideApproval(mode: ApprovalMode, call: ToolCall, cwd: string, branch?: BranchSource): Verdict {
  if (call.kind === "other") return UNCHANGED;

  if (call.kind === "edit") {
    if (effectiveMode(mode, cwd, branch) === "normal") return UNCHANGED;
    const problem = editProblem(call.path, cwd);
    return problem ? askFor([problem]) : ALLOW;
  }

  const { matches, writes, files } = analyzeCommand(call.command, { stays: (dir) => staysInCheckout(dir, cwd) });
  const catastrophic = matches.find((match) => match.hardDeny);
  if (catastrophic) return { action: "block", reason: `marcsh: ${catastrophic.reason} is never allowed` };
  const effective = effectiveMode(mode, cwd, branch);
  if (effective === "normal") return UNCHANGED;

  // Only a local commit is relaxed, and only in yolo.
  const reasons = matches.filter((match) => effective === "auto" || match.kind !== CommandKind.COMMIT).map((match) => match.reason);
  for (const target of writes) {
    const problem = writeProblem(target, cwd, "a redirect");
    if (problem) reasons.push(problem);
  }
  for (const { program, path } of files) {
    const problem = writeProblem(path, cwd, `a write by ${program}`);
    if (problem) reasons.push(problem);
  }
  return reasons.length > 0 ? askFor(reasons) : ALLOW;
}
