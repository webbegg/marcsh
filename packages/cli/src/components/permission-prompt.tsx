import { useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type BoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { EmptyBorder } from "./border";
import { useQuietWindow } from "../hooks/use-quiet-window";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { LOCKED_LINE, usePromptLock } from "../lib/prompt-lock";
import { useTheme } from "../providers/theme";
import type { PermissionRequest } from "../hooks/use-chat";
import { pathAnswer } from "../lib/engine/types";
import { escapeProjectText } from "../lib/engine/pi-trust";
import { wrapByWidth, wrappedRows } from "../lib/display-text";
import { previewEdit, type EditPreview, type EditPreviewLine } from "../lib/edit-preview";
import { deriveDiffColors, type DiffColors } from "../lib/theme-derived";

const PRIMARY_INPUT_KEYS = ["command", "file_path", "path", "url", "pattern"];
const MAX_DETAIL_LINES = 12;
const MIN_TEXT_WIDTH = 10;
const UNMEASURED_MARGIN = 8;
// Starts every row of text a tool supplied (the first, the wrapped and the continuation rows), which the prompt's own rows never have:
// the hint row is the border and two blanks, then the key, so no row of tool text can pass for it.
const GUTTER = "┊ ";
// The columns the prompt uses beside its text: the left border, the padding on both sides and the gutter.
const SIDE_COLUMNS = 1 + 4 + GUTTER.length;

// The tools whose approval shows the diff of what they will write: Claude's Edit, MultiEdit and Write, pi's edit and write.
const PREVIEW_TOOLS = new Set(["Edit", "MultiEdit", "Write", "edit", "write"]);
// The rows of the prompt that are not diff rows: the title, the hint row, the input bar and the footer below, with some room. The diff gets the rest of the terminal.
const RESERVED_ROWS = 16;
const MIN_DIFF_ROWS = 6;
const MAX_DIFF_ROWS = 40;

type Props = {
  request: PermissionRequest;
  /** The folder a relative path of the tool resolves against (the session's). Default: the process's. */
  cwd?: string;
  /** Builds the preview of an edit. Default: `previewEdit`. A seam for tests. */
  previewer?: typeof previewEdit;
};

/** How many diff rows fit above the keys, so a long diff never pushes them off the screen. */
export const diffRowCap = (terminalHeight: number) => Math.max(MIN_DIFF_ROWS, Math.min(MAX_DIFF_ROWS, terminalHeight - RESERVED_ROWS));

type DiffRow = { kind: EditPreviewLine["kind"]; numbers: string; sign: string; text: string };

/**
 * The diff as the rows to draw: the old and new line numbers, the sign and the text (already escaped by the preview), each long line
 * cut into rows that fit, the continuations with blank numbers. Every row is counted, so the cap hides exactly what it says.
 */
function diffRows(lines: EditPreviewLine[], width: number): DiffRow[] {
  const numberWidth = Math.max(1, ...lines.map((line) => String(Math.max(line.oldLine ?? 0, line.newLine ?? 0)).length));
  const blank = " ".repeat(2 * numberWidth + 2);
  const textWidth = Math.max(1, width - blank.length - 2);
  return lines.flatMap((line) => {
    const sign = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
    const numbers = `${line.oldLine === undefined ? "" : String(line.oldLine)}`.padStart(numberWidth) + " " + `${line.newLine === undefined ? "" : String(line.newLine)}`.padStart(numberWidth) + " ";
    return wrapByWidth(line.text, textWidth).map((text, index) => ({
      kind: line.kind,
      numbers: index === 0 && line.kind !== "hunk" ? numbers : blank,
      sign: index === 0 ? sign : " ",
      text,
    }));
  });
}

/**
 * The header: the tool, what changes, then the file it writes (absolute, escaped by the preview, a symlink shown as the path given, an arrow
 * and the real file). The path goes last so that a long one wraps without pushing the counts off the first row.
 */
function diffHeader(toolName: string, preview: Extract<EditPreview, { kind: "diff" }>) {
  const parts = [escapeProjectText(toolName)];
  if (preview.newFile) parts.push("new file");
  parts.push(`+${preview.added} −${preview.removed}`);
  if (preview.crlf) parts.push("CRLF");
  parts.push(preview.via === undefined ? preview.path : `${preview.via} → ${preview.path} (symlink)`);
  return parts.join("  ");
}

type DiffRowsProps = { rows: DiffRow[]; diffColors: DiffColors; numberColor: string };

/** The diff rows, through the same gutter as every other row of tool text: the sign and tint of the row go inside it. */
function DiffRows({ rows, diffColors, numberColor }: DiffRowsProps) {
  return (
    <>
      {rows.map((row, index) => {
        const background = row.kind === "add" ? diffColors.addedBg : row.kind === "remove" ? diffColors.removedBg : undefined;
        const signColor = row.kind === "add" ? diffColors.addedSign : row.kind === "remove" ? diffColors.removedSign : undefined;
        return (
          <box key={index} flexDirection="row">
            <text attributes={TextAttributes.DIM} flexShrink={0}>{GUTTER}</text>
            <box flexDirection="row" flexGrow={1} flexShrink={1} backgroundColor={background}>
              <text fg={numberColor} flexShrink={0}>{row.numbers}</text>
              <text fg={signColor} flexShrink={0}>{`${row.sign} `}</text>
              <text attributes={row.kind === "hunk" ? TextAttributes.DIM : undefined} flexGrow={1} flexShrink={1} wrapMode="char">{row.text === "" ? " " : row.text}</text>
            </box>
          </box>
        );
      })}
    </>
  );
}

/** Splits the input into its main field (whole, escaped, hard-wrapped) and the rest (pretty JSON, wrapped, capped). */
function describeInput(input: Record<string, unknown>, width: number) {
  const primaryKey = PRIMARY_INPUT_KEYS.find((key) => typeof input[key] === "string");
  const primary = primaryKey ? wrappedRows(input[primaryKey] as string, width) : null;
  const rest = Object.fromEntries(Object.entries(input).filter(([key]) => key !== primaryKey));

  if (Object.keys(rest).length === 0) return { primary, detail: [], omitted: 0 };

  // Wrapped before the cap, so it counts what is actually drawn and nothing is hidden within a row.
  const rows = wrappedRows(JSON.stringify(rest, null, 2), width);

  return {
    primary,
    detail: rows.slice(0, MAX_DETAIL_LINES),
    omitted: Math.max(0, rows.length - MAX_DETAIL_LINES),
  };
}

type RowsProps = {
  rows: string[];
  dim?: boolean;
  /** The first row starts with text the prompt wrote itself (a label), so it needs no gutter. */
  labelled?: boolean;
  fg?: string;
  em?: boolean;
};

/**
 * Text a tool or engine supplied, drawn as the rows it was already cut into (no soft wrap on a correct width):
 * each row behind the gutter, in a column of its own, so a row of it can never be drawn as a row of the prompt.
 */
function Rows({ rows, dim = false, labelled = false, fg, em = false }: RowsProps) {
  return (
    <>
      {rows.map((row, index) => {
        const text = em ? <em fg={fg}>{row}</em> : row;
        const attributes = dim ? TextAttributes.DIM : undefined;
        return labelled && index === 0 ? (
          <text key={index} attributes={attributes} wrapMode="char">{text}</text>
        ) : (
          <box key={index} flexDirection="row">
            <text attributes={TextAttributes.DIM} flexShrink={0}>{GUTTER}</text>
            <text attributes={attributes} flexGrow={1} flexShrink={1} wrapMode="char">{text}</text>
          </box>
        );
      })}
    </>
  );
}

/** A single line of tool text (escaped, so one line) behind a label the prompt wrote, as hard-wrapped rows. */
const labelledRows = (label: string, text: string, width: number) => wrapByWidth(`${label}${escapeProjectText(text)}`, width);

export function PermissionPrompt({ request, cwd = process.cwd(), previewer = previewEdit }: Props) {
  const { colors } = useTheme();
  const renderer = useRenderer();
  const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
  const diffColors = useMemo(() => deriveDiffColors(colors), [colors]);
  const boxRef = useRef<BoxRenderable>(null);
  // The prompt's own width once laid out (the screen around it takes columns); until then the terminal's less a margin, so a first row is never too wide.
  const [boxWidth, setBoxWidth] = useState(terminalWidth - UNMEASURED_MARGIN);
  const textWidth = Math.max(MIN_TEXT_WIDTH, Math.min(boxWidth, terminalWidth) - SIDE_COLUMNS);

  useEffect(() => {
    const measure = () => {
      const width = boxRef.current?.width;
      if (width) setBoxWidth((prev) => (prev === width ? prev : width));
    };
    measure();
    renderer.root.on("layout-changed", measure);
    return () => {
      renderer.root.off("layout-changed", measure);
    };
  }, [renderer]);
  // The preview of the edit, kept with the request it was built for: one that arrives after a newer prompt opened is never drawn on it.
  const wantsPreview = PREVIEW_TOOLS.has(request.toolName);
  const [loaded, setLoaded] = useState<{ request: PermissionRequest; preview: EditPreview } | null>(null);
  useEffect(() => {
    if (!wantsPreview) return;
    let current = true;
    // Through `then`, so a previewer that throws before it returns a promise is the raw fallback too, not a crash of the prompt.
    Promise.resolve().then(() => previewer(request.toolName, request.input, cwd)).then(
      (preview) => {
        if (current) setLoaded({ request, preview });
      },
      (error) => {
        if (current) setLoaded({ request, preview: { kind: "raw", reason: `the preview failed (${error instanceof Error ? error.message : String(error)})` } });
      },
    );
    return () => {
      current = false;
    };
  }, [request, wantsPreview, cwd, previewer]);
  const preview = wantsPreview && loaded?.request === request ? loaded.preview : null;
  const diff = preview?.kind === "diff" ? preview : null;
  const { isTopLayer } = useKeyboardLayer();
  const [armedRequest, setArmedRequest] = useState<PermissionRequest | null>(null);
  const [pickedFolder, setPickedFolder] = useState<{ request: PermissionRequest; index: number }>({ request, index: 0 });
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const lock = usePromptLock(request);

  const confirmFirst = request.defaultToNo === true;
  const offerAlways = !confirmFirst && !request.suppressAlwaysAllowRule;
  const armed = armedRequest === request;
  // The folders a path command can be allowed under, narrowest first. Offered on floor asks too (they only hide "always"), never on a confirm-first ask.
  const folders = !confirmFirst && request.pathRule ? request.pathRule.dirs : [];
  const offerFolder = folders.length > 0;
  const folderIndex = pickedFolder.request === request ? Math.min(pickedFolder.index, folders.length - 1) : 0;
  const folderRows = offerFolder ? labelledRows(`p  allow \`${request.pathRule!.program}\` under `, folders[folderIndex]!, textWidth) : [];
  const { primary, detail, omitted } = useMemo(() => describeInput(request.input, textWidth), [request.input, textWidth]);
  const diffCap = diffRowCap(terminalHeight);
  // Kept between renders: wrapping a big diff walks every grapheme of it, and a key press or a timer re-renders the prompt.
  const allDiffRows = useMemo(() => (diff ? diffRows(diff.lines, textWidth) : []), [diff, textWidth]);
  const diffHeaderRows = useMemo(() => (diff ? wrapByWidth(diffHeader(request.toolName, diff), textWidth) : []), [diff, request.toolName, textWidth]);
  const titleRows = request.title !== undefined ? wrapByWidth(escapeProjectText(request.title), textWidth) : labelledRows("Allow ", `${request.toolName}?`, textWidth);

  useKeyboard((key) => {
    // Opened while the user was composing: nothing answers it until ↓, then the rules below apply from a fresh quiet window.
    if (lock.isLocked()) {
      if (key.name === "down" && isTopLayer("base") && !key.ctrl && !key.meta && !key.option && !key.super && !key.hyper) {
        key.preventDefault();
        lock.unlock();
        restartQuiet();
      }
      return;
    }

    // Any key before the keyboard is quiet (approval keys included) is ignored and restarts the wait.
    if (!isQuiet() || !isTopLayer("base") || key.ctrl || key.meta || key.option || key.super || key.hyper) {
      setArmedRequest(null);
      restartQuiet();
      return;
    }

    if (key.name === "n") {
      key.preventDefault();
      request.respond("deny");
    } else if (key.name === "y") {
      key.preventDefault();
      if (confirmFirst) setArmedRequest(request);
      else request.respond("allow");
    } else if (key.name === "a" && offerAlways) {
      key.preventDefault();
      request.respond("always");
    } else if (key.name === "p" && offerFolder) {
      key.preventDefault();
      request.respond(pathAnswer(folders[folderIndex]!));
    } else if ((key.name === "left" || key.name === "right") && offerFolder) {
      // ← widens to the parent folder, → narrows back.
      key.preventDefault();
      const index = key.name === "left" ? Math.min(folderIndex + 1, folders.length - 1) : Math.max(folderIndex - 1, 0);
      setPickedFolder({ request, index });
    } else if ((key.name === "return" || key.name === "enter") && armed) {
      key.preventDefault();
      request.respond("allow");
    } else {
      setArmedRequest(null);
      restartQuiet();
    }
  });

  return (
    <box
      ref={boxRef}
      border={["left"]}
      borderColor={colors.info}
      customBorderChars={{
        ...EmptyBorder,
        vertical: "│",
      }}
      width="100%"
      paddingX={2}
    >
      <Rows rows={titleRows} labelled={request.title === undefined} em fg={colors.info} />
      {request.description ? <Rows rows={wrapByWidth(escapeProjectText(request.description), textWidth)} dim /> : null}
      {request.decisionReason ? <Rows rows={labelledRows("Reason: ", request.decisionReason, textWidth)} dim labelled /> : null}
      {request.blockedPath ? <Rows rows={labelledRows("Path: ", request.blockedPath, textWidth)} dim labelled /> : null}
      {wantsPreview && !preview ? <text attributes={TextAttributes.DIM}>preparing diff…</text> : null}
      {preview?.kind === "raw" ? <Rows rows={labelledRows("diff unavailable: ", preview.reason, textWidth)} dim labelled /> : null}
      {diff ? (
        <box>
          <Rows rows={diffHeaderRows} />
          <DiffRows rows={allDiffRows.slice(0, diffCap)} diffColors={diffColors} numberColor={colors.dimSeparator} />
          {allDiffRows.length > diffCap ? (
            <text attributes={TextAttributes.DIM}>… {allDiffRows.length - diffCap} more lines</text>
          ) : null}
        </box>
      ) : (
        <>
          {primary ? <Rows rows={primary} /> : null}
          {detail.length > 0 ? (
            <box>
              <Rows rows={detail} dim />
              {omitted > 0 ? (
                <text attributes={TextAttributes.DIM}>… {omitted} more lines</text>
              ) : null}
            </box>
          ) : null}
        </>
      )}
      <box flexDirection="row" gap={2}>
        {lock.locked ? (
          <>
            <text attributes={TextAttributes.DIM}>y {confirmFirst ? "allow once (then Enter)" : "allow once"}</text>
            {offerAlways ? <text attributes={TextAttributes.DIM}>a always allow</text> : null}
            <text attributes={TextAttributes.DIM}>n deny</text>
          </>
        ) : !quiet ? (
          <text attributes={TextAttributes.DIM}>waiting for typing to stop…</text>
        ) : (
          <>
            <text>y</text>
            <text attributes={TextAttributes.DIM}>{confirmFirst ? (armed ? "press Enter to confirm" : "allow once (then Enter)") : "allow once"}</text>
            {offerAlways ? (
              <>
                <text>a</text>
                <text attributes={TextAttributes.DIM}>always allow</text>
              </>
            ) : null}
            <text>n</text>
            <text attributes={TextAttributes.DIM}>deny</text>
          </>
        )}
      </box>
      {offerFolder && (lock.locked || quiet) ? (
        <>
          <Rows rows={folderRows} dim={lock.locked} labelled />
          {folders.length > 1 ? <text attributes={TextAttributes.DIM}>←/→ change folder</text> : null}
        </>
      ) : null}
      {lock.locked ? <text>{LOCKED_LINE}</text> : null}
    </box>
  );
}
