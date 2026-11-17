import { useCallback, useRef, useState, type ReactNode } from "react";
import { TextAttributes, type BoxRenderable, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";

const MAX_VISIBLE_ITEMS = 6;
// The dialog (providers/dialog) is up to 60 columns (100 when wide), 4 less than the terminal, and pads its content by 4 on each side.
const DIALOG_WIDTH = 60;
const DIALOG_MARGIN = 4;
const DIALOG_PADDING_X = 4;

type DialogSearchListProps<T> = {
  items: T[];
  onSelect: (item: T) => void;
  onHighlight?: (item: T) => void;
  filterFn: (item: T, query: string) => boolean;
  /** `width` is the cells the row has (the list's scrollbar apart): text that may not fit goes through `fitText(text, cells)`. */
  renderItem: (item: T, isSelected: boolean, width: number) => ReactNode;
  getKey: (item: T) => string;
  placeholder?: string;
  emptyText?: string;
};

export function DialogSearchList<T>({
  items,
  onSelect,
  onHighlight,
  filterFn,
  renderItem,
  getKey,
  placeholder = "Search",
  emptyText = "No results",
}: DialogSearchListProps<T>) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchValue, setSearchValue] = useState("");
  const inputRef = useRef<InputRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();
  const rootRef = useRef<BoxRenderable>(null);
  const { width: terminalWidth } = useTerminalDimensions();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);

  const handleContentChange = useCallback(() => {
    const text = inputRef.current?.value ?? "";
    setSearchValue(text);
    setSelectedIndex(0);

    const scrollbox = scrollRef.current;
    if (scrollbox) {
      scrollbox.scrollTo(0);
    }
  }, []);
    
  const filtered = searchValue 
    ? items.filter((item) => filterFn(item, searchValue)) : items;

  const visibleHeight = Math.min(filtered.length, MAX_VISIBLE_ITEMS);
  // Measured once laid out; until then what the dialog gives at this terminal width. A scrolling list's scrollbar takes a column.
  const rowWidth =
    (measuredWidth ?? Math.min(DIALOG_WIDTH, terminalWidth - DIALOG_MARGIN) - 2 * DIALOG_PADDING_X) - (filtered.length > MAX_VISIBLE_ITEMS ? 1 : 0);

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;

    if (key.name === "return" || key.name === "enter") {
      const item = filtered[selectedIndex];
      if (item) {
        onSelect(item);
      }
    } else if (key.name === "up") {
      setSelectedIndex((i) => {
        const newIndex = Math.max(0, i - 1);
        const sb = scrollRef.current;
        if (sb && newIndex < sb.scrollTop) {
          sb.scrollTo(newIndex);
        }
        const item = filtered[newIndex];
        if (item && onHighlight) onHighlight(item);
        return newIndex;
      });
    } else if (key.name === "down") {
      setSelectedIndex((i) => {
        const newIndex = Math.min(filtered.length - 1, i + 1);
        const sb = scrollRef.current;
        if (sb) {
          const viewportHeight = sb.viewport.height;
          const visibleEnd = sb.scrollTop + viewportHeight - 1;
          if (newIndex > visibleEnd) {
            sb.scrollTo(newIndex - viewportHeight + 1);
          }
        }
        const item = filtered[newIndex];
        if (item && onHighlight) onHighlight(item);
        return newIndex;
      });
    }
  });

  return (
    <box
      ref={rootRef}
      flexDirection="column"
      gap={1}
      onSizeChange={() => {
        const width = rootRef.current?.width ?? 0;
        if (width > 0) setMeasuredWidth(width);
      }}
    >
      <input
        ref={inputRef}
        placeholder={placeholder}
        focused
        onContentChange={handleContentChange}
      />
      {filtered.length === 0 ? (
        <text attributes={TextAttributes.DIM}>
          {emptyText}
        </text>
      ) : (
        <scrollbox ref={scrollRef} height={visibleHeight}>
          {filtered.map((item, i) => {
            const isSelected = i === selectedIndex;
            return (
              <box
                key={getKey(item)}
                flexDirection="row"
                height={1}
                overflow="hidden"
                backgroundColor={isSelected ? colors.selection : undefined}
                onMouseMove={() => {
                  setSelectedIndex(i);
                  if (onHighlight) onHighlight(item);
                }}
                onMouseDown={() => onSelect(item)}
              >
                {renderItem(item, isSelected, rowWidth)}
              </box>
            )
          })}
        </scrollbox>
      )}
    </box>
  );
};
