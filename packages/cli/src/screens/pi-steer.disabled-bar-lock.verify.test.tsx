import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-disabled-bar-lock-"));
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

// S4 B1 / A1: after Enter on the home screen the session's input is off while pi's model check runs. Keys typed then
// still mean the user is composing: a prompt that opens within 2 s opens locked, and the next keys answer nothing.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const modelCheck = Promise.withResolvers<void>();
const answers: unknown[] = [];
let turns = 0;
const engine = {
  id: "pi",
  // The model check waits on this; rejecting lets the turn go out with the model in use.
  getRuntime: () => modelCheck.promise.then(() => Promise.reject(new Error("no runtime in this test"))),
  getDeviceId: async () => "test-device",
  startTurn: (request, host) => {
    turns++;
    return {
      done: host.askPermission({ toolName: "bash", input: { command: "echo hello" } }, request.signal).then((a) => {
        answers.push(a);
      }),
      interrupt: () => {},
      steer: async () => {},
      followUp: async () => {},
    };
  },
  warmUpCommands: async () => {},
} as Engine;

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

test("keys typed while the new session's input is still off (model check) lock the approval that opens next", async () => {
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
  await settle(150);
  expect(turns).toBe(0); // the session screen is up, its turn waits on the model check
  await act(() => screen!.mockInput.typeText("please check the "));
  await settle(100);
  modelCheck.resolve();

  expect(await frameContaining("Allow")).toContain("press ↓ to answer");
  await settle(400);
  await act(async () => screen!.mockInput.pressKey("a" as never));
  await settle(100);
  expect(answers).toEqual([]);
}, 30000);
