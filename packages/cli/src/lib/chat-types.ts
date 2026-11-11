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

export type ChatMessageMetadata = {
  mode?: ModeType;
  model?: string;
  durationMs?: number;
  costUsd?: number;
  /** A user message typed during a turn and delivered to it (shown with a marker). */
  steered?: boolean;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  metadata?: ChatMessageMetadata;
};
