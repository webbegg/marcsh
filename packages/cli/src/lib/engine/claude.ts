import { query, type CanUseTool, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeDeniedTools, isClaudeToolDenied, notAvailableReason } from "../agent-tools";
import { decideApproval, isGuardAsk, type ApprovalMode, type ToolCall } from "../approval-policy";
import { type BranchSource, type BranchState, branchState } from "../git-branch";
import type { Group } from "../tool-names";
import { parseAskUserQuestion } from "../ask-user-question";
import { referenceText, splitAttachments, type Attachment } from "../attachments";
import type { ChatMessage } from "../chat-types";
import { mergeUsage } from "../usage";
import { normalizeClaudeCommands } from "../claude-commands";
import { warmUpClaudeCommands } from "../command-warmup";
import { Mode } from "../modes";
import { prepareViewForTurn } from "../packs";
import { answeredPathRule, hasMatchingPathRule, type PathRuleStore, pathRuleCandidate } from "../path-rules";
import { marcshPluginPath } from "../plugin";
import {
  applySdkMessage,
  resultError,
  toAnswersResult,
  toDeclinedResult,
  toPermissionMode,
  toPermissionResult,
} from "../sdk-messages";
import { getStorage } from "../storage";
import { systemPromptWithMode, type Engine, type EngineTurn, type TurnHost, type TurnRequest } from "./types";

// The command list only feeds the `/` menu: failing to fetch it never affects the turn.
function emitCommands(host: TurnHost, commands: unknown) {
  try {
    host.emit({ type: "commands", commands: normalizeClaudeCommands(commands) });
  } catch {}
}

async function refreshCommands(chat: Query, host: TurnHost) {
  try {
    emitCommands(host, await chat.supportedCommands());
  } catch {}
}

/** Claude's edit tools and the input key that names the file each one writes. */
const EDIT_PATH_KEYS: Record<string, string> = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

/** What the approval policy sees of a call: `Bash` is a shell command, the edit tools a file edit, any other tool is not classified. */
function policyCall(toolName: string, input: Record<string, unknown>): ToolCall {
  if (toolName === "Bash" && typeof input.command === "string") return { kind: "shell", command: input.command };
  const key = EDIT_PATH_KEYS[toolName];
  const path = key ? input[key] : undefined;
  return typeof path === "string" ? { kind: "edit", path } : { kind: "other" };
}

/**
 * The permission callback of a turn. A denied tool is refused here whoever calls it (the turn or a Task child), before anything is asked.
 * Backstop for `disallowedTools` (the SDK documents its MCP wildcard for agent definitions; this keeps a denied MCP call from ever
 * reaching the user as an approval). Never `allowedTools`: that would approve tools without asking.
 *
 * With an approval mode, the session's policy decides next, except for asks Claude forces itself (the user's ask rules, `defaultToNo`,
 * a blocked path): those always ask, though a catastrophic command is still denied. The mode never turns an ask into an always-allow rule: a
 * policy ask suppresses it, and so does any branch-guard ask (push, PR, merge, publish): no mode skips one. The guard's ask arrives as the
 * hook's `decisionReason`. The branch is read for every call: auto and yolo count only on a feature branch.
 *
 * With `pathRules`, a `Bash` call covered by a stored folder rule ("allow `rm` under /tmp/x") runs without asking, in every mode and also past a
 * floor ask, but never past the catastrophic block or for a forced ask; an ask for a path command offers to store one.
 */
