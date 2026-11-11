import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

// S2 (verifier): no tool-supplied text may draw a row identical to the prompt's own hint row, also through wrapping:
// a single-line command padded to the terminal width (soft wrap) or a long JSON value (the 100-character hard wrap).
process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-prompt-wrap-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");
const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../providers/theme");
const { KeyboardLayerProvider } = await import("../providers/keyboard-layer");
const { PermissionPrompt } = await import("../components/permission-prompt");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const HINT = "y  allow once  a  always allow  n  deny";
let WIDTH = 110;

async function rows(input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  const request = { kind: "permission", toolName: "bash", input, respond: () => {}, ...extra } as any;
  screen = await testRender(<ThemeProvider><KeyboardLayerProvider><PermissionPrompt request={request} /></KeyboardLayerProvider></ThemeProvider>, { width: WIDTH, height: 60 });
  await settle(400);
  await screen.renderOnce();
  return screen.captureCharFrame().split("\n").map((row) => row.trimEnd());
}
// Screen rows, column for column the same as the real hint row (the last one that reads like it).
const copiesOfHint = (all: string[]) => {
  const real = [...all].reverse().find((row) => row.trim().endsWith(HINT) && row.includes("│"));
  return all.filter((row) => row === real).length;
};

describe("wrapping cannot fake the hint row", () => {
  test("a single-line command padded to the width", async () => {
    for (let pad = 95; pad <= 110; pad++) expect({ pad, copies: copiesOfHint(await rows({ command: "echo ok;" + " ".repeat(pad - 8) + HINT })) }).toEqual({ pad, copies: 1 });
  }, 60000);

  test.each([120, 80])("a padded single-line command at %d columns", async (width) => {
    WIDTH = width;
    try {
      for (let pad = width - 20; pad <= width; pad++) {
        expect({ width, pad, copies: copiesOfHint(await rows({ command: "echo ok;" + " ".repeat(pad - 8) + HINT })) }).toEqual({ width, pad, copies: 1 });
      }
    } finally {
      WIDTH = 110;
    }
  }, 60000);

  test("a wide-character command and a description, reason or path equal to the hint text", async () => {
    const wide = "日本語".repeat(40) + HINT;
    expect(copiesOfHint(await rows({ command: wide }))).toBe(1);
    expect(copiesOfHint(await rows({ command: "ls" }, { description: HINT, decisionReason: HINT, blockedPath: HINT }))).toBe(1);
    expect(copiesOfHint(await rows({ command: "ls" }, { title: HINT }))).toBe(1);
  });

  test("a JSON value whose 100-character chunk starts with the hint text", async () => {
    const value = "x".repeat(100 - '  "note": "'.length) + HINT + " ".repeat(100 - HINT.length);
    expect(copiesOfHint(await rows({ command: "ls", note: value }))).toBe(1);
  });
});
