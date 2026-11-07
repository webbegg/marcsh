import type { ModeType } from "./modes";

export type ToolState = "running" | "done" | "error";

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
    };

export type ChatMessageMetadata = {
  mode?: ModeType;
  model?: string;
  durationMs?: number;
  costUsd?: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  metadata?: ChatMessageMetadata;
};
