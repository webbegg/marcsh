import { TextAttributes } from "@opentui/core";
import { useMemo } from "react";
import { useTheme } from "../../providers/theme";
import { transcriptViewKey, useTranscriptView } from "../../providers/transcript-view";
import { deriveDiffColors, type DiffColors } from "../../lib/theme-derived";
import type { ThemeColors } from "../../theme";
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

/** Lines of output a collapsed call shows: the last ones. */
export const OUTPUT_PREVIEW_LINES = 4;
/** Lines of a diff a collapsed edit shows: the first ones. */
export const DIFF_PREVIEW_LINES = 12;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** The lines of a text, without the line breaks that end it. */
const linesOf = (text: string): string[] => text.replace(/(?:\r?\n)+$/, "").split("\n");

export const isUnifiedPatch = (patch: string): boolean => linesOf(patch).some((line) => HUNK_HEADER.test(line));

/**
 * The first `max` lines of a unified patch, as a patch that still parses: when the cut falls inside a hunk, that hunk's header
 * counts are made to match the lines kept, and a hunk header left with no line under it is dropped. `hidden` is how many lines
 * were left out.
 */
export function cutPatch(patch: string, max: number): { patch: string; hidden: number } {
  const lines = linesOf(patch);
  if (lines.length <= max) return { patch: lines.join("\n"), hidden: 0 };
  const kept = lines.slice(0, max);
  while (kept.length > 0 && HUNK_HEADER.test(kept[kept.length - 1]!)) kept.pop();
  const header = kept.findLastIndex((line) => HUNK_HEADER.test(line));
  if (header >= 0) {
    let oldCount = 0;
    let newCount = 0;
    for (const line of kept.slice(header + 1)) {
      if (line.startsWith("+")) newCount++;
      else if (line.startsWith("-")) oldCount++;
      else if (!line.startsWith("\\")) {
        oldCount++;
        newCount++;
      }
    }
    const [, oldStart, newStart, rest] = HUNK_HEADER.exec(kept[header]!)!;
    kept[header] = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${rest}`;
  }
  return { patch: kept.join("\n"), hidden: lines.length - kept.length };
}

/** The line above a call's output when some of it is not shown: the count (a lower bound when the stored output was itself cut). */
function hiddenMarker(hidden: number, cut: boolean, hint: string): string | undefined {
  if (hidden > 0) return `… ${hidden}${cut ? "+" : ""} more lines${hint}`;
  return cut ? "… earlier lines not kept" : undefined;
}

/** The keys that turn details on, as the user's keybinds say, for the end of a marker. */
const detailsHint = () => {
  const key = transcriptViewKey("details");
  return key ? ` (${key})` : " (/details)";
};

/** What an edit or write did, as a diff in the theme's colours; only its first lines until details are on. */
function PatchView({ patch, details, colors }: { patch: string; details: boolean; colors: ThemeColors }) {
  // A theme colour that is not #RRGGBB leaves the diff to OpenTUI's own colours.
  const diffColors = useMemo<DiffColors | undefined>(() => {
    try {
      return deriveDiffColors(colors);
    } catch {
      return undefined;
    }
  }, [colors]);

  if (!isUnifiedPatch(patch)) {
    // An older or foreign format: the lines as they are, coloured by their sign.
    const lines = linesOf(patch);
    const shown = details ? lines : lines.slice(0, DIFF_PREVIEW_LINES);
    return (
      <box paddingLeft={2}>
        {shown.map((line, i) => (
          <text key={i} fg={line.startsWith("+") ? colors.success : line.startsWith("-") ? colors.error : undefined}>
            {safe(line)}
          </text>
        ))}
        {shown.length < lines.length && <text attributes={TextAttributes.DIM}>{`… ${lines.length - shown.length} more lines${detailsHint()}`}</text>}
      </box>
    );
  }

  const { patch: shown, hidden } = details ? { patch, hidden: 0 } : cutPatch(patch, DIFF_PREVIEW_LINES);
  return (
    <box paddingLeft={2}>
      <diff
        diff={safe(shown)}
        view="unified"
        showLineNumbers
        wrapMode="char"
        {...(diffColors && {
          addedBg: diffColors.addedBg,
          removedBg: diffColors.removedBg,
          contextBg: diffColors.contextBg,
          addedSignColor: diffColors.addedSign,
          removedSignColor: diffColors.removedSign,
          lineNumberFg: diffColors.lineNumber,
          addedLineNumberBg: diffColors.addedBg,
          removedLineNumberBg: diffColors.removedBg,
        })}
      />
      {hidden > 0 && <text attributes={TextAttributes.DIM}>{`… ${hidden} more lines${detailsHint()}`}</text>}
    </box>
  );
}

/** The tail of a call's output, dim and indented under the call: the last lines, or all of what is stored when details are on. */
function OutputView({ output, truncated, details }: { output: string; truncated: boolean; details: boolean }) {
  const lines = linesOf(output);
  const shown = details ? lines : lines.slice(-OUTPUT_PREVIEW_LINES);
  const marker = hiddenMarker(lines.length - shown.length, truncated, lines.length > shown.length ? detailsHint() : "");
  return (
    <box paddingLeft={2}>
      {marker && <text attributes={TextAttributes.DIM}>{marker}</text>}
      <text attributes={TextAttributes.DIM}>{safe(shown.join("\n"))}</text>
    </box>
  );
}

/**
 * A tool call: its name, a one-line summary of its input, and its state. A finished edit or write shows what it changed as a
 * diff, and another finished call that kept output shows the end of it; both are cut short unless the transcript's details are on.
 * An error shows in full on the call's line.
 */
export function ToolPart({ part }: { part: ToolPartData }) {
  const { colors } = useTheme();
  const { details } = useTranscriptView();
  const finished = part.state === "done";
  const patch = finished && part.patch ? part.patch : undefined;
  const output = finished && patch === undefined && part.output ? part.output : undefined;
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
      {patch !== undefined && <PatchView patch={patch} details={details} colors={colors} />}
      {output !== undefined && <OutputView output={output} truncated={part.outputTruncated === true} details={details} />}
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
