import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useEffect } from "react";

const root = join(tmpdir(), `marcsh-help-dialog-${process.pid}`);
process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh.
process.env.MARCSH_PREFERENCES_PATH = join(root, "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(root, "agents");
process.env.MARCSH_COMMANDS_DIR = join(root, "commands");
process.env.MARCSH_KEYBINDS_PATH = join(root, "keybinds.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../../layouts/root-layout");
const { useDialog } = await import("../../providers/dialog");
const { openHelp } = await import("./help-dialog");
const { getStorage } = await import("../../lib/storage");
const { resetKeybinds } = await import("../../lib/keybinds");
import type { CommandContext } from "../command-menu/types";

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
// OpenTUI 0.9 paints a committed update on a later frame (and a frame cannot be read mid-paint): draw it before it is read.
const settle = async (ms = 40) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const press = async (name: string) => {
  await act(async () => screen!.mockInput.pressKey(name as never));
  await settle();
};

// Opens the dialog the way `/help` does.
function Opener() {
  const dialog = useDialog();
  // Once: the dialog value changes when it opens, and opening it again would loop.
  useEffect(() => {
    openHelp({ dialog, engine: "claude", cwd: process.cwd(), session: null } as unknown as CommandContext);
  }, []);
  return null;
}

async function open(size = { width: 100, height: 36 }) {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Opener /> }] }], { initialEntries: ["/"] });
  screen = await testRender(<RouterProvider router={router} />, size);
  await settle(80);
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  resetKeybinds();
  getStorage().saveClaudeCommands([]);
});

afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("the help dialog (S12)", () => {
  test("has a keys section with the default keys", async () => {
    await open();
    const text = frame();
    expect(text).toContain("Help");
    expect(text).toContain("Keys");
    expect(text).toContain("Enter Send the message");
    expect(text).toContain("ctrl+p Open the command palette");
    expect(text).toContain("ctrl+x n /new");
    expect(text).toContain("? Open this help");
  });

  test("has a commands section with each command's name and description", async () => {
    await open({ width: 100, height: 60 });
    const text = frame();
    expect(text).toContain("Commands");
    expect(text).toContain("/new");
    expect(text).toContain("/help Show the keys and the commands");
    expect(text).toContain("/exit");
  });

  test("a rebinding shows", async () => {
    writeFileSync(join(root, "keybinds.json"), JSON.stringify({ models: ["ctrl+o"], palette: ["ctrl+k"] }));
    await open({ width: 100, height: 60 });
    const text = frame();
    expect(text).toContain("ctrl+o /models");
    expect(text).toContain("ctrl+k Open the command palette");
    expect(text).not.toContain("ctrl+x m /models");
  });

  test("lists the engine's commands and cuts a long description with …", async () => {
    getStorage().saveClaudeCommands([{ name: "wordy", description: `${"long words ".repeat(30)}END`, argumentHint: "" }]);
    // Tall enough for every key and marcsh command above the engine's.
    await open({ width: 100, height: 70 });
    const text = frame();
    expect(text).toContain("/wordy long words");
    expect(text).toContain("…");
    expect(text).not.toContain("END");
  });

  test("shows no control character of a command's name or description", async () => {
    getStorage().saveClaudeCommands([{ name: "sneaky", description: "plain \u001b[31mred\u001b[0m‮text", argumentHint: "" }]);
    await open({ width: 100, height: 70 });
    const raw = screen!.captureCharFrame();
    expect(raw).not.toContain("\u001b");
    expect(raw).not.toContain("‮");
    expect(frame()).toContain("/sneaky plain [31mred[0mtext");
  });

  test("fits 80x24: the rest is reached by scrolling", async () => {
    await open({ width: 80, height: 24 });
    expect(frame()).toContain("Keys");
    expect(frame()).not.toContain("/exit");
    // Every line fits the dialog: a cut one ends with …, never wraps or clips mid-word.
    expect(frame()).toMatch(/close a menu or (dialog|[a-z]*…)/);
    expect(frame()).toMatch(/press a key after it (to run a command|[a-z ]*…)/);
    expect(frame()).toContain("…");

    await press("END");
    expect(frame()).toContain("/exit");
    expect(frame()).not.toContain("Enter Send the message");

    await press("HOME");
    expect(frame()).toContain("Enter Send the message");
  });

  test("Esc closes it", async () => {
    await open();
    expect(frame()).toContain("Keys");
    await act(async () => screen!.mockInput.pressEscape());
    await settle();
    expect(frame()).not.toContain("Keys");
  });
});
