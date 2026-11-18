// S16: the `/` menu heads each group (marcsh, packs & custom, the engine) with a dim, non-selectable row on an empty query; with a query the
// score-sorted list stays ungrouped. Selection indexes stay over commands only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useRef, useState } from "react";
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-menu-groups-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../../providers/theme");
const { KeyboardLayerProvider } = await import("../../providers/keyboard-layer");
const { CommandMenu } = await import("./index");
const { useCommandMenu } = await import("./use-command-menu");
type Command = import("./types").Command;

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

type Screen = Awaited<ReturnType<typeof testRender>>;
const settle = async (screen: Screen, ms = 60) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (!screen.renderer.isDestroyed) await screen.renderOnce();
};
// Trimmed, and without the scrollbar's glyphs at the end of a row.
const lines = (screen: Screen) => screen.captureCharFrame().split("\n").map((line) => line.replace(/[\s█▀▄▐▌░▒▓]+$/, "").trim());
const highlighted = (screen: Screen) =>
  screen
    .captureSpans()
    .lines.map((line) => line.spans.filter((span) => span.text.trim().startsWith("/") && span.fg.r === 0 && span.fg.g === 0 && span.fg.b === 0).map((span) => span.text.trim()))
    .flat();

const entry = (name: string, source?: string): Command => ({ name, description: `${name} does things`, value: `/${name}`, ...(source ? { source } : {}) });
const LIST = [entry("new"), entry("agents"), entry("mine", "personal"), entry("spec", "flows"), entry("init", "claude"), entry("review", "claude")];

function StaticMenu({ commands, query }: { commands: Command[]; query?: string }) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const [selected, setSelected] = useState(0);
  return <CommandMenu commands={commands} query={query} selectedIndex={selected} scrollRef={scrollRef} onSelect={setSelected} onExecute={() => {}} />;
}

async function render(node: React.ReactNode, size = { width: 80, height: 30 }) {
  const screen = await testRender(
    <ThemeProvider>
      <KeyboardLayerProvider>{node}</KeyboardLayerProvider>
    </ThemeProvider>,
    size,
  );
  await settle(screen, 100);
  return screen;
}

describe("group headers", () => {
  test("an empty query heads each group, in order, with a row that is not a command", async () => {
    const screen = await render(<StaticMenu commands={LIST} query="" />);
    try {
      const text = lines(screen);
      const at = (label: string) => text.findIndex((line) => line === label);
      expect(at("marcsh")).toBeGreaterThanOrEqual(0);
      expect(at("packs & custom")).toBeGreaterThan(at("marcsh"));
      expect(at("claude")).toBeGreaterThan(at("packs & custom"));
      // Each header sits right above its group's first command.
      expect(text[at("marcsh") + 1]).toStartWith("/new");
      expect(text[at("packs & custom") + 1]).toStartWith("/mine");
      expect(text[at("claude") + 1]).toStartWith("/init");
      // Only the first command is highlighted, never a header.
      expect(highlighted(screen)).toEqual(["/new"]);
    } finally {
      await act(async () => screen.renderer.destroy());
    }
  });

  test("with a query the list stays ungrouped", async () => {
    const screen = await render(<StaticMenu commands={LIST} query="n" />);
    try {
      const text = lines(screen);
      for (const label of ["marcsh", "packs & custom", "claude"]) expect(text).not.toContain(label);
      expect(text.filter((line) => line.startsWith("/"))).toHaveLength(LIST.length);
    } finally {
      await act(async () => screen.renderer.destroy());
    }
  });
});

// The real hook (arrows, scrolling, the commands the menu loads) over a stand-in prompt.
let state: { commands: Command[]; selectedIndex: number; resolved: Command | undefined } = { commands: [], selectedIndex: 0, resolved: undefined };
function HookMenu() {
  const menu = useCommandMenu("claude", "/tmp/marcsh-menu-groups", true);
  const inputRef = useRef<InputRenderable>(null);
  state = { commands: menu.commands, selectedIndex: menu.selectedIndex, resolved: state.resolved };
  useKeyboard((key) => {
    if (key.name === "return") state.resolved = menu.resolveCommand(menu.selectedIndex);
  });
  return (
    <box flexDirection="column">
      <CommandMenu
        commands={menu.commands}
        query={menu.commandQuery}
        selectedIndex={menu.selectedIndex}
        scrollRef={menu.scrollRef}
        onSelect={menu.setSelectedIndex}
        onExecute={() => {}}
      />
      <input ref={inputRef} focused onContentChange={() => menu.handleContentChange(inputRef.current?.value ?? "")} />
    </box>
  );
}

