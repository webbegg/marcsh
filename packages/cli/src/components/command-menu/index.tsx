import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import type { Command } from "./types";
import { groupOf } from "./filter-commands";
import { fitText } from "../../lib/fit-text";
import { useTheme } from "../../providers/theme";

// marcsh's own commands come first; room for all of them and the first Claude commands below.
const MAX_VISIBLE_ITEMS = 10;
const MIN_VISIBLE_ITEMS = 1;
// Rows the session layout keeps below the menu's anchor (the input) until the menu has been measured.
const ROWS_BELOW_MENU = 8;

/**
 * How many rows the menu may have when `rowsAbove` rows are free above the input (group header rows count: they are rows). The menu grows
 * upward from the input, so rows beyond the top of the screen would push the first, highlighted command out of view.
 */
export function menuRowLimit(rowsAbove: number): number {
  return Math.max(MIN_VISIBLE_ITEMS, Math.min(MAX_VISIBLE_ITEMS, Math.floor(rowsAbove)));
}
const MAX_COMMAND_COL_WIDTH = 32;
const SOURCE_TAG_WIDTH = 8;

type MenuRow = { kind: "header"; group: string; before: number } | { kind: "command"; index: number };

/**
 * The menu's rows: with no query, a dim header row before each run of commands of one group (`groupOf`); with a query, the commands alone, in
 * the order the filter ranked them. `index` is the command's place in `commands`, which is what selection and execution use; a header's
 * `before` is the index of the command it heads (it keeps the header's React key unique when a group comes up twice).
 */
export function menuRows(commands: readonly Command[], query: string): MenuRow[] {
  const rows: MenuRow[] = [];
  let group: string | null = null;
  commands.forEach((command, index) => {
    if (query === "" && groupOf(command) !== group) {
      group = groupOf(command);
      rows.push({ kind: "header", group, before: index });
    }
    rows.push({ kind: "command", index });
  });
  return rows;
}

type CommandMenuProps = {
  commands: Command[];
  /** What follows the `/` in the prompt. Empty (the default): the list is the whole list and gets group headers; otherwise it is ranked, ungrouped. */
  query?: string;
  selectedIndex: number;
  scrollRef: RefObject<ScrollBoxRenderable | null>;
  onSelect: (index: number) => void;
  onExecute: (index: number) => void;
};

export function CommandMenu({
  commands: filtered,
  query = "",
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
  // The cells a row has, scrollbar apart; until the menu is measured the terminal's width bounds it.
  const { width: terminalWidth } = useTerminalDimensions();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const measure = useCallback(() => {
    const menu = scrollRef.current;
    if (!menu) return;
    setMeasuredRows(menu.y + menu.height);
    if (menu.viewport.width > 0) setMeasuredWidth(menu.viewport.width);
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
  const rows = useMemo(() => menuRows(filtered, query), [filtered, query]);
  const visibleHeight = Math.min(rows.length, menuRowLimit(measuredRows ?? terminalHeight - ROWS_BELOW_MENU));

  // The selection moves over commands, the scroll over rows: keep the highlighted row in view, and its group's header with it when it is
  // the group's first command (the first command of the list shows the first header).
  useEffect(() => {
    const menu = scrollRef.current;
    if (!menu) return;
    const row = rows.findIndex((entry) => entry.kind === "command" && entry.index === selectedIndex);
    if (row < 0) return;
    // After the frame's layout, when the viewport has the height this render gave it.
    menu.afterLayout(() => {
      const viewport = menu.viewport.height;
      // The header goes with the command when there is room for both; with one row to show, the command wins.
      const top = rows[row - 1]?.kind === "header" && viewport >= 2 ? row - 1 : row;
      if (top < menu.scrollTop) menu.scrollTo(top);
      else if (viewport > 0 && row > menu.scrollTop + viewport - 1) menu.scrollTo(row - viewport + 1);
    });
  }, [rows, selectedIndex, scrollRef, visibleHeight, measuredRows]);

  // What a description may take: the row, less its padding and the name and source columns.
  const descriptionCells = (measuredWidth ?? terminalWidth) - 2 - commandColWidth - sourceTagWidth;

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
      {rows.map((row) => {
        if (row.kind === "header") {
          return (
            <box key={`group:${row.group}:${row.before}`} paddingX={1} height={1} overflow="hidden">
              <text selectable={false} attributes={TextAttributes.DIM}>
                {row.group}
              </text>
            </box>
          );
        }
        const i = row.index;
        const cmd = filtered[i]!;
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
                {fitText(cmd.argumentHint ? `${cmd.argumentHint} ${cmd.description}` : cmd.description, descriptionCells)}
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
