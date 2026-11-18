import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-first-run-card-"));
const prefsPath = join(prefsDir, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("../screens/home");
const { engines } = await import("../lib/engine");

let available: { provider: string; id: string; name: string }[] = [];
let failure: Error | null = null;

const fakePi = {
  id: "pi",
  startTurn: () => ({ done: Promise.resolve(), interrupt() {} }),
  warmUpCommands: async () => {},
  getRuntime: async () => {
    if (failure) throw failure;
    return { getAvailable: async () => available };
  },
  getDeviceId: async () => "device-1",
};

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│\s]+/g, " ");

async function openHome(prefs: object) {
  writeFileSync(prefsPath, JSON.stringify(prefs), "utf8");
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }],
    { initialEntries: ["/"] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 30 });
  await settle(150);
}

beforeAll(() => engines.set("pi", fakePi as never));
afterAll(() => {
  engines.set("pi", undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});
beforeEach(() => {
  available = [];
  failure = null;
});
afterEach(async () => {
  rmSync(prefsPath, { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("first-run card on the home screen (S4)", () => {
  test("with no pi model it names /login for pi and /engine → Claude with the user's Claude sign-in", async () => {
    await openHome({ defaultEngine: "pi" });

    const text = frame();
    expect(text).toContain("No model yet");
    expect(text).toContain("/login");
    expect(text).toContain("pi");
    expect(text).toContain("/engine → Claude");
    expect(text).toContain("Claude sign-in");
  });

  test("it is gone when a model is available", async () => {
    available = [{ provider: "fake-a", id: "a-1", name: "Alpha One" }];
    await openHome({ defaultEngine: "pi" });

    expect(frame()).not.toContain("No model yet");
    expect(frame()).toContain("fake-a/a-1 · pi");
  });

  test("it is not shown when the check failed (the status line says pi is unavailable instead)", async () => {
    failure = new Error("cannot load pi");
    await openHome({ defaultEngine: "pi" });

    expect(frame()).not.toContain("No model yet");
    expect(frame()).toContain("pi unavailable");
  });

  test("it is not shown on the Claude engine, where there is no model signal", async () => {
    await openHome({ defaultEngine: "claude" });

    expect(frame()).not.toContain("No model yet");
  });
});
