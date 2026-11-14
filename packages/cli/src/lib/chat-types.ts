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
  /** What the engine's session had cost in all when this reply ended; the next resumed turn subtracts it, since Claude's running total carries over. */
  cumulativeCostUsd?: number;
  costUsd?: number;
};

/**
 * The project's files before and after the turn this reply ended, as snapshot tree hashes (see `snapshot.ts`).
 * `undone` is set while `/undo` has put the turn's files back, and `abandoned` once a later turn made that undo permanent (no `/redo`).
 */
export type TurnSnapshot = {
  before: string;
  after: string;
  undone?: boolean;
  abandoned?: boolean;
};

/** A file the user attached to a message: only where it is and what it is, never its bytes (the engine got those when the message was sent). */
export type MessageAttachment = {
  path: string;
  mime: string;
  kind: "image" | "pdf" | "file";
};

export type ChatMessageMetadata = {
  mode?: ModeType;
  /** The name of the agent that answered (stored under the key `agent`); older messages have none and show their mode. */
  agent?: string;
  model?: string;
  durationMs?: number;
  costUsd?: number;
  usage?: ChatUsage;
  /** The files attached to a user message. */
  attachments?: MessageAttachment[];
  /** A user message typed during a turn and delivered to it (shown with a marker). */
  steered?: boolean;
  /** Set on the last reply of a turn when the project's files could be snapshotted around it. */
  snapshot?: TurnSnapshot;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  metadata?: ChatMessageMetadata;
};
