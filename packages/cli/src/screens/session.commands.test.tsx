import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh/preferences.json: a missing file reads as no preferences, and writes land in tmp.
process.env.MARCSH_PREFERENCES_PATH = join(tmpdir(), `marcsh-screen-prefs-${process.pid}`, "preferences.json");

const PROBE = { name: "probe:hello", description: "Say hello to someone", argumentHint: "<who>", builtin: false };
// Shares a name with a marcsh command, so the marcsh one must win.
const CLASH = { name: "new", description: "Claude's own new", argumentHint: "" };
const CHANGED = { name: "changed-cmd", description: "Pushed mid-turn", argumentHint: "" };

let calls: { prompt: string; options: any }[] = [];
let fetchedCommands: () => Promise<any[]> = async () => [PROBE, CLASH];
// Messages emitted between `init` and `result`.
let extraMessages: any[] = [];
let supportedCommandsCalls = 0;

// Fake query(): init → (extra messages) → result, with the Query's `supportedCommands()`.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    calls.push({ prompt, options });
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      for (const message of extraMessages) yield message;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0 };
    })();
    return Object.assign(messages, {
      interrupt: async () => {},
      supportedCommands: async () => {
        supportedCommandsCalls += 1;
        return fetchedCommands();
      },
    });
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");

// pi is the default engine and its status line asks the pi runtime: a stand-in without one keeps the real pi engine from loading.
beforeAll(() => engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} }));
afterAll(() => engines.set("pi", undefined));

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());

async function openIdle() {
  calls = [];
  const session = getStorage().createSession({ title: "idle", cwd: "/tmp/marcsh-cwd" });
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <RootLayout />,
        children: [
          { index: true, element: <text>HOME-MARKER</text> },
          { path: "sessions/:id", element: <Session /> },
        ],
      },
    ],
    { initialEntries: [`/sessions/${session.id}`] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 30 });
  await settle();
  return session;
}

// Runs one full turn so the fake query()'s command list reaches the cache.
async function openAfterTurn() {
  await openIdle();
  await type("hi");
  await press("RETURN");
  await settle(80);
  expect(calls.map((c) => c.prompt)).toEqual(["hi"]);
}

afterEach(async () => {
  fetchedCommands = async () => [PROBE, CLASH];
  extraMessages = [];
  supportedCommandsCalls = 0;
  getStorage().saveClaudeCommands([]);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("slash commands from Claude Code (S11a)", () => {
  test("asks for the command list once per turn and lists the commands in the / menu with description, hint and a claude tag", async () => {
    await openAfterTurn();
    expect(supportedCommandsCalls).toBe(1);

    await type("/");
    // marcsh commands stay in the menu, listed first
    expect(frame()).toContain("Start a new conversation");

    // The bundled marcsh: plugin entries push Claude commands below the fold, so filter to reach them.
    await type("probe");
    const text = frame();
    expect(text).toContain("/probe:hello");
    expect(text).toContain("<who>");
    expect(text).toContain("Say hello to someone");
    expect(text).toContain("claude");
  });

  test("a Claude command that shares a name with a marcsh command is not listed twice", async () => {
    await openAfterTurn();

    await type("/");

    const text = frame();
    expect(text).toContain("Start a new conversation");
    expect(text).not.toContain("Claude's own new");
  });

  test("the cached list is shown after a restart, before any turn", async () => {
    getStorage().saveClaudeCommands([{ name: "cached-cmd", description: "From an earlier run", argumentHint: "" }]);
    await openIdle();

    await type("/cach");

    expect(frame()).toContain("From an earlier run");
    expect(supportedCommandsCalls).toBe(0);
  });

  test("a commands_changed message replaces the cached list, and a failing supportedCommands() is ignored", async () => {
    fetchedCommands = async () => {
      throw new Error("not supported");
    };
    extraMessages = [{ type: "system", subtype: "commands_changed", commands: [CHANGED], uuid: "u1", session_id: "claude-1" }];
    await openAfterTurn();

    // marcsh's own commands (ten with /trust) fill the menu's ten rows, so the Claude list is looked at through a filter.
    await type("/chan");

    const text = frame();
    expect(text).toContain("Pushed mid-turn");
    expect(text).not.toContain("Say hello to someone");
    expect((screen!.renderer as any).isDestroyed).toBe(false);
    expect(getStorage().getClaudeCommands().map((c) => c.name)).toEqual(["changed-cmd"]);
  });

  test("selecting a Claude command puts /name and a space in the input and does not run a query", async () => {
    await openAfterTurn();

    await type("/probe");
    await press("RETURN");

    expect(calls).toHaveLength(1);
    const text = frame();
    expect(text).toContain("/probe:hello");
    // the menu is closed
    expect(text).not.toContain("Say hello to someone");

    await type("world");
    await press("RETURN");
    await settle(80);

    expect(calls.map((c) => c.prompt)).toEqual(["hi", "/probe:hello world"]);
  });

  test("submitting /probe:hello world sends exactly that prompt to query()", async () => {
    await openAfterTurn();

    await type("/probe:hello world");
    await press("RETURN");
    await settle(80);

    expect(calls.map((c) => c.prompt)).toEqual(["hi", "/probe:hello world"]);
  });

  test("a /name that matches no command and has no arguments is submitted verbatim", async () => {
    await openAfterTurn();

    await type("/unknown-thing");
    await press("RETURN");
    await settle(80);

    expect(calls.map((c) => c.prompt)).toEqual(["hi", "/unknown-thing"]);
  });

  test("marcsh's own /new still runs its action instead of querying", async () => {
    await openAfterTurn();

    await type("/new");
    await press("RETURN");
    await settle(80);

    expect(calls).toHaveLength(1);
    expect(frame()).toContain("HOME-MARKER");
  });
});
