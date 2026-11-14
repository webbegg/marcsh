import type { PermissionMode, PermissionResult, PermissionUpdate, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Mode, type ModeType } from "./modes";
import type { ChatMessage, MessagePart, TaskStatus } from "./chat-types";
import type { PermissionDecision } from "./engine/types";

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

type TaskPart = Extract<MessagePart, { type: "task" }>;

/** Merges changes into the task's part, creating it when unknown; returns the same reply when nothing changes. */
function upsertTask(reply: ChatMessage, taskId: string, changes: Partial<Omit<TaskPart, "type" | "taskId">>): ChatMessage {
  const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
  const index = reply.parts.findIndex((p) => p.type === "task" && p.taskId === taskId);
  const existing = reply.parts[index];

  if (!existing || existing.type !== "task") {
    const created: TaskPart = { type: "task", taskId, description: "", status: "running", ...defined };
    return { ...reply, parts: [...reply.parts, created] };
  }

  if (Object.entries(defined).every(([key, value]) => existing[key as keyof TaskPart] === value)) return reply;

  const parts = reply.parts.map((p, i): MessagePart => (i === index ? { ...existing, ...defined } : p));
  return { ...reply, parts };
}

/** The status a task patch shows, or undefined for states the line does not distinguish (paused). */
function patchStatus(status: string | undefined): TaskStatus | undefined {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "completed":
    case "failed":
      return status;
    case "killed":
      return "stopped";
    default:
      return undefined;
  }
}

function applyTaskMessage(reply: ChatMessage, message: SDKMessage): ChatMessage | null {
  if (message.type !== "system") return null;

  switch (message.subtype) {
    case "task_started":
      return upsertTask(reply, message.task_id, { description: message.description });
    case "task_progress":
      return upsertTask(reply, message.task_id, {
        description: message.description,
        lastToolName: message.last_tool_name,
        toolUses: message.usage.tool_uses,
        totalTokens: message.usage.total_tokens,
        summary: message.summary,
      });
    case "task_updated":
      return upsertTask(reply, message.task_id, {
        status: patchStatus(message.patch.status),
        description: message.patch.description,
        error: message.patch.error,
      });
    case "task_notification":
      return upsertTask(reply, message.task_id, {
        status: message.status,
        summary: message.summary,
        toolUses: message.usage?.tool_uses,
        totalTokens: message.usage?.total_tokens,
      });
    default:
      return null;
  }
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
    case "system":
      if (message.subtype === "local_command_output") {
        return { ...reply, parts: [...reply.parts, { type: "text", text: message.content }] };
      }
      return applyTaskMessage(reply, message) ?? reply;
    default:
      return reply;
  }
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

export function toAnswersResult(input: Record<string, unknown>, answers: Record<string, string>): PermissionResult {
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

export function toDeclinedResult(): PermissionResult {
  return { behavior: "deny", message: "The user declined to answer." };
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

  // A folder answer (`path:<dir>`) is a one-time allow here: the engine stores the rule itself, Claude gets no updatedPermissions.
  if (decision === "always" && !suppressAlwaysAllowRule && suggestions?.length) {
    return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions };
  }

  return { behavior: "allow", updatedInput: input };
}
