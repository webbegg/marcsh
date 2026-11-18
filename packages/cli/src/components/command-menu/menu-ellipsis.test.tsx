// S14: a description the `/` menu has no room for ends with `…` instead of being clipped silently, at 80 and 140 columns.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-menu-ellipsis-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../../providers/theme");
const { KeyboardLayerProvider } = await import("../../providers/keyboard-layer");
const { CommandMenu } = await import("./index");
type Command = import("./types").Command;

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

const LONG = "Explain what this does in great detail, with background, trade-offs and a worked example for every option that is available here and then some more";
const COMMANDS: Command[] = [
  { name: "long", description: LONG, value: "/long", source: "claude", argumentHint: "[topic]" },
  { name: "short", description: "A short one", value: "/short", source: "claude" },
  { name: "wide", description: "宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符宽字符", value: "/wide", source: "claude" },
  // More commands than the menu has rows for, so its scrollbar takes a column of the row.
  ...Array.from({ length: 12 }, (_, i): Command => ({ name: `filler${i}`, description: "filler", value: `/filler${i}`, source: "claude" })),
];

function Menu() {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [selected, setSelected] = useState(1);
  return <CommandMenu commands={COMMANDS} query="x" selectedIndex={selected} scrollRef={scrollRef} onSelect={setSelected} onExecute={() => {}} />;
}

async function rows(width: number) {
  const screen = await testRender(
    <ThemeProvider>
      <KeyboardLayerProvider>
        <Menu />
      </KeyboardLayerProvider>
    </ThemeProvider>,
    { width, height: 12 },
  );
  try {
    await act(() => new Promise<void>((r) => setTimeout(r, 120)));
    await screen.renderOnce();
    const lines = screen.captureCharFrame().split("\n");
    return (name: string) => lines.find((line) => line.trim().startsWith(`/${name}`)) ?? "";
  } finally {
    await act(async () => screen.renderer.destroy());
  }
}

describe("the / menu cuts a long description with an ellipsis", () => {
  const shown: Record<number, string> = {};
  for (const width of [80, 140]) {
    test(`at ${width} columns the long one ends with … before the source tag and fits`, async () => {
      const row = (await rows(width))("long");
      expect(row).toMatch(/… +claude\s*[█ ]*$/);
      expect(row.length).toBeLessThanOrEqual(width);
      const text = row.slice(row.indexOf("[topic]"), row.indexOf("…"));
      expect(`[topic] ${LONG}`.startsWith(text)).toBe(true);
      shown[width] = text;
    });

    test(`at ${width} columns a wide-character description is cut on a character, in cells`, async () => {
      const row = (await rows(width))("wide");
      expect(row).toMatch(/… +claude\s*[█ ]*$/);
      expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
    });

    test(`at ${width} columns a short description is not cut`, async () => {
      const row = (await rows(width))("short");
      expect(row).toContain("A short one");
      expect(row).not.toContain("…");
    });
  }

  test("a wider terminal shows more of the description", () => {
    expect(shown[140]!.length).toBeGreaterThan(shown[80]!.length);
  });
});
