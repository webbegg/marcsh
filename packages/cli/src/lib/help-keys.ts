import { formatBinding, formatChord, type Binding, type Keybinds } from "./keybinds";

/** One line of the help dialog's keys section: the keys to press and what they do. */
export type HelpKeyRow = { keys: string; action: string };

/** The keys that cannot be changed (see docs/keybinds.md), before the ones that can. */
const FIXED_KEYS: readonly HelpKeyRow[] = [
  { keys: "Enter", action: "Send the message" },
  { keys: "Shift+Enter, ctrl+j", action: "New line" },
  { keys: "Tab", action: "Switch agent" },
  { keys: "Esc", action: "Stop a running reply, close a menu or dialog" },
  { keys: "Ctrl+C", action: "Quit (press twice)" },
  { keys: "@", action: "Mention a file or folder" },
  { keys: "Up / Down", action: "Earlier prompts" },
  { keys: "?", action: "Open this help (on an empty prompt)" },
];

/** The bindings that can be pressed: one after the leader needs a leader that is on. */
const usable = (bindings: readonly Binding[], keybinds: Keybinds) => bindings.filter((binding) => !binding.leader || keybinds.leader.length > 0);

const joined = (bindings: readonly Binding[], keybinds: Keybinds) => bindings.map((binding) => formatBinding(binding, keybinds.leader)).join(", ");

/**
 * The keys section of `/help`: the fixed keys, then the palette, the leader, paste and each command's keys as the loaded keybinds have
 * them, so a rebinding shows. An unbound action, and a key after a leader that is off, is left out.
 */
export function helpKeyRows(keybinds: Keybinds): HelpKeyRow[] {
  const rows: HelpKeyRow[] = [...FIXED_KEYS];
  const palette = usable(keybinds.palette, keybinds);
  if (palette.length > 0) rows.push({ keys: joined(palette, keybinds), action: "Open the command palette" });
  if (keybinds.leader.length > 0) {
    rows.push({ keys: keybinds.leader.map(formatChord).join(", "), action: "Start a leader key: press a key after it to run a command" });
  }
  const paste = usable(keybinds.paste, keybinds);
  if (paste.length > 0) rows.push({ keys: joined(paste, keybinds), action: "Paste from the clipboard" });
  for (const [name, bindings] of Object.entries(keybinds.commands)) {
    const pressable = usable(bindings, keybinds);
    if (pressable.length > 0) rows.push({ keys: joined(pressable, keybinds), action: `/${name}` });
  }
  return rows;
}

/** The palette's first key that can be pressed, for the footer hint (`ctrl+p`); null when the palette is unbound. */
export function paletteKeyHint(keybinds: Keybinds): string | null {
  const [first] = usable(keybinds.palette, keybinds);
  return first ? formatBinding(first, keybinds.leader) : null;
}
