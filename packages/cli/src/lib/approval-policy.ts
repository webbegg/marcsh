// The session's approval mode, and what it decides about a tool call before the engine's own approval flow.
//
// - normal: today's flow for everything (every tool except reads asks, the branch/ship guard asks or denies). Only
//   catastrophic commands are decided here: they are blocked.
// - auto: edits inside the project and ordinary shell commands run; delivery (commit, push, PR/issue writes, branch
//   switches) and the floor ask.
// - yolo: as auto, and delivery runs too; the floor still asks.
//
// The floor, in every mode: destructive, publish, privileged and dependency commands, commands marcsh cannot read,
// edits outside the project, to secret-looking files or to `.git/`. These asks never offer "always". Catastrophic
// commands are blocked. Tools the policy does not know (MCP, web, extension tools) keep the existing flow, and the
// branch guard runs before this policy: a commit on the default branch stays denied in every mode.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CommandKind, analyzeCommand, isScratchPath } from "./command-classifier";

export const APPROVAL_MODES = ["normal", "auto", "yolo"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "normal";

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return (APPROVAL_MODES as readonly unknown[]).includes(value);
}

/** One line for the system prompt, so the agent knows what needs no confirmation in chat. None in normal mode. */
export function approvalModeLine(mode: ApprovalMode): string | undefined {
  if (mode === "auto") {
    return "Approval mode AUTO: file edits inside the project and ordinary shell commands run without asking; commits, pushes, PR/issue writes, branch switches, and destructive, publish, privileged, or dependency commands ask the user through marcsh. Run the command; don't ask in chat first.";
  }
  if (mode === "yolo") {
    return "Approval mode YOLO: file edits inside the project, ordinary shell commands, commits, non-force pushes, branch switches, and PR/issue creation run without asking, so they need no confirmation in chat; destructive, publish or merge, privileged, and dependency (install) commands still ask the user through marcsh.";
  }
  return undefined;
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

/** The real path `path` would have: symlinks resolved on the part that exists, the rest appended. */
function realTarget(path: string): string {
  let existing = path;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  try {
    return join(realpathSync(existing), ...missing);
  } catch {
    return path;
  }
}

/** The path relative to the project, or null when it is outside it (after symlinks) or cannot be resolved literally. */
function insideProject(path: string, cwd: string): string | null {
  if (path === "" || /^~|\$|`/.test(path)) return null;
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return null;
  }
  const rel = relative(root, realTarget(resolve(cwd, path)));
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

/** Why a write to `path` (`what`: "an edit" or "a redirect") must ask, or null when it may run. */
function editProblem(path: string, cwd: string, what = "an edit"): string | null {
  const rel = insideProject(path, cwd);
  if (rel === null) return `${what} outside the project (${path})`;
  const normalized = rel.replace(/\\/g, "/");
  if (/(^|\/)\.git(\/|$)/.test(normalized)) return `${what} inside .git (${path})`;
  if (!EXAMPLE_ENV.test(normalized) && SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) return `${what} to a secret-looking file (${path})`;
  return null;
}

/** Why a shell redirect to `target` must ask, or null: a scratch path or a device such as /dev/null, or a file inside the project that is not secret-looking or in `.git`. */
function writeProblem(target: string, cwd: string): string | null {
  if (DEVICE_WRITES.has(target) || isScratchPath(target)) return null;
  return editProblem(target, cwd, "a redirect");
}

// The branch guard's asks read `marcsh: <action> needs your approval`. A mode may skip the ask for delivery, never the others (merge, publish).
const GUARD_ASK = /^marcsh: (.+) needs your approval$/;
const GUARD_DELIVERY_ACTIONS = new Set(["git push", "gh pr create"]);

/** True when `reason` is a branch-guard ask for an action a mode must not skip: it keeps asking, with no always-allow. */
export function isFixedGuardAsk(reason: string | undefined): boolean {
  const action = reason === undefined ? undefined : GUARD_ASK.exec(reason)?.[1];
  return action !== undefined && !GUARD_DELIVERY_ACTIONS.has(action);
}

const askFor = (reasons: string[]): Verdict => ({ action: "ask", reason: `marcsh: ${[...new Set(reasons)].join("; ")} needs your approval` });

/** Decides a call under `mode` for the project at `cwd`. */
export function decideApproval(mode: ApprovalMode, call: ToolCall, cwd: string): Verdict {
  if (call.kind === "other") return UNCHANGED;

  if (call.kind === "edit") {
    if (mode === "normal") return UNCHANGED;
    const problem = editProblem(call.path, cwd);
    return problem ? askFor([problem]) : ALLOW;
  }

  const { matches, writes } = analyzeCommand(call.command);
  const catastrophic = matches.find((match) => match.hardDeny);
  if (catastrophic) return { action: "block", reason: `marcsh: ${catastrophic.reason} is never allowed` };
  if (mode === "normal") return UNCHANGED;

  const reasons = matches.filter((match) => mode === "auto" || match.kind !== CommandKind.DELIVERY).map((match) => match.reason);
  for (const target of writes) {
    const problem = writeProblem(target, cwd);
    if (problem) reasons.push(problem);
  }
  return reasons.length > 0 ? askFor(reasons) : ALLOW;
}
