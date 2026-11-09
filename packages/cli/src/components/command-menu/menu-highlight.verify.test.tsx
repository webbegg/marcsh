// S12 interaction (T11 B1): the `/` menu keeps `/new` highlighted on its first visible row at every height, on the session and home screens, while resizing and navigating.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
process.env.MARCSH_DB_PATH = ":memory:";
process.env.MARCSH_PREFERENCES_PATH = join(mkdtempSync(join(tmpdir(), "menuprobe-")), "p.json");
const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../../layouts/root-layout");
const { Session } = await import("../../screens/session");
const { Home } = await import("../../screens/home");
const { getStorage } = await import("../../lib/storage");
const { engines } = await import("../../lib/engine");
const fake = (id: string) => ({ id, startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} });
beforeAll(() => { engines.set("claude", fake("claude") as any); engines.set("pi", fake("pi") as any); });
afterAll(() => { engines.set("claude", undefined); engines.set("pi", undefined); });
const settle = (ms = 60) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
type Scr = Awaited<ReturnType<typeof testRender>>;
function info(screen: Scr) {
  const f = screen.captureSpans();
  const text = f.lines.map((l) => l.spans.map((s) => s.text).join(""));
  const rows = text.map((t, i) => [i, t] as const).filter(([, t]) => /^\s*\/[a-z]/.test(t.replace(/^[┃│ ]+/, " ")));
  const hl = f.lines.map((l, i) => [i, l] as const).filter(([, l]) => l.spans.some((s) => s.text.trim().startsWith("/") && s.fg.r === 0 && s.fg.g === 0 && s.fg.b === 0)).map(([i]) => i);
  return { text, rows, hl };
}
function dump(tag: string, screen: Scr) {
  const { text, rows, hl } = info(screen);
  void tag;
  return { rows, hl, text };
}
async function open(kind: "session" | "home", w: number, h: number, msgs = 0) {
  const s = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine: kind === "session" ? "claude" : "pi" });
  if (msgs > 0) {
    const messages = Array.from({ length: msgs }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", parts: [{ type: "text", text: `message ${i}` }] }));
    getStorage().saveMessages(s.id, messages as any);
  }
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }, { path: "sessions/:id", element: <Session /> }] }], { initialEntries: [kind === "session" ? `/sessions/${s.id}` : "/"] });
  const screen = await testRender(<RouterProvider router={router} />, { width: w, height: h });
  await settle(150);
  await act(() => screen.mockInput.typeText("/"));
  await settle(150);
  return screen;
}
const check = (tag: string, screen: Scr, expectMax?: number) => {
  const { rows, hl } = dump(tag, screen);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]![1]).toContain("/new");
  expect(hl).toEqual([rows[0]![0]]);
  expect(rows[0]![0]).toBeGreaterThanOrEqual(0);
  if (expectMax) expect(rows.length).toBe(expectMax);
};
for (const kind of ["session", "home"] as const)
  for (const h of [8, 10, 12, 16, 17, 18, 24, 40]) {
    test(`${kind} 80x${h}`, async () => {
      const screen = await open(kind, 80, h);
      try { check(`${kind} 80x${h}`, screen, h >= 40 ? 10 : undefined); } finally { await act(async () => screen.renderer.destroy()); }
    });
  }
// Runs with the real default engine (pi): shrinking once left the menu scrolled with /new off the top.
for (const kind of ["session", "home"] as const)
  test(`resize while open ${kind} 40->16->12->17->9->40`, async () => {
    const prefs = process.env.MARCSH_PREFERENCES_PATH!;
    const screen = await open(kind, 80, 40);
    try {
      check(`${kind} start 40`, screen, 10);
      for (const h of [16, 12, 17, 9, 40]) {
        await act(async () => screen.resize(80, h)); await settle(150);
        check(`${kind} resized ${h}`, screen, h === 40 ? 10 : undefined);
      }
    } finally {
      await act(async () => screen.renderer.destroy());
      rmSync(prefs, { force: true });
    }
  });
test("arrow navigation at 80x16 keeps highlighted row visible; filtering re-measures", async () => {
  const screen = await open("session", 80, 16);
  try {
    for (let i = 0; i < 12; i++) { await act(() => screen.mockInput.pressArrow("down")); await settle(30); }
    const d = dump("after 12 downs", screen);
    expect(d.hl.length).toBe(1);
    expect(d.hl[0]).toBeGreaterThanOrEqual(0);
    await act(() => screen.mockInput.typeText("lo")); await settle(150);
    const e = dump("filter /lo", screen);
    expect(e.hl.length).toBe(1);
  } finally { await act(async () => screen.renderer.destroy()); }
});
