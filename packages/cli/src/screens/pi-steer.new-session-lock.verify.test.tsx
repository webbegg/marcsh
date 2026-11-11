import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-new-session-lock-"));
const prefsPath = join(prefsDir, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { NewSession } = await import("./new-session");
const { Session } = await import("./session");
const { engines } = await import("../lib/engine");
const { getStorage } = await import("../lib/storage");
type Engine = import("../lib/engine/types").Engine;

// S4 A1 (L7): keys typed right after Enter on the home screen can reach the /sessions/new screen, whose input is off.
// They are the user composing: they must not be lost, and the prompt that opens next must open locked.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const answers: unknown[] = [];
const engine: Engine = {
  id: "pi",
  startTurn: (request, host) => ({
    done: host.askPermission({ toolName: "bash", input: { command: "echo hello" } }, request.signal).then((a) => {
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

test("keys that reach the new-session screen are kept and lock the approval that opens next", async () => {
  // The keys arrive while /sessions/new is up (its input mounted), just before it creates the session and moves on.
  const storage = getStorage();
  const createSession = storage.createSession.bind(storage);
  storage.createSession = ((...args: Parameters<typeof createSession>) => {
    storage.createSession = createSession; // one burst only: the storage is shared with the other test files
    for (const ch of "please check the ") screen!.mockInput.pressKey(ch as never);
    return createSession(...args);
  }) as typeof storage.createSession;

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
  await act(async () => screen!.mockInput.pressEnter());

  expect(await frameContaining("Allow")).toContain("press ↓ to answer");
  await settle(400);
  await act(async () => screen!.mockInput.pressKey("a" as never));
  await settle(100);
  expect(answers).toEqual([]);
  // The burst is still in the input once the prompt is gone (Esc dismisses it as "not now"/deny).
  await act(async () => screen!.mockInput.pressEscape());
  expect(await frameContaining("please check the")).toContain("please check the");
}, 30000);
