import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh.
process.env.MARCSH_PREFERENCES_PATH = join(tmpdir(), `marcsh-session-wiring-prefs-${process.pid}`, "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(tmpdir(), `marcsh-session-wiring-agents-${process.pid}`);
process.env.MARCSH_COMMANDS_DIR = join(tmpdir(), `marcsh-session-wiring-commands-${process.pid}`);

let calls: { prompt: string; options: any }[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    calls.push({ prompt, options });
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
const { setDefaultEngine } = await import("../lib/preferences");
const { formatUsage, sessionUsage } = await import("../lib/usage");
const { clearDrafts } = await import("../lib/prompt-history");

beforeAll(() => engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} }));
afterAll(() => engines.set("pi", undefined));

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let router: ReturnType<typeof createMemoryRouter>;

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

const routes = [
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: "sessions/new", element: <NewSession /> },
      { path: "sessions/:id", element: <Session /> },
    ],
  },
];

async function render(initialEntries: any[]) {
  router = createMemoryRouter(routes, { initialEntries });
  screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 30 });
  await settle(80);
}

function close() {
  act(() => screen?.renderer.destroy());
  screen = null;
}

beforeEach(() => {
  calls = [];
  clearDrafts();
});
afterEach(close);

test("the session's status bar shows the usage its replies reported", async () => {
  const session = getStorage().createSession({ title: "t", cwd: process.cwd(), engine: "claude" });
  const messages = [
    { id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "hi" }], metadata: { mode: "BUILD" as const, model: "sonnet" } },
    {
      id: "a1",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "hello" }],
      metadata: { mode: "BUILD" as const, model: "sonnet", usage: { contextTokens: 50_000, contextWindow: 200_000, costUsd: 0.5 } },
    },
  ];
  getStorage().saveMessages(session.id, messages as any);
  await render([`/sessions/${session.id}`]);
  const expected = formatUsage(sessionUsage(messages as any));
  expect(expected).not.toBe("");
  expect(frame()).toContain(expected.replace(/\s+/g, " "));
});

test("a session keeps its unsent draft when it is left and opened again", async () => {
  const session = getStorage().createSession({ title: "t", cwd: process.cwd(), engine: "claude" });
  await render([`/sessions/${session.id}`]);
  await act(() => screen!.mockInput.typeText("half typed draft"));
  await settle(60);
  expect(frame()).toContain("half typed draft");
  // Home unmounts the session's input; its own input must not show the draft.
  await act(() => router.navigate("/"));
  await settle(80);
  expect(frame()).not.toContain("half typed draft");
  await act(() => router.navigate(`/sessions/${session.id}`));
  await settle(80);
  expect(frame()).toContain("half typed draft");
});

test("a model chosen on the home screen for the first turn reaches the engine", async () => {
  setDefaultEngine("claude");
  await render([{ pathname: "/sessions/new", state: { message: "hi", mode: "BUILD", model: "sonnet", agentModel: "haiku" } }]);
  await settle(200);
  expect(calls.length).toBe(1);
  expect(calls[0]!.options.model).toBe("haiku");
});
