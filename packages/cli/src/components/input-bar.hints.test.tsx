import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-input-hints-"));
process.env.MARCSH_PREFERENCES_PATH = join(dir, "preferences.json");
process.env.MARCSH_HISTORY_PATH = join(dir, "history.jsonl");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { InputBar, TurnInputContext } = await import("./input-bar");
const { primeTmuxKeys, resetTmuxKeys } = await import("../lib/tmux");

// S1: inside tmux without extended keys, the dim hint shows `ctrl+j new line`. S7: a disabled input says a reply is running.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let sent: string[] = [];

afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  sent = [];
});
afterEach(async () => {
  resetTmuxKeys();
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

type Open = { width?: number; disabled?: boolean; replyRunning?: boolean; messages?: unknown[]; active?: boolean; legacyKeys?: boolean };
async function open({ width = 110, disabled = false, replyRunning = false, messages, active = false, legacyKeys = false }: Open = {}) {
  const turn = { active, steer: () => true, queue: () => true };
  const router = createMemoryRouter([
    {
      path: "/",
      element: <RootLayout />,
      children: [
        {
          index: true,
          element: (
            <TurnInputContext.Provider value={turn}>
              <InputBar disabled={disabled} replyRunning={replyRunning} messages={messages as any} onSubmit={(text) => sent.push(text)} />
            </TurnInputContext.Provider>
          ),
        },
      ],
    },
  ]);
  screen = await testRender(<RouterProvider router={router} />, { width, height: 30, kittyKeyboard: !legacyKeys });
  await settle(150);
}

describe("the tmux new-line hint (S1)", () => {
  test("shows `ctrl+j new line` inside tmux without extended keys", async () => {
    primeTmuxKeys("tmux-basic");
    await open();
    expect(frame()).toContain("ctrl+j new line");
  });

  test("is not shown outside tmux, with extended keys, or when unknown", async () => {
    for (const keys of ["none", "extended", "unknown"] as const) {
      primeTmuxKeys(keys);
      await open();
      expect(frame()).not.toContain("ctrl+j");
      await act(async () => screen!.renderer.destroy());
      screen = null;
    }
  });

  test("is not shown when the input is off", async () => {
    primeTmuxKeys("tmux-basic");
    await open({ disabled: true, messages: [] });
    expect(frame()).not.toContain("ctrl+j");
  });

  test("sits next to the turn hint when it fits, without replacing it", async () => {
    primeTmuxKeys("tmux-basic");
    await open({ active: true });
    expect(frame()).toContain("enter steers · alt+enter queues · ctrl+j new line");
  });

  test("when the line is too narrow for both, the turn hint stays and the new-line hint goes", async () => {
    primeTmuxKeys("tmux-basic");
    await open({ active: true, width: 62 });
    const text = frame();
    expect(text).toContain("enter steers");
    expect(text).not.toContain("ctrl+j");
  });

  test("at 80 columns, idle, the new-line hint is shown whole", async () => {
    primeTmuxKeys("tmux-basic");
    await open({ width: 80 });
    expect(frame()).toContain("ctrl+j new line");
  });

  // In tmux without extended keys, Ctrl+J reaches the app as a raw line feed (no kitty keyboard).
  test("Ctrl+J adds a new line and sends nothing", async () => {
    primeTmuxKeys("tmux-basic");
    await open({ legacyKeys: true });
    await act(() => screen!.mockInput.typeText("first"));
    await act(async () => screen!.mockInput.pressKey("LINEFEED"));
    await act(() => screen!.mockInput.typeText("second"));
    await settle(60);
    expect(sent).toEqual([]);
    const lines = screen!.captureCharFrame().split("\n");
    const first = lines.findIndex((l) => l.includes("first"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(lines[first + 1]).toContain("second");
  });
});

describe("the placeholder while the input is off (S7)", () => {
  beforeEach(() => primeTmuxKeys("none"));

  test("says a reply is running and how to stop it", async () => {
    await open({ disabled: true, replyRunning: true, messages: [] });
    const text = frame();
    expect(text).toContain("reply running · esc to stop");
    expect(text).not.toContain("Ask anything");
  });

  test("is the normal one when the input is off for another reason (compacting)", async () => {
    await open({ disabled: true, messages: [] });
    expect(frame()).not.toContain("reply running");
  });

  test("is the normal one when the input is on", async () => {
    await open({ messages: [] });
    const text = frame();
    expect(text).toContain(`Ask anything... "Fix a bug in the database"`);
    expect(text).not.toContain("reply running");
  });

  test("is the normal one while a session is still loading (no messages yet)", async () => {
    await open({ disabled: true });
    expect(frame()).toContain("Ask anything");
  });
});
