import { APPROVAL_MODES, isApprovalMode, type ApprovalMode } from "../../lib/approval-policy";

export const PERMISSIONS_USAGE = `Usage: /permissions [${APPROVAL_MODES.join("|")} | default <${APPROVAL_MODES.join("|")}>]`;

/** The toast after the session's mode is set. */
export const sessionModeMessage = (mode: ApprovalMode) => `Approval mode: ${mode} for this session`;

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
