import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PermissionRule, Storage } from "../storage";
import type { TurnHost } from "./types";

export const DENIED_REASON = "The user denied this tool call.";
const INTERRUPTED_REASON = "The turn ended before this tool call was approved.";

/** pi's read-only tools. Like Claude's default mode, they run without asking; everything else asks. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export function needsApproval(toolName: string): boolean {
  return !(READ_ONLY_TOOLS as readonly string[]).includes(toolName);
}

/**
 * The rule an "always" answer stores: the exact command for `bash`, the tool name for any other tool.
 * A `bash` call without a command has no rule, so "always" allows it once.
 */
export function ruleFor(cwd: string, toolName: string, input: Record<string, unknown>): PermissionRule | undefined {
  if (toolName !== "bash") return { cwd, toolName };
  const command = input.command;
  return typeof command === "string" && command !== "" ? { cwd, toolName, command } : undefined;
}

export type ToolCallBlock = { block: true; reason: string };

export type ApprovalOptions = {
  /** The session's project directory: rules apply per cwd. */
  cwd: string;
  rules: Pick<Storage, "addPermissionRule" | "hasPermissionRule">;
  host: Pick<TurnHost, "askPermission">;
  /** Aborts when the turn ends; a pending ask is then declined and its call never runs. */
  signal: AbortSignal;
};

/** Decides one tool call: `undefined` lets it run, a block stops it with a reason pi shows the model. */
export function createApprovalHandler({ cwd, rules, host, signal }: ApprovalOptions) {
  return async (call: { toolName: string; input: Record<string, unknown> }): Promise<ToolCallBlock | undefined> => {
    if (!needsApproval(call.toolName)) return undefined;
    const rule = ruleFor(cwd, call.toolName, call.input);
    if (rule && rules.hasPermissionRule(rule)) return undefined;

    let decision: Awaited<ReturnType<TurnHost["askPermission"]>>;
    try {
      decision = await host.askPermission({ toolName: call.toolName, input: call.input }, signal);
    } catch {
      return { block: true, reason: DENIED_REASON };
    }
    // An answer that arrives after the turn ended must not start the tool.
    if (signal.aborted) return { block: true, reason: INTERRUPTED_REASON };
    if (decision === "deny") return { block: true, reason: DENIED_REASON };
    if (decision === "always" && rule) rules.addPermissionRule(rule);
    return undefined;
  };
}

/** The pi extension that routes every tool call through marcsh's approval prompt. */
export function createApprovalExtension(options: ApprovalOptions): ExtensionFactory {
  const decide = createApprovalHandler(options);
  return (pi) => {
    pi.on("tool_call", (event) => decide({ toolName: event.toolName, input: event.input }));
  };
}
