import type { RefObject } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { Command } from "./types";
import { useTheme } from "../../providers/theme";

// marcsh's own commands come first; room for all of them and the first Claude commands below.
const MAX_VISIBLE_ITEMS = 10;
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
  const visibleHeight = Math.min(filtered.length, MAX_VISIBLE_ITEMS);

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
    <scrollbox ref={scrollRef} height={visibleHeight}>
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
            <box width={SOURCE_TAG_WIDTH} alignItems="flex-end" flexShrink={0}>
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
