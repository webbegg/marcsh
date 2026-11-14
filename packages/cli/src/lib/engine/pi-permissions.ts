import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type ApprovalMode, decideApproval, isFixedGuardAsk, type ToolCall } from "../approval-policy";
import { answeredPathRule, hasMatchingPathRule, type PathRuleStore, pathRuleCandidate } from "../path-rules";
import type { PermissionRule, Storage } from "../storage";
import { isMarcshAskUser } from "./pi-ask-user";
import { type Decision, type Guard, guardBashCommand, isBuiltinBash } from "./pi-guard";
import { isMarcshTask } from "./pi-subagent";
import type { TurnHost } from "./types";

export const DENIED_REASON = "The user denied this tool call.";
const INTERRUPTED_REASON = "The turn ended before this tool call was approved.";
export const PLAN_MODE_REASON = "Plan mode only allows reading tools.";

/** pi's read-only tools. Like Claude's default mode, they run without asking; everything else asks. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** The part of pi's `ToolInfo` that says where a tool comes from: pi's own tools have the path `builtin:<name>`. */
export type ToolSource = { name: string; sourceInfo: { path: string } };

/**
 * Read-only means pi's own read, grep, find or ls. An extension can register a tool with one of those
 * names and replace the built-in, so the name alone proves nothing: the tool must come from pi itself.
 */
export function isReadOnlyBuiltin(tool: ToolSource): boolean {
  return (READ_ONLY_TOOLS as readonly string[]).includes(tool.name) && tool.sourceInfo.path === `builtin:${tool.name}`;
}

/**
 * Tools that run without the approval prompt, and the only ones plan mode offers: pi's read-only built-ins,
 * marcsh's own `AskUserQuestion` (answering the question is the approval), and marcsh's own `Task` (the
 * subagent it starts asks for its own tool calls, and has only the read-only tools in plan mode).
 */
export function runsUnasked(tool: ToolSource): boolean {
  return isReadOnlyBuiltin(tool) || isMarcshAskUser(tool) || isMarcshTask(tool);
}

/** A tool that is not registered (or not one that runs unasked) asks. */
export function needsApproval(toolName: string, tools: readonly ToolSource[]): boolean {
  const tool = tools.find((candidate) => candidate.name === toolName);
  return !tool || !runsUnasked(tool);
}

/** Shell tools: an "always" answer covers the exact command only. */
const COMMAND_TOOLS = ["bash", "powershell"];

/**
 * The rule an "always" answer stores: the exact command for a shell tool (`bash`, `powershell`), the tool
 * name for any other tool. A shell call without a command has no rule, so "always" allows it once.
 */
export function ruleFor(cwd: string, toolName: string, input: Record<string, unknown>): PermissionRule | undefined {
  if (!COMMAND_TOOLS.includes(toolName)) return { cwd, toolName };
  const command = input.command;
  return typeof command === "string" && command !== "" ? { cwd, toolName, command } : undefined;
}

export type ToolCallBlock = { block: true; reason: string };

/** The rules the approval flow reads and writes. Without the path-rule methods, no folder choice is offered and none is applied. */
export type RuleStore = Pick<Storage, "addPermissionRule" | "hasPermissionRule"> & Partial<PathRuleStore>;

export type ApprovalOptions = {
  /** The session's project directory: rules apply per cwd. */
  cwd: string;
  rules: RuleStore;
  host: Pick<TurnHost, "askPermission">;
  /** Aborts when the turn ends; a pending ask is then declined and its call never runs. */
  signal: AbortSignal;
  /** Plan mode: every call except pi's read-only built-ins is blocked without asking, whatever the rules say. */
  planMode?: boolean;
  /** The session's tools with their sources (`pi.getAllTools()`), read when a call arrives. */
  tools: () => readonly ToolSource[];
  /** The branch/ship guard for pi's built-in `bash`. Default: the same decision Claude's PreToolUse hook makes. */
  guard?: Guard;
  /** The session's approval mode (absent = normal). Decides after the plan-mode block and the guard's deny, so neither is ever loosened. */
  approvalMode?: ApprovalMode;
};

/** The guard's verdict on a call, or null: only pi's own `bash` with a command string is guarded, and a guard that fails is no verdict (fail open, like the Claude hook). */
function guardVerdict(guard: Guard, cwd: string, call: { toolName: string; input: Record<string, unknown> }, tools: readonly ToolSource[]): Decision | null {
  const tool = tools.find((candidate) => candidate.name === call.toolName);
  const command = call.input.command;
  if (!tool || !isBuiltinBash(tool) || typeof command !== "string") return null;
  try {
    return guard(command, cwd);
  } catch {
    return null;
  }
}

/** pi's own built-in `edit` and `write` write the file named by their `path` input. */
const EDIT_TOOLS = ["edit", "write"];

