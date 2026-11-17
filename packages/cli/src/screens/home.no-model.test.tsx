import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-home-no-model-"));
const prefsPath = join(prefsDir, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { NewSession } = await import("./new-session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");

// The models that have credentials right now: none, or one.
let available: { provider: string; id: string; name: string }[] = [];
// Holds the model check back until released, to press Enter while it is still running.
let gate: Promise<void> = Promise.resolve();
let turns = 0;

const fakePi = {
  id: "pi",
  startTurn: () => {
    turns++;
    return { done: Promise.resolve(), interrupt() {} };
  },
  warmUpCommands: async () => {},
  getRuntime: async () => {
    await gate;
    return { getAvailable: async () => available };
  },
  getDeviceId: async () => "device-1",
};

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const frame = () => screen!.captureCharFrame().replace(/[│\s]+/g, " ");

async function openHome(width = 110) {
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }, { path: "sessions/new", element: <NewSession /> }, { path: "sessions/:id", element: <text>session opened</text> }] }],
    { initialEntries: ["/"] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width, height: 40 });
  await settle(150);
  return router;
}

const sessionTitles = () => getStorage().listSessions().map((session) => session.title);

beforeAll(() => engines.set("pi", fakePi as never));
afterAll(() => {
  engines.set("pi", undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});
beforeEach(() => {
  available = [];
  gate = Promise.resolve();
  turns = 0;
  writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");
});
afterEach(async () => {
  rmSync(prefsPath, { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("home with no model (S3)", () => {
  test("Enter creates no session and starts no turn; the message says what to do and the text stays in the input", async () => {
    const router = await openHome();
    const before = sessionTitles().length;

    await type("hi there");
    await press("RETURN");
    await settle(150);

    expect(router.state.location.pathname).toBe("/");
    expect(sessionTitles().length).toBe(before);
    expect(turns).toBe(0);
    const text = frame();
    expect(text).toContain("No model yet: /login (pi) or /engine (Claude)");
    expect(text).toContain("hi there");
  });

  test("at 80 columns the message fits on one line, and stays while the input is left alone", async () => {
    await openHome(80);
    await type("hi there");
    await press("RETURN");
    await settle(300);

    const rows = screen!.captureCharFrame().split("\n");
    expect(rows.some((row) => row.includes("No model yet: /login (pi) or /engine (Claude)"))).toBe(true);
  });

  test("the message goes away once the input changes, and comes back on the next Enter", async () => {
    await openHome(80);
    await type("hi there");
    await press("RETURN");
    await settle(150);
    expect(frame()).toContain("No model yet: /login (pi)");

    await type("!");
    expect(frame()).not.toContain("No model yet: /login (pi)");
    expect(frame()).toContain("hi there!");

    await press("RETURN");
    await settle(150);
    expect(frame()).toContain("No model yet: /login (pi)");

    await press("BACKSPACE");
    expect(frame()).not.toContain("No model yet: /login (pi)");
  });

  test("a slash command still runs: /engine opens its dialog", async () => {
    await openHome();

    await type("/engine");
    await press("RETURN");
    await settle(150);

    expect(frame()).not.toContain("No model yet: /login (pi)");
    expect(frame()).toContain("Claude");
  });

  test("with a model available, Enter starts a session as before", async () => {
    available = [{ provider: "fake-a", id: "a-1", name: "Alpha One" }];
    const router = await openHome();

    await type("hello");
    await press("RETURN");
    await settle(150);

    expect(router.state.location.pathname).toStartWith("/sessions/");
    expect(sessionTitles()).toContain("hello");
  });

  test("while the first check is still running, Enter keeps today's behaviour (no guess is made)", async () => {
    let release: () => void = () => {};
    gate = new Promise<void>((resolve) => (release = resolve));
    const router = await openHome();

    await type("early");
    await press("RETURN");
    await settle(100);
    release();

    expect(router.state.location.pathname).toStartWith("/sessions/");
    expect(sessionTitles()).toContain("early");
  });
});
