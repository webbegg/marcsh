import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Key bindings: the command palette, the leader key and the keys that run a command. `~/.marcsh/keybinds.json` maps an action to a key
 * or a list of keys:
 *
 *   { "palette": ["ctrl+p"], "leader": ["ctrl+x"], "models": ["<leader>m", "alt+m"], "theme": [] }
 *
 * The actions are `palette`, `leader` and the name of a marcsh command (`new`, `models`, …). A key is modifiers joined with `+`
 * (`ctrl`, `alt`, `shift`) and a key name (a letter, digit or punctuation mark, `f1`–`f12`, `space`), as in `ctrl+p`; `<leader>n`
 * is `n` pressed after the leader. A key pressed directly needs `ctrl` or `alt`, so typing is never taken. The keys given for an
 * action replace its defaults and `[]` unbinds it. This module is pure apart from reading the file in `loadKeybinds`.
 */

export type Chord = { key: string; ctrl: boolean; alt: boolean; shift: boolean };
/** A chord pressed on its own, or (`leader`) after the leader key. */
export type Binding = { leader: boolean; chord: Chord };

export type Keybinds = {
  /** What opens the palette. */
  palette: Binding[];
  /** What starts a leader sequence: chords pressed directly. Empty turns the leader off. */
  leader: Chord[];
  /** The keys that run a marcsh command, by command name. */
  commands: Record<string, Binding[]>;
};

/** The part of a key event the bindings look at. */
export type KeyLike = { name: string; sequence?: string; ctrl?: boolean; meta?: boolean; option?: boolean; shift?: boolean; super?: boolean; hyper?: boolean };

export type KeyAction = { action: "palette" } | { action: "command"; name: string };

const DEFAULT_PALETTE = ["ctrl+p"];
const DEFAULT_LEADER = ["ctrl+x"];
/** The leader's keys, in the order the status line lists them. */
const DEFAULT_LEADER_KEYS: readonly (readonly [command: string, key: string])[] = [
  ["new", "n"],
  ["models", "m"],
  ["agents", "a"],
  ["sessions", "s"],
  ["theme", "t"],
  ["engine", "e"],
  ["permissions", "p"],
  ["undo", "u"],
  ["redo", "r"],
  ["diff", "d"],
  ["compact", "c"],
  ["copy", "y"],
  ["fork", "f"],
  ["export", "x"],
  ["exit", "q"],
];

