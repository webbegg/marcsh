import { useCallback, useEffect, useState, type RefObject } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import type { Command } from "./types";
import { useTheme } from "../../providers/theme";

// marcsh's own commands come first; room for all of them and the first Claude commands below.
const MAX_VISIBLE_ITEMS = 10;
const MIN_VISIBLE_ITEMS = 1;
// Rows the session layout keeps below the menu's anchor (the input) until the menu has been measured.
const ROWS_BELOW_MENU = 8;

/**
 * How many rows the menu may have when `rowsAbove` rows are free above the input. The menu grows upward from
 * the input, so rows beyond the top of the screen would push the first, highlighted command out of view.
 */
export function menuRowLimit(rowsAbove: number): number {
  return Math.max(MIN_VISIBLE_ITEMS, Math.min(MAX_VISIBLE_ITEMS, Math.floor(rowsAbove)));
}
const MAX_COMMAND_COL_WIDTH = 32;
const SOURCE_TAG_WIDTH = 8;

type CommandMenuProps = {
  commands: Command[];
  selectedIndex: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onSelect: (index: number) => void;
  onExecute: (index: number) => void;
};

export function CommandMenu({
  commands: filtered,
  selectedIndex,
  scrollRef,
  onSelect,
  onExecute,
}: CommandMenuProps) {
  const { colors } = useTheme();
  // Align all command names in a fixed-width column so their descriptions
  // start at the same horizontal position for a clean tabular look.
  // The width adjusts to accommodate the longest command name (capped for long plugin names).
  const commandColWidth = Math.min(
    MAX_COMMAND_COL_WIDTH,
    Math.max(...filtered.map((cmd) => cmd.name.length), 0) + 4,
  );

  // Wide enough for the longest source word shown (pi's `extension`), and never narrower than Claude's tags need.
  const sourceTagWidth = Math.max(SOURCE_TAG_WIDTH, ...filtered.map((cmd) => (cmd.source?.length ?? 0) + 1));

  // The menu sits right above the input, so the screen row of its bottom edge is the number of free rows above.
  const { height: terminalHeight } = useTerminalDimensions();
  const [measuredRows, setMeasuredRows] = useState<number | null>(null);
  const measure = useCallback(() => {
    const menu = scrollRef.current;
    if (menu) setMeasuredRows(menu.y + menu.height);
  }, [scrollRef]);
  // After a resize the new layout is not computed yet: measure once it is (growing the terminal moves the menu
  // without resizing it, so its own onSizeChange would not fire), and on the next tick for the first render.
  const renderer = useRenderer();
  useEffect(() => {
    renderer.root.on("layout-changed", measure);
    return () => {
      renderer.root.off("layout-changed", measure);
    };
  }, [renderer, measure]);
  // A resize can reach this effect before the layout does, and no later layout event is guaranteed: measure once
  // the root has the terminal's height (bounded, ~0.5 s), so the menu never keeps a size computed for the old screen.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let tries = 0;
    const measureWhenLaidOut = () => {
      if (renderer.root.height !== terminalHeight && tries++ < 30) {
        timer = setTimeout(measureWhenLaidOut, 16);
        return;
      }
      measure();
    };
    timer = setTimeout(measureWhenLaidOut, 0);
    return () => clearTimeout(timer);
  }, [measure, renderer, terminalHeight, filtered.length]);
  const visibleHeight = Math.min(filtered.length, menuRowLimit(measuredRows ?? terminalHeight - ROWS_BELOW_MENU));

  if (filtered.length === 0) {
    return (
      <box paddingX={1}>
        <text attributes={TextAttributes.DIM}>
          No matching commands
        </text>
      </box>
    );
  }

  return (
    <scrollbox ref={scrollRef} height={visibleHeight} onSizeChange={measure}>
      {filtered.map((cmd, i) => {
        const isSelected = i === selectedIndex;

        return (
          <box
            key={cmd.value}
            flexDirection="row"
            paddingX={1}
            height={1}
            overflow="hidden"
            backgroundColor={isSelected ? colors.selection : undefined}
            onMouseMove={() => onSelect(i)}
            onMouseDown={() => onExecute(i)}
          >
            <box width={commandColWidth} flexShrink={0}>
              <text selectable={false} fg={isSelected ? "black" : "white"}>
                /{cmd.name}
              </text>
            </box>
            <box flexGrow={1} flexShrink={1} overflow="hidden">
              <text selectable={false} fg={isSelected ? "black" : "gray"}>
                {cmd.argumentHint ? `${cmd.argumentHint} ${cmd.description}` : cmd.description}
              </text>
            </box>
            <box width={sourceTagWidth} alignItems="flex-end" flexShrink={0}>
              <text selectable={false} fg={isSelected ? "black" : "gray"} attributes={TextAttributes.DIM}>
                {cmd.source ?? ""}
              </text>
            </box>
          </box>
        );
      })}
    </scrollbox>
  );
};
