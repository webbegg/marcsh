import { useCallback, useMemo, useRef, useState } from "react";
import { TextAttributes, type BoxRenderable, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { getFilteredCommands } from "./command-menu/filter-commands";
import type { Command } from "./command-menu/types";
import { fitText } from "../lib/fit-text";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";

const MAX_VISIBLE_ITEMS = 8;
const MAX_NAME_COL_WIDTH = 20;
// The wide dialog (providers/dialog) is up to 100 columns, 4 less than the terminal, and pads its content by 4 on each side.
const WIDE_DIALOG_WIDTH = 100;
const DIALOG_MARGIN = 4;
const DIALOG_PADDING_X = 4;

type Props = {
  /** Every command the prompt can run, in the order the `/` menu lists them. */
  commands: Command[];
  /** The keys that run a command (`ctrl+x n`), by command name. */
  keys: Readonly<Record<string, string>>;
  onSelect: (command: Command) => void;
};

/**
 * The content of the palette dialog: a search field over every command, filtered the way the `/` menu filters (the letters typed
 * must appear in the name in order). Up and Down move, Enter picks, and the dialog's Esc closes it.
 */
export function CommandPalette({ commands, keys, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<InputRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const rootRef = useRef<BoxRenderable>(null);
  const measure = useCallback(() => {
    const width = rootRef.current?.width ?? 0;
    if (width > 0) setMeasuredWidth(width);
  }, []);
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();
  // The cells a row has: measured once laid out; until then what the wide dialog gives at this terminal width.
  const { width: terminalWidth } = useTerminalDimensions();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const rowWidth = measuredWidth ?? Math.min(WIDE_DIALOG_WIDTH, terminalWidth - DIALOG_MARGIN) - 2 * DIALOG_PADDING_X;

  const filtered = useMemo(() => getFilteredCommands(query, commands), [query, commands]);
  const visibleHeight = Math.min(filtered.length, MAX_VISIBLE_ITEMS);
  const nameWidth = Math.min(MAX_NAME_COL_WIDTH, Math.max(...filtered.map((command) => command.name.length), 0) + 3);
  const keysWidth = Math.max(...filtered.map((command) => keys[command.name]?.length ?? 0), 0);
  // What a description may take: the row (the list's scrollbar takes a column when it scrolls), less the name column and the keys column.
  const scrollbarWidth = filtered.length > MAX_VISIBLE_ITEMS ? 1 : 0;
  const descriptionCells = rowWidth - scrollbarWidth - nameWidth - (keysWidth > 0 ? keysWidth + 1 : 0);

  const handleContentChange = useCallback(() => {
    setQuery(inputRef.current?.value ?? "");
    setSelectedIndex(0);
    scrollRef.current?.scrollTo(0);
  }, []);

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;

    if (key.name === "return" || key.name === "enter") {
      const command = filtered[selectedIndex];
      if (command) onSelect(command);
    } else if (key.name === "up") {
      setSelectedIndex((index) => {
        const next = Math.max(0, index - 1);
        const scrollbox = scrollRef.current;
        if (scrollbox && next < scrollbox.scrollTop) scrollbox.scrollTo(next);
        return next;
      });
    } else if (key.name === "down") {
      setSelectedIndex((index) => {
        const next = Math.max(0, Math.min(filtered.length - 1, index + 1));
        const scrollbox = scrollRef.current;
        if (scrollbox) {
          const visibleEnd = scrollbox.scrollTop + scrollbox.viewport.height - 1;
          if (next > visibleEnd) scrollbox.scrollTo(next - scrollbox.viewport.height + 1);
        }
        return next;
      });
    }
  });

  return (
    <box flexDirection="column" gap={1} onSizeChange={() => measure()} ref={rootRef}>
      <input ref={inputRef} placeholder="Search commands" focused onContentChange={handleContentChange} />
      {filtered.length === 0 ? (
        <text attributes={TextAttributes.DIM}>No matching commands</text>
      ) : (
        <scrollbox ref={scrollRef} height={visibleHeight}>
          {filtered.map((command, index) => {
            const isSelected = index === selectedIndex;
            return (
              <box
                key={command.value}
                flexDirection="row"
                height={1}
                overflow="hidden"
                backgroundColor={isSelected ? colors.selection : undefined}
                onMouseMove={() => setSelectedIndex(index)}
                onMouseDown={() => onSelect(command)}
              >
                <box width={nameWidth} flexShrink={0}>
                  <text selectable={false} fg={isSelected ? "black" : "white"}>
                    /{command.name}
                  </text>
                </box>
                <box flexGrow={1} flexShrink={1} overflow="hidden">
                  <text selectable={false} fg={isSelected ? "black" : "gray"}>
                    {fitText(command.argumentHint ? `${command.argumentHint} ${command.description}` : command.description, descriptionCells)}
                  </text>
                </box>
                {keysWidth > 0 && (
                  <box width={keysWidth + 1} alignItems="flex-end" flexShrink={0}>
                    <text selectable={false} fg={isSelected ? "black" : "gray"} attributes={TextAttributes.DIM}>
                      {keys[command.name] ?? ""}
                    </text>
                  </box>
                )}
              </box>
            );
          })}
        </scrollbox>
      )}
    </box>
  );
}
