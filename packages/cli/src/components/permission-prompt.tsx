import { useEffect, useRef, useState } from "react";
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

const PRIMARY_INPUT_KEYS = ["command", "file_path", "path", "url", "pattern"];
const MAX_DETAIL_LINES = 12;
const MIN_TEXT_WIDTH = 10;
const UNMEASURED_MARGIN = 8;
// Starts every row of text a tool supplied (the first, the wrapped and the continuation rows), which the prompt's own rows never have:
// the hint row is the border and two blanks, then the key, so no row of tool text can pass for it.
const GUTTER = "┊ ";
// The columns the prompt uses beside its text: the left border, the padding on both sides and the gutter.
const SIDE_COLUMNS = 1 + 4 + GUTTER.length;

type Props = {
  request: PermissionRequest;
};

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

export function PermissionPrompt({ request }: Props) {
  const { colors } = useTheme();
  const renderer = useRenderer();
  const { width: terminalWidth } = useTerminalDimensions();
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
  const { primary, detail, omitted } = describeInput(request.input, textWidth);
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
      {primary ? <Rows rows={primary} /> : null}
      {detail.length > 0 ? (
        <box>
          <Rows rows={detail} dim />
          {omitted > 0 ? (
            <text attributes={TextAttributes.DIM}>… {omitted} more lines</text>
          ) : null}
        </box>
      ) : null}
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
