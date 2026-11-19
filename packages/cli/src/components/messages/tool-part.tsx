import { TextAttributes, type SyntaxStyle } from "@opentui/core";
import { useMemo, type ReactNode } from "react";
import { useTheme } from "../../providers/theme";
import { transcriptViewKey, useTranscriptView } from "../../providers/transcript-view";
import { deriveDiffColors, type DiffColors } from "../../lib/theme-derived";
import type { ThemeColors } from "../../theme";
import type { MessagePart } from "../../lib/chat-types";
import { escapeTranscriptText as safe } from "../../lib/display-text";
import { TODO_GLYPH } from "../../lib/todo";
import {
  patchStats,
  refusalOf,
  TOOL_ICON,
  todoItems,
  toolKind,
  toolStyle,
  toolTitle,
  type TodoItem,
  type ToolKind,
  type ToolTitle,
} from "../../lib/tool-display";
import { EmptyBorder } from "../border";
import "../spinner";

export { formatToolName, summarizeToolInput } from "../../lib/tool-display";

type ToolPartData = Extract<MessagePart, { type: "tool" }>;
type TaskPartData = Extract<MessagePart, { type: "task" }>;

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
/** Lines of a command's output a collapsed shell block shows: the last ones. */
export const SHELL_PREVIEW_LINES = 10;
/** Lines of a diff a collapsed edit shows: the first ones. */
export const DIFF_PREVIEW_LINES = 12;

/** Columns of the transcript's gutter: assistant text, rows and their bodies all start after it. */
export const GUTTER = 3;
/** Columns of a row's glyph cell: the title starts after it, and so does what a row shows under its title. */
export const ICON_WIDTH = 2;

/** Inline calls whose output is only a lookup's (a file read, search hits): it shows with details on, never in a preview. */
const QUIET_OUTPUT = new Set<ToolKind>(["read", "grep", "glob", "list", "webfetch", "websearch", "skill"]);

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

/** The state a call's title shows: its glyph, and the colour of its words. */
type RowState = "running" | "done" | "error" | "denied";

function rowState(part: ToolPartData): RowState {
  if (part.state === "running") return "running";
  if (part.state === "error") return refusalOf(part.errorText) ? "denied" : "error";
  return "done";
}

/**
 * The title line of a call: a one-column glyph (a spinner while it runs, `✗` when it failed, `⊘` when the user refused it) in a
 * two-column cell, then the verb, what it acts on, a short result and a badge. A long title wraps under its own start, not under
 * the glyph. A refused call is struck through.
 */
function TitleRow({ icon, state, refusal = "denied", title, colors, strong = false, extra }: {
  icon: string;
  state: RowState;
  /** The word after a refused call's title. */
  refusal?: string;
  title: ToolTitle;
  colors: ThemeColors;
  /** The subject in the normal colour (a command, a block's title), not dim. */
  strong?: boolean;
  /** Drawn after the title, inside the same line (an edit's `+3 −1`). */
  extra?: ReactNode;
}) {
  const glyph = state === "error" ? "✗" : state === "denied" ? "⊘" : icon;
  const glyphColor = state === "error" ? colors.error : state === "denied" ? colors.dimSeparator : colors.info;
  const words = [title.verb, title.subject].filter((word) => word !== "").map(safe).join(" ");
  return (
    <box flexDirection="row" width="100%">
      <box width={ICON_WIDTH} flexShrink={0}>
        {state === "running" ? <spinner variant="dots" color={colors.thinking} /> : <text fg={glyphColor}>{glyph}</text>}
      </box>
      <text
        flexGrow={1}
        flexShrink={1}
        fg={state === "error" ? colors.error : undefined}
        attributes={(strong && state !== "denied" ? 0 : TextAttributes.DIM) | (state === "denied" ? TextAttributes.STRIKETHROUGH : 0)}
      >
        {words}
        {title.suffix ? <span fg={colors.dimSeparator}>{` · ${safe(title.suffix)}`}</span> : null}
        {title.badge ? <span fg={colors.planMode}>{` [${safe(title.badge)}]`}</span> : null}
        {state === "denied" ? <span fg={colors.dimSeparator}>{` · ${refusal}`}</span> : null}
        {extra}
      </text>
    </box>
  );
}

/** What a row shows under its title, aligned with the title's words. */
function Body({ children }: { children: ReactNode }) {
  return <box paddingLeft={ICON_WIDTH}>{children}</box>;
}

