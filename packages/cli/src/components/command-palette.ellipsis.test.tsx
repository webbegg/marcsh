// S14: a description the command palette has no room for ends with `…` instead of being clipped silently, at 80 and 140 columns.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useEffect } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-palette-ellipsis-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../providers/theme");
const { KeyboardLayerProvider } = await import("../providers/keyboard-layer");
const { DialogProvider, useDialog } = await import("../providers/dialog");
const { CommandPalette } = await import("./command-palette");
type Command = import("./command-menu/types").Command;

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

const LONG = "Explain what this does in great detail, with background, trade-offs and a worked example for every option that is available here and then some more";
const COMMANDS: Command[] = [
  { name: "long", description: LONG, value: "/long", argumentHint: "[topic]" },
  { name: "short", description: "A short one", value: "/short" },
  { name: "wide", description: "宽字符".repeat(60), value: "/wide" },
  // More rows than the palette shows, so its scrollbar takes a column of the row.
  ...Array.from({ length: 12 }, (_, i): Command => ({ name: `filler${i}`, description: "filler", value: `/filler${i}` })),
];
const KEYS = { long: "ctrl+x l", short: "ctrl+x s", wide: "ctrl+x w" };

function Open() {
  const dialog = useDialog();
  useEffect(() => {
    dialog.open({ title: "Commands", width: "wide", children: <CommandPalette commands={COMMANDS} keys={KEYS} onSelect={() => {}} /> });
  }, []);
  return null;
}

async function rows(width: number) {
  const screen = await testRender(
    <ThemeProvider>
      <KeyboardLayerProvider>
        <DialogProvider>
          <Open />
        </DialogProvider>
      </KeyboardLayerProvider>
    </ThemeProvider>,
    { width, height: 24 },
  );
  try {
    await act(() => new Promise<void>((r) => setTimeout(r, 150)));
    await screen.renderOnce();
    const lines = screen.captureCharFrame().split("\n");
    return (name: string) => lines.find((line) => line.includes(`/${name}`)) ?? "";
  } finally {
    await act(async () => screen.renderer.destroy());
  }
}

describe("the command palette cuts a long description with an ellipsis", () => {
  const shown: Record<number, string> = {};
  for (const width of [80, 140]) {
    test(`at ${width} columns the long one ends with … before its key and fits`, async () => {
      const row = (await rows(width))("long");
      expect(row).toMatch(/… +ctrl\+x l/);
      const text = row.slice(row.indexOf("[topic]"), row.indexOf("…"));
      expect(`[topic] ${LONG}`.startsWith(text)).toBe(true);
      shown[width] = text;
    });

    test(`at ${width} columns a wide-character description is cut on a character`, async () => {
      expect((await rows(width))("wide")).toMatch(/… +ctrl\+x w/);
    });

    test(`at ${width} columns a short description is not cut`, async () => {
      const row = (await rows(width))("short");
      expect(row).toContain("A short one");
      expect(row).not.toContain("…");
    });
  }

  test("the 140-column palette uses its wider dialog", () => {
    expect(shown[140]!.length).toBeGreaterThan(shown[80]!.length);
  });
});

// The setting dialogs list their rows through DialogSearchList: a model's long name ends with `…` too.
const { ToastProvider } = await import("../providers/toast");
const { PiModelsDialogContent } = await import("./dialogs/pi-models-dialog");

const LONG_NAME = "A model with an extraordinarily long display name that no dialog row has the room for, however wide";
const MODELS = [
  { ref: "acme/long", provider: "acme", id: "long", name: LONG_NAME },
  { ref: "acme/short", provider: "acme", id: "short", name: "Short" },
];

function OpenModels() {
  const dialog = useDialog();
  useEffect(() => {
    dialog.open({ title: "Models", children: <PiModelsDialogContent models={MODELS} currentModel="acme/short" onSelectModel={() => {}} /> });
  }, []);
  return null;
}

describe("the model dialog cuts a long model name with an ellipsis", () => {
  for (const width of [80, 140]) {
    test(`at ${width} columns`, async () => {
      const screen = await testRender(
        <ThemeProvider>
          <ToastProvider>
            <KeyboardLayerProvider>
              <DialogProvider>
                <OpenModels />
              </DialogProvider>
            </KeyboardLayerProvider>
          </ToastProvider>
        </ThemeProvider>,
        { width, height: 24 },
      );
      try {
        await act(() => new Promise<void>((r) => setTimeout(r, 150)));
        await screen.renderOnce();
        const lines = screen.captureCharFrame().split("\n");
        const long = lines.find((line) => line.includes("acme/long")) ?? "";
        const short = lines.find((line) => line.includes("acme/short")) ?? "";
        expect(long).toMatch(/acme\/long A model with .*…/);
        expect(short).toContain("Short");
        expect(short).not.toContain("…");
      } finally {
        await act(async () => screen.renderer.destroy());
      }
    });
  }
});
