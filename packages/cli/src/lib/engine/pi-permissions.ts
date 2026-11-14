import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PermissionRule, Storage } from "../storage";
import { isMarcshAskUser } from "./pi-ask-user";
import { BG_PLAN_TOOLS, isMarcshBgStart, isMarcshBgTool } from "./pi-bg-tools";
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
 * Tools that run without the approval prompt: pi's read-only built-ins, marcsh's own `AskUserQuestion` (answering the
 * question is the approval), marcsh's own `Task` (the subagent it starts asks for its own tool calls, and has only the
 * read-only tools in plan mode), and marcsh's own bg tools except `bg_start` (they read, or stop this session's terminals).
 */
export function runsUnasked(tool: ToolSource): boolean {
  return isReadOnlyBuiltin(tool) || isMarcshAskUser(tool) || isMarcshTask(tool) || (isMarcshBgTool(tool) && !isMarcshBgStart(tool));
}

/** The only tools plan mode offers: those that run unasked, without `bg_kill` (plan mode stops nothing). */
export function offeredInPlan(tool: ToolSource): boolean {
  return runsUnasked(tool) && (!isMarcshBgTool(tool) || (BG_PLAN_TOOLS as readonly string[]).includes(tool.name));
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

export type ApprovalOptions = {
  /** The session's project directory: rules apply per cwd. */
  cwd: string;
  rules: Pick<Storage, "addPermissionRule" | "hasPermissionRule">;
  host: Pick<TurnHost, "askPermission">;
  /** Aborts when the turn ends; a pending ask is then declined and its call never runs. */
  signal: AbortSignal;
  /** Plan mode: every call except pi's read-only built-ins is blocked without asking, whatever the rules say. */
  planMode?: boolean;
  /** The session's tools with their sources (`pi.getAllTools()`), read when a call arrives. */
  tools: () => readonly ToolSource[];
  /** The branch/ship guard for pi's built-in `bash`. Default: the same decision Claude's PreToolUse hook makes. */
  guard?: Guard;
};

type Call = { toolName: string; input: Record<string, unknown> };

/**
 * The call as approval judges it: marcsh's `bg_start` is `bash` with the same command, so it gets bash's guard verdict and
 * shares bash's exact-command rule (an "always" for one covers the other). The ask itself still shows the real call.
 */
function judgedAs(call: Call, tools: readonly ToolSource[]): Call {
  const tool = tools.find((candidate) => candidate.name === call.toolName);
  return tool && isMarcshBgStart(tool) ? { toolName: "bash", input: { command: call.input.command } } : call;
}

/** The guard's verdict on a call, or null: only pi's own `bash` (and marcsh's `bg_start`, judged as it) with a command string is guarded, and a guard that fails is no verdict (fail open, like the Claude hook). */
function guardVerdict(guard: Guard, cwd: string, call: Call, tools: readonly ToolSource[]): Decision | null {
  const tool = tools.find((candidate) => candidate.name === call.toolName);
  const command = call.input.command;
  if (!tool || !(isBuiltinBash(tool) || isMarcshBgStart(tool)) || typeof command !== "string") return null;
  try {
    return guard(command, cwd);
  } catch {
    return null;
  }
}

/** Decides one tool call: `undefined` lets it run, a block stops it with a reason pi shows the model. */
export function createApprovalHandler({ cwd, rules, host, signal, planMode = false, tools, guard = guardBashCommand }: ApprovalOptions) {
  return async (call: Call): Promise<ToolCallBlock | undefined> => {
    if (planMode) {
      const tool = tools().find((candidate) => candidate.name === call.toolName);
      return tool && offeredInPlan(tool) ? undefined : { block: true, reason: PLAN_MODE_REASON };
    }
    if (!needsApproval(call.toolName, tools())) return undefined;

    const verdict = guardVerdict(guard, cwd, call, tools());
    if (verdict?.decision === "deny") return { block: true, reason: verdict.reason };
    // A guarded action always asks and can never be always-allowed: no rule is matched, and none is stored.
    const guarded = verdict?.decision === "ask" ? verdict : undefined;
    const judged = judgedAs(call, tools());
    const rule = guarded ? undefined : ruleFor(cwd, judged.toolName, judged.input);
    if (rule && rules.hasPermissionRule(rule)) return undefined;

    let decision: Awaited<ReturnType<TurnHost["askPermission"]>>;
    try {
      decision = await host.askPermission(
        guarded
          ? { toolName: call.toolName, input: call.input, decisionReason: guarded.reason, suppressAlwaysAllowRule: true }
          : { toolName: call.toolName, input: call.input },
        signal,
      );
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
      pi.setActiveTools(pi.getAllTools().filter(offeredInPlan).map((tool) => tool.name));
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