/** A failed call's error, whole and in the error colour. */
function ErrorText({ text, colors }: { text: string | undefined; colors: ThemeColors }) {
  return text ? <text fg={colors.error}>{safe(text)}</text> : null;
}

/** What an edit or write did, as a diff in the theme's colours; only its first lines until details are on. */
function PatchView({ patch, details, colors, base }: { patch: string; details: boolean; colors: ThemeColors; base: string }) {
  // A theme colour that is not #RRGGBB leaves the diff to OpenTUI's own colours.
  const diffColors = useMemo<DiffColors | undefined>(() => {
    try {
      return deriveDiffColors(colors, base);
    } catch {
      return undefined;
    }
  }, [colors, base]);

  if (!isUnifiedPatch(patch)) {
    // An older or foreign format: the lines as they are, coloured by their sign.
    const lines = linesOf(patch);
    const shown = details ? lines : lines.slice(0, DIFF_PREVIEW_LINES);
    return (
      <box>
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
    <box>
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

/** The tail of a call's output, dim: the last `preview` lines, or all of what is stored when details are on. */
function OutputView({ output, truncated, details, preview = OUTPUT_PREVIEW_LINES }: {
  output: string;
  truncated: boolean;
  details: boolean;
  preview?: number;
}) {
  const lines = linesOf(output);
  const shown = details ? lines : lines.slice(-preview);
  const marker = hiddenMarker(lines.length - shown.length, truncated, lines.length > shown.length ? detailsHint() : "");
  return (
    <box>
      {marker && <text attributes={TextAttributes.DIM}>{marker}</text>}
      <text attributes={TextAttributes.DIM}>{safe(shown.join("\n"))}</text>
    </box>
  );
}

/** A panel on the raised surface, behind a dark notch: the frame of a shell command, an edit, a subagent, a todo list, a plan. */
function Block({ children, colors }: { children: ReactNode; colors: ThemeColors }) {
  return (
    <box
      border={["left"]}
      borderColor={colors.background}
      customBorderChars={{ ...EmptyBorder, vertical: "┃" }}
      backgroundColor={colors.surface}
      width="100%"
      paddingX={2}
      paddingY={1}
    >
      {children}
    </box>
  );
}

/** One muted line at the gutter, with whatever the call shows under it. */
function Inline({ children }: { children: ReactNode }) {
  return (
    <box paddingLeft={GUTTER} paddingRight={GUTTER} width="100%">
      {children}
    </box>
  );
}

const TODO_COLOR = (colors: ThemeColors): Record<TodoItem["status"], string> => ({
  done: colors.success,
  in_progress: colors.primary,
  pending: colors.dimSeparator,
  blocked: colors.error,
  dropped: colors.dimSeparator,
});

/** A todo list as a checklist: the item being worked on stands out, finished and dropped ones step back. */
function TodoList({ items, colors }: { items: TodoItem[]; colors: ThemeColors }) {
  if (items.length === 0) return <text attributes={TextAttributes.DIM}>No todos</text>;
  const color = TODO_COLOR(colors);
  return (
    <box>
      {items.map((item, i) => (
        <box key={i} flexDirection="row" width="100%">
          <box width={ICON_WIDTH} flexShrink={0}>
            <text fg={color[item.status]}>{TODO_GLYPH[item.status]}</text>
          </box>
          <text
            flexGrow={1}
            flexShrink={1}
            attributes={
              item.status === "dropped" ? TextAttributes.DIM | TextAttributes.STRIKETHROUGH : item.status === "done" ? TextAttributes.DIM : 0
            }
          >
            {safe(item.text)}
          </text>
        </box>
      ))}
    </box>
  );
}

type ToolPartProps = {
  part: ToolPartData;
  /** The session's folder: paths under it are shown relative. */
  cwd?: string;
  /** For a plan, drawn as markdown; without one the plan is plain text. */
  syntaxStyle?: SyntaxStyle;
};

/**
 * A tool call, drawn for what it is. A lookup (read, search, list, fetch, skill, question, any tool marcsh does not know) is one
 * muted row at the gutter: `→ Read src/a.ts:10-59`, `✱ Grep "foo" in src · 3 files`; what it read shows only with details on,
 * except for an unknown tool's output and a question's answers, whose last lines show. A shell command, an edit or write, a
 * subagent, a todo list and a plan are panels: the command with the end of its output, the diff, the subagent's report, the
 * checklist, the plan. Previews are cut short unless the transcript's details are on; a failure shows its whole error.
 */
export function ToolPart({ part, cwd, syntaxStyle }: ToolPartProps) {
  const { colors } = useTheme();
  const { details } = useTranscriptView();
  const kind = toolKind(part.toolName);
  const state = rowState(part);
  const title = toolTitle(part, cwd);
  const icon = TOOL_ICON[kind];
  const refusal = refusalOf(part.state === "error" ? part.errorText : undefined);
  const finished = part.state === "done";
  const error = state === "error" ? <ErrorText text={part.errorText} colors={colors} /> : null;

  if (kind === "todo") {
    const items = todoItems(part);
    if (items) {
      const done = items.filter((item) => item.status === "done").length;
      return (
        <Block colors={colors}>
          <TitleRow icon={icon} state={state} refusal={refusal} title={{ ...title, ...(items.length > 0 ? { suffix: `${done}/${items.length} done` } : {}) }} colors={colors} strong />
          <Body>
            <TodoList items={items} colors={colors} />
            {error}
          </Body>
        </Block>
      );
    }
  }

  if (kind === "plan" && typeof part.input.plan === "string") {
    return (
      <Block colors={colors}>
        <TitleRow icon={icon} state={state} refusal={refusal} title={title} colors={colors} strong />
        <Body>
          {syntaxStyle ? <markdown content={safe(part.input.plan)} syntaxStyle={syntaxStyle} /> : <text>{safe(part.input.plan)}</text>}
          {error}
        </Body>
      </Block>
    );
  }

  if (toolStyle(kind) === "block" && kind !== "todo" && kind !== "plan") {
    const patch = finished && part.patch ? part.patch : undefined;
    const output = finished && patch === undefined && part.output ? part.output : undefined;
    const stats = patch !== undefined ? patchStats(patch) : undefined;
    const description = kind === "bash" && typeof part.input.description === "string" && part.input.description.trim() !== "" ? part.input.description : undefined;
    // A shell block's title is the command itself, after its `$`; the description, when the model gave one, heads it.
    const row = kind === "bash" ? { ...title, verb: "" } : title;
    return (
      <Block colors={colors}>
        {description && (
          <Body>
            <text attributes={TextAttributes.DIM}>{`# ${safe(description)}`}</text>
          </Body>
        )}
        <TitleRow
          icon={icon}
          state={state}
          refusal={refusal}
          title={row}
          colors={colors}
          strong
          extra={
            stats && (stats.added > 0 || stats.removed > 0) ? (
              <>
                {"  "}
                {stats.added > 0 ? <span fg={colors.success}>{`+${stats.added}`}</span> : null}
                {stats.added > 0 && stats.removed > 0 ? " " : null}
                {stats.removed > 0 ? <span fg={colors.error}>{`−${stats.removed}`}</span> : null}
              </>
            ) : null
          }
        />
        {(patch !== undefined || output !== undefined || error) && (
          <Body>
            {patch !== undefined && <PatchView patch={patch} details={details} colors={colors} base={colors.surface} />}
            {output !== undefined && (
              <OutputView output={output} truncated={part.outputTruncated === true} details={details} preview={kind === "bash" ? SHELL_PREVIEW_LINES : OUTPUT_PREVIEW_LINES} />
            )}
            {error}
          </Body>
        )}
      </Block>
    );
  }

  // One row. A lookup's output waits for details; an unknown tool's and a question's show their last lines.
  const output = finished && part.output && (details || !QUIET_OUTPUT.has(kind)) ? part.output : undefined;
  return (
    <Inline>
      <TitleRow icon={icon} state={state} refusal={refusal} title={title} colors={colors} />
      {(output !== undefined || error) && (
        <Body>
          {output !== undefined && <OutputView output={output} truncated={part.outputTruncated === true} details={details} />}
          {error}
        </Body>
      )}
    </Inline>
  );
}

/** A sub-agent task: its status line in a panel, and what it reported once it finished. */
export function TaskPart({ part }: { part: TaskPartData }) {
  const { colors } = useTheme();
  const outcome = taskOutcome(part);
  const state: RowState = part.status === "running" ? "running" : part.status === "failed" ? "error" : "done";
  return (
    <Block colors={colors}>
      <TitleRow icon={TOOL_ICON.task} state={state} title={{ verb: "Task", subject: formatTaskLine(part) }} colors={colors} strong />
      {outcome && (
        <Body>
          <text attributes={TextAttributes.DIM}>{safe(outcome)}</text>
        </Body>
      )}
    </Block>
  );
}
