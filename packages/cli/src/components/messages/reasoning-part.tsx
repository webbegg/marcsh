import prettyMs from "pretty-ms";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "../../providers/theme";
import { transcriptViewKey, useTranscriptView } from "../../providers/transcript-view";
import type { MessagePart } from "../../lib/chat-types";
import { escapeTranscriptText as safe } from "../../lib/display-text";
import { EmptyBorder } from "../border";
import { GUTTER, ICON_WIDTH } from "./tool-part";
import "../spinner";

type ReasoningPartData = Extract<MessagePart, { type: "reasoning" }>;

/** Columns the line does not own: the gutter and glyph cell on the left, the gutter on the right. */
const CHROME_COLUMNS = GUTTER + ICON_WIDTH + GUTTER;

/** The glyph of a thought, in the same cell as a tool call's. */
const THOUGHT_ICON = "◇";

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

/**
 * The title a model put at the head of a thought (`**Planning the change**` on a line of its own, as OpenAI's and Gemini's models
 * do), and the rest of the thought; no title when the thought does not start with one.
 */
export function thoughtTitle(text: string): { title?: string; rest: string } {
  const match = /^\s*\*\*([^*\n]+)\*\*[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { rest: text };
  return { title: match[1]!.trim(), rest: text.slice(match[0].length).replace(/^\s*\n/, "") };
}

/** The label of a collapsed block: `Thinking · 2.3s`, or `Thought: <title> · 2.3s` (the duration is only known when the engine reported it). */
export const thinkingLabel = (durationMs?: number, title?: string): string => {
  const name = title ? `Thought: ${title}` : "Thinking";
  return durationMs != null && durationMs >= 0 ? `${name} · ${prettyMs(durationMs)}` : name;
};

/**
 * The model's reasoning, a row at the gutter like a tool call's. An empty block shows nothing. Collapsed (the default) it is one
 * line that never grows: the label with the title and duration, the first words of the thought when they fit, and the key that
 * expands it; a spinner takes the glyph's place while the thought is still being written. Expanded, the whole thought follows,
 * dim, behind a thin rule.
 */
export function ReasoningPart({ part, live = false }: { part: ReasoningPartData; /** Still being written. */ live?: boolean }) {
  const { colors } = useTheme();
  const { thinking } = useTranscriptView();
  const { width } = useTerminalDimensions();
  if (part.text.trim() === "") return null;

  const { title, rest } = thoughtTitle(part.text);
  const key = transcriptViewKey("thinking");
  const label = thinkingLabel(part.durationMs, title ? safe(title) : undefined);
  // On a line too narrow for the label and the key, the key goes: the line must stay one line.
  const room = width - CHROME_COLUMNS - Bun.stringWidth(label);
  const keyHint = key ? ` (${key})` : "";
  const hint = Bun.stringWidth(keyHint) <= room ? keyHint : "";
  // " · " before the words, and the hint after them. A titled thought shows its title instead.
  const words = thinking || title ? "" : firstWords(part.text, room - 3 - Bun.stringWidth(hint));
  const body = title ? rest : part.text;

  return (
    <box paddingLeft={GUTTER} paddingRight={GUTTER} width="100%">
      <box flexDirection="row" width="100%">
        <box width={ICON_WIDTH} flexShrink={0}>
          {live ? <spinner variant="dots" color={colors.thinking} /> : <text fg={colors.thinking}>{THOUGHT_ICON}</text>}
        </box>
        <text attributes={TextAttributes.DIM} flexGrow={1} flexShrink={1}>
          <em fg={colors.thinking}>{label}</em>
          {words ? ` · ${words}` : ""}
          {thinking ? "" : hint}
        </text>
      </box>
      {thinking && body.trim() !== "" && (
        <box
          border={["left"]}
          borderColor={colors.thinkingBorder}
          customBorderChars={{ ...EmptyBorder, vertical: "│" }}
          // The rule sits under the glyph, so the thought's lines start where the label does.
          paddingLeft={ICON_WIDTH - 1}
          width="100%"
        >
          <text attributes={TextAttributes.DIM}>{safe(body)}</text>
        </box>
      )}
    </box>
  );
}
