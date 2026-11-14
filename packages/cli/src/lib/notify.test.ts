import { describe, expect, test } from "bun:test";
import { appleScriptString, notifyTurnDone, type NotifyDeps } from "./notify";

function fake(platform: string) {
  const written: string[] = [];
  const spawned: string[][] = [];
  const deps: NotifyDeps = { platform, write: (text) => void written.push(text), spawn: (command) => void spawned.push(command) };
  return { deps, written, spawned };
}

describe("notifyTurnDone", () => {
  test("bell writes the bell character to the terminal and starts nothing", () => {
    const { deps, written, spawned } = fake("darwin");
    notifyTurnDone("t: done", "bell", deps);
    expect(written).toEqual(["\x07"]);
    expect(spawned).toEqual([]);
  });

  test("off does nothing", () => {
    const { deps, written, spawned } = fake("darwin");
    notifyTurnDone("t: done", "off", deps);
    expect(written).toEqual([]);
    expect(spawned).toEqual([]);
  });

  test("system on macOS runs osascript with an args array and no bell", () => {
    const { deps, written, spawned } = fake("darwin");
    notifyTurnDone("my chat: done", "system", deps);
    expect(written).toEqual([]);
    expect(spawned).toEqual([["osascript", "-e", 'display notification "my chat: done" with title "marcsh"']]);
  });

  test("system elsewhere falls back to the bell", () => {
    const { deps, written, spawned } = fake("linux");
    notifyTurnDone("t: done", "system", deps);
    expect(written).toEqual(["\x07"]);
    expect(spawned).toEqual([]);
  });

  test("system falls back to the bell when osascript cannot start", () => {
    const written: string[] = [];
    notifyTurnDone("t: done", "system", {
      platform: "darwin",
      write: (text) => void written.push(text),
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(written).toEqual(["\x07"]);
  });

  test("a title that tries to leave the AppleScript string stays text", () => {
    const { deps, spawned } = fake("darwin");
    notifyTurnDone('"; do shell script "touch /tmp/pwned" --\\', "system", deps);
    expect(spawned[0]![2]).toBe('display notification "\\"; do shell script \\"touch /tmp/pwned\\" --\\\\" with title "marcsh"');
  });
});

describe("appleScriptString", () => {
  test("escapes quotes and backslashes", () => {
    expect(appleScriptString('a"b\\c')).toBe('a\\"b\\\\c');
  });

  test("turns line breaks and other control characters into spaces", () => {
    expect(appleScriptString("a\nb\r\nc\x1b[31md")).toBe("a b  c [31md");
  });

  test("shortens a long text", () => {
    expect(appleScriptString("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });
});
