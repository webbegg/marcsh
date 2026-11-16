import { useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { escapeTranscriptText } from "../../lib/display-text";
import type { BackgroundHub } from "../../lib/background/hub";
import { outputLines, outputTail, sanitizeText } from "../../lib/background/output";
import { terminalsFor } from "../../lib/background/session-terminals";
import { formatElapsed, formatExit, type BackgroundTerminals, type TerminalSnapshot } from "../../lib/background/terminals";
import { leftoverWatch, type LeftoverWatch } from "../../lib/background/leftover-watch";
import { formatAge, type Leftover } from "../../lib/background/leftovers";
import { useLeftovers, useLeftoverScanError } from "../../lib/background/use-leftovers";

// The /ps viewer follows davi7's `extensions/background-terminals/src/ui/ps.ts` (MIT license; see THIRD_PARTY_NOTICES.md): a list,
// and a read-only output view.

const MAX_VISIBLE_ROWS = 8;
/** More output lines than this are not drawn: the log file has them all. */
export const MAX_OUTPUT_ROWS = 3000;
/** Nor more characters than this (a few very long lines): only this much of the end is sanitized for each draw. */
const MAX_OUTPUT_CHARS = 512 * 1024;
/** The list redraws on a change at most this often; the output view, which sanitizes its text again, less often. */
const LIST_REDRAW_MS = 50;
const DETAIL_REDRAW_MS = 250;

/** The session's terminals (none without a hub), drawn again when they change (at most every `redrawMs`) and every second for the runtimes. */
function useTerminals(hub: BackgroundHub | undefined, redrawMs: number): BackgroundTerminals | undefined {
  const terminals = hub && !hub.disposed ? terminalsFor(hub) : undefined;
  const [, setTick] = useState(0);
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      pending ??= setTimeout(() => {
        pending = undefined;
        setTick((tick) => tick + 1);
      }, redrawMs);
    };
    const off = terminals ? terminals.subscribe(bump) : () => {};
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => {
      off();
      clearInterval(timer);
      if (pending) clearTimeout(pending);
    };
  }, [terminals, redrawMs]);
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
  // Only the end that can be drawn is sanitized: the raw text can be megabytes.
  const tail = useMemo(() => outputTail(view.text, MAX_OUTPUT_ROWS, MAX_OUTPUT_CHARS), [view.text]);
  const shown = useMemo(() => outputLines(tail.text).slice(-MAX_OUTPUT_ROWS), [tail]);
  const hidden = tail.cut || view.truncatedBytes > 0;
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
        {hidden && <text attributes={TextAttributes.DIM}>{`… earlier output is in the full log`}</text>}
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

/** A leftover process: its pid, age, memory, command and, when known, the terminal that started it; "possibly yours" when it may be the user's own. */
function LeftoverRow({ leftover, selected, stopping }: { leftover: Leftover; selected: boolean; stopping: boolean }) {
  const { colors } = useTheme();
  const from = [leftover.possiblyYours ? "possibly yours" : undefined, leftover.bg].filter(Boolean).join(" · ");
  return (
    <box flexDirection="row" height={1} overflow="hidden" gap={1} backgroundColor={selected ? colors.selection : undefined}>
      <text selectable={false} flexShrink={0} fg={selected ? "black" : colors.info}>
        {(stopping ? "stopping" : String(leftover.pid)).padEnd(8)}
      </text>
      <text selectable={false} flexShrink={0} fg={selected ? "black" : undefined} attributes={TextAttributes.DIM}>
        {formatAge(leftover.ageMs).padStart(3)}
      </text>
      <text selectable={false} flexShrink={0} fg={selected ? "black" : undefined} attributes={TextAttributes.DIM}>
        {`${leftover.rssMb} MB`}
      </text>
      <text selectable={false} flexShrink={1} flexGrow={1} wrapMode="none" fg={selected ? "black" : "white"}>
        {oneLine(leftover.command || "(command unknown)", 70)}
      </text>
      {from ? (
        <text selectable={false} flexShrink={0} fg={selected ? "black" : undefined} attributes={TextAttributes.DIM}>
          {oneLine(from, 24)}
        </text>
      ) : null}
    </box>
  );
}

type Row = { key: string; terminal: TerminalSnapshot; leftover?: undefined } | { key: string; leftover: Leftover; terminal?: undefined };

const leftoverKey = (leftover: Leftover) => `p:${leftover.pid}:${leftover.startKey}`;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `/ps`: the session's background terminals, newest first (Enter shows one's output, `x` kills the highlighted one), then the leftover
 * processes this marcsh run's tools started (see `leftovers.ts`; `x` stops the highlighted one, and what did not stop is said). Without
 * a hub (a Claude session) only the leftovers. The leftovers are scanned when it opens and after each stop, never per keystroke; a scan
 * that failed is said, with the last list it found. One that may be the user's own (`possiblyYours`) is marked, and the line under the
 * list says why. What pi's pack hooks leave running (`MARCSH_INFRA`) is not listed.
 */
