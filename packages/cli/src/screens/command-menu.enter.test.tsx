import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-menu-enter-"));
process.env.MARCSH_PREFERENCES_PATH = join(dir, "preferences.json");
process.env.MARCSH_HISTORY_PATH = join(dir, "history.jsonl");
process.env.MARCSH_COMMANDS_DIR = join(dir, "commands");
process.env.MARCSH_KEYBINDS_PATH = join(dir, "keybinds.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { InputBar } = await import("../components/input-bar");
const { getStorage } = await import("../lib/storage");

// S13: Enter in the `/` menu runs a command only when what was typed is one (L6/Q1), and says so when it is not (L6/Q2).

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let sent: string[] = [];

afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  sent = [];
  getStorage().saveClaudeCommands([{ name: "review", description: "Review a pull request", argumentHint: "" }]);
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

async function open(engine = "claude", atBottom = false) {
  const bar = <InputBar engine={engine} onSubmit={(text) => sent.push(text)} />;
  const element = atBottom ? (
    <box flexDirection="column" height="100%">
      <box flexGrow={1} />
      {bar}
    </box>
  ) : (
    bar
  );
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 30, kittyKeyboard: true, exitOnCtrlC: false });
  await settle(120);
}

describe("Enter in the / menu runs what was typed (S13, L6/Q1)", () => {
  test("`/he` does not open /theme: it is the start of /help only, which opens", async () => {
    await open();
    await type("/he");
    await enter();

    expect(frame()).not.toContain("Select Theme");
    expect(frame()).toContain("Help");
    expect(sent).toEqual([]);
  });

  test("an exact name runs", async () => {
    await open();
    await type("/theme");
    await enter();

    expect(frame()).toContain("Select Theme");
  });

  test("a unique prefix runs: `/them` opens /theme", async () => {
    await open();
    await type("/them");
    await enter();

    expect(frame()).toContain("Select Theme");
    expect(sent).toEqual([]);
  });

  test("letters that only match /theme by skipping some do not run it", async () => {
    await open();
    await type("/tm");
    await enter();

    expect(frame()).not.toContain("Select Theme");
    expect(frame()).toContain("/tm is not a known command");
  });

  test("an ambiguous prefix runs nothing: the text stays and the toast says so", async () => {
    await open();
    // `/engine` and `/exit` both start with `e` (the session commands are not listed here).
    await type("/e");
    await enter();

    expect(frame()).toContain("/e is not a known command · enter again to send it to Claude");
    expect(frame()).not.toContain("Select Engine");
    expect(sent).toEqual([]);
  });

  test("an engine command in the menu is known by its name: Enter completes it for the arguments, as before", async () => {
    await open();
    await type("/rev");
    await enter();

    expect(frame()).not.toContain("not a known command");
    expect(frame()).toContain("/review");
    expect(sent).toEqual([]);
  });

  test("the row the user moved to with the arrows runs, whatever was typed", async () => {
    await open();
    await type("/");
    await act(async () => screen!.mockInput.pressArrow("down"));
    await settle(60);
    await enter();

    // The first row is /new, the second /agents: Down once is the second row.
    expect(frame()).toContain("Select Agent");
    expect(frame()).not.toContain("not a known command");
  });

  test("the mouse passing over a row does not choose it: only the arrows or a click do", async () => {
    await open("claude", true);
    await type("/e");
    const rows = screen!.captureCharFrame().split("\n");
    const y = rows.findIndex((row) => row.includes("/theme"));
    expect(y).toBeGreaterThan(-1);
    await act(async () => screen!.mockMouse.moveTo(rows[y]!.indexOf("/theme") + 2, y));
    await settle(60);
    await enter();

    expect(frame()).not.toContain("Select Theme");
    expect(frame()).toContain("/e is not a known command");
  });

  test("`/` and Enter alone run nothing: no row was chosen", async () => {
    await open();
    await type("/");
    await enter();

    expect(frame()).not.toContain("Select Agent");
    expect(frame()).toContain("Type a command's name, or pick one with ↑ ↓");
    // There is nothing to send: a second Enter says the same.
    await enter();
    expect(sent).toEqual([]);
  });

  test("text after a name still reaches the command: `/theme ` runs without the menu", async () => {
    await open();
    await type("/theme ");
    await enter();

    expect(frame()).toContain("Select Theme");
  });
});

describe("an unknown command is said, then sent on a second Enter (S13, L6/Q2)", () => {
  test("the toast names the command and the engine; the text stays in the prompt", async () => {
    await open();
    await type("/zzz");
    await enter();

    expect(frame()).toContain("/zzz is not a known command · enter again to send it to Claude");
    expect(frame()).toContain("/zzz");
    expect(sent).toEqual([]);
  });

  test("a second Enter with the same text sends it to the engine as typed", async () => {
    await open();
    await type("/zzz");
    await enter();
    await enter();

    expect(sent).toEqual(["/zzz"]);
  });

  test("the engine is named as pi on pi", async () => {
    await open("pi");
    await type("/zzz");
    await enter();

    expect(frame()).toContain("/zzz is not a known command · enter again to send it to pi");
  });

  test("changing the text between the Enters asks again instead of sending", async () => {
    await open();
    await type("/zzz");
    await enter();
    await type("z");
    await enter();

    expect(sent).toEqual([]);
    expect(frame()).toContain("/zzzz is not a known command");
    await enter();
    expect(sent).toEqual(["/zzzz"]);
  });

  test("a path typed as a prompt is sent at once, not taken for a command", async () => {
    await open();
    await type("/usr/bin/env");
    await enter();

    expect(sent).toEqual(["/usr/bin/env"]);
    expect(frame()).not.toContain("not a known command");
  });
});
