// The `/` menu grows upward from the input: its rows follow the room above the input, 10 at most, 1 at least.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-menu-height-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../../layouts/root-layout");
const { Session } = await import("../../screens/session");
const { Home } = await import("../../screens/home");
const { getStorage } = await import("../../lib/storage");
const { engines } = await import("../../lib/engine");
const { menuRowLimit } = await import("./index");

const fake = (id: string) => ({ id, startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} });
beforeAll(() => {
  engines.set("claude", fake("claude"));
  engines.set("pi", fake("pi"));
});
afterAll(() => {
  engines.set("claude", undefined);
  engines.set("pi", undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});
const settle = (ms = 60) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

type Screen = Awaited<ReturnType<typeof testRender>>;

async function openMenu(path: "session" | "home", size: { width: number; height: number }) {
  const session = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine: "claude" });
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <RootLayout />,
        children: [
          { index: true, element: <Home /> },
          { path: "sessions/:id", element: <Session /> },
        ],
      },
    ],
    { initialEntries: [path === "session" ? `/sessions/${session.id}` : "/"] },
  );
  const screen = await testRender(<RouterProvider router={router} />, size);
  await settle(150);
  await act(() => screen.mockInput.typeText("/"));
  await settle(120);
  return screen;
}

const commandRows = (screen: Screen) => screen.captureCharFrame().split("\n").filter((line) => /^\s+\/\S/.test(line));

describe("menuRowLimit", () => {
  test("is the free rows, between 1 and 10", () => {
    expect(menuRowLimit(30)).toBe(10);
    expect(menuRowLimit(10)).toBe(10);
    expect(menuRowLimit(7.9)).toBe(7);
    expect(menuRowLimit(1)).toBe(1);
    expect(menuRowLimit(0)).toBe(1);
    expect(menuRowLimit(-4)).toBe(1);
  });
});

describe("the / menu height", () => {
  test("a large terminal shows 10 rows", async () => {
    const screen = await openMenu("session", { width: 100, height: 40 });
    try {
      const rows = commandRows(screen);
      expect(rows).toHaveLength(10);
      expect(rows[0]).toContain("/new");
    } finally {
      await act(async () => screen.renderer.destroy());
    }
  });

  test("the first row stays visible when the terminal shrinks while the menu is open", async () => {
    const screen = await openMenu("session", { width: 80, height: 30 });
    try {
      expect(commandRows(screen)[0]).toContain("/new");
      for (const height of [14, 12]) {
        await act(async () => screen.resize(80, height));
        await settle(150);
        const rows = commandRows(screen);
        expect(rows[0]).toContain("/new");
        expect(rows.length).toBeLessThanOrEqual(height - 8);
      }
    } finally {
      await act(async () => screen.renderer.destroy());
    }
  });

  test("a terminal with almost no room above the input keeps at least one row, the highlighted one", async () => {
    const screen = await openMenu("session", { width: 80, height: 10 });
    try {
      expect(commandRows(screen)[0]).toContain("/new");
    } finally {
      await act(async () => screen.renderer.destroy());
    }
  });

  test("the home screen, whose input has a different layout, keeps the first row too", async () => {
    for (const height of [24, 16]) {
      const screen = await openMenu("home", { width: 80, height });
      try {
        expect(commandRows(screen)[0]).toContain("/new");
      } finally {
        await act(async () => screen.renderer.destroy());
      }
    }
  });
});
