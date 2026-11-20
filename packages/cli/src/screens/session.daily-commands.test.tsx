import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

// S6: a daily action picked from the palette inside a session runs in that session (the user's choice), not in a new one.

process.env.MARCSH_DB_PATH = ":memory:";
const root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-session-daily-")));
process.env.MARCSH_PREFERENCES_PATH = join(root, "prefs", "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(root, "agents");
process.env.MARCSH_PACKS_DIR = join(root, "packs");
process.env.MARCSH_COMMANDS_DIR = join(root, "commands");

let calls: { prompt: string }[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    calls.push({ prompt });
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
const { Home } = await import("./home");
const { NewSession } = await import("./new-session");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { preferencesPath, setDefaultEngine } = await import("../lib/preferences");

beforeAll(() => engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} } as never));
afterAll(() => {
  engines.set("pi", undefined);
  rmSync(root, { recursive: true, force: true });
});

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let router: ReturnType<typeof createMemoryRouter>;
const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(150);
};
const ctrl = async (name: string) => {
  await act(async () => screen!.mockInput.pressKey(name as never, { ctrl: true }));
  await settle(80);
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

async function openSession() {
  const session = getStorage().createSession({ title: "t", cwd: process.cwd(), engine: "claude" });
  router = createMemoryRouter(
    [
      {
        path: "/",
        element: <RootLayout />,
        children: [
          { index: true, element: <Home dashboard /> },
          { path: "sessions/new", element: <NewSession /> },
          { path: "sessions/:id", element: <Session /> },
        ],
      },
    ],
    { initialEntries: [`/sessions/${session.id}`] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 36 });
  await settle(150);
  return session.id;
}

beforeEach(() => {
  calls = [];
  setDefaultEngine("claude");
});
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(process.env.MARCSH_COMMANDS_DIR!, { recursive: true, force: true });
  rmSync(preferencesPath(), { force: true });
});

describe("daily actions inside a session (S6)", () => {
  test("/fix-bug from the palette sends /bug-fix in this session when it is loaded", async () => {
    mkdirSync(process.env.MARCSH_COMMANDS_DIR!, { recursive: true });
    writeFileSync(join(process.env.MARCSH_COMMANDS_DIR!, "bug-fix.md"), "---\ndescription: Fix it\n---\nReproduce the bug, then fix it.");
    const id = await openSession();

    await ctrl("p");
    await type("fix-bug");
    await enter();
    await settle(200);

    expect(router.state.location.pathname).toBe(`/sessions/${id}`);
    expect(calls.map((call) => call.prompt)).toContain("Reproduce the bug, then fix it.");
  });

  test("with no /bug-fix command, the session's prompt holds the starter text and nothing is sent", async () => {
    const id = await openSession();

    await ctrl("p");
    await type("fix-bug");
    await enter();

    expect(router.state.location.pathname).toBe(`/sessions/${id}`);
    expect(frame()).toContain("Fix a bug:");
    expect(calls.length).toBe(0);
  });

  test("/dashboard goes to the home screen, which opens on the menu", async () => {
    await openSession();

    await ctrl("p");
    await type("dashboard");
    await enter();

    expect(router.state.location.pathname).toBe("/");
    expect(frame()).toContain("Work on a ticket");
  });
});