const LEADER_PREFIX = /^<leader>/i;
const PLAIN_KEY = /^[a-z0-9`\-=[\]\\;',./]$/;
const FUNCTION_KEY = /^f(?:[1-9]|1[0-2])$/;
/** What a terminal sends for Enter, Tab and Esc (and ctrl+c, which quits): not keys to give away. */
const RESERVED_CTRL = new Set(["c", "i", "m", "j", "["]);

type Parsed = { ok: true; binding: Binding } | { ok: false; reason: string };

/** One key of the file: `ctrl+p`, `alt+shift+f5`, `<leader>n`. */
export function parseBinding(text: string): Parsed {
  const leader = LEADER_PREFIX.test(text);
  const tokens = text.replace(LEADER_PREFIX, "").toLowerCase().split("+");
  const key = tokens.pop() ?? "";
  if (key === "" || tokens.includes("")) return { ok: false, reason: "a key is missing" };
  if (!PLAIN_KEY.test(key) && !FUNCTION_KEY.test(key) && key !== "space") return { ok: false, reason: `"${key}" is not a key name` };

  const chord: Chord = { key, ctrl: false, alt: false, shift: false };
  for (const modifier of tokens) {
    const field = modifier === "ctrl" || modifier === "control" ? "ctrl" : modifier === "alt" || modifier === "meta" || modifier === "option" ? "alt" : modifier === "shift" ? "shift" : null;
    if (field === null) return { ok: false, reason: `"${modifier}" is not a modifier (use ctrl, alt or shift)` };
    if (chord[field]) return { ok: false, reason: `"${modifier}" is given twice` };
    chord[field] = true;
  }

  if (!leader) {
    if (!chord.ctrl && !chord.alt && !FUNCTION_KEY.test(key)) return { ok: false, reason: "a key pressed on its own needs ctrl or alt (or put it after <leader>)" };
    if (chord.ctrl && !chord.alt && RESERVED_CTRL.has(key)) return { ok: false, reason: `ctrl+${key} is Enter, Tab, Esc or quit and cannot be bound` };
  }
  return { ok: true, binding: { leader, chord } };
}

const mustParse = (text: string): Binding => {
  const parsed = parseBinding(text);
  if (!parsed.ok) throw new Error(`default key ${text}: ${parsed.reason}`);
  return parsed.binding;
};

export function formatChord(chord: Chord): string {
  return [chord.ctrl && "ctrl", chord.alt && "alt", chord.shift && "shift", chord.key].filter(Boolean).join("+");
}

/** The keys to press for a binding: `ctrl+p`, `ctrl+x n`. */
export function formatBinding(binding: Binding, leader: readonly Chord[]): string {
  const key = formatChord(binding.chord);
  return binding.leader ? `${leader[0] ? formatChord(leader[0]) : "<leader>"} ${key}` : key;
}

export function matchesChord(chord: Chord, key: KeyLike): boolean {
  if (!!key.ctrl !== chord.ctrl || !!(key.meta || key.option) !== chord.alt || !!key.shift !== chord.shift || key.super || key.hyper) return false;
  if (chord.key === "space") return key.name === "space" || key.sequence === " ";
  return key.name === chord.key || (chord.key.length === 1 && !chord.ctrl && !chord.alt && key.sequence === chord.key);
}

/** The action a key triggers: pressed on its own, or (`afterLeader`) after the leader key. */
export function resolveKey(keybinds: Keybinds, key: KeyLike, afterLeader: boolean): KeyAction | undefined {
  if (keybinds.palette.some((binding) => binding.leader === afterLeader && matchesChord(binding.chord, key))) return { action: "palette" };
  for (const [name, bindings] of Object.entries(keybinds.commands)) {
    if (bindings.some((binding) => binding.leader === afterLeader && matchesChord(binding.chord, key))) return { action: "command", name };
  }
  return undefined;
}

export const isLeaderKey = (keybinds: Keybinds, key: KeyLike): boolean => keybinds.leader.some((chord) => matchesChord(chord, key));

/** What the status line says while the leader waits for its key: several wordings, longest first. */
export function leaderHint(keybinds: Keybinds): string[] {
  const first = keybinds.leader[0];
  if (!first) return [];
  const leader = formatChord(first);
  const keys = Object.entries(keybinds.commands).flatMap(([name, bindings]) => {
    const binding = bindings.find((candidate) => candidate.leader);
    return binding ? [`${formatChord(binding.chord)} ${name}`] : [];
  });
  return [
    ...(keys.length > 0 ? [`${leader}: ${keys.slice(0, 2).join(" · ")} · esc cancels`] : []),
    `${leader}: press a key · esc cancels`,
    `${leader}…`,
  ];
}

function build(user: Map<string, Binding[]>, commands: readonly string[], warnings: string[]): Keybinds {
  const leader = (user.get("leader") ?? DEFAULT_LEADER.map(mustParse)).map((binding) => binding.chord);
  const palette = user.get("palette") ?? DEFAULT_PALETTE.map(mustParse);

  // Who holds each key. A key a user gave beats a default; two users' keys on one key is a mistake the first wins, and is said.
  const owners = new Map<string, string>();
  const take = (owner: string, binding: Binding, given: boolean): boolean => {
    const id = `${binding.leader ? "leader " : ""}${formatChord(binding.chord)}`;
    const held = owners.get(id);
    if (held === undefined) {
      owners.set(id, owner);
      return true;
    }
    if (given) warnings.push(`Keybinds: "${owner}" ignored on ${id}, already used by "${held}".`);
    return false;
  };

  for (const chord of leader) take("leader", { leader: false, chord }, true);
  const keybinds: Keybinds = { palette: [], leader, commands: {} };
  for (const binding of palette) if (take("palette", binding, true)) keybinds.palette.push(binding);

  for (const [name, bindings] of user) {
    if (name === "palette" || name === "leader") continue;
    keybinds.commands[name] = bindings.filter((binding) => take(name, binding, true));
  }
  for (const [name, key] of DEFAULT_LEADER_KEYS) {
    if (user.has(name) || !commands.includes(name)) continue;
    const binding = mustParse(`<leader>${key}`);
    if (take(name, binding, false)) keybinds.commands[name] = [binding];
  }
  return keybinds;
}

export const defaultKeybinds = (commands: readonly string[]): Keybinds => build(new Map(), commands, []);

const quote = (text: string) => JSON.stringify(text);

/**
 * The keybinds a file's text describes, over the defaults, with what was wrong in it. `commands` are the names of the commands that
 * can be bound. A file that is not a JSON object is invalid: the defaults and one warning. An unknown action or a key that cannot
 * be read is skipped with a warning.
 */
export function parseKeybinds(text: string, commands: readonly string[]): { keybinds: Keybinds; warnings: string[] } {
  const invalid = (reason: string) => ({ keybinds: defaultKeybinds(commands), warnings: [`Invalid keybinds file: ${reason}. Using the default keys.`] });
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return invalid(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return invalid("expected a JSON object mapping actions to keys");

  const warnings: string[] = [];
  const user = new Map<string, Binding[]>();
  for (const [action, value] of Object.entries(data)) {
    if (action !== "palette" && action !== "leader" && !commands.includes(action)) {
      warnings.push(`Keybinds: unknown action ${quote(action)} ignored.`);
      continue;
    }
    const entries = typeof value === "string" ? [value] : Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : null;
    if (entries === null) {
      warnings.push(`Keybinds: ${quote(action)} must be a key or a list of keys; ignored.`);
      continue;
    }
    const bindings: Binding[] = [];
    for (const entry of entries) {
      const parsed = parseBinding(entry);
      if (!parsed.ok) warnings.push(`Keybinds: ${quote(action)}: ${quote(entry)} ignored, ${parsed.reason}.`);
      else if (action === "leader" && parsed.binding.leader) warnings.push(`Keybinds: "leader": ${quote(entry)} ignored, the leader is pressed on its own.`);
      else bindings.push(parsed.binding);
    }
    // Nothing usable was given: the action keeps its defaults (an empty list is the way to unbind).
    if (bindings.length > 0 || entries.length === 0) user.set(action, bindings);
  }
  return { keybinds: build(user, commands, warnings), warnings };
}

/** Where the keybinds file is: `MARCSH_KEYBINDS_PATH`, else next to the preferences file, else `~/.marcsh/keybinds.json`. */
export function keybindsPath(): string {
  const own = process.env.MARCSH_KEYBINDS_PATH?.trim();
  if (own) return own;
  const preferences = process.env.MARCSH_PREFERENCES_PATH?.trim();
  return join(preferences ? dirname(preferences) : join(homedir(), ".marcsh"), "keybinds.json");
}

let loaded: Keybinds | null = null;
let pendingWarnings: string[] = [];

/** The keybinds, read from the file once (the first call); a missing file is the defaults. */
export function loadKeybinds(commands: readonly string[]): Keybinds {
  if (loaded) return loaded;
  let text: string | null = null;
  try {
    text = readFileSync(keybindsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      pendingWarnings = [`Could not read the keybinds file: ${error instanceof Error ? error.message : String(error)}. Using the default keys.`];
    }
  }
  if (text === null) {
    loaded = defaultKeybinds(commands);
  } else {
    const result = parseKeybinds(text, commands);
    loaded = result.keybinds;
    pendingWarnings = result.warnings;
  }
  return loaded;
}

/** What was wrong with the file, once: the screen that loaded it says so in a single toast. */
export function takeKeybindWarnings(): string[] {
  const warnings = pendingWarnings;
  pendingWarnings = [];
  return warnings;
}

/** Forgets what was read, so the next `loadKeybinds` reads the file again (tests). */
export function resetKeybinds() {
  loaded = null;
  pendingWarnings = [];
}
