import { query, type CanUseTool, type Query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claudeDeniedTools, isClaudeToolDenied, notAvailableReason } from "../agent-tools";
import { parseAskUserQuestion } from "../ask-user-question";
import { normalizeClaudeCommands } from "../claude-commands";
import { warmUpClaudeCommands } from "../command-warmup";
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

function startTurn({ prompt, cwd, mode, model, systemPromptAppend, packPluginPath, deniedTools, resumeRef, signal }: TurnRequest, host: TurnHost): EngineTurn {
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), { once: true });

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    // Backstop for `disallowedTools` (the SDK documents its MCP wildcard for agent definitions; this keeps a denied MCP call from ever
    // reaching the user as an approval). Never `allowedTools`: that would approve tools without asking.
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

  const disallowedTools = claudeDeniedTools(deniedTools ?? []);

  let chat: Query | null = null;
  const done = (async () => {
    const pluginPath = marcshPluginPath();
    // The pack's view has only skills and commands (no hooks, MCP or agents); a view that is gone is left out.
    const packPath = packPluginPath && existsSync(join(packPluginPath, ".claude-plugin", "plugin.json")) ? packPluginPath : null;
    const plugins = [...(pluginPath ? [pluginPath] : []), ...(packPath ? [packPath] : [])].map((path) => ({ type: "local" as const, path }));
    try {
      chat = query({
        prompt,
        options: {
          cwd,
          model,
          permissionMode: toPermissionMode(mode),
          resume: resumeRef,
          abortController,
          systemPrompt: { type: "preset", preset: "claude_code", ...(systemPromptAppend ? { append: systemPromptAppend } : {}) },
          settingSources: ["user", "project", "local"],
          canUseTool,
          ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
          ...(plugins.length > 0 ? { plugins } : {}),
        },
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