export function createCanUseTool(
  host: TurnHost,
  deniedTools: readonly Group[] | undefined,
  policy?: { approvalMode: ApprovalMode; currentApprovalMode?: () => ApprovalMode; cwd: string; pathRules?: PathRuleStore; branchOf?: (cwd: string) => BranchState },
): CanUseTool {
  return async (toolName, input, options) => {
    if (deniedTools && isClaudeToolDenied(toolName, deniedTools)) return { behavior: "deny", message: notAvailableReason(toolName) };

    const asked = toolName === "AskUserQuestion" ? parseAskUserQuestion(input) : null;
    if (asked) {
      const answers = await host.askQuestions(asked.questions, options.signal);
      return answers ? toAnswersResult(input, answers) : toDeclinedResult();
    }

    const forced = options.matchedAskRule || options.defaultToNo || options.blockedPath;
    // A forced ask is never auto-allowed, but the catastrophic block still applies to it (read as the policy of normal mode).
    const verdict = policy ? decideApproval(forced ? "normal" : (policy.currentApprovalMode?.() ?? policy.approvalMode), policyCall(toolName, input), policy.cwd, () => (policy.branchOf ?? branchState)(policy.cwd)) : undefined;
    if (verdict?.action === "block") return { behavior: "deny", message: verdict.reason };
    // The guard's ask is never skipped by a mode: the ask stays, and cannot be always-allowed.
    const guardFloor = verdict?.action === "allow" && isGuardAsk(options.decisionReason);
    if (verdict?.action === "allow" && !guardFloor) return { behavior: "allow", updatedInput: input };
    const floor = !forced && verdict?.action === "ask" ? verdict : undefined;
    const noAlways = floor !== undefined || guardFloor;

    const folders = forced || !policy?.pathRules ? undefined : { rules: policy.pathRules, cwd: policy.cwd };
    const command = folders && toolName === "Bash" && typeof input.command === "string" ? input.command : undefined;
    if (folders && command !== undefined && hasMatchingPathRule(folders.rules, command, folders.cwd)) return { behavior: "allow", updatedInput: input };
    const candidate = folders && command !== undefined ? pathRuleCandidate(command, folders.cwd) : null;

    const decision = await host.askPermission(
      {
        toolName,
        input,
        title: options.title,
        description: options.description,
        decisionReason: floor ? floor.reason : options.decisionReason,
        blockedPath: options.blockedPath,
        defaultToNo: options.defaultToNo,
        suppressAlwaysAllowRule: noAlways ? true : options.suppressAlwaysAllowRule,
        ...(candidate ? { pathRule: candidate } : {}),
      },
      options.signal,
    );
    const answered = folders ? answeredPathRule(decision, folders.cwd, candidate) : null;
    if (answered) folders?.rules.addPathRule(answered);
    return toPermissionResult(decision, input, options.suggestions, {
      suppressAlwaysAllowRule: noAlways ? true : options.suppressAlwaysAllowRule || options.defaultToNo,
    });
  };
}

/**
 * The options of a Claude turn. An agent's denied groups go in `disallowedTools` (none when it denies nothing), never `allowedTools`.
 * The approval mode only adds its line to the appended system prompt: the permission mode stays default or plan, never bypassPermissions.
 */
export function claudeQueryOptions({
  cwd,
  mode,
  model,
  systemPromptAppend,
  approvalMode,
  branch,
  deniedTools,
  resumeRef,
  abortController,
  canUseTool,
  plugins,
}: Pick<TurnRequest, "cwd" | "mode" | "model" | "systemPromptAppend" | "approvalMode" | "deniedTools" | "resumeRef"> & {
  /** Where the project is, for the mode line. Default: read from `cwd` when there is a line to write. */
  branch?: BranchSource;
  abortController: AbortController;
  canUseTool: CanUseTool;
  plugins: readonly string[];
}): Options {
  const disallowedTools = claudeDeniedTools(deniedTools ?? []);
  // Plan mode stays read-only whatever the approval mode, so it gets no mode line.
  const append = systemPromptWithMode(systemPromptAppend, mode === Mode.PLAN ? undefined : approvalMode, branch ?? (() => branchState(cwd)));
  return {
    cwd,
    model,
    permissionMode: toPermissionMode(mode),
    resume: resumeRef,
    abortController,
    systemPrompt: { type: "preset", preset: "claude_code", ...(append ? { append } : {}) },
    settingSources: ["user", "project", "local"],
    canUseTool,
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    ...(plugins.length > 0 ? { plugins: plugins.map((path) => ({ type: "local" as const, path })) } : {}),
  };
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * What a Claude turn is sent. Plain text stays a string; with images or PDFs it is one user message whose content is the text, then an
 * `image` or `document` block (base64) for each. Other files, and an image whose bytes were not read, are `@path` mentions in the text.
 */
export function claudePrompt(prompt: string, attachments: readonly Attachment[] | undefined, cwd: string): string | AsyncIterable<SDKUserMessage> {
  const { inline, references } = splitAttachments(attachments ?? [], { image: true, pdf: true });
  const blocks = inline.filter((attachment) => attachment.bytes);
  const text = referenceText(prompt, [...references, ...inline.filter((attachment) => !attachment.bytes)], cwd);
  if (blocks.length === 0) return text;

  const content = [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...blocks.map((attachment) => {
      const data = Buffer.from(attachment.bytes!).toString("base64");
      return attachment.kind === "pdf"
        ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data } }
        : { type: "image" as const, source: { type: "base64" as const, media_type: attachment.mime as ImageMediaType, data } };
    }),
  ];
  const message: SDKUserMessage = { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
  return (async function* () {
    yield message;
  })();
}

