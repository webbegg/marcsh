import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helpKeyRows, paletteKeyHint } from "./help-keys";
import { loadKeybinds, parseKeybinds, resetKeybinds } from "./keybinds";

const COMMANDS = ["new", "models", "sessions", "agents", "theme", "engine", "undo", "redo", "diff", "compact", "copy", "fork", "export", "rename", "exit"];
const rows = (json?: string) => helpKeyRows(json === undefined ? loadKeybinds(COMMANDS) : parseKeybinds(json, COMMANDS).keybinds);
const keysFor = (list: { keys: string; action: string }[], action: string) => list.find((row) => row.action === action)?.keys;

const dirs: string[] = [];
const previousPath = process.env.MARCSH_KEYBINDS_PATH;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previousPath === undefined) delete process.env.MARCSH_KEYBINDS_PATH;
  else process.env.MARCSH_KEYBINDS_PATH = previousPath;
  resetKeybinds();
});

describe("helpKeyRows", () => {
  test("lists the default palette, leader, paste and command keys", () => {
    const list = rows("{}");
    expect(keysFor(list, "Open the command palette")).toBe("ctrl+p");
    expect(keysFor(list, "Start a leader key: press a key after it to run a command")).toBe("ctrl+x");
    expect(keysFor(list, "Paste from the clipboard")).toBe("ctrl+v");
    expect(keysFor(list, "/new")).toBe("ctrl+x n");
    expect(keysFor(list, "/models")).toBe("ctrl+x m");
    expect(keysFor(list, "/exit")).toBe("ctrl+x q");
  });

  test("lists the keys that are fixed", () => {
    const list = rows("{}");
    expect(keysFor(list, "Send the message")).toBe("Enter");
    expect(keysFor(list, "New line")).toBe("Shift+Enter, ctrl+j");
    expect(keysFor(list, "Switch agent")).toBe("Tab");
    expect(keysFor(list, "Stop a running reply, close a menu or dialog")).toBe("Esc");
    expect(keysFor(list, "Quit (press twice)")).toBe("Ctrl+C");
    expect(keysFor(list, "Mention a file or folder")).toBe("@");
    expect(keysFor(list, "Earlier prompts")).toBe("Up / Down");
    expect(keysFor(list, "Open this help (on an empty prompt)")).toBe("?");
  });

  test("a rebound command shows its new key, not the default", () => {
    const list = rows(JSON.stringify({ models: ["<leader>l", "alt+m"] }));
    expect(keysFor(list, "/models")).toBe("ctrl+x l, alt+m");
    expect(list.some((row) => row.keys === "ctrl+x m")).toBe(false);
  });

  test("a rebound palette shows its new key", () => {
    expect(keysFor(rows(JSON.stringify({ palette: ["ctrl+k", "f2"] })), "Open the command palette")).toBe("ctrl+k, f2");
  });

  test("an unbound palette, command or paste is left out", () => {
    const list = rows(JSON.stringify({ palette: [], theme: [], paste: [] }));
    expect(keysFor(list, "Open the command palette")).toBeUndefined();
    expect(keysFor(list, "/theme")).toBeUndefined();
    expect(keysFor(list, "Paste from the clipboard")).toBeUndefined();
    expect(keysFor(list, "/new")).toBe("ctrl+x n");
  });

  test("with the leader off, the leader and the keys after it are left out; direct keys stay", () => {
    const list = rows(JSON.stringify({ leader: [], models: ["<leader>l", "alt+m"], theme: ["<leader>t"] }));
    expect(keysFor(list, "Start a leader key: press a key after it to run a command")).toBeUndefined();
    expect(keysFor(list, "/new")).toBeUndefined();
    expect(keysFor(list, "/theme")).toBeUndefined();
    expect(keysFor(list, "/models")).toBe("alt+m");
    expect(keysFor(list, "Open the command palette")).toBe("ctrl+p");
  });

  test("follows the keybinds file that is loaded (a temporary MARCSH_KEYBINDS_PATH)", () => {
    const dir = mkdtempSync(join(tmpdir(), "marcsh-help-keys-"));
    dirs.push(dir);
    writeFileSync(join(dir, "keybinds.json"), JSON.stringify({ models: ["ctrl+o"] }));
    process.env.MARCSH_KEYBINDS_PATH = join(dir, "keybinds.json");
    resetKeybinds();
    expect(keysFor(helpKeyRows(loadKeybinds(COMMANDS)), "/models")).toBe("ctrl+o");
  });
});

describe("paletteKeyHint", () => {
  const hint = (json: string) => paletteKeyHint(parseKeybinds(json, COMMANDS).keybinds);

  test("is ctrl+p by default", () => expect(hint("{}")).toBe("ctrl+p"));
  test("is the rebound key", () => expect(hint(JSON.stringify({ palette: ["ctrl+k", "ctrl+p"] }))).toBe("ctrl+k"));
  test("is a key after the leader as the leader and the key", () => expect(hint(JSON.stringify({ palette: ["<leader>k"] }))).toBe("ctrl+x k"));
  test("is null when the palette is unbound", () => expect(hint(JSON.stringify({ palette: [] }))).toBeNull());
  test("skips a key after the leader when the leader is off", () => {
    expect(hint(JSON.stringify({ leader: [], palette: ["<leader>k", "alt+k"] }))).toBe("alt+k");
    expect(hint(JSON.stringify({ leader: [], palette: ["<leader>k"] }))).toBeNull();
  });
});