export const PsDialogContent = ({ hub, leftovers: watch = leftoverWatch }: { hub?: BackgroundHub; leftovers?: LeftoverWatch }) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const terminals = useTerminals(hub, openId ? DETAIL_REDRAW_MS : LIST_REDRAW_MS);
  const leftovers = useLeftovers(watch);
  const scanError = useLeftoverScanError(watch);
  const { colors } = useTheme();
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [stopNote, setStopNote] = useState<string | null>(null);
  useEffect(() => {
    void watch.refresh({ force: true });
  }, [watch]);
  const { isTopLayer } = useKeyboardLayer();
  // The highlight is a row's terminal or process, not a row: one started or pruned meanwhile does not move it. When the highlighted one
  // is pruned, the row it was on keeps the highlight.
  const [selected, setSelected] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const list = terminals ? [...terminals.list()].reverse() : [];
  const rows: Row[] = [
    ...list.map((snapshot) => ({ key: `t:${snapshot.id}`, terminal: snapshot })),
    ...leftovers.map((leftover) => ({ key: leftoverKey(leftover), leftover })),
  ];
  const found = selected.id === null ? -1 : rows.findIndex((row) => row.key === selected.id);
  const index = found >= 0 ? found : Math.min(selected.index, Math.max(0, rows.length - 1));
  const open = openId && terminals ? terminals.get(openId) : undefined;
  const select = (at: number) => setSelected({ id: rows[at]?.key ?? null, index: at });
  // Pin what is highlighted (the first row on opening, the next one after a prune) to its terminal or process.
  const highlightedId = rows[index]?.key ?? null;
  useEffect(() => {
    if (highlightedId !== selected.id) setSelected({ id: highlightedId, index });
  }, [highlightedId, selected.id, index]);

  const stop = (leftover: Leftover) => {
    const key = leftoverKey(leftover);
    if (stopping.has(key)) return;
    setStopping((current) => new Set([...current, key]));
    setStopNote(null);
    // The start it was listed with: a pid given to another process meanwhile is left alone.
    void watch
      .stop([{ pid: leftover.pid, startKey: leftover.startKey }])
      .then(
        (result) => {
          const failed = result.failed[0];
          setStopNote(failed ? `Not stopped pid ${failed.pid}: ${failed.reason}` : null);
        },
        (error) => setStopNote(`Could not stop pid ${leftover.pid}: ${errorText(error)}`),
      )
      .finally(() =>
        setStopping((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        }),
      );
  };

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || open) return;
    const highlighted = rows[index];
    if (key.name === "up") select(Math.max(0, index - 1));
    else if (key.name === "down") select(Math.min(rows.length - 1, index + 1));
    else if ((key.name === "return" || key.name === "enter") && highlighted?.terminal) setOpenId(highlighted.terminal.id);
    else if (key.name === "x" && highlighted?.terminal) terminals?.requestKill(highlighted.terminal.id);
    else if (key.name === "x" && highlighted?.leftover) stop(highlighted.leftover);
  });

  if (open && terminals) return <TerminalDetail snapshot={open} terminals={terminals} onBack={() => setOpenId(null)} />;

  const first = Math.max(0, Math.min(index - MAX_VISIBLE_ROWS + 1, rows.length - MAX_VISIBLE_ROWS));
  const visible = rows.slice(first, first + MAX_VISIBLE_ROWS);
  const visibleTerminals = visible.filter((row) => row.terminal);
  const visibleLeftovers = visible.filter((row) => row.leftover);
  const running = list.filter((snapshot) => snapshot.status === "running").length;
  const highlightedYours = rows[index]?.leftover?.possiblyYours;
  const footer = [
    ...(terminals ? [`${running} running of ${list.length}`] : []),
    ...(leftovers.length > 0 ? [`${leftovers.length} leftover`] : []),
    ...(terminals ? ["enter output"] : []),
    leftovers.length > 0 ? (terminals ? "x kill/stop" : "x stop") : "x kill",
    "esc close",
  ].join(" · ");
  return (
    <box flexDirection="column" gap={1}>
      {!terminals ? (
        <text attributes={TextAttributes.DIM}>Background terminals run in pi sessions only.</text>
      ) : list.length === 0 ? (
        <text attributes={TextAttributes.DIM}>No background terminals in this session.</text>
      ) : visibleTerminals.length > 0 ? (
        <box flexDirection="column">
          {visibleTerminals.map((row) => (
            <TerminalRow key={row.key} snapshot={row.terminal!} selected={row.key === highlightedId} />
          ))}
        </box>
      ) : null}
      {leftovers.length > 0 ? (
        <box flexDirection="column">
          <text attributes={TextAttributes.BOLD}>{`Leftover processes · started by this marcsh run's tools, still running`}</text>
          {visibleLeftovers.map((row) => (
            <LeftoverRow key={row.key} leftover={row.leftover!} selected={row.key === highlightedId} stopping={stopping.has(row.key)} />
          ))}
        </box>
      ) : null}
      {highlightedYours ? (
        <text attributes={TextAttributes.DIM} wrapMode="word" width="100%">
          {oneLine(`Possibly yours: ${highlightedYours}. A tool call started what it runs under; you may have opened it yourself.`, 400)}
        </text>
      ) : null}
      {scanError ? (
        <text fg={colors.error} wrapMode="word" width="100%">
          {oneLine(`The process table could not be read (${scanError})${leftovers.length > 0 ? `: the leftovers shown are from the last scan that worked` : ""}.`, 400)}
        </text>
      ) : null}
      {stopNote ? (
        <text fg={colors.error} wrapMode="word" width="100%">
          {oneLine(stopNote, 400)}
        </text>
      ) : null}
      <text attributes={TextAttributes.DIM}>{footer}</text>
    </box>
  );
};
