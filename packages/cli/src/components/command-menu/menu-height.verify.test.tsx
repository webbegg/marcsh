// S12 interaction: with /login and /logout added (MAX_VISIBLE_ITEMS 8 -> 10), the `/` menu must keep its first,
// highlighted command on screen at the heights where the 8-item menu fit (16 and 17 rows at 80 columns).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "verify-menu-height-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../../layouts/root-layout");
const { Session } = await import("../../screens/session");
const { getStorage } = await import("../../lib/storage");
const { engines } = await import("../../lib/engine");

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

for (const height of [20, 17, 16]) {
  test(`at 80x${height} the highlighted first command stays visible`, async () => {
    const session = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine: "claude" });
    const router = createMemoryRouter(
      [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
      { initialEntries: [`/sessions/${session.id}`] },
    );
    const screen = await testRender(<RouterProvider router={router} />, { width: 80, height });
    try {
      await settle(150);
      await act(() => screen.mockInput.typeText("/"));
      await settle(120);
      const frame = screen.captureCharFrame();
      expect(frame).toContain("/new");
      expect(frame).toContain("Build › opus");
    } finally {
      await act(async () => screen.renderer.destroy());
    }
  });
}
