import { query, type CanUseTool, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeDeniedTools, isClaudeToolDenied, notAvailableReason } from "../agent-tools";
import type { Group } from "../tool-names";
import { parseAskUserQuestion } from "../ask-user-question";
import { referenceText, splitAttachments, type Attachment } from "../attachments";
import type { ChatMessage } from "../chat-types";
import { mergeUsage } from "../usage";
import { normalizeClaudeCommands } from "../claude-commands";
import { warmUpClaudeCommands } from "../command-warmup";
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
import type { Engine, EngineTurn, TurnHost, TurnRequest } from "./types";

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

/**
 * The permission callback of a turn. A denied tool is refused here whoever calls it (the turn or a Task child), before anything is asked.
 * Backstop for `disallowedTools` (the SDK documents its MCP wildcard for agent definitions; this keeps a denied MCP call from ever
 * reaching the user as an approval). Never `allowedTools`: that would approve tools without asking.
 */
export function createCanUseTool(host: TurnHost, deniedTools: readonly Group[] | undefined): CanUseTool {
  return async (toolName, input, options) => {
    if (deniedTools && isClaudeToolDenied(toolName, deniedTools)) return { behavior: "deny", message: notAvailableReason(toolName) };

    const asked = toolName === "AskUserQuestion" ? parseAskUserQuestion(input) : null;
    if (asked) {
      const answers = await host.askQuestions(asked.questions, options.signal);
      return answers ? toAnswersResult(input, answers) : toDeclinedResult();
    }

    const decision = await host.askPermission(
      {
        toolName,
        input,
        title: options.title,
        description: options.description,
        decisionReason: options.decisionReason,
        blockedPath: options.blockedPath,
        defaultToNo: options.defaultToNo,
        suppressAlwaysAllowRule: options.suppressAlwaysAllowRule,
      },
      options.signal,
    );
    return toPermissionResult(decision, input, options.suggestions, {
      suppressAlwaysAllowRule: options.suppressAlwaysAllowRule || options.defaultToNo,
    });
  };
}

/** The options of a Claude turn. An agent's denied groups go in `disallowedTools` (none when it denies nothing), never `allowedTools`. */
export function claudeQueryOptions({
  cwd,
  mode,
  model,
  systemPromptAppend,
  deniedTools,
  resumeRef,
  abortController,
  canUseTool,
  plugins,
}: Pick<TurnRequest, "cwd" | "mode" | "model" | "systemPromptAppend" | "deniedTools" | "resumeRef"> & {
  abortController: AbortController;
  canUseTool: CanUseTool;
  plugins: readonly string[];
}): Options {
  const disallowedTools = claudeDeniedTools(deniedTools ?? []);
  return {
    cwd,
    model,
    permissionMode: toPermissionMode(mode),
    resume: resumeRef,
    abortController,
    systemPrompt: { type: "preset", preset: "claude_code", ...(systemPromptAppend ? { append: systemPromptAppend } : {}) },
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

function startTurn({ prompt, attachments, cwd, mode, model, systemPromptAppend, packPluginPath, deniedTools, resumeRef, priorCostUsd, signal }: TurnRequest, host: TurnHost): EngineTurn {
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const canUseTool = createCanUseTool(host, deniedTools);

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
        options: claudeQueryOptions({ cwd, mode, model, systemPromptAppend, deniedTools, resumeRef, abortController, canUseTool, plugins }),
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
