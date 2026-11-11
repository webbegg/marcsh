import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useLayoutEffect } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-handoff-merge-"));
const prefsPath = join(prefsDir, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider, useNavigate } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { InputBar } = await import("../components/input-bar");
const { Home } = await import("./home");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
type Engine = import("../lib/engine/types").Engine;

// S4 A1 (L10): every input bar hands its unsent text to the next bar when it unmounts, and the next bar merges it with whatever
// its own textarea already holds (hand-off first, then the keys that got there first), never replacing. Text a bar just sent is
// never handed off.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const claude: Engine = {
  id: "claude",
  startTurn: () => ({ done: new Promise<void>(() => {}), interrupt: () => {} }),
  warmUpCommands: async () => {},
};

beforeAll(() => {
  writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude" }), "utf8");
  engines.set("claude", claude);
});
afterAll(() => {
  engines.set("claude", undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│\s]+/g, " ");
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const PLACEHOLDER = "Ask anything";

// A page that is only an input bar; `sendTo` makes a sent message navigate there (like the home screen does).
function Page({ sendTo, early }: { sendTo?: string; early?: string }) {
  const navigate = useNavigate();
  return (
    <>
      {/* Keys that reach this page's textarea before its bar takes the hand-off (the bar's own effects run after this one's). */}
      {early ? <Early keys={early} /> : null}
      <InputBar onSubmit={() => sendTo && navigate(sendTo)} />
    </>
  );
}

// A different component type, so going from a page to this one unmounts the bar (the same type in the same place would be reused).
const NextPage = (props: { sendTo?: string; early?: string }) => <Page {...props} />;

function Early({ keys }: { keys: string }) {
  useLayoutEffect(() => {
    for (const ch of keys) screen!.mockInput.pressKey(ch as never);
  }, []);
  return null;
}

async function open(routes: { path: string; element: React.ReactNode }[]) {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: routes.map((r) => (r.path === "/" ? { index: true, element: r.element } : r)) }]);
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
  await settle(150);
  return router;
}
const go = (router: Awaited<ReturnType<typeof open>>, to: string, state?: unknown) =>
  act(async () => {
    await router.navigate(to, { state });
  });
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};

describe("the next bar merges the hand-off with what it already holds", () => {
  test("keys that reached the new textarea before the take stay after the hand-off text, in order", async () => {
    const router = await open([
      { path: "/", element: <Page /> },
      { path: "b", element: <NextPage early="ld" /> },
    ]);
    await type("hello wor");
    await go(router, "/b");
    await settle(100);

    expect(frame()).toContain("hello world");
    expect(frame()).not.toContain(PLACEHOLDER);
    // Typing goes on at the end of the merged text.
    await type("!");
    expect(frame()).toContain("hello world!");
  });

  test("a router-state draft that is the same text is not duplicated", async () => {
    const router = await open([
      { path: "/", element: <Page /> },
      { path: "sessions/:id", element: <Session /> },
    ]);
    const session = getStorage().createSession({ title: "chat", cwd: process.cwd(), engine: "claude" });
    await type("same text");
    await go(router, `/sessions/${session.id}`, { draft: "same text" });
    await settle(100);

    expect(occurrences(frame(), "same text")).toBe(1);
  });

  test("a router-state draft comes first, then the hand-off", async () => {
    const router = await open([
      { path: "/", element: <Page /> },
      { path: "sessions/:id", element: <Session /> },
    ]);
    const session = getStorage().createSession({ title: "chat", cwd: process.cwd(), engine: "claude" });
    await type("tail");
    await go(router, `/sessions/${session.id}`, { draft: "head " });
    await settle(100);

    expect(frame()).toContain("head tail");
  });
});

describe("a sent message is never handed off", () => {
  test("only the keys typed after the send reach the next bar", async () => {
    const router = await open([
      { path: "/", element: <Page sendTo="/b" /> },
      { path: "b", element: <NextPage /> },
    ]);
    await type("send me");
    // Enter sends and navigates; the burst lands before the old bar unmounts.
    await act(async () => {
      screen!.mockInput.pressEnter();
      for (const ch of "next") screen!.mockInput.pressKey(ch as never);
    });
    await settle(100);

    expect(router.state.location.pathname).toBe("/b");
    const after = frame();
    expect(after).toContain("next");
    expect(after).not.toContain("send me");
  });

  test("nothing typed after the send: the next bar starts empty", async () => {
    const router = await open([
      { path: "/", element: <Page sendTo="/b" /> },
      { path: "b", element: <NextPage /> },
    ]);
    await type("send me");
    await act(async () => screen!.mockInput.pressEnter());
    await settle(100);

    expect(router.state.location.pathname).toBe("/b");
    expect(frame()).toContain(PLACEHOLDER);
    expect(frame()).not.toContain("send me");
  });
});

describe("leaving a session with a draft", () => {
  test("carries it to the next bar once, and on to the one after, never duplicated", async () => {
    const first = getStorage().createSession({ title: "one", cwd: process.cwd(), engine: "claude" });
    const second = getStorage().createSession({ title: "two", cwd: process.cwd(), engine: "claude" });
    const router = await open([
      { path: "/", element: <Home /> },
      { path: "sessions/:id", element: <Session /> },
    ]);
    await go(router, `/sessions/${first.id}`);
    await settle(100);
    await type("my unsent draft");

    // Home (as /new or the sessions dialog would go).
    await go(router, "/");
    await settle(100);
    expect(occurrences(frame(), "my unsent draft")).toBe(1);

    await go(router, `/sessions/${second.id}`);
    await settle(100);
    expect(occurrences(frame(), "my unsent draft")).toBe(1);

    // The draft follows the bars (each takes it once), it is never copied.
    await go(router, "/");
    await go(router, `/sessions/${first.id}`);
    await settle(100);
    expect(occurrences(frame(), "my unsent draft")).toBe(1);
  });

  test("a session with an empty input hands nothing on", async () => {
    const session = getStorage().createSession({ title: "one", cwd: process.cwd(), engine: "claude" });
    const router = await open([
      { path: "/", element: <Home /> },
      { path: "sessions/:id", element: <Session /> },
    ]);
    await go(router, `/sessions/${session.id}`);
    await settle(100);
    await go(router, "/");
    await settle(100);

    expect(frame()).toContain(PLACEHOLDER);
  });
});
