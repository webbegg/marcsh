import { APPROVAL_MODES, isApprovalMode, type ApprovalMode } from "../../lib/approval-policy";
import type { BranchState } from "../../lib/git-branch";
import { escapeTranscriptText } from "../../lib/display-text";

export const PERMISSIONS_USAGE = `Usage: /permissions [${APPROVAL_MODES.join("|")} | default <${APPROVAL_MODES.join("|")}>]`;

/**
 * Why auto and yolo are paused in a folder (`on the default branch main`, `detached HEAD`); undefined on a feature branch. The branch
 * name comes from the folder, so what could act on the terminal shows as a visible escape, as in `pausedLabel`.
 */
function pauseReason(branch: BranchState): string | undefined {
  if (branch.kind === "feature") return undefined;
  return escapeTranscriptText(branch.kind === "default" ? `on the default branch ${branch.branch}` : branch.reason);
}

/**
 * The toast after the session's mode is set. In auto and yolo, when the folder is not on a feature branch (`branch`), it adds that the
 * mode is paused there: marcsh asks as in normal mode.
 */
export function sessionModeMessage(mode: ApprovalMode, branch?: BranchState): string {
  const message = `Approval mode: ${mode} for this session`;
  const reason = mode === "normal" || !branch ? undefined : pauseReason(branch);
  if (reason === undefined) return message;
  return `${message}. ${mode} is paused here: ${reason}. marcsh asks as in normal mode until you work on a feature branch, preferably in a worktree.`;
}

/**
 * The short note next to a mode in the `/permissions` dialog: `(paused on main)` on the default branch, `(paused: detached HEAD)`
 * where there is no branch, and nothing for normal, on a feature branch, or while the branch is not known. The branch name comes
 * from the folder, so what could act on the terminal shows as a visible escape.
 */
export function pausedLabel(mode: ApprovalMode, branch?: BranchState): string {
  if (mode === "normal" || !branch || branch.kind === "feature") return "";
  return branch.kind === "default" ? `(paused on ${escapeTranscriptText(branch.branch)})` : `(paused: ${escapeTranscriptText(branch.reason)})`;
}

/** The toast after the default for new sessions is saved. */
export const defaultModeMessage = (mode: ApprovalMode) => `New sessions will start in ${mode} mode`;

/** What a typed `/permissions <args>` asks for. `usage` carries the error text to show; the others are ready to run. */
export type PermissionsCommand =
  | { kind: "dialog" }
  /** Sets the mode of this session. */
  | { kind: "set"; mode: ApprovalMode }
  /** Saves the mode new sessions start in. */
  | { kind: "default"; mode: ApprovalMode }
  | { kind: "usage"; message: string };

const usage = (why?: string): PermissionsCommand => ({
  kind: "usage",
  message: why ? `${why} ${PERMISSIONS_USAGE}` : PERMISSIONS_USAGE,
});

/** `/permissions`, `/permissions <mode>` and `/permissions default <mode>`. Pure: nothing is stored or changed. */
export function parsePermissionsCommand(args: string): PermissionsCommand {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: "dialog" };

  const [first, second, ...extra] = words;
  if (first === "default") {
    if (second === undefined || extra.length > 0) return usage();
    return isApprovalMode(second) ? { kind: "default", mode: second } : usage(`"${second}" is not a mode.`);
  }
  if (second !== undefined) return usage();
  return isApprovalMode(first) ? { kind: "set", mode: first } : usage(`"${first}" is not a mode.`);
}
