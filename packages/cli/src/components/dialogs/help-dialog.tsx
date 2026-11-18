import { useMemo, useRef } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { Command, CommandContext } from "../command-menu/types";
import { loadMenuCommands } from "../command-menu/use-command-menu";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { fitText } from "../../lib/fit-text";
import { helpKeyRows, type HelpKeyRow } from "../../lib/help-keys";
import { printable } from "../../lib/safe-text";
import { activeKeybinds } from "../palette-hint";

// The first column holds the keys or the command's name; both sections share it.
const MAX_FIRST_COLUMN = 26;

// The dialog's own width: up to 100 columns, 4 cells of margin to the screen, and 4 cells of padding at each side.
const DIALOG_MAX_WIDTH = 100;
const DIALOG_CHROME = 4 + 8;

type Row = { kind: "heading" | "gap" | "key" | "command"; first: string; rest: string };

/** A pack's or an engine's text on one line, with nothing in it that the terminal would act on (the `/` menu strips a pack's the same way). */
const oneLine = (text: string) => printable(text.replace(/\s+/g, " ")).trim();

/**
 * The dialog's lines: the keys, then the commands (a name and its description, with the argument hint the `/` menu shows), and the width
 * of the first column. Long text is cut with `…` to fit `width` cells.
 */
export function helpRows(keys: readonly HelpKeyRow[], commands: readonly Command[], width: number): { rows: Row[]; column: number } {
  const names = commands.map((command) => `/${oneLine(command.name)}`);
  const widest = Math.max(...keys.map((row) => Bun.stringWidth(row.keys)), ...names.map((name) => Bun.stringWidth(name)), 0);
  const column = Math.min(MAX_FIRST_COLUMN, widest + 2);
  const room = Math.max(1, width - column);
  const rows: Row[] = [{ kind: "heading", first: "Keys", rest: "" }];
  for (const row of keys) rows.push({ kind: "key", first: fitText(row.keys, column - 1), rest: fitText(row.action, room) });
  rows.push({ kind: "gap", first: "", rest: "" }, { kind: "heading", first: "Commands", rest: "" });
  commands.forEach((command, index) => {
    const hint = oneLine(command.argumentHint ?? "");
    const description = oneLine(command.description);
    rows.push({ kind: "command", first: fitText(names[index]!, column - 1), rest: fitText(hint ? `${hint} ${description}` : description, room) });
  });
  return { rows, column };
}

type Props = { keys: readonly HelpKeyRow[]; commands: readonly Command[] };

/** The content of the help dialog: the keys and the commands in one list, scrolled with ↑↓, PageUp/PageDown, Home and End. */
export const HelpDialogContent = ({ keys, commands }: Props) => {
  const { colors } = useTheme();
  const { isTopLayer } = useKeyboardLayer();
  const { width, height } = useTerminalDimensions();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  // The list's scrollbar takes one more cell.
  const contentWidth = Math.max(20, Math.min(DIALOG_MAX_WIDTH, width - 4) - 8 - 1);
  const { rows, column } = useMemo(() => helpRows(keys, commands, contentWidth), [keys, commands, contentWidth]);
  // The dialog adds a title, padding and a footer around the list.
  const visible = Math.max(5, Math.min(rows.length, height - DIALOG_CHROME));

  useKeyboard((key) => {
    const scrollbox = scrollRef.current;
    if (!scrollbox || !isTopLayer("dialog")) return;
    if (key.name === "up") scrollbox.scrollBy(-1);
    else if (key.name === "down") scrollbox.scrollBy(1);
    else if (key.name === "pageup") scrollbox.scrollBy(-visible);
    else if (key.name === "pagedown") scrollbox.scrollBy(visible);
    else if (key.name === "home") scrollbox.scrollTo(0);
    else if (key.name === "end") scrollbox.scrollTo(scrollbox.scrollHeight);
  });

  return (
    <box flexDirection="column" gap={1}>
      <scrollbox ref={scrollRef} height={visible}>
        {rows.map((row, index) =>
          row.kind === "heading" ? (
            <text key={index} fg={colors.primary} attributes={TextAttributes.BOLD}>
              {row.first}
            </text>
          ) : row.kind === "gap" ? (
            <text key={index}> </text>
          ) : (
            <box key={index} flexDirection="row" height={1} overflow="hidden">
              <box width={column} flexShrink={0}>
                <text wrapMode="none" fg={row.kind === "key" ? colors.info : "white"}>
                  {row.first}
                </text>
              </box>
              <text wrapMode="none" attributes={row.kind === "command" ? TextAttributes.DIM : undefined}>
                {row.rest}
              </text>
            </box>
          ),
        )}
      </scrollbox>
      <text attributes={TextAttributes.DIM}>↑↓ PgUp PgDn scroll · esc close</text>
    </box>
  );
};

/** Opens the help dialog (`/help`, and `?` on an empty prompt): the keys as the active keybinds have them, and the commands this prompt can run (S12). */
export function openHelp(ctx: CommandContext): void {
  ctx.dialog.open({
    title: "Help",
    width: "wide",
    children: <HelpDialogContent keys={helpKeyRows(activeKeybinds())} commands={loadMenuCommands(ctx.engine, ctx.cwd, ctx.session !== null)} />,
  });
}
