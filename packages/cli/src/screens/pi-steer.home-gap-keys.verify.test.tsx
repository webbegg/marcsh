import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-home-gap-keys-"));
const prefsPath = join(prefsDir, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { NewSession } = await import("./new-session");
const { Session } = await import("./session");
const { engines } = await import("../lib/engine");
type Engine = import("../lib/engine/types").Engine;

// S4 A1 (L7-L9): keys typed right after Enter on the home screen land in the home bar, which stays mounted until the route
// change commits (26-100 ms in a real terminal, longer under load). They must reach the session's input: if they are lost, a
// prompt opening more than 2 s later sees no draft and no recent key and opens unlocked, so the next typed `a` answers it
// ("always allow").

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const answers: unknown[] = [];
const engine: Engine = {
  id: "pi",
  startTurn: (request, host) => ({
    done: new Promise<void>((r) => setTimeout(r, 2300))
      .then(() => host.askPermission({ toolName: "bash", input: { command: "echo hello" } }, request.signal))
      .then((a) => {
        answers.push(a);
      }),
    interrupt: () => {},
    steer: async () => {},
    followUp: async () => {},
  }),
  warmUpCommands: async () => {},
};

beforeAll(() => {
  writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");
  engines.set("pi", engine);
});
afterAll(() => {
  engines.set("pi", undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│\s]+/g, " ");
const frameContaining = async (text: string, timeoutMs = 8000) => {
  const start = Date.now();
  while (!frame().includes(text) && Date.now() - start < timeoutMs) await settle(25);
  return frame();
};

test("keys typed on the home screen right after Enter reach the session input and lock a later prompt", async () => {
  const router = createMemoryRouter([
    { path: "/", element: <RootLayout />, children: [
      { index: true, element: <Home /> },
      { path: "sessions/new", element: <NewSession /> },
      { path: "sessions/:id", element: <Session /> },
    ] },
  ]);
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
  await settle(150);
  await act(() => screen!.mockInput.typeText("hi"));
  await settle(60);
  // Enter sends; the burst comes in before the route change commits, so the home bar takes it.
  await act(async () => {
    screen!.mockInput.pressEnter();
    for (const ch of "please check the ") screen!.mockInput.pressKey(ch as never);
  });

  // The prompt opens more than 2 s after the burst: only the draft in the input can lock it.
  const opened = await frameContaining("Allow", 8000);
  await settle(400);
  await act(async () => screen!.mockInput.pressKey("a" as never));
  await settle(100);
  expect(answers).toEqual([]);
  expect(opened).toContain("press ↓ to answer");
  // The burst is in the input exactly once when the prompt is gone.
  await act(async () => screen!.mockInput.pressEscape());
  const after = await frameContaining("please check the", 2000);
  expect(after.split("please check the").length - 1).toBe(1);
}, 30000);
