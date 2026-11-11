import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatMessage, MessagePart } from "../chat-types";
import { redactSecrets } from "./pi-auth";
import type { EngineEvent } from "./types";

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

/**
 * The text and reasoning parts that the deltas of the assistant message being generated made, with the content index of
 * the block each one grows from. Kept beside the reply, not in it, so nothing streaming-only is ever saved: they are
 * ordinary parts, and `message_end` swaps them for the final ones.
 */
const streamed = new WeakMap<MessagePart, number>();

type StreamDelta = { kind: "text" | "reasoning"; contentIndex: number; delta: string };

function streamDelta(event: AgentSessionEvent): StreamDelta | null {
  if (event.type !== "message_update") return null;
  const update = event.assistantMessageEvent;
  if (update.type === "text_delta") return { kind: "text", contentIndex: update.contentIndex, delta: update.delta };
  if (update.type === "thinking_delta") return { kind: "reasoning", contentIndex: update.contentIndex, delta: update.delta };
  return null;
}

/** Whether the event is a text or thinking delta of the session's own assistant message, which the reply shows as it arrives. */
export function isStreamDelta(event: AgentSessionEvent): boolean {
  return !("parentToolCallId" in event && event.parentToolCallId != null) && streamDelta(event) !== null;
}

function appendDelta(reply: ChatMessage, { kind, contentIndex, delta }: StreamDelta): ChatMessage {
  if (delta === "") return reply;

  const at = reply.parts.findIndex((p) => p.type === kind && streamed.get(p) === contentIndex);
  const current = reply.parts[at];
  const next: MessagePart = { type: kind, text: (current && current.type === kind ? current.text : "") + delta };
  streamed.set(next, contentIndex);
  return { ...reply, parts: current ? reply.parts.map((p, i) => (i === at ? next : p)) : [...reply.parts, next] };
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

  // The final parts take the place of the streamed ones. A message that ended without content (an interrupted one) keeps what streamed.
  const live = reply.parts.filter((p) => streamed.has(p));
  let parts = reply.parts;
  if (added.length > 0) {
    const kept = reply.parts.filter((p) => !streamed.has(p));
    const at = live.length > 0 ? reply.parts.indexOf(live[0]!) : kept.length;
    parts = [...kept.slice(0, at), ...added, ...kept.slice(at)];
  }
  for (const part of live) streamed.delete(part);

  const cost = message.usage?.cost?.total;
  if (typeof cost !== "number") return parts === reply.parts ? reply : { ...reply, parts };

  return { ...reply, parts, metadata: { ...reply.metadata, costUsd: (reply.metadata?.costUsd ?? 0) + cost } };
}

function finishTool(reply: ChatMessage, toolCallId: string, result: unknown, isError: boolean): ChatMessage {
  const index = reply.parts.findIndex((p) => p.type === "tool" && p.toolCallId === toolCallId);
  const part = reply.parts[index];
  if (!part || part.type !== "tool") return reply;

  const next: MessagePart = isError ? { ...part, state: "error", errorText: redactSecrets(resultText(result)) } : { ...part, state: "done" };
  return { ...reply, parts: reply.parts.map((p, i) => (i === index ? next : p)) };
}

/** Folds one pi session event into the assistant reply, returning the same object when nothing changes. */
export function applyPiEvent(reply: ChatMessage, event: AgentSessionEvent): ChatMessage {
  // Calls a tool made through `ctx.executeTool()` are the tool's internals, not the user's conversation.
  if ("parentToolCallId" in event && event.parentToolCallId != null) return reply;

  switch (event.type) {
    case "message_update": {
      const delta = streamDelta(event);
      return delta ? appendDelta(reply, delta) : reply;
    }
    case "message_end":
      return event.message.role === "assistant" ? appendAssistant(reply, event.message) : reply;
    case "tool_execution_end":
      return finishTool(reply, event.toolCallId, event.result, event.isError);
    default:
      return reply;
  }
}

export type ReplyFeed = {
  /** Queues an update for the next flush, which a timer makes at most once per interval. */
  push(update: (reply: ChatMessage) => ChatMessage): void;
  /** Sends the queued updates and this one together, now. */
  emitNow(update: (reply: ChatMessage) => ChatMessage): void;
  /** Sends whatever is queued, now. */
  flush(): void;
  /** Flushes and stops the timer for good: later updates are sent at once. */
  close(): void;
};

export type ReplyFeedOptions = {
  /** Shortest time between two emits of queued updates. Default 33 ms (about 30 a second). */
  intervalMs?: number;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

/**
 * Streaming deltas arrive far faster than a screen should be redrawn: they are queued and sent to the host as one
 * reply update per interval. Anything else (a finished message, a tool result) goes out at once behind the queue, so
 * order is kept, and the turn closes the feed so no timer outlives it.
 */
export function createReplyFeed(emit: (event: EngineEvent) => void, options: ReplyFeedOptions = {}): ReplyFeed {
  const { intervalMs = 33, now = Date.now, setTimer = (run, ms) => setTimeout(run, ms), clearTimer = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) } = options;
  let queued: Array<(reply: ChatMessage) => ChatMessage> = [];
  let timer: unknown = null;
  let lastEmit = Number.NEGATIVE_INFINITY;
  let closed = false;

  const flush = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (queued.length === 0) return;

    const updates = queued;
    queued = [];
    lastEmit = now();
    emit({ type: "reply", update: (reply) => updates.reduce((current, update) => update(current), reply) });
  };

  const emitNow = (update: (reply: ChatMessage) => ChatMessage) => {
    queued.push(update);
    flush();
  };

  return {
    push(update) {
      if (closed) return emitNow(update);
      queued.push(update);
      if (timer === null) timer = setTimer(flush, Math.max(0, lastEmit + intervalMs - now()));
    },
    emitNow,
    flush,
    close() {
      closed = true;
      flush();
    },
  };
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
