import { TextAttributes } from "@opentui/core";
import { useTheme } from "../../providers/theme";
import type { MessagePart } from "../../lib/chat-types";
import { escapeTranscriptText as safe } from "../../lib/display-text";
import { EmptyBorder } from "../border";

type ReasoningPartData = Extract<MessagePart, { type: "reasoning" }>;

/** The model's reasoning, dimmed behind a left rule. */
export function ReasoningPart({ part }: { part: ReasoningPartData }) {
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
        <em fg={colors.thinking}>Thinking:</em> {safe(part.text)}
      </text>
    </box>
  );
}
