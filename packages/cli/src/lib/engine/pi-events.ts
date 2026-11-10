import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatMessage, MessagePart } from "../chat-types";

type ContentBlock = Record<string, unknown> & { type?: string };

function contentBlocks(message: unknown): ContentBlock[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function resultText(result: unknown): string {
  return contentBlocks(result)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function appendAssistant(reply: ChatMessage, message: { usage?: { cost?: { total?: number } } }): ChatMessage {
  const added: MessagePart[] = [];

  for (const block of contentBlocks(message)) {
    if (block.type === "text" && typeof block.text === "string") {
      added.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      added.push({ type: "reasoning", text: block.thinking });
    } else if (block.type === "toolCall") {
      added.push({
        type: "tool",
        toolCallId: String(block.id),
        toolName: String(block.name),
        input: (block.arguments ?? {}) as Record<string, unknown>,
        state: "running",
      });
    }
  }

  const cost = message.usage?.cost?.total;
  const parts = added.length === 0 ? reply.parts : [...reply.parts, ...added];
  if (typeof cost !== "number") return parts === reply.parts ? reply : { ...reply, parts };

  return { ...reply, parts, metadata: { ...reply.metadata, costUsd: (reply.metadata?.costUsd ?? 0) + cost } };
}

function finishTool(reply: ChatMessage, toolCallId: string, result: unknown, isError: boolean): ChatMessage {
  const index = reply.parts.findIndex((p) => p.type === "tool" && p.toolCallId === toolCallId);
  const part = reply.parts[index];
  if (!part || part.type !== "tool") return reply;

  const next: MessagePart = isError ? { ...part, state: "error", errorText: resultText(result) } : { ...part, state: "done" };
  return { ...reply, parts: reply.parts.map((p, i) => (i === index ? next : p)) };
}

/** Folds one pi session event into the assistant reply, returning the same object when nothing changes. */
export function applyPiEvent(reply: ChatMessage, event: AgentSessionEvent): ChatMessage {
  // Calls a tool made through `ctx.executeTool()` are the tool's internals, not the user's conversation.
  if ("parentToolCallId" in event && event.parentToolCallId != null) return reply;

  switch (event.type) {
    case "message_end":
      return event.message.role === "assistant" ? appendAssistant(reply, event.message) : reply;
    case "tool_execution_end":
      return finishTool(reply, event.toolCallId, event.result, event.isError);
    default:
      return reply;
  }
}

export function withDuration(reply: ChatMessage, durationMs: number): ChatMessage {
  return { ...reply, metadata: { ...reply.metadata, durationMs } };
}

export type ErrorTracker = {
  /** Feeds one event; returns the error to report now, if any. */
  observe(event: AgentSessionEvent): string | null;
  /** The error still held when the turn ends, if any. */
  flush(): string | null;
};

/**
 * Pi retries failed responses by itself, so an assistant error is held until it is known to be final:
 * a successful retry drops it, and exhausted retries report it once, with their final error.
 */
export function createErrorTracker(): ErrorTracker {
  let pending: string | null = null;

  return {
    observe(event) {
      if ("parentToolCallId" in event && event.parentToolCallId != null) return null;

      if (event.type === "message_end" && event.message.role === "assistant") {
        pending = event.message.stopReason === "error" ? event.message.errorMessage || "Pi stopped with an error" : null;
      } else if (event.type === "auto_retry_end") {
        const failure = event.success ? null : event.finalError || pending;
        pending = null;
        return failure;
      }
      return null;
    },
    flush() {
      const failure = pending;
      pending = null;
      return failure;
    },
  };
}
