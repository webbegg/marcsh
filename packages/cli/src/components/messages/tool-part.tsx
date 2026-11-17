import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../providers/theme";
import type { MessagePart } from "../../lib/chat-types";
import { escapeTranscriptText as safe } from "../../lib/display-text";
import { EmptyBorder } from "../border";

type ToolPartData = Extract<MessagePart, { type: "tool" }>;
type TaskPartData = Extract<MessagePart, { type: "task" }>;

const MAX_SUMMARY_LENGTH = 80;
const PREFERRED_INPUT_KEYS = ["command", "file_path", "path", "pattern", "url", "description"];

export function formatToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

export function summarizeToolInput(input: Record<string, unknown>): string {
  const values = Object.values(input);
  const preferred = PREFERRED_INPUT_KEYS.map((key) => input[key]).find((v) => typeof v === "string");
  const summary = preferred ?? values.find((v) => typeof v === "string") ?? "";

  return typeof summary === "string" && summary.length > MAX_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : String(summary);
}

/** The task's one-line status: description, status, last tool and usage when known. */
export function formatTaskLine(part: TaskPartData): string {
  const fields = [
    part.description,
    part.status,
    part.lastToolName,
    part.toolUses != null ? `${part.toolUses} ${part.toolUses === 1 ? "tool" : "tools"}` : undefined,
    part.totalTokens != null ? `${part.totalTokens} tok` : undefined,
  ];
  return fields.filter((field) => field).join(" · ");
}

/** What a finished task reports below its line: the summary, or the error of a task that failed without one. */
function taskOutcome(part: TaskPartData): string | undefined {
  return part.status === "running" ? undefined : part.summary || part.error;
}

/** A tool call: its name, a one-line summary of its input, and its state. */
export function ToolPart({ part }: { part: ToolPartData }) {
  const { colors } = useTheme();
  return (
    <box
      border={["left"]}
      borderColor={colors.thinkingBorder}
      customBorderChars={{
        ...EmptyBorder,
        vertical: "│",
      }}
      width="100%"
      paddingX={2}
    >
      <text attributes={TextAttributes.DIM}>
        <em fg={colors.info}>{safe(formatToolName(part.toolName))}:</em> {safe(summarizeToolInput(part.input))}
        {part.state === "running" ? " …" : ""}
        {part.state === "error" ? ` ${safe(String(part.errorText))}` : ""}
      </text>
    </box>
  );
}

/** A sub-agent task: its status line, and what it reported once it finished. */
export function TaskPart({ part }: { part: TaskPartData }) {
  const { colors } = useTheme();
  const outcome = taskOutcome(part);
  return (
    <box
      border={["left"]}
      borderColor={colors.thinkingBorder}
      customBorderChars={{
        ...EmptyBorder,
        vertical: "│",
      }}
      width="100%"
      paddingX={2}
    >
      <text attributes={TextAttributes.DIM}>
        <em fg={colors.info}>Task:</em> {safe(formatTaskLine(part))}
      </text>
      {outcome && <text attributes={TextAttributes.DIM}>{safe(outcome)}</text>}
    </box>
  );
}
