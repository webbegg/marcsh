import prettyMs from "pretty-ms";
import { useTheme } from "../../providers/theme";
import { useSyntaxStyle } from "../../hooks/use-syntax-style";
import type { MessagePart } from "../../lib/chat-types";
import { Mode, type ModeType } from "../../lib/modes";
import { escapeTranscriptText as safe } from "../../lib/display-text";
import { TextAttributes } from "@opentui/core";
import { ReasoningPart } from "./reasoning-part";
import { TaskPart, ToolPart } from "./tool-part";
import { TextPart } from "./text-part";

export { formatTaskLine, summarizeToolInput } from "./tool-part";

type ToolPartData = Extract<MessagePart, { type: "tool" }>;

type Props = {
  parts: MessagePart[];
  model: string;
  mode: ModeType;
  /** The name of the agent that answered; without it, the mode's name. */
  agentName?: string;
  durationMs?: number;
  /** The turn was cancelled with Esc: the footer says so. */
  interrupted?: boolean;
  streaming?: boolean;
};

function isToolPart(part: MessagePart): part is ToolPartData {
  return part.type === "tool";
};

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
  agentName,
  durationMs,
  interrupted = false,
  streaming = false,
}: Props) {
  const { colors } = useTheme();
  // One style for every text part of the message.
  const syntaxStyle = useSyntaxStyle();
  // Only the last part of a message still being written can be unfinished.
  const lastPart = parts[parts.length - 1];
  return (
    <box width="100%" alignItems="center">
      {groupConsecutiveParts(parts).map((group, i) => (
        <box key={group.key} width="100%" paddingTop={i === 0 ? 0 : 1}>
          {group.parts.map((part, j) => {
            if (part.type === "reasoning") return <ReasoningPart key={`reasoning-${j}`} part={part} />;
            if (isToolPart(part)) return <ToolPart key={part.toolCallId} part={part} />;
            if (part.type === "task") return <TaskPart key={`task-${part.taskId}`} part={part} />;
            if (part.type === "text") return <TextPart key={`text-${j}`} part={part} syntaxStyle={syntaxStyle} streaming={streaming && part === lastPart} />;
            return null;
          })}
        </box>
      ))}

      <box paddingX={3} paddingY={1} gap={1} width="100%">
        <box flexDirection="row" gap={2}>
          <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>◉</text>
          <box flexDirection="row" gap={1}>
            <text>
              {agentName ?? (mode === Mode.PLAN ? "Plan" : "Build")}
            </text>
            <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
              ›
            </text>
            <text attributes={TextAttributes.DIM}>{safe(model)}</text>
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
            {interrupted && (
              <>
                <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
                  ›
                </text>
                <text attributes={TextAttributes.DIM}>interrupted</text>
              </>
            )}
          </box>
        </box>
      </box>
    </box>
  );
};
