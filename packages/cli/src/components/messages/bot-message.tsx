import prettyMs from "pretty-ms";
import { EmptyBorder } from "../border";
import { useTheme } from "../../providers/theme";
import type { MessagePart } from "../../lib/chat-types";
import { Mode, type ModeType } from "../../lib/modes";
import { TextAttributes } from "@opentui/core";

type ToolPart = Extract<MessagePart, { type: "tool" }>;
type TaskPart = Extract<MessagePart, { type: "task" }>;

const MAX_SUMMARY_LENGTH = 80;
const PREFERRED_INPUT_KEYS = ["command", "file_path", "path", "pattern", "url", "description"];

type Props = {
  parts: MessagePart[];
  model: string;
  mode: ModeType;
  /** The name of the agent that answered; without it, the mode's name. */
  agent?: string;
  durationMs?: number;
  streaming?: boolean;
};

function formatToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
};

function isToolPart(part: MessagePart): part is ToolPart {
  return part.type === "tool";
};

export function summarizeToolInput(input: Record<string, unknown>): string {
  const values = Object.values(input);
  const preferred = PREFERRED_INPUT_KEYS.map((key) => input[key]).find((v) => typeof v === "string");
  const summary = preferred ?? values.find((v) => typeof v === "string") ?? "";

  return typeof summary === "string" && summary.length > MAX_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : String(summary);
}

/** The task's one-line status: description, status, last tool and usage when known. */
export function formatTaskLine(part: TaskPart): string {
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
function taskOutcome(part: TaskPart): string | undefined {
  return part.status === "running" ? undefined : part.summary || part.error;
}

type PartGroup = {
  type: MessagePart["type"];
  parts: MessagePart[];
  key: string;
};

function groupConsecutiveParts(parts: MessagePart[]): PartGroup[] {
  const groups: PartGroup[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const lastGroup = groups[groups.length - 1];

     if (lastGroup && lastGroup.type === part.type) {
      lastGroup.parts.push(part);
     } else {
      const key = 
        isToolPart(part) ? `group-tc-${part.toolCallId}` : `group-${part.type}-${i}`;
      groups.push({ type: part.type, parts: [part], key });
     }
  }

  return groups;
};

export function BotMessage({ 
  parts,
  model,
  mode,
  agent,
  durationMs,
  streaming = false,
}: Props) {
  const { colors } = useTheme();
  return (
    <box width="100%" alignItems="center">
      {groupConsecutiveParts(parts).map((group, i) => (
        <box key={group.key} width="100%" paddingTop={i === 0 ? 0 : 1}>
          {group.parts.map((part, j) => {
            if (part.type === "reasoning") {
              return (
                <box
                  key={`reasoning-${j}`}
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
                    <em fg={colors.thinking}>Thinking:</em> {part.text}
                  </text>
                </box>
              );
            }

            if (isToolPart(part)) {
              return (
                <box
                  key={part.toolCallId}
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
                    <em fg={colors.info}>{formatToolName(part.toolName)}:</em> {summarizeToolInput(part.input)}
                    {part.state === "running" ? " …" : ""}
                    {part.state === "error" ? ` ${part.errorText}` : ""}
                  </text>
                </box>
              );
            }

            if (part.type === "task") {
              const outcome = taskOutcome(part);
              return (
                <box
                  key={`task-${part.taskId}`}
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
                    <em fg={colors.info}>Task:</em> {formatTaskLine(part)}
                  </text>
                  {outcome && <text attributes={TextAttributes.DIM}>{outcome}</text>}
                </box>
              );
            }

            if (part.type === "text") {
              return (
                <box key={`text-${j}`} paddingX={3} width="100%">
                  <text>{part.text}</text>
                </box>
              );
            }
            
            return null;
          })}
        </box>
      ))}

      <box paddingX={3} paddingY={1} gap={1} width="100%">
        <box flexDirection="row" gap={2}>
          <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>◉</text>
          <box flexDirection="row" gap={1}>
            <text>
              {agent ?? (mode === Mode.PLAN ? "Plan" : "Build")}
            </text>
            <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
              ›
            </text>
            <text attributes={TextAttributes.DIM}>{model}</text>
            {(durationMs != null) && (
              <>
                <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
                  ›
                </text>
                <text attributes={TextAttributes.DIM}>
                  {prettyMs(durationMs)}
                </text>
              </>
            )}
          </box>
        </box>
      </box>
    </box>
  );
};