/** What the approval policy sees of a call: pi's own `bash` is a shell command, its own `edit`/`write` a file edit, any other tool is not classified. */
function policyCall(call: { toolName: string; input: Record<string, unknown> }, tools: readonly ToolSource[]): ToolCall {
  const tool = tools.find((candidate) => candidate.name === call.toolName);
  if (!tool) return { kind: "other" };
  const { command, path } = call.input;
  if (isBuiltinBash(tool) && typeof command === "string") return { kind: "shell", command };
  if (EDIT_TOOLS.includes(tool.name) && tool.sourceInfo.path === `builtin:${tool.name}` && typeof path === "string") return { kind: "edit", path };
  return { kind: "other" };
}

/** Decides one tool call: `undefined` lets it run, a block stops it with a reason pi shows the model. */
export function createApprovalHandler({ cwd, rules, host, signal, planMode = false, tools, guard = guardBashCommand, approvalMode = "normal" }: ApprovalOptions) {
  return async (call: { toolName: string; input: Record<string, unknown> }): Promise<ToolCallBlock | undefined> => {
    if (!needsApproval(call.toolName, tools())) return undefined;
    if (planMode) return { block: true, reason: PLAN_MODE_REASON };

    const verdict = guardVerdict(guard, cwd, call, tools());
    if (verdict?.decision === "deny") return { block: true, reason: verdict.reason };

    // The mode only loosens what the existing flow would ask. A policy ask is like a guarded one: it can never be always-allowed.
    const seen = policyCall(call, tools());
    const policy = decideApproval(approvalMode, seen, cwd);
    if (policy.action === "block") return { block: true, reason: policy.reason };
    // A stored path rule ("allow `rm` under /tmp/x") runs a covered shell command in every mode, also past a floor ask; sudo and catastrophic commands never match.
    const command = seen.kind === "shell" ? seen.command : undefined;
    const { pathRulesFor, addPathRule } = rules;
    if (command !== undefined && pathRulesFor && hasMatchingPathRule({ pathRulesFor }, command, cwd)) return undefined;
    // The mode skips the guard's ask only for delivery (`git push`, `gh pr create`); a merge or publish keeps asking, as a floor ask.
    if (policy.action === "allow" && !(verdict?.decision === "ask" && isFixedGuardAsk(verdict.reason))) return undefined;
    const floor = policy.action === "ask" ? { reason: policy.reason } : verdict?.decision === "ask" ? verdict : undefined;
    // A floor action always asks and can never be always-allowed: no rule is matched, and none is stored.
    const rule = floor ? undefined : ruleFor(cwd, call.toolName, call.input);
    if (rule && rules.hasPermissionRule(rule)) return undefined;

    const candidate = command !== undefined && pathRulesFor && addPathRule ? pathRuleCandidate(command, cwd) : null;
    let decision: Awaited<ReturnType<TurnHost["askPermission"]>>;
    try {
      decision = await host.askPermission(
        {
          toolName: call.toolName,
          input: call.input,
          ...(floor ? { decisionReason: floor.reason, suppressAlwaysAllowRule: true } : {}),
          ...(candidate ? { pathRule: candidate } : {}),
        },
        signal,
      );
    } catch {
      return { block: true, reason: DENIED_REASON };
    }
    // An answer that arrives after the turn ended must not start the tool.
    if (signal.aborted) return { block: true, reason: INTERRUPTED_REASON };
    if (decision === "deny") return { block: true, reason: DENIED_REASON };
    if (decision === "always" && rule) rules.addPermissionRule(rule);
    const answered = answeredPathRule(decision, cwd, candidate);
    if (answered) addPathRule?.(answered);
    return undefined;
  };
}

/**
 * The pi extension that routes every tool call through marcsh's approval prompt. In plan mode it also keeps
 * the session's active tools to the ones that run unasked: an extension that registers a tool later (in
 * `before_agent_start` or `turn_start`) has it activated by pi, and these handlers run after it. The
 * `tool_call` block is the backstop if a tool is offered anyway.
 */
export function createApprovalExtension(options: Omit<ApprovalOptions, "tools">): ExtensionFactory {
  return (pi) => {
    const decide = createApprovalHandler({ ...options, tools: () => pi.getAllTools() });
    pi.on("tool_call", (event) => decide({ toolName: event.toolName, input: event.input }));
    if (!options.planMode) return;
    const keepReadOnly = () => {
      pi.setActiveTools(pi.getAllTools().filter(runsUnasked).map((tool) => tool.name));
    };
    pi.on("before_agent_start", keepReadOnly);
    pi.on("turn_start", keepReadOnly);
    // The first turn declares its tools before `turn_start` runs, so a tool replaced there would still be
    // declared by name: the model is shown only the tools that are active when the request goes out.
    pi.on("context_with_system", (event) => {
      const active = new Set(pi.getActiveTools());
      return {
        messages: event.messages.map((message) =>
          message.role === "system" && message.toolsAdded
            ? { ...message, toolsAdded: message.toolsAdded.filter((tool) => active.has(tool.name)) }
            : message,
        ),
      };
    });
  };
}
