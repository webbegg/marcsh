import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultKeybinds,
  formatBinding,
  keybindsPath,
  leaderHint,
  loadKeybinds,
  matchesChord,
  parseBinding,
  parseKeybinds,
  resetKeybinds,
  resolveKey,
  takeKeybindWarnings,
} from "./keybinds";

const COMMANDS = ["new", "models", "sessions", "agents", "theme", "engine", "undo", "redo", "diff", "compact", "copy", "fork", "export", "rename", "exit"];
const key = (name: string, extra: Record<string, boolean> = {}) => ({ name, ...extra });

describe("parseBinding", () => {
  test("reads modifiers and a key, in any case", () => {
    expect(parseBinding("Ctrl+P")).toEqual({ ok: true, binding: { leader: false, chord: { key: "p", ctrl: true, alt: false, shift: false } } });
    expect(parseBinding("alt+shift+f5")).toEqual({ ok: true, binding: { leader: false, chord: { key: "f5", ctrl: false, alt: true, shift: true } } });
    expect(parseBinding("meta+k")).toMatchObject({ ok: true, binding: { chord: { key: "k", alt: true } } });
  });

  test("`<leader>` puts the key after the leader, where no modifier is needed", () => {
    expect(parseBinding("<leader>n")).toEqual({ ok: true, binding: { leader: true, chord: { key: "n", ctrl: false, alt: false, shift: false } } });
    expect(parseBinding("<leader>ctrl+n")).toMatchObject({ ok: true, binding: { leader: true, chord: { key: "n", ctrl: true } } });
  });

  test("refuses what cannot be a key", () => {
    for (const text of ["", "ctrl+", "ctrl+pp", "hyper+p", "ctrl+escape", "<leader>", "ctrl+ctrl"]) {
      expect(parseBinding(text).ok).toBe(false);
    }
  });

  test("a key pressed directly needs ctrl or alt (or is a function key), so typing is never taken", () => {
    expect(parseBinding("p").ok).toBe(false);
    expect(parseBinding("shift+p").ok).toBe(false);
    expect(parseBinding("f2").ok).toBe(true);
  });

  test("keys the terminal sends as Enter, Tab or Esc and ctrl+c cannot be bound", () => {
    for (const text of ["ctrl+c", "ctrl+i", "ctrl+m", "ctrl+j", "ctrl+["]) expect(parseBinding(text).ok).toBe(false);
    expect(parseBinding("<leader>c").ok).toBe(true);
  });
});

describe("matchesChord", () => {
  const ctrlP = { key: "p", ctrl: true, alt: false, shift: false };
  test("matches the name and exactly the modifiers", () => {
    expect(matchesChord(ctrlP, key("p", { ctrl: true }))).toBe(true);
    expect(matchesChord(ctrlP, key("p"))).toBe(false);
    expect(matchesChord(ctrlP, key("p", { ctrl: true, shift: true }))).toBe(false);
    expect(matchesChord(ctrlP, key("o", { ctrl: true }))).toBe(false);
    expect(matchesChord(ctrlP, key("p", { ctrl: true, super: true }))).toBe(false);
  });
  test("alt is meta or option", () => {
    const altK = { key: "k", ctrl: false, alt: true, shift: false };
    expect(matchesChord(altK, key("k", { meta: true }))).toBe(true);
    expect(matchesChord(altK, key("k", { option: true }))).toBe(true);
  });
});

describe("the defaults", () => {
  const kb = defaultKeybinds(COMMANDS);
  test("ctrl+p opens the palette and ctrl+x is the leader", () => {
    expect(resolveKey(kb, key("p", { ctrl: true }), false)).toEqual({ action: "palette" });
    expect(kb.leader).toEqual([{ key: "x", ctrl: true, alt: false, shift: false }]);
  });
  test("after the leader, a key runs its command", () => {
    expect(resolveKey(kb, key("n"), true)).toEqual({ action: "command", name: "new" });
    expect(resolveKey(kb, key("m"), true)).toEqual({ action: "command", name: "models" });
    expect(resolveKey(kb, key("z"), true)).toBeUndefined();
  });
  test("a default for a command marcsh does not have is left out", () => {
    expect(resolveKey(defaultKeybinds(["new"]), key("m"), true)).toBeUndefined();
  });
  test("the status line lists what the leader offers, longest wording first", () => {
    const hints = leaderHint(kb);
    expect(hints.length).toBeGreaterThan(1);
    expect(hints[0]).toContain("n new");
    expect(hints[0]!.length).toBeGreaterThan(hints.at(-1)!.length);
    expect(hints.at(-1)).toContain("ctrl+x");
  });
  test("a binding reads back as the keys to press", () => {
    expect(formatBinding({ leader: true, chord: { key: "n", ctrl: false, alt: false, shift: false } }, kb.leader)).toBe("ctrl+x n");
    expect(formatBinding({ leader: false, chord: { key: "p", ctrl: true, alt: false, shift: false } }, kb.leader)).toBe("ctrl+p");
  });
});