describe("moving through the grouped menu", () => {
  test("Enter on the first row is the first command; arrows skip headers and keep the highlight on screen", async () => {
    state = { commands: [], selectedIndex: 0, resolved: undefined };
    const screen = await render(<HookMenu />, { width: 80, height: 14 });
    try {
      await act(() => screen.mockInput.typeText("/"));
      await settle(screen);
      expect(state.commands.length).toBeGreaterThan(8);
      expect(lines(screen)).toContain("marcsh");
      expect(highlighted(screen)).toEqual([`/${state.commands[0]!.name}`]);

      // Walk the whole list: the highlight is always one command row (a header is never highlighted) and always in view.
      for (let i = 1; i < state.commands.length; i++) {
        await act(() => screen.mockInput.pressArrow("down"));
        await settle(screen, 30);
        expect(state.selectedIndex).toBe(i);
        expect(highlighted(screen)).toEqual([`/${state.commands[i]!.name}`]);
      }
      for (let i = state.commands.length - 2; i >= 0; i--) {
        await act(() => screen.mockInput.pressArrow("up"));
        await settle(screen, 30);
        expect(state.selectedIndex).toBe(i);
        expect(highlighted(screen)).toEqual([`/${state.commands[i]!.name}`]);
      }
      // Back on the first command its group's header is in view again.
      expect(lines(screen)).toContain("marcsh");

      // Resolving closes the menu, which empties the list: read the first command before.
      const first = state.commands[0]!.name;
      await act(() => screen.mockInput.pressEnter());
      expect(state.resolved?.name).toBe(first);
    } finally {
      await act(async () => screen.renderer.destroy());
    }
  });

  test("typing a query drops the headers", async () => {
    state = { commands: [], selectedIndex: 0, resolved: undefined };
    const screen = await render(<HookMenu />, { width: 80, height: 30 });
    try {
      await act(() => screen.mockInput.typeText("/"));
      await settle(screen);
      expect(lines(screen)).toContain("marcsh");
      await act(() => screen.mockInput.typeText("th"));
      await settle(screen);
      expect(lines(screen)).not.toContain("marcsh");
      expect(highlighted(screen)).toEqual(["/theme"]);
    } finally {
      await act(async () => screen.renderer.destroy());
    }
  });
});

// Typing narrows the list through many states: a header is never left behind (or doubled) and the one command stays visible.
test("a list that narrows to one command keeps one header at most and shows the command", async () => {
  const { createMemoryRouter, RouterProvider } = await import("react-router");
  const { RootLayout } = await import("../../layouts/root-layout");
  const { Session } = await import("../../screens/session");
  const { getStorage } = await import("../../lib/storage");
  const { engines } = await import("../../lib/engine");
  const fake = (id: string) => ({ id, startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} });
  engines.set("claude", fake("claude") as any);
  getStorage().saveClaudeCommands([{ name: "acme-flows:ship", description: "Ship", argumentHint: "" }, { name: "spec", description: "Spec", argumentHint: "" }]);
  const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd", engine: "claude" });
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }], { initialEntries: [`/sessions/${session.id}`] });
  const screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 30 });
  const wait = () => act(() => new Promise<void>((r) => setTimeout(r, 60)));
  await wait();
  await act(() => screen.mockInput.typeText("/spec"));
  await wait();
  for (let i = 0; i < 4; i++) await act(() => screen.mockInput.pressBackspace());
  await wait();
  await act(() => screen.mockInput.typeText("acme-flows:sh"));
  await wait();
  await screen.renderOnce();
  try {
    const frame = lines(screen);
    expect(frame.some((line) => line.startsWith("/acme-flows:ship"))).toBe(true);
    expect(frame.filter((line) => line === "claude").length).toBeLessThanOrEqual(1);
  } finally {
    engines.set("claude", undefined);
    await act(async () => screen.renderer.destroy());
  }
});
