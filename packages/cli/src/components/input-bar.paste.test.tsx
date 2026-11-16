import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-input-paste-"));
process.env.MARCSH_PREFERENCES_PATH = join(dir, "preferences.json");
process.env.MARCSH_HISTORY_PATH = join(dir, "history.jsonl");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { InputBar } = await import("./input-bar");

// Every mounted bar listens for pastes; only the focused one takes it (two are mounted for a moment while a screen hands over).

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

describe("with two bars mounted", () => {
  test("a paste goes into one of them only", async () => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: <RootLayout />,
        children: [
          {
            index: true,
            element: (
              <box flexDirection="column">
                <InputBar onSubmit={() => {}} />
                <InputBar onSubmit={() => {}} />
              </box>
            ),
          },
        ],
      },
    ]);
    screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40, kittyKeyboard: true });
    await settle(150);

    await act(() => screen!.mockInput.pasteBracketedText("pasted once"));
    await settle(80);

    expect(frame().split("pasted once").length - 1).toBe(1);
  });
});