describe("parseKeybinds", () => {
  test("an empty object keeps every default", () => {
    expect(parseKeybinds("{}", COMMANDS)).toEqual({ keybinds: defaultKeybinds(COMMANDS), warnings: [] });
  });

  test("the palette and the leader can be moved to other keys", () => {
    const { keybinds, warnings } = parseKeybinds(JSON.stringify({ palette: ["ctrl+k", "f1"], leader: "ctrl+space" }), COMMANDS);
    expect(warnings).toEqual([]);
    expect(resolveKey(keybinds, key("k", { ctrl: true }), false)).toEqual({ action: "palette" });
    expect(resolveKey(keybinds, key("f1"), false)).toEqual({ action: "palette" });
    expect(resolveKey(keybinds, key("p", { ctrl: true }), false)).toBeUndefined();
    expect(keybinds.leader).toHaveLength(1);
  });

  test("a command's keys replace its default; the others keep theirs", () => {
    const { keybinds, warnings } = parseKeybinds(JSON.stringify({ models: ["<leader>o", "alt+m"] }), COMMANDS);
    expect(warnings).toEqual([]);
    expect(resolveKey(keybinds, key("o"), true)).toEqual({ action: "command", name: "models" });
    expect(resolveKey(keybinds, key("m", { meta: true }), false)).toEqual({ action: "command", name: "models" });
    expect(resolveKey(keybinds, key("m"), true)).toBeUndefined();
    expect(resolveKey(keybinds, key("n"), true)).toEqual({ action: "command", name: "new" });
  });

  test("an empty list unbinds the action", () => {
    const { keybinds } = parseKeybinds(JSON.stringify({ palette: [], new: [] }), COMMANDS);
    expect(resolveKey(keybinds, key("p", { ctrl: true }), false)).toBeUndefined();
    expect(resolveKey(keybinds, key("n"), true)).toBeUndefined();
  });

  test("a key a user gave wins over another command's default", () => {
    const { keybinds, warnings } = parseKeybinds(JSON.stringify({ models: ["<leader>n"] }), COMMANDS);
    expect(warnings).toEqual([]);
    expect(resolveKey(keybinds, key("n"), true)).toEqual({ action: "command", name: "models" });
  });

  test("two user bindings on one key: the first wins and one warning says so", () => {
    const { keybinds, warnings } = parseKeybinds(JSON.stringify({ palette: ["ctrl+k"], theme: ["ctrl+k"] }), COMMANDS);
    expect(resolveKey(keybinds, key("k", { ctrl: true }), false)).toEqual({ action: "palette" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ctrl+k");
  });

  test("an unknown action is ignored with a warning, the rest applies", () => {
    const { keybinds, warnings } = parseKeybinds(JSON.stringify({ banana: ["ctrl+b"], palette: ["ctrl+k"] }), COMMANDS);
    expect(warnings).toEqual(['Keybinds: unknown action "banana" ignored.']);
    expect(resolveKey(keybinds, key("k", { ctrl: true }), false)).toEqual({ action: "palette" });
    expect(resolveKey(keybinds, key("b", { ctrl: true }), false)).toBeUndefined();
  });

  test("a key that is not valid is ignored with a warning, and the action keeps its default when none is left", () => {
    const { keybinds, warnings } = parseKeybinds(JSON.stringify({ palette: ["ctrl+"], theme: ["alt+t", "nope+"] }), COMMANDS);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"palette"');
    expect(warnings[1]).toContain('"theme"');
    expect(resolveKey(keybinds, key("p", { ctrl: true }), false)).toEqual({ action: "palette" });
    expect(resolveKey(keybinds, key("t", { meta: true }), false)).toEqual({ action: "command", name: "theme" });
  });

  test("a value that is neither a key nor a list of keys is ignored with a warning", () => {
    const { keybinds, warnings } = parseKeybinds(JSON.stringify({ palette: 3, theme: [1] }), COMMANDS);
    expect(warnings).toHaveLength(2);
    expect(keybinds).toEqual(defaultKeybinds(COMMANDS));
  });

  test("the leader takes a key pressed directly only", () => {
    const { keybinds, warnings } = parseKeybinds(JSON.stringify({ leader: ["<leader>x"] }), COMMANDS);
    expect(warnings).toHaveLength(1);
    expect(keybinds.leader).toEqual(defaultKeybinds(COMMANDS).leader);
  });

  test("an empty leader list turns the leader off, and its keys with it", () => {
    const { keybinds } = parseKeybinds(JSON.stringify({ leader: [] }), COMMANDS);
    expect(keybinds.leader).toEqual([]);
    expect(resolveKey(keybinds, key("x", { ctrl: true }), false)).toBeUndefined();
  });

  test("text that is not JSON, or not an object, is invalid: one warning and the defaults", () => {
    for (const text of ["{ nope", "[]", '"palette"', "null", ""]) {
      const result = parseKeybinds(text, COMMANDS);
      expect(result.keybinds).toEqual(defaultKeybinds(COMMANDS));
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("Using the default keys");
    }
  });
});

describe("loading the file", () => {
  let dir: string | undefined;
  const saved = { keybinds: process.env.MARCSH_KEYBINDS_PATH, preferences: process.env.MARCSH_PREFERENCES_PATH };
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    for (const [name, value] of [["MARCSH_KEYBINDS_PATH", saved.keybinds], ["MARCSH_PREFERENCES_PATH", saved.preferences]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetKeybinds();
  });
  const fileWith = (text: string) => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-keybinds-"));
    const path = join(dir, "keybinds.json");
    writeFileSync(path, text);
    process.env.MARCSH_KEYBINDS_PATH = path;
    resetKeybinds();
  };

  test("MARCSH_KEYBINDS_PATH wins; else the folder of the preferences file; else ~/.marcsh", () => {
    process.env.MARCSH_KEYBINDS_PATH = "/x/keys.json";
    expect(keybindsPath()).toBe("/x/keys.json");
    delete process.env.MARCSH_KEYBINDS_PATH;
    process.env.MARCSH_PREFERENCES_PATH = "/y/preferences.json";
    expect(keybindsPath()).toBe(join("/y", "keybinds.json"));
    delete process.env.MARCSH_PREFERENCES_PATH;
    expect(keybindsPath().endsWith(join(".marcsh", "keybinds.json"))).toBe(true);
  });

  test("a missing file is the defaults, with no warning", () => {
    process.env.MARCSH_KEYBINDS_PATH = join(tmpdir(), `marcsh-no-such-${process.pid}`, "keybinds.json");
    resetKeybinds();
    expect(loadKeybinds(COMMANDS)).toEqual(defaultKeybinds(COMMANDS));
    expect(takeKeybindWarnings()).toEqual([]);
  });

  test("the file is read once; its warnings are handed out once", () => {
    fileWith(JSON.stringify({ palette: ["ctrl+k"], banana: ["x"] }));
    const first = loadKeybinds(COMMANDS);
    expect(resolveKey(first, key("k", { ctrl: true }), false)).toEqual({ action: "palette" });
    writeFileSync(process.env.MARCSH_KEYBINDS_PATH!, "{}");
    expect(loadKeybinds(COMMANDS)).toBe(first);
    expect(takeKeybindWarnings()).toHaveLength(1);
    expect(takeKeybindWarnings()).toEqual([]);
  });

  test("an invalid file gives the defaults and one warning", () => {
    fileWith("{ not json");
    expect(loadKeybinds(COMMANDS)).toEqual(defaultKeybinds(COMMANDS));
    expect(takeKeybindWarnings()).toHaveLength(1);
  });
});
