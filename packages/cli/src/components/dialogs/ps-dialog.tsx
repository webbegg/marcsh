import { useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { escapeTranscriptText } from "../../lib/display-text";
import type { BackgroundHub } from "../../lib/background/hub";
import { outputLines, sanitizeText } from "../../lib/background/output";
import { terminalsFor } from "../../lib/background/session-terminals";
import { formatElapsed, formatExit, type BackgroundTerminals, type TerminalSnapshot } from "../../lib/background/terminals";

// The /ps viewer follows davi7's `extensions/background-terminals/src/ui/ps.ts` (MIT license): a list, and a read-only output view.

const MAX_VISIBLE_ROWS = 8;
/** More output lines than this are not drawn: the log file has them all. */
export const MAX_OUTPUT_ROWS = 3000;

/** The session's terminals, drawn again when they change (at most every 50 ms) and every second for the runtimes. */
function useTerminals(hub: BackgroundHub): BackgroundTerminals {
  const terminals = terminalsFor(hub);
  const [, setTick] = useState(0);
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      pending ??= setTimeout(() => {
        pending = undefined;
        setTick((tick) => tick + 1);
      }, 50);
    };
    const off = terminals.subscribe(bump);
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => {
      off();
      clearInterval(timer);
      if (pending) clearTimeout(pending);
    };
  }, [terminals]);
  return terminals;
}

const oneLine = (text: string, max: number) => {
  const line = escapeTranscriptText(sanitizeText(text).replace(/\s+/g, " ").trim());
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function statusColor(status: TerminalSnapshot["status"], colors: ReturnType<typeof useTheme>["colors"]) {
  return status === "running" ? colors.info : status === "done" ? colors.success : colors.error;
}

function TerminalRow({ snapshot, selected }: { snapshot: TerminalSnapshot; selected: boolean }) {
  const { colors } = useTheme();
  return (
    <box flexDirection="row" height={1} overflow="hidden" gap={1} backgroundColor={selected ? colors.selection : undefined}>
      <text selectable={false} flexShrink={0} fg={selected ? "black" : statusColor(snapshot.status, colors)}>
        {snapshot.status.padEnd(7)}
      </text>
      <text selectable={false} flexShrink={0} fg={selected ? "black" : "white"}>
        {oneLine(snapshot.title, 30)}
      </text>
      <text selectable={false} flexShrink={1} flexGrow={1} wrapMode="none" fg={selected ? "black" : undefined} attributes={TextAttributes.DIM}>
        {oneLine(snapshot.command, 60)}
      </text>
      <text selectable={false} flexShrink={0} fg={selected ? "black" : undefined} attributes={TextAttributes.DIM}>
        {formatElapsed(snapshot)}
      </text>
    </box>
  );
}

function TerminalDetail({ snapshot, terminals, onBack }: { snapshot: TerminalSnapshot; terminals: BackgroundTerminals; onBack: () => void }) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { height } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const view = snapshot[stream];
  const lines = useMemo(() => outputLines(view.text), [view.text]);
  const shown = lines.slice(-MAX_OUTPUT_ROWS);
  const hidden = lines.length - shown.length + (view.truncatedBytes > 0 ? 1 : 0);
  // The dialog adds a title, padding and a footer; the header here takes four lines.
  const visible = Math.max(5, Math.min(Math.max(shown.length, 1), height - 16));

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;
    const scrollbox = scrollRef.current;
    if (key.name === "t") setStream((current) => (current === "stdout" ? "stderr" : "stdout"));
    else if (key.name === "x") terminals.requestKill(snapshot.id);
    else if (key.name === "left" || key.name === "backspace") onBack();
    else if (!scrollbox) return;
    else if (key.name === "up") scrollbox.scrollBy(-1);
    else if (key.name === "down") scrollbox.scrollBy(1);
    else if (key.name === "pageup") scrollbox.scrollBy(-visible);
    else if (key.name === "pagedown") scrollbox.scrollBy(visible);
    else if (key.name === "home") scrollbox.scrollTo(0);
    else if (key.name === "end") scrollbox.scrollTo(scrollbox.scrollHeight);
  });

  const state = snapshot.status === "running" ? "running" : `${snapshot.status} · ${formatExit(snapshot)}`;
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="column">
        <text>
          <span fg={statusColor(snapshot.status, colors)}>{state}</span>
          {` · ${oneLine(snapshot.title, 60)} · ${formatElapsed(snapshot)} · pid ${snapshot.pid ?? "?"}`}
        </text>
        <text attributes={TextAttributes.DIM} wrapMode="char" width="100%">
          {`$ ${escapeTranscriptText(snapshot.command)}`}
        </text>
        <text attributes={TextAttributes.DIM} wrapMode="char" width="100%">
          {view.logPath ? `${stream} · full log ${escapeTranscriptText(view.logPath)}` : stream}
        </text>
      </box>
      <scrollbox ref={scrollRef} height={visible} stickyScroll stickyStart="bottom">
        {hidden > 0 && <text attributes={TextAttributes.DIM}>{`… earlier output is in the full log`}</text>}
        {shown.length === 0 ? (
          <text attributes={TextAttributes.DIM}>{`(no ${stream} yet)`}</text>
        ) : (
          shown.map((line, index) => (
            <text key={index} wrapMode="char" width="100%">
              {escapeTranscriptText(line) || " "}
            </text>
          ))
        )}
      </scrollbox>
      <text attributes={TextAttributes.DIM}>{`t ${stream === "stdout" ? "stderr" : "stdout"} · x kill · ↑↓ scroll · ← back · esc close`}</text>
    </box>
  );
}

/** `/ps`: the session's background terminals, newest first. Enter shows one's output, `x` kills the highlighted one. */
export const PsDialogContent = ({ hub }: { hub: BackgroundHub }) => {
  const terminals = useTerminals(hub);
  const { isTopLayer } = useKeyboardLayer();
  const [selected, setSelected] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = [...terminals.list()].reverse();
  const index = Math.min(selected, Math.max(0, list.length - 1));
  const open = openId ? terminals.get(openId) : undefined;

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || open) return;
    const highlighted = list[index];
    if (key.name === "up") setSelected(Math.max(0, index - 1));
    else if (key.name === "down") setSelected(Math.min(list.length - 1, index + 1));
    else if ((key.name === "return" || key.name === "enter") && highlighted) setOpenId(highlighted.id);
    else if (key.name === "x" && highlighted) terminals.requestKill(highlighted.id);
  });

  if (open) return <TerminalDetail snapshot={open} terminals={terminals} onBack={() => setOpenId(null)} />;

  const first = Math.max(0, Math.min(index - MAX_VISIBLE_ROWS + 1, list.length - MAX_VISIBLE_ROWS));
  const running = list.filter((snapshot) => snapshot.status === "running").length;
  return (
    <box flexDirection="column" gap={1}>
      {list.length === 0 ? (
        <text attributes={TextAttributes.DIM}>No background terminals in this session.</text>
      ) : (
        <box flexDirection="column">
          {list.slice(first, first + MAX_VISIBLE_ROWS).map((snapshot, at) => (
            <TerminalRow key={snapshot.id} snapshot={snapshot} selected={first + at === index} />
          ))}
        </box>
      )}
      <text attributes={TextAttributes.DIM}>{`${running} running of ${list.length} · enter output · x kill · esc close`}</text>
    </box>
  );
};
