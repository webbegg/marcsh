import { useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { EmptyBorder } from "./border";
import { escapeProjectText } from "../lib/engine/pi-trust";
import { useQuietWindow } from "../hooks/use-quiet-window";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";
import type { TrustRequest } from "../hooks/use-chat";

// The list scrolls inside this many rows (at most half the terminal), so the title and the key hints stay on screen.
const MIN_LIST_ROWS = 3;
// Columns the prompt's border and padding take from the terminal width.
const ROW_INDENT = 6;

// Terminal rows a line takes when wrapped at word boundaries (a word longer than a row is cut), counted on the safe side.
function wrappedRows(line: string, width: number): number {
  let rows = 1;
  let used = 0;
  for (const word of line.split(" ")) {
    const length = word.length;
    if (used > 0 && used + 1 + length <= width) used += 1 + length;
    else if (used === 0 && length <= width) used = length;
    else {
      rows += used > 0 ? 1 : 0;
      rows += Math.floor(Math.max(0, length - 1) / width);
      used = length % width || width;
    }
  }
  return rows;
}

type Props = {
  request: TrustRequest;
};

/**
 * marcsh's own question before pi loads a project's pi files (extensions, MCP servers, settings...): what the folder
 * holds, then `t` to trust (arms Enter), `d` not to, Esc to leave this one turn untrusted without remembering.
 * Like an approval it ignores keys until the keyboard has been quiet, so typing ahead cannot answer it, and
 * `t` alone trusts nothing: trusting lets the project's code run. Everything the project supplies is listed whole,
 * one escaped line each (newlines, terminal controls and bidi or invisible characters show as escapes), in a list that
 * scrolls (↑/↓, PgUp/PgDn, wheel) under a title and above key hints that never move.
 */
export function TrustPrompt({ request }: Props) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const [armedRequest, setArmedRequest] = useState<TrustRequest | null>(null);
  const armed = armedRequest === request;
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const { width, height } = useTerminalDimensions();

  const rows = request.resources.map((resource) => escapeProjectText(resource.detail ? `${resource.path} — ${resource.detail}` : resource.path));
  const listRows = Math.max(MIN_LIST_ROWS, Math.floor(height / 2));
  const wrapAt = Math.max(10, width - ROW_INDENT);
  const wanted = rows.reduce((sum, row) => sum + wrappedRows(`• ${row}`, wrapAt), 0);
  const scrolls = wanted > listRows;

  useKeyboard((key) => {
    const modified = key.ctrl || key.meta || key.option || key.super || key.hyper;

    // Reading the list answers nothing and does not touch the quiet window or an armed `t`.
    const scrollBy = { up: -1, down: 1, pageup: -(listRows - 1), pagedown: listRows - 1 }[key.name as string];
    if (scrollBy !== undefined && isTopLayer("base") && !modified) {
      key.preventDefault();
      scrollRef.current?.scrollBy(scrollBy);
      return;
    }

    // Not now: harmless, so it works at once. The turn goes on with the project's files unloaded.
    if (isTopLayer("base") && !modified && key.name === "escape") {
      key.preventDefault();
      request.respond("skip");
      return;
    }

    // Any key before the keyboard is quiet (answer keys included) is ignored and restarts the wait.
    if (!isQuiet() || !isTopLayer("base") || modified) {
      setArmedRequest(null);
      restartQuiet();
      return;
    }

    if (key.name === "d") {
      key.preventDefault();
      request.respond("distrust");
    } else if (key.name === "t") {
      key.preventDefault();
      setArmedRequest(request);
    } else if ((key.name === "return" || key.name === "enter") && armed) {
      key.preventDefault();
      request.respond("trust");
    } else {
      setArmedRequest(null);
      restartQuiet();
    }
  });

  return (
    <box
      border={["left"]}
      borderColor={colors.info}
      customBorderChars={{
        ...EmptyBorder,
        vertical: "│",
      }}
      width="100%"
      paddingX={2}
    >
      <text>
        <em fg={colors.info}>Trust this project&apos;s pi files?</em>
      </text>
      <text attributes={TextAttributes.DIM} wrapMode="char">
        {escapeProjectText(request.cwd)}
      </text>
      <text attributes={TextAttributes.DIM}>
        {rows.length} {rows.length === 1 ? "item" : "items"} pi would load or run, most dangerous first{scrolls ? " · ↑/↓ PgUp/PgDn scroll" : ""}
      </text>
      <scrollbox ref={scrollRef} height={Math.min(wanted, listRows)} flexShrink={0}>
        {rows.map((row, i) => (
          <text key={i} wrapMode="word">
            {`• ${row}`}
          </text>
        ))}
      </scrollbox>
      <text attributes={TextAttributes.DIM}>Trusting lets pi load these files and run their code with your permissions.</text>
      <box flexDirection="row" gap={2}>
        {!quiet ? (
          <text attributes={TextAttributes.DIM}>waiting for typing to stop…</text>
        ) : (
          <>
            <text>t</text>
            <text attributes={TextAttributes.DIM}>{armed ? "press Enter to trust" : "trust (then Enter)"}</text>
            <text>d</text>
            <text attributes={TextAttributes.DIM}>don&apos;t trust</text>
            <text>Esc</text>
            <text attributes={TextAttributes.DIM}>not now (this turn only)</text>
          </>
        )}
      </box>
    </box>
  );
}
