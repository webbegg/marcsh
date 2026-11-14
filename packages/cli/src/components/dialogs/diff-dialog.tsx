import { useMemo, useRef } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { escapeTranscriptText } from "../../lib/display-text";
import type { DiffFile } from "../../lib/session-snapshots";

/** More rows than this are not drawn: a rewritten lock file would make the dialog crawl. */
export const MAX_DIFF_ROWS = 3000;

type Row = { kind: "file" | "hunk" | "add" | "remove" | "context" | "note" | "gap"; text: string };

const STATUS_LABEL = { added: "new file", deleted: "deleted", modified: "modified" } as const;

/** One row per line to draw: a header for each file, then its lines; cut at `MAX_DIFF_ROWS` with the rest counted. */
export function diffRows(files: DiffFile[]): { rows: Row[]; hidden: number } {
  const all: Row[] = files.flatMap((file, index) => [
    ...(index > 0 ? [{ kind: "gap" as const, text: "" }] : []),
    { kind: "file" as const, text: `${file.path}  ${STATUS_LABEL[file.status]}  +${file.additions} -${file.deletions}` },
    ...file.lines,
  ]);
  return { rows: all.slice(0, MAX_DIFF_ROWS), hidden: Math.max(0, all.length - MAX_DIFF_ROWS) };
}

type Props = { files: DiffFile[] };

/** `/diff`: every changed file as a unified diff, scrolled with ↑↓, PageUp/PageDown, Home and End. */
export const DiffDialogContent = ({ files }: Props) => {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { height } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const { rows, hidden } = useMemo(() => diffRows(files), [files]);
  // The dialog adds a title, padding and a footer around the list.
  const visible = Math.max(5, Math.min(rows.length, height - 12));

  const color = (kind: Row["kind"]) =>
    kind === "add" ? colors.success : kind === "remove" ? colors.error : kind === "hunk" ? colors.info : kind === "file" ? colors.primary : undefined;

  useKeyboard((key) => {
    const scrollbox = scrollRef.current;
    if (!scrollbox || !isTopLayer("dialog")) return;
    if (key.name === "up") scrollbox.scrollBy(-1);
    else if (key.name === "down") scrollbox.scrollBy(1);
    else if (key.name === "pageup") scrollbox.scrollBy(-visible);
    else if (key.name === "pagedown") scrollbox.scrollBy(visible);
    else if (key.name === "home") scrollbox.scrollTo(0);
    else if (key.name === "end") scrollbox.scrollTo(scrollbox.scrollHeight);
  });

  return (
    <box flexDirection="column" gap={1}>
      <scrollbox ref={scrollRef} height={visible}>
        {rows.map((row, index) => (
          <text
            key={index}
            fg={color(row.kind)}
            wrapMode="char"
            width="100%"
            attributes={row.kind === "file" ? TextAttributes.BOLD : row.kind === "context" || row.kind === "note" ? TextAttributes.DIM : undefined}
          >
            {escapeTranscriptText(row.text) || " "}
          </text>
        ))}
        {hidden > 0 && (
          <text attributes={TextAttributes.DIM} wrapMode="word" width="100%">
            {`… ${hidden} more lines not shown`}
          </text>
        )}
      </scrollbox>
      <text attributes={TextAttributes.DIM}>↑↓ PgUp PgDn scroll · esc close</text>
    </box>
  );
};
