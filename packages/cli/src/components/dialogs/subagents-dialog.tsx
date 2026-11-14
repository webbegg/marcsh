import { useEffect, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { escapeTranscriptText } from "../../lib/display-text";
import { Mode } from "../../lib/modes";
import type { BackgroundHub } from "../../lib/background/hub";
import { sanitizeText } from "../../lib/background/output";
import { subagentsFor } from "../../lib/background/session-subagents";
import type { BackgroundSubagents, SubagentSnapshot } from "../../lib/background/subagents";
import { formatElapsed } from "../../lib/background/terminals";
import { BotMessage } from "../messages/bot-message";

// The /subagents viewer follows davi7's background subagents "takeover" view (MIT license): a list, and a live read-only transcript.

const MAX_VISIBLE_ROWS = 8;

/** The session's subagents, drawn again when they change (at most every 50 ms) and every second for the runtimes. */
function useSubagents(hub: BackgroundHub): BackgroundSubagents {
  const subagents = subagentsFor(hub);
  const [, setTick] = useState(0);
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      pending ??= setTimeout(() => {
        pending = undefined;
        setTick((tick) => tick + 1);
      }, 50);
    };
    const off = subagents.subscribe(bump);
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => {
      off();
      clearInterval(timer);
      if (pending) clearTimeout(pending);
    };
  }, [subagents]);
  return subagents;
}

const oneLine = (text: string, max: number) => {
  const line = escapeTranscriptText(sanitizeText(text).replace(/\s+/g, " ").trim());
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** "1200 tokens · $0.01": tokens once there are any, the cost once it is above zero. */
function usageText(snapshot: SubagentSnapshot): string {
  const parts = [snapshot.totalTokens > 0 ? `${snapshot.totalTokens} tokens` : "", snapshot.costUsd > 0 ? `$${snapshot.costUsd.toFixed(2)}` : ""];
  return parts.filter(Boolean).join(" · ");
}

function statusColor(status: SubagentSnapshot["status"], colors: ReturnType<typeof useTheme>["colors"]) {
  return status === "running" ? colors.info : status === "completed" ? colors.success : colors.error;
}

function SubagentRow({ snapshot, selected }: { snapshot: SubagentSnapshot; selected: boolean }) {
  const { colors } = useTheme();
  return (
    <box flexDirection="row" height={1} overflow="hidden" gap={1} backgroundColor={selected ? colors.selection : undefined}>
      <text selectable={false} flexShrink={0} fg={selected ? "black" : statusColor(snapshot.status, colors)}>
        {snapshot.status.padEnd(9)}
      </text>
      <text selectable={false} flexShrink={1} flexGrow={1} wrapMode="none" fg={selected ? "black" : "white"}>
        {oneLine(snapshot.description, 60)}
      </text>
      <text selectable={false} flexShrink={0} fg={selected ? "black" : undefined} attributes={TextAttributes.DIM}>
        {usageText(snapshot)}
      </text>
      <text selectable={false} flexShrink={0} fg={selected ? "black" : undefined} attributes={TextAttributes.DIM}>
        {formatElapsed(snapshot)}
      </text>
    </box>
  );
}

function SubagentTranscript({ snapshot, subagents, onBack }: { snapshot: SubagentSnapshot; subagents: BackgroundSubagents; onBack: () => void }) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { height } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  // The dialog adds a title, padding and a footer; the header here takes a few lines.
  const visible = Math.max(5, height - 16);

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;
    const scrollbox = scrollRef.current;
    if (key.name === "x") subagents.requestCancel(snapshot.id);
    else if (key.name === "left" || key.name === "backspace") onBack();
    else if (!scrollbox) return;
    else if (key.name === "up") scrollbox.scrollBy(-1);
    else if (key.name === "down") scrollbox.scrollBy(1);
    else if (key.name === "pageup") scrollbox.scrollBy(-visible);
    else if (key.name === "pagedown") scrollbox.scrollBy(visible);
    else if (key.name === "home") scrollbox.scrollTo(0);
    else if (key.name === "end") scrollbox.scrollTo(scrollbox.scrollHeight);
  });

  const usage = usageText(snapshot);
  const parts = snapshot.transcript.parts;
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        <text>
          <span fg={statusColor(snapshot.status, colors)}>{snapshot.status}</span>
          {` · ${oneLine(snapshot.description, 60)} · ${formatElapsed(snapshot)}${usage ? ` · ${usage}` : ""}`}
        </text>
        <text attributes={TextAttributes.DIM} wrapMode="word" width="100%">
          {escapeTranscriptText(snapshot.prompt)}
        </text>
      </box>
      <scrollbox ref={scrollRef} height={visible} stickyScroll stickyStart="bottom">
        {parts.length === 0 ? (
          <text attributes={TextAttributes.DIM}>(nothing yet)</text>
        ) : (
          <BotMessage parts={parts} model="subagent" mode={Mode.BUILD} streaming={snapshot.status === "running"} />
        )}
      </scrollbox>
      {snapshot.status === "failed" && snapshot.error && (
        <text fg={colors.error} wrapMode="word" width="100%">
          {`Error: ${escapeTranscriptText(snapshot.error)}`}
        </text>
      )}
      <text attributes={TextAttributes.DIM}>x cancel · ↑↓ scroll · ← back · esc close</text>
    </box>
  );
}

/** `/subagents`: the session's background subagents, newest first. Enter shows one's live transcript, `x` cancels the highlighted one. */
export const SubagentsDialogContent = ({ hub }: { hub: BackgroundHub }) => {
  const subagents = useSubagents(hub);
  const { isTopLayer } = useKeyboardLayer();
  const [selected, setSelected] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = [...subagents.list()].reverse();
  const index = Math.min(selected, Math.max(0, list.length - 1));
  const open = openId ? subagents.get(openId) : undefined;

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || open) return;
    const highlighted = list[index];
    if (key.name === "up") setSelected(Math.max(0, index - 1));
    else if (key.name === "down") setSelected(Math.min(list.length - 1, index + 1));
    else if ((key.name === "return" || key.name === "enter") && highlighted) setOpenId(highlighted.id);
    else if (key.name === "x" && highlighted) subagents.requestCancel(highlighted.id);
  });

  if (open) return <SubagentTranscript snapshot={open} subagents={subagents} onBack={() => setOpenId(null)} />;

  const first = Math.max(0, Math.min(index - MAX_VISIBLE_ROWS + 1, list.length - MAX_VISIBLE_ROWS));
  const running = list.filter((snapshot) => snapshot.status === "running").length;
  return (
    <box flexDirection="column" gap={1}>
      {list.length === 0 ? (
        <text attributes={TextAttributes.DIM}>No background subagents in this session.</text>
      ) : (
        <box flexDirection="column">
          {list.slice(first, first + MAX_VISIBLE_ROWS).map((snapshot, at) => (
            <SubagentRow key={snapshot.id} snapshot={snapshot} selected={first + at === index} />
          ))}
        </box>
      )}
      <text attributes={TextAttributes.DIM}>{`${running} running of ${list.length} · enter transcript · x cancel · esc close`}</text>
    </box>
  );
};
