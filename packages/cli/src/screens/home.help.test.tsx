import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

const root = join(tmpdir(), `marcsh-home-help-${process.pid}`);
process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh.
process.env.MARCSH_PREFERENCES_PATH = join(root, "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(root, "agents");
process.env.MARCSH_COMMANDS_DIR = join(root, "commands");
process.env.MARCSH_KEYBINDS_PATH = join(root, "keybinds.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { getStorage } = await import("../lib/storage");
const { setDefaultEngine } = await import("../lib/preferences");
const { resetKeybinds } = await import("../lib/keybinds");
const { clearDrafts } = await import("../lib/prompt-history");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
// OpenTUI 0.9 paints a committed update on a later frame (and a frame cannot be read mid-paint): draw it before it is read.
const settle = async (ms = 40) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};

beforeEach(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  resetKeybinds();
  clearDrafts();
  setDefaultEngine("claude");
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }], { initialEntries: ["/"] });
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 70 });
  await settle(80);
});

afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  getStorage().saveClaudeCommands([]);
});

describe("/help on the home screen (S12)", () => {
  test("typing /help and pressing Enter opens the dialog with the keys and the commands", async () => {
    await type("/help");
    await act(async () => screen!.mockInput.pressEnter());
    await settle(80);

    const text = frame();
    expect(text).toContain("Help");
    expect(text).toContain("Keys");
    expect(text).toContain("ctrl+p Open the command palette");
    expect(text).toContain("Commands");
    expect(text).toContain("/help Show the keys and the commands");
    // No session was started by it.
    expect(text).not.toContain("Thinking");
  });

  test("Esc closes it", async () => {
    await type("/help");
    await act(async () => screen!.mockInput.pressEnter());
    await settle(80);
    expect(frame()).toContain("Keys");

    await act(async () => screen!.mockInput.pressEscape());
    await settle();
    expect(frame()).not.toContain("Open the command palette");
  });
});
