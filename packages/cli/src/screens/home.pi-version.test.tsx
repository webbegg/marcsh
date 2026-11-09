import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import cliPackage from "../../package.json";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh/preferences.json: a missing file reads as no preferences, and writes land in tmp.
process.env.MARCSH_PREFERENCES_PATH = join(tmpdir(), `marcsh-screen-prefs-${process.pid}`, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { engines } = await import("../lib/engine");

// pi is the default engine and its status line asks the pi runtime: a stand-in without one keeps the real pi engine from loading.
beforeAll(() => engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} }));
afterAll(() => engines.set("pi", undefined));

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");

afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("home screen (S16)", () => {
  test("shows the pi version that powers marcsh", async () => {
    const router = createMemoryRouter(
      [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }],
      { initialEntries: ["/"] },
    );
    screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 30 });
    await settle();

    const version = cliPackage.dependencies["@earendil-works/pi-coding-agent"];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(collapse(screen.captureCharFrame())).toContain(`powered by pi v${version}`);
  });
});
