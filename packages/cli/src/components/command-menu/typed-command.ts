import type { Command } from "./types";

/** What Enter does with the `/` menu open: run a command, say the name is not one, or leave the text for the prompt to send. */
export type TypedCommand = { run: Command } | { unknown: true } | { send: true };

/**
 * Decides what Enter does in the `/` menu, from what the user typed and not from what the fuzzy list ranks first (`/he` must never
 * open `/theme`). `query` is the text after the `/`; `commands` is the list as the menu shows it, and `selectedIndex` its highlighted row.
 *
 * - A row the user moved to (arrows, mouse: `navigated`) runs, whatever was typed.
 * - Otherwise the first word of `query` must be the name of a command, or the start of exactly one name (`/mod` → `/models`).
 *   An exact name wins over longer names that start with it. What follows the name is the command's arguments, not matched here.
 * - A text with a `/` in its name (`/usr/bin/env`) is a path in a prompt, not a command: it is sent as typed.
 * - Anything else (no match, or a prefix that several names start) is `unknown`.
 */
export function typedCommand(query: string, commands: readonly Command[], navigated: boolean, selectedIndex = 0): TypedCommand {
  if (navigated) {
    const highlighted = commands[selectedIndex];
    return highlighted ? { run: highlighted } : { unknown: true };
  }
  const name = query.trimStart().split(/\s/, 1)[0]!.toLowerCase();
  if (name.includes("/")) return { send: true };
  if (name.length === 0) return { unknown: true };
  const exact = commands.find((command) => command.name.toLowerCase() === name);
  if (exact) return { run: exact };
  const starting = commands.filter((command) => command.name.toLowerCase().startsWith(name));
  return starting.length === 1 ? { run: starting[0]! } : { unknown: true };
}
