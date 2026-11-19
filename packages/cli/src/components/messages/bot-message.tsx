import prettyMs from "pretty-ms";
import { useTheme } from "../../providers/theme";
import { useSyntaxStyle } from "../../hooks/use-syntax-style";
import type { MessagePart } from "../../lib/chat-types";
import { Mode, type ModeType } from "../../lib/modes";
import { escapeTranscriptText as safe } from "../../lib/display-text";
import { TextAttributes } from "@opentui/core";
import { useTranscriptView } from "../../providers/transcript-view";
import { isExploration, toolKind, toolStyle } from "../../lib/tool-display";
import { ReasoningPart } from "./reasoning-part";
import { ExploreGroup, TaskPart, ToolPart } from "./tool-part";
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
  /** The session's folder: tool calls show the paths under it relative. */
  cwd?: string;
  /** The turn was cancelled with Esc: the footer says so. */
  interrupted?: boolean;
  streaming?: boolean;
};

function isToolPart(part: MessagePart): part is ToolPartData {
  return part.type === "tool";
};

/**
 * How a part sits in the reply: `text` is the model's prose, a `row` is one line at the gutter (a lookup, a collapsed thought) and a
 * `block` is a panel (a command, an edit, a subagent, an expanded thought).
 */
type Layout = "text" | "row" | "block";

function layoutOf(part: MessagePart, thinking: boolean): Layout {
  if (part.type === "text") return "text";
  if (part.type === "reasoning") return thinking ? "block" : "row";
  if (part.type === "task") return "block";
  return toolStyle(toolKind(part.toolName)) === "block" ? "block" : "row";
}

type PartGroup = {
  layout: Layout;
  parts: MessagePart[];
  key: string;
};

/**
 * The reply's parts in the groups it draws, with a blank line between two groups: consecutive text and consecutive rows stay
 * together (a run of lookups reads as a list), while every block stands apart.
 */
export function groupParts(parts: MessagePart[], thinking = false): PartGroup[] {
  const groups: PartGroup[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const layout = layoutOf(part, thinking);
    const lastGroup = groups[groups.length - 1];

    if (lastGroup && layout !== "block" && lastGroup.layout === layout) {
      lastGroup.parts.push(part);
    } else {
      const key = isToolPart(part) ? `group-tc-${part.toolCallId}` : part.type === "task" ? `group-task-${part.taskId}` : `group-${part.type}-${i}`;
      groups.push({ layout, parts: [part], key });
    }
  }

  return groups;
};

/** What a group draws: a part as it is, or a run of lookups folded into one line. */
export type GroupItem = { part: MessagePart } | { explore: ToolPartData[] };

const isLookup = (part: MessagePart): part is ToolPartData => isToolPart(part) && isExploration(toolKind(part.toolName));

/**
 * A group's parts with every run of two or more lookups in a row (reads, searches, lists, fetches) folded into one item; with
 * details on nothing is folded, so each call shows on its own line with what it read.
 */
export function foldLookups(parts: MessagePart[], details = false): GroupItem[] {
  const items: GroupItem[] = [];
  let run: ToolPartData[] = [];
  const flush = () => {
    if (run.length >= 2) items.push({ explore: run });
    else items.push(...run.map((part) => ({ part })));
    run = [];
  };
  for (const part of parts) {
    if (!details && isLookup(part)) {
      run.push(part);
      continue;
    }
    flush();
    items.push({ part });
  }
  flush();
  return items;
}

export function BotMessage({ 
  parts,
  model,
  mode,
  agentName,
  durationMs,
  cwd,
  interrupted = false,
  streaming = false,
}: Props) {
  const { colors } = useTheme();
  const { thinking, details } = useTranscriptView();
  // One style for every text part of the message.
  const syntaxStyle = useSyntaxStyle();
  // Only the last part of a message still being written can be unfinished.
  const lastPart = parts[parts.length - 1];
  return (
    <box width="100%" alignItems="center">
      {groupParts(parts, thinking).map((group, i) => (
        <box key={group.key} width="100%" paddingTop={i === 0 ? 0 : 1}>
          {foldLookups(group.parts, details).map((item, j) => {
            if ("explore" in item) return <ExploreGroup key={`explore-${item.explore[0]!.toolCallId}`} parts={item.explore} cwd={cwd} />;
            const { part } = item;
            if (part.type === "reasoning") return <ReasoningPart key={`reasoning-${j}`} part={part} live={streaming && part === lastPart} />;
            if (isToolPart(part)) return <ToolPart key={part.toolCallId} part={part} cwd={cwd} syntaxStyle={syntaxStyle} />;
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
