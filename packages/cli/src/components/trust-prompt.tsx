import { useCallback, useEffect, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { EmptyBorder } from "./border";
import { escapeProjectText } from "../lib/engine/pi-trust";
import { useQuietWindow } from "../hooks/use-quiet-window";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";
import type { TrustRequest } from "../hooks/use-chat";

// How often the scroll position is re-read, to follow the mouse wheel (it triggers no layout change).
const MEASURE_MS = 100;

// What the rendered list reports: rows scrolled past, rows in all, rows on screen.
type View = { top: number; total: number; viewport: number };

const UNMEASURED: View = { top: 0, total: 0, viewport: 0 };

// The whole list has been on screen when it fits, or the last row is in view. Nothing is measured before the first layout.
function reachedEnd({ top, total, viewport }: View): boolean {
  return viewport > 0 && top + viewport >= total;
}

type Props = {
  request: TrustRequest;
};

/**
 * marcsh's own question before pi loads a project's pi files (extensions, MCP servers, settings...): what the folder
 * holds, then `t` to trust (arms Enter), `d` not to, Esc to leave this one turn untrusted without remembering.
 * Like an approval it ignores keys until the keyboard has been quiet, so typing ahead cannot answer it, and
 * `t` alone trusts nothing: trusting lets the project's code run, so it only works once the whole list has been on screen.
 * It owns the whole screen while pending: the title, folder and count are pinned at the top and the key hints at the
 * bottom, and everything the project supplies is listed whole, one escaped line each (newlines, terminal controls and
 * bidi or invisible characters show as escapes), in a list that takes the remaining rows and scrolls
 * (↑/↓, PgUp/PgDn, wheel). Scrolling is read from the rendered list, not guessed from the text.
 */
export function TrustPrompt({ request }: Props) {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { quiet, isQuiet, restart: restartQuiet } = useQuietWindow(request);
  const [armedRequest, setArmedRequest] = useState<TrustRequest | null>(null);
  const armed = armedRequest === request;
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const { width, height } = useTerminalDimensions();
  const renderer = useRenderer();

  const [view, setView] = useState<View>(UNMEASURED);
  const [endSeen, setEndSeen] = useState(false);
  const endSeenRef = useRef(false);

  const measure = useCallback((): View => {
    const box = scrollRef.current;
    if (!box) return UNMEASURED;
    const next = { top: box.scrollTop, total: box.scrollHeight, viewport: box.viewport.height };
    setView((prev) => (prev.top === next.top && prev.total === next.total && prev.viewport === next.viewport ? prev : next));
    if (reachedEnd(next) && !endSeenRef.current) {
      endSeenRef.current = true;
      setEndSeen(true);
    }
    return next;
  }, []);

  // Layout (first render, resize) is not known until it is computed; the wheel moves the list without a layout change.
  useEffect(() => {
    renderer.root.on("layout-changed", measure);
    const timer = setInterval(measure, MEASURE_MS);
    measure();
    return () => {
      renderer.root.off("layout-changed", measure);
      clearInterval(timer);
    };
  }, [renderer, measure]);

  const rows = request.resources.map((resource) => escapeProjectText(resource.detail ? `${resource.path} — ${resource.detail}` : resource.path));
  const scrolls = view.viewport > 0 && view.total > view.viewport;

  useKeyboard((key) => {
    const modified = key.ctrl || key.meta || key.option || key.super || key.hyper;

    // Reading the list answers nothing and does not touch the quiet window or an armed `t`.
    const page = Math.max(1, (scrollRef.current?.viewport.height ?? 1) - 1);
    const scrollBy = { up: -1, down: 1, pageup: -page, pagedown: page }[key.name as string];
    if (scrollBy !== undefined && isTopLayer("base") && !modified) {
      key.preventDefault();
      scrollRef.current?.scrollBy(scrollBy);
      measure();
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
      // Trusting is only offered once the whole list has been on screen; until then `t` does nothing.
      measure();
      if (endSeenRef.current) setArmedRequest(request);
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
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      zIndex={50}
      backgroundColor={colors.background}
      border={["left"]}
      borderColor={colors.info}
      customBorderChars={{
        ...EmptyBorder,
        vertical: "│",
      }}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <box flexShrink={0} flexDirection="column">
        <text>
          <em fg={colors.info}>Trust this project&apos;s pi files?</em>
        </text>
        <text attributes={TextAttributes.DIM} wrapMode="char">
          {escapeProjectText(request.cwd)}
        </text>
        <text attributes={TextAttributes.DIM}>
          {rows.length} {rows.length === 1 ? "item" : "items"} pi would load or run, most dangerous first
        </text>
      </box>
      <scrollbox ref={scrollRef} flexGrow={1} flexShrink={1} minHeight={0}>
        {rows.map((row, i) => (
          <box key={i} flexDirection="row" flexShrink={0}>
            <text width={2} flexShrink={0}>
              •
            </text>
            <text flexGrow={1} flexShrink={1} wrapMode="word">
              {row}
            </text>
          </box>
        ))}
      </scrollbox>
      <box flexShrink={0} flexDirection="column">
        {scrolls ? (
          <text attributes={TextAttributes.DIM}>
            {`rows ${view.top + 1}–${Math.min(view.total, view.top + view.viewport)} of ${view.total} · ↑/↓ PgUp/PgDn`}
          </text>
        ) : null}
        <text attributes={TextAttributes.DIM}>Trusting lets pi load these files and run their code with your permissions.</text>
        <box flexDirection="row" gap={2}>
          {!quiet ? (
            <text attributes={TextAttributes.DIM}>waiting for typing to stop…</text>
          ) : (
            <>
              {endSeen ? (
                <>
                  <text>t</text>
                  <text attributes={TextAttributes.DIM}>{armed ? "press Enter to trust" : "trust (then Enter)"}</text>
                </>
              ) : (
                <text attributes={TextAttributes.DIM}>scroll to the end first</text>
              )}
              <text>d</text>
              <text attributes={TextAttributes.DIM}>don&apos;t trust</text>
              <text>Esc</text>
              <text attributes={TextAttributes.DIM}>not now (this turn only)</text>
            </>
          )}
        </box>
      </box>
    </box>
  );
}
