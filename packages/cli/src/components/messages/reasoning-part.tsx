import prettyMs from "pretty-ms";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "../../providers/theme";
import { transcriptViewKey, useTranscriptView } from "../../providers/transcript-view";
import type { MessagePart } from "../../lib/chat-types";
import { escapeTranscriptText as safe } from "../../lib/display-text";
import { EmptyBorder } from "../border";

type ReasoningPartData = Extract<MessagePart, { type: "reasoning" }>;

/** Columns the line does not own: the message's rule and padding on both sides. */
const CHROME_COLUMNS = 8;

/**
 * The first words of the thought's first line that fit in `room` columns, ending in `…` when there are more (on that line or after
 * it); "" when not even one fits. The text is escaped first, so a control character takes its visible width.
 */
export function firstWords(text: string, room: number): string {
  const [first = "", ...rest] = safe(text).trim().split("\n");
  const words = first.split(/\s+/).filter(Boolean);
  const more = rest.some((line) => line.trim() !== "");
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i]!;
    // Leave a column for the ellipsis unless this is the last word of the whole text.
    if (Bun.stringWidth(next) + (i < words.length - 1 || more ? 1 : 0) > room) return line ? `${line}…` : "";
    line = next;
  }
  return more ? `${line}…` : line;
}

/** The label of a collapsed block: `Thinking · 2.3s` (the duration is only known when the engine reported it). */
export const thinkingLabel = (durationMs?: number): string =>
  durationMs != null && durationMs >= 0 ? `Thinking · ${prettyMs(durationMs)}` : "Thinking";

/**
 * The model's reasoning, dimmed behind a left rule. An empty block shows nothing. Collapsed (the default) it is one line: the
 * label with the duration, the first words of the thought when they fit, and the key that expands it. Expanded it is the whole text.
 */
export function ReasoningPart({ part }: { part: ReasoningPartData }) {
  const { colors } = useTheme();
  const { thinking } = useTranscriptView();
  const { width } = useTerminalDimensions();
  if (part.text.trim() === "") return null;

  const key = transcriptViewKey("thinking");
  const label = thinkingLabel(part.durationMs);
  // On a line too narrow for the label and the key, the key goes: the line must stay one line.
  const room = width - CHROME_COLUMNS - Bun.stringWidth(label);
  const keyHint = key ? ` (${key})` : "";
  const hint = Bun.stringWidth(keyHint) <= room ? keyHint : "";
  // " · " before the words, and the hint after them.
  const words = thinking ? "" : firstWords(part.text, room - 3 - Bun.stringWidth(hint));

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
        {thinking ? (
          <>
            <em fg={colors.thinking}>Thinking:</em> {safe(part.text)}
          </>
        ) : (
          <>
            <em fg={colors.thinking}>{label}</em>
            {words ? ` · ${words}` : ""}
            {hint}
          </>
        )}
      </text>
    </box>
  );
}
