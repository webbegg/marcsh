import { useCallback, useMemo, useRef, useState } from "react";
import { TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { getFilteredCommands } from "./command-menu/filter-commands";
import type { Command } from "./command-menu/types";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";

const MAX_VISIBLE_ITEMS = 8;
const MAX_NAME_COL_WIDTH = 20;

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
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();

  const filtered = useMemo(() => getFilteredCommands(query, commands), [query, commands]);
  const visibleHeight = Math.min(filtered.length, MAX_VISIBLE_ITEMS);
  const nameWidth = Math.min(MAX_NAME_COL_WIDTH, Math.max(...filtered.map((command) => command.name.length), 0) + 3);
  const keysWidth = Math.max(...filtered.map((command) => keys[command.name]?.length ?? 0), 0);

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
    <box flexDirection="column" gap={1}>
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
                    {command.argumentHint ? `${command.argumentHint} ${command.description}` : command.description}
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
