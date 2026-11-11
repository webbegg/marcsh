import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-new-session-late-keys-"));
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

// S4 A1 (L7, L8, L9): keys that land on /sessions/new after it has navigated (it stays mounted until the route change commits)
// must still reach the session's input. If they are lost, a prompt opening more than 2 s later sees no draft and no recent key
// and opens unlocked, so the next typed `a` answers it ("always allow").

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let restoreNavigate: (() => void) | null = null;
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
  restoreNavigate?.();
  restoreNavigate = null;
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

test("keys landing on /sessions/new after it navigated reach the session input and lock a later prompt", async () => {
  const router = createMemoryRouter([
    { path: "/", element: <RootLayout />, children: [
      { index: true, element: <Home /> },
      { path: "sessions/new", element: <NewSession /> },
      { path: "sessions/:id", element: <Session /> },
    ] },
  ]);
  // /sessions/new navigates, but stays mounted until the route change commits. Keys in that window:
  const original = router.navigate;
  const navigate = original.bind(router);
  restoreNavigate = () => {
    router.navigate = original;
  };
  let burstSent = false;
  router.navigate = ((to: any, opts?: any) => {
    if (!burstSent && typeof to === "string" && /^\/sessions\/(?!new)/.test(to)) {
      burstSent = true;
      for (const ch of "please check the ") screen!.mockInput.pressKey(ch as never);
    }
    return navigate(to, opts);
  }) as typeof router.navigate;
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
  await settle(150);
  await act(() => screen!.mockInput.typeText("hi"));
  await settle(60);
  await act(async () => screen!.mockInput.pressEnter());
  expect(burstSent).toBe(true);

  // The prompt opens more than 2 s after the burst: only the draft in the input can lock it.
  const opened = await frameContaining("Allow", 8000);
  await settle(400);
  await act(async () => screen!.mockInput.pressKey("a" as never));
  await settle(100);
  expect(answers).toEqual([]);
  expect(opened).toContain("press ↓ to answer");
  // The burst is still in the input once the prompt is gone.
  await act(async () => screen!.mockInput.pressEscape());
  expect(await frameContaining("please check the", 2000)).toContain("please check the");
}, 30000);
