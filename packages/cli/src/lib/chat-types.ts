import type { ModeType } from "./modes";

export type ToolState = "running" | "done" | "error";

export type TaskStatus = "running" | "completed" | "failed" | "stopped";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      state: ToolState;
      errorText?: string;
    }
  | {
      type: "task";
      taskId: string;
      description: string;
      status: TaskStatus;
      lastToolName?: string;
      toolUses?: number;
      totalTokens?: number;
      summary?: string;
      error?: string;
    };

/**
 * What the engine reported for one reply; every field is optional because an engine reports only some of them, and a
 * value it did not report is left out, never guessed. Messages saved before this existed have none.
 */
export type ChatUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Tokens the conversation took up in the last request of the reply: input + cache read + cache write (output is not counted). */
  contextTokens?: number;
  /** The model's context window in tokens. */
  contextWindow?: number;
  costUsd?: number;
};

export type ChatMessageMetadata = {
  mode?: ModeType;
  /** The name of the agent that answered (stored under the key `agent`); older messages have none and show their mode. */
  agent?: string;
  model?: string;
  durationMs?: number;
  costUsd?: number;
  usage?: ChatUsage;
  /** A user message typed during a turn and delivered to it (shown with a marker). */
  steered?: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  metadata?: ChatMessageMetadata;
};
