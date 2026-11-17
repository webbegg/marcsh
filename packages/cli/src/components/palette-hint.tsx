import { TextAttributes } from "@opentui/core";
import { COMMAND_NAMES } from "./command-menu/commands";
import { paletteKeyHint } from "../lib/help-keys";
import { loadKeybinds, loadedKeybinds, type Keybinds } from "../lib/keybinds";

/** The keybinds in use: the ones the prompt loaded, or (before any screen has) the file's, read once. */
export const activeKeybinds = (): Keybinds => loadedKeybinds() ?? loadKeybinds(COMMAND_NAMES);

/** The footer hint beside `tab agents` (S15): the palette's key and `commands`, in the same styling. Nothing when the palette is unbound. */
export function PaletteHint() {
  const key = paletteKeyHint(activeKeybinds());
  if (key === null) return null;
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text>{key}</text>
      <text attributes={TextAttributes.DIM}>commands</text>
    </box>
  );
}
