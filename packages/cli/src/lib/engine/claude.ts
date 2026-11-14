import { query, type CanUseTool, type Options, type Query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeDeniedTools, isClaudeToolDenied, notAvailableReason } from "../agent-tools";
import { decideApproval, type ApprovalMode, type ToolCall } from "../approval-policy";
import type { Group } from "../tool-names";
import { parseAskUserQuestion } from "../ask-user-question";
import { normalizeClaudeCommands } from "../claude-commands";
import { warmUpClaudeCommands } from "../command-warmup";
import { Mode } from "../modes";
import { prepareViewForTurn } from "../packs";
import { marcshPluginPath } from "../plugin";
import {
  applySdkMessage,
  resultError,
  toAnswersResult,
  toDeclinedResult,
  toPermissionMode,
  toPermissionResult,
} from "../sdk-messages";
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
 * a blocked path): those always ask. The mode never turns an ask into an always-allow rule: a policy ask suppresses it.
 */
export function createCanUseTool(host: TurnHost, deniedTools: readonly Group[] | undefined, policy?: { approvalMode: ApprovalMode; cwd: string }): CanUseTool {
  return async (toolName, input, options) => {
    if (deniedTools && isClaudeToolDenied(toolName, deniedTools)) return { behavior: "deny", message: notAvailableReason(toolName) };

    const asked = toolName === "AskUserQuestion" ? parseAskUserQuestion(input) : null;
    if (asked) {
      const answers = await host.askQuestions(asked.questions, options.signal);
      return answers ? toAnswersResult(input, answers) : toDeclinedResult();
    }

    const forced = options.matchedAskRule || options.defaultToNo || options.blockedPath;
    const verdict = policy && !forced ? decideApproval(policy.approvalMode, policyCall(toolName, input), policy.cwd) : undefined;
    if (verdict?.action === "block") return { behavior: "deny", message: verdict.reason };
    if (verdict?.action === "allow") return { behavior: "allow", updatedInput: input };
    const floor = verdict?.action === "ask" ? verdict : undefined;

    const decision = await host.askPermission(
      {
        toolName,
        input,
        title: options.title,
        description: options.description,
        decisionReason: floor ? floor.reason : options.decisionReason,
        blockedPath: options.blockedPath,
        defaultToNo: options.defaultToNo,
        suppressAlwaysAllowRule: floor ? true : options.suppressAlwaysAllowRule,
      },
      options.signal,
    );
    return toPermissionResult(decision, input, options.suggestions, {
      suppressAlwaysAllowRule: floor ? true : options.suppressAlwaysAllowRule || options.defaultToNo,
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
  deniedTools,
  resumeRef,
  abortController,
  canUseTool,
  plugins,
}: Pick<TurnRequest, "cwd" | "mode" | "model" | "systemPromptAppend" | "approvalMode" | "deniedTools" | "resumeRef"> & {
  abortController: AbortController;
  canUseTool: CanUseTool;
  plugins: readonly string[];
}): Options {
  const disallowedTools = claudeDeniedTools(deniedTools ?? []);
  const append = systemPromptWithMode(systemPromptAppend, approvalMode);
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

function startTurn({ prompt, cwd, mode, model, systemPromptAppend, approvalMode, packPluginPath, deniedTools, resumeRef, signal }: TurnRequest, host: TurnHost): EngineTurn {
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });
  // Plan mode is a separate axis: Claude's own plan mode keeps it read-only, so only the catastrophic block (normal) applies there.
  const canUseTool = createCanUseTool(host, deniedTools, { approvalMode: mode === Mode.PLAN ? "normal" : (approvalMode ?? "normal"), cwd });

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
        prompt,
        options: claudeQueryOptions({ cwd, mode, model, systemPromptAppend, approvalMode, deniedTools, resumeRef, abortController, canUseTool, plugins }),
      });

      for await (const message of chat) {
        host.emit({ type: "reply", update: (reply) => applySdkMessage(reply, message) });

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
