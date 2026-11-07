import type { PermissionMode, PermissionResult, PermissionUpdate, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Mode, type ModeType } from "./modes";
import type { ChatMessage, MessagePart } from "./chat-types";

export type PermissionDecision = "allow" | "always" | "deny";

type ContentBlock = Record<string, unknown> & { type?: string };

function contentBlocks(message: unknown): ContentBlock[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function appendParts(reply: ChatMessage, blocks: ContentBlock[]): ChatMessage {
  const added: MessagePart[] = [];

  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      added.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      added.push({ type: "reasoning", text: block.thinking });
    } else if (block.type === "tool_use") {
      added.push({
        type: "tool",
        toolCallId: String(block.id),
        toolName: String(block.name),
        input: (block.input ?? {}) as Record<string, unknown>,
        state: "running",
      });
    }
  }

  return added.length === 0 ? reply : { ...reply, parts: [...reply.parts, ...added] };
}

function applyToolResults(reply: ChatMessage, blocks: ContentBlock[]): ChatMessage {
  let parts = reply.parts;

  for (const block of blocks) {
    if (block.type !== "tool_result") continue;

    const index = parts.findIndex((p) => p.type === "tool" && p.toolCallId === block.tool_use_id);
    const part = parts[index];
    if (!part || part.type !== "tool") continue;

    const next: MessagePart = block.is_error
      ? { ...part, state: "error", errorText: toolResultText(block.content) }
      : { ...part, state: "done" };
    parts = parts.map((p, i) => (i === index ? next : p));
  }

  return parts === reply.parts ? reply : { ...reply, parts };
}

/** Folds one SDK message into the assistant reply, returning the same object when nothing changes. */
export function applySdkMessage(reply: ChatMessage, message: SDKMessage): ChatMessage {
  if ("parent_tool_use_id" in message && message.parent_tool_use_id != null) return reply;

  switch (message.type) {
    case "assistant":
      return appendParts(reply, contentBlocks(message.message));
    case "user":
      return applyToolResults(reply, contentBlocks(message.message));
    case "result":
      return {
        ...reply,
        metadata: {
          ...reply.metadata,
          durationMs: message.duration_ms,
          costUsd: message.total_cost_usd,
        },
      };
    default:
      return reply;
  }
}

/** Ends a turn: tools still running will never get a result, so they are saved as interrupted errors. */
export function finishReply(reply: ChatMessage): ChatMessage {
  if (!reply.parts.some((p) => p.type === "tool" && p.state === "running")) return reply;

  const parts = reply.parts.map((p): MessagePart =>
    p.type === "tool" && p.state === "running" ? { ...p, state: "error", errorText: "Interrupted" } : p,
  );
  return { ...reply, parts };
}

/** The user-facing error for a failed turn, or null when the turn succeeded. */
export function resultError(message: SDKMessage): string | null {
  if (message.type !== "result") return null;

  if (message.subtype === "success") {
    return message.is_error ? message.result || "Claude returned an error" : null;
  }

  return `Claude stopped: ${message.subtype}`;
}

export function toPermissionMode(mode: ModeType): PermissionMode {
  return mode === Mode.PLAN ? "plan" : "default";
}

export function toPermissionResult(
  decision: PermissionDecision,
  input: Record<string, unknown>,
  suggestions?: PermissionUpdate[],
  { suppressAlwaysAllowRule = false }: { suppressAlwaysAllowRule?: boolean } = {},
): PermissionResult {
  if (decision === "deny") {
    return { behavior: "deny", message: "The user denied this tool call." };
  }

  if (decision === "always" && !suppressAlwaysAllowRule && suggestions?.length) {
    return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions };
  }

  return { behavior: "allow", updatedInput: input };
}
