import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useState } from "react";
import { RGBA, type SyntaxStyle } from "@opentui/core";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-syntax-style-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider, useTheme } = await import("../providers/theme");
const { THEMES } = await import("../theme");
const { deriveSyntaxStyles } = await import("../lib/theme-derived");
const { useSyntaxStyle } = await import("./use-syntax-style");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let seen: SyntaxStyle[] = [];
let setThemeRef: ((index: number) => void) | null = null;
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  seen = [];
  setThemeRef = null;
});
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

let setShownRef: ((shown: boolean) => void) | null = null;
function Toggle() {
  const [shown, setShown] = useState(true);
  setShownRef = setShown;
  return shown ? <Probe /> : <text>gone</text>;
}

function Probe() {
  const style = useSyntaxStyle();
  const { setTheme } = useTheme();
  setThemeRef = (index) => setTheme(THEMES[index]!);
  if (seen[seen.length - 1] !== style) seen.push(style);
  return <text>probe</text>;
}

const destroyed = (style: SyntaxStyle) => {
  try {
    style.getStyleCount();
    return false;
  } catch {
    return true;
  }
};

async function mount() {
  screen = await testRender(
    <ThemeProvider>
      <Toggle />
    </ThemeProvider>,
    { width: 20, height: 3 },
  );
  await settle();
}

describe("useSyntaxStyle", () => {
  test("builds the theme's styles once and keeps the same style across renders", async () => {
    await mount();
    expect(seen).toHaveLength(1);
    const style = seen[0]!;
    expect(style.getRegisteredNames().sort()).toEqual(Object.keys(deriveSyntaxStyles(THEMES[0]!.colors)).sort());
    await act(async () => screen!.renderer.root.requestRender());
    await settle();
    expect(seen).toHaveLength(1);
    expect(destroyed(style)).toBe(false);
  });

  test("builds a new style when the theme changes and destroys the old one", async () => {
    await mount();
    const first = seen[0]!;
    const other = THEMES.findIndex((t) => t.colors.primary !== THEMES[0]!.colors.primary);
    await act(async () => setThemeRef!(other));
    await settle();
    const latest = seen[seen.length - 1]!;
    expect(latest).not.toBe(first);
    expect(destroyed(first)).toBe(true);
    expect(destroyed(latest)).toBe(false);
    expect(latest.getStyle("keyword")?.fg?.equals(RGBA.fromHex(THEMES[other]!.colors.primary))).toBe(true);
  });

  test("destroys the style when the component unmounts", async () => {
    await mount();
    const style = seen[0]!;
    expect(destroyed(style)).toBe(false);
    await act(async () => setShownRef!(false));
    await settle();
    // The renderer is still alive: only the hook's own cleanup can have freed the style.
    expect(screen!.renderer.isDestroyed).toBe(false);
    expect(destroyed(style)).toBe(true);
  });
});
