import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-turn-notify-"));
const prefsPath = join(prefsDir, "preferences.json");
// Never the real ~/.marcsh.
process.env.MARCSH_PREFERENCES_PATH = prefsPath;
process.env.MARCSH_AGENTS_DIR = join(prefsDir, "agents");
process.env.MARCSH_COMMANDS_DIR = join(prefsDir, "commands");

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: any) => {
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0 };
    })();
    return Object.assign(messages, { interrupt: async () => {}, supportedCommands: async () => [] });
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { updatePreferences } = await import("../lib/preferences");
const { setNotifyDeps } = await import("../lib/notify");
const { clearDrafts } = await import("../lib/prompt-history");

// A pi turn that runs until it is interrupted.
let finishHeldTurn = () => {};
beforeAll(() =>
  engines.set("pi", {
    id: "pi",
    startTurn: (_request, _host) => {
      let finish = () => {};
      const done = new Promise<void>((resolve) => (finish = resolve));
      finishHeldTurn = finish;
      return { done, interrupt: finish };
    },
    warmUpCommands: async () => {},
  }),
);
afterAll(() => {
  engines.set("pi", undefined);
  setNotifyDeps(undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});

let written: string[] = [];
let spawned: string[][] = [];
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

async function openSession(engine: string, title = "my chat") {
  const session = getStorage().createSession({ title, cwd: process.cwd(), engine });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [`/sessions/${session.id}`] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 30 });
  await settle(100);
}

async function send(text: string) {
  await act(() => screen!.mockInput.typeText(text));
  await settle(40);
  await act(async () => screen!.mockInput.pressKey("RETURN" as never));
  await settle(150);
}

beforeEach(() => {
  written = [];
  spawned = [];
  clearDrafts();
  rmSync(prefsPath, { force: true });
  setNotifyDeps({ platform: "darwin", write: (text) => void written.push(text), spawn: (command) => void spawned.push(command) });
});

afterEach(async () => {
  finishHeldTurn();
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

test("opening a session does not notify", async () => {
  await openSession("claude");
  expect(written).toEqual([]);
  expect(spawned).toEqual([]);
});

test("a finished turn rings the bell once by default", async () => {
  await openSession("claude");
  await send("hello");
  expect(written).toEqual(["\x07"]);
  expect(spawned).toEqual([]);
});

test("notify off stays quiet", async () => {
  updatePreferences({ notify: "off" }, prefsPath);
  await openSession("claude");
  await send("hello");
  expect(written).toEqual([]);
  expect(spawned).toEqual([]);
});

test("notify system names the session and that the turn is done", async () => {
  updatePreferences({ notify: "system" }, prefsPath);
  await openSession("claude", 'my "chat"');
  await send("hello");
  expect(written).toEqual([]);
  expect(spawned).toEqual([["osascript", "-e", 'display notification "my \\"chat\\": done" with title "marcsh"']]);
});

test("a turn that failed says so", async () => {
  updatePreferences({ notify: "system" }, prefsPath);
  await openSession("no-such-engine", "broken");
  await send("hello");
  expect(spawned.map((command) => command[2])).toEqual(['display notification "broken: failed" with title "marcsh"']);
});

test("an interrupted turn does not notify", async () => {
  await openSession("pi");
  await send("hello");
  await act(async () => screen!.mockInput.pressEscape());
  await settle(150);
  expect(written).toEqual([]);
  expect(spawned).toEqual([]);
});

test("a turn that ends on its own notifies once it has run", async () => {
  await openSession("pi");
  await send("hello");
  expect(written).toEqual([]);
  finishHeldTurn();
  await settle(150);
  expect(written).toEqual(["\x07"]);
});