/**
 * Folds one SDK message into the reply. The SDK's `total_cost_usd` is a running total that a resumed conversation continues from
 * (the first result of a resumed turn already holds the earlier turns), so the reply keeps only the difference from `priorCostUsd`,
 * and the running total itself is stored beside it for the next turn. A total below the prior one means nothing was carried over.
 */
export function applyClaudeMessage(reply: ChatMessage, message: SDKMessage, priorCostUsd: number | undefined): ChatMessage {
  if (message.type !== "result" || typeof message.total_cost_usd !== "number") return applySdkMessage(reply, message);
  const prior = priorCostUsd ?? 0;
  const own = message.total_cost_usd >= prior ? message.total_cost_usd - prior : message.total_cost_usd;
  const applied = applySdkMessage(reply, { ...message, total_cost_usd: own });
  const usage = mergeUsage(applied.metadata?.usage, { cumulativeCostUsd: prior + own });
  return { ...applied, metadata: { ...applied.metadata, ...(usage ? { usage } : {}) } };
}

function startTurn({ prompt, attachments, cwd, mode, model, systemPromptAppend, approvalMode, currentApprovalMode, packPluginPath, deniedTools, resumeRef, priorCostUsd, signal }: TurnRequest, host: TurnHost): EngineTurn {
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });
  // Plan mode is a separate axis: Claude's own plan mode keeps it read-only, so only the catastrophic block (normal) applies there.
  // Folder rules do not apply in plan mode either: Claude's read-only guarantee stays as it is.
  const canUseTool = createCanUseTool(host, deniedTools, {
    approvalMode: mode === Mode.PLAN ? "normal" : (approvalMode ?? "normal"),
    ...(mode !== Mode.PLAN && currentApprovalMode ? { currentApprovalMode } : {}),
    cwd,
    ...(mode === Mode.PLAN ? {} : { pathRules: getStorage() }),
  });

  let chat: Query | null = null;
  const done = (async () => {
    const pluginPath = marcshPluginPath();
    // The view's hooks/ stay only while enabled and matching what the user approved (run through marcsh's filter); otherwise they are removed before Claude loads it.
    const packTurn = packPluginPath ? await prepareViewForTurn(packPluginPath) : undefined;
    if (packTurn?.warning) host.notify?.(packTurn.warning, "warning");
    const packView = packTurn?.view;
    const packPath = packView && existsSync(join(packView, ".claude-plugin", "plugin.json")) ? packView : null;
    const plugins = [...(pluginPath ? [pluginPath] : []), ...(packPath ? [packPath] : [])];
    try {
      chat = query({
        prompt: claudePrompt(prompt, attachments, cwd),
        options: claudeQueryOptions({ cwd, mode, model, systemPromptAppend, approvalMode, deniedTools, resumeRef, abortController, canUseTool, plugins }),
      });

      for await (const message of chat) {
        host.emit({ type: "reply", update: (reply) => applyClaudeMessage(reply, message, priorCostUsd) });

        if (message.type === "system" && message.subtype === "init") {
          host.emit({ type: "session", ref: message.session_id });
          void refreshCommands(chat, host);
        }

        // "Clients should REPLACE their cached command list"
        if (message.type === "system" && message.subtype === "commands_changed") {
          emitCommands(host, message.commands);
        }

        const failure = resultError(message);
        if (failure) host.emit({ type: "error", message: failure });
      }
    } finally {
      chat = null;
    }
  })();

  return {
    done,
    interrupt() {
      void chat?.interrupt();
    },
  };
}

export const claudeEngine: Engine = {
  id: "claude",
  startTurn,
  warmUpCommands: warmUpClaudeCommands,
};
