import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-menu-enter-verify-"));
process.env.MARCSH_PREFERENCES_PATH = join(dir, "preferences.json");
process.env.MARCSH_HISTORY_PATH = join(dir, "history.jsonl");
process.env.MARCSH_COMMANDS_DIR = join(dir, "commands");
process.env.MARCSH_KEYBINDS_PATH = join(dir, "keybinds.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { InputBar } = await import("../components/input-bar");
const { getStorage } = await import("../lib/storage");

// S13 / L6-Q1, Q2: Enter runs only a named or picked command; an unknown one is said, and the second Enter sends exactly the text.
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let sent: string[] = [];
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  sent = [];
  getStorage().saveClaudeCommands([
    { name: "review", description: "Review a pull request", argumentHint: "" },
    { name: "reviews-all", description: "Review everything", argumentHint: "" },
  ]);
});
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});
const settle = async (ms = 40) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(60);
};
const backspace = async () => {
  await act(async () => screen!.mockInput.pressKey("BACKSPACE" as never));
  await settle(60);
};

async function open() {
  const router = createMemoryRouter([
    {
      path: "/",
      element: <RootLayout />,
      children: [
        {
          index: true,
          element: (
            <box flexDirection="column" height="100%">
              <box flexGrow={1} />
              <InputBar engine="claude" onSubmit={(text) => sent.push(text)} />
            </box>
          ),
        },
      ],
    },
  ]);
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 30, kittyKeyboard: true, exitOnCtrlC: false });
  await settle(120);
}

describe("Enter in the / menu (verify)", () => {
  test("a prefix two engine commands share runs neither and inserts nothing", async () => {
    await open();
    await type("/rev");
    await enter();
    expect(frame()).toContain("/rev is not a known command · enter again to send it to Claude");
    expect(sent).toEqual([]);
  });

  test("an exact engine name wins over a longer one that starts with it", async () => {
    await open();
    await type("/review");
    await enter();
    expect(frame()).not.toContain("not a known command");
    expect(sent).toEqual([]);
  });

  test("editing the text after the toast asks again; the second Enter sends exactly what is shown", async () => {
    await open();
    await type("/zzz");
    await enter();
    await type("q");
    await backspace();
    await enter();
    expect(sent).toEqual([]);
    await enter();
    expect(sent).toEqual(["/zzz"]);
  });

  test("a changed unknown name is asked about, not sent on the old arm", async () => {
    await open();
    await type("/zzz");
    await enter();
    await backspace();
    await type("y");
    await enter();
    expect(sent).toEqual([]);
  });

  test("`/` alone never sends and never runs a command", async () => {
    await open();
    await type("/");
    await enter();
    await enter();
    await enter();
    expect(sent).toEqual([]);
    expect(frame()).not.toContain("Select Theme");
    expect(frame()).not.toContain("Project Trust");
  });

  test("`?` after text or inside the / menu is typed, not help", async () => {
    await open();
    await type("/?");
    expect(frame()).not.toMatch(/\bHelp\b/);
    await backspace();
    await backspace();
    await type("a ?");
    await enter();
    expect(sent).toEqual(["a ?"]);
  });
});
