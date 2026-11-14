import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

const root = join(tmpdir(), `marcsh-leader-${process.pid}`);
process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh.
process.env.MARCSH_PREFERENCES_PATH = join(root, "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(root, "agents");
process.env.MARCSH_COMMANDS_DIR = join(root, "commands");
process.env.MARCSH_KEYBINDS_PATH = join(root, "keybinds.json");

let hang = false;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: any) => {
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      if (hang) await new Promise(() => {});
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0 };
    })();
    return Object.assign(messages, { interrupt: async () => {}, supportedCommands: async () => [] });
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { setDefaultEngine } = await import("../lib/preferences");
const { resetKeybinds } = await import("../lib/keybinds");
const { clearDrafts } = await import("../lib/prompt-history");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let router: ReturnType<typeof createMemoryRouter>;

const settle = (ms = 40) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const press = async (name: string, modifiers: { ctrl?: boolean; meta?: boolean } = {}) => {
  await act(async () => {
    const input = screen!.mockInput;
    if (name === "return") input.pressEnter();
    else if (name === "escape") input.pressEscape();
    else input.pressKey(name as never, modifiers);
  });
  await settle();
};
const leader = () => press("x", { ctrl: true });

const routes = [
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: "sessions/:id", element: <Session /> },
    ],
  },
];

async function render(initialEntries: any[] = ["/"]) {
  router = createMemoryRouter(routes, { initialEntries });
  screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 36 });
  await settle(80);
}

const openSession = () => getStorage().createSession({ title: "t", cwd: process.cwd(), engine: "claude" });
const writeKeybinds = (value: unknown) => writeFileSync(process.env.MARCSH_KEYBINDS_PATH!, JSON.stringify(value));

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  resetKeybinds();
  clearDrafts();
  hang = false;
  setDefaultEngine("claude");
});

afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("the leader key (S8)", () => {
  test("ctrl+x then m runs /models", async () => {
    await render();
    await leader();
    await press("m");
    expect(frame()).toContain("Select Model");
  });

  test("ctrl+x then t runs /theme, and the prompt stays empty", async () => {
    await render();
    await leader();
    await press("t");
    expect(frame()).toContain("Select Theme");
    await press("escape");
    expect(frame()).toContain("Ask anything");
  });

  test("the status line says the leader is waiting, and what it offers", async () => {
    await render();
    expect(frame()).not.toContain("ctrl+x:");
    await leader();
    expect(frame()).toContain("ctrl+x: n new");
    expect(frame()).toContain("esc cancels");
  });

  test("the hint goes once the key is pressed", async () => {
    await render();
    await leader();
    await press("t");
    await press("escape");
    expect(frame()).not.toContain("ctrl+x:");
  });

  test("ctrl+x then ctrl+x leaves nothing pending and types nothing", async () => {
    await render();
    await leader();
    await leader();
    expect(frame()).not.toContain("ctrl+x:");
    expect(frame()).toContain("Ask anything");
  });

  test("a key that is not bound ends the wait and is not typed", async () => {
    await render();
    await leader();
    await press("z");
    expect(frame()).not.toContain("ctrl+x:");
    expect(frame()).toContain("Ask anything");
    expect(frame()).not.toContain("z");
  });

  test("Esc cancels the leader", async () => {
    await render();
    await leader();
    await press("escape");
    expect(frame()).not.toContain("ctrl+x:");
    await press("m");
    expect(frame()).not.toContain("Select Model");
  });

  test("the leader times out after 2 s, and the next key is typed as usual", async () => {
    await render();
    await leader();
    await settle(2150);
    expect(frame()).not.toContain("ctrl+x:");
    await act(() => screen!.mockInput.typeText("m"));
    await settle();
    expect(frame()).not.toContain("Select Model");
    expect(frame()).not.toContain("Ask anything");
  });

  test("a command that needs an argument puts /name in the prompt", async () => {
    const session = openSession();
    await render([`/sessions/${session.id}`]);
    await leader();
    await press("x");
    expect(frame()).toContain("/export");
    expect(frame()).not.toContain("Ask anything");
  });

  test("a session command says it needs a session on the home screen", async () => {
    await render();
    await leader();
    await press("u");
    expect(frame()).toContain("/undo works inside a session");
  });

  test("the leader does nothing while a dialog is open", async () => {
    await render();
    await leader();
    await press("t");
    expect(frame()).toContain("Select Theme");
    await leader();
    expect(frame()).not.toContain("ctrl+x:");
  });

  test("the leader does nothing while the input is off for a turn", async () => {
    hang = true;
    const session = openSession();
    await render([`/sessions/${session.id}`]);
    await act(() => screen!.mockInput.typeText("hello"));
    await press("return");
    await settle(100);
    await leader();
    expect(frame()).not.toContain("ctrl+x:");
  });
});

describe("overriding the leader and the keys in keybinds.json (S8)", () => {
  test("a command can move to another leader key", async () => {
    writeKeybinds({ models: ["<leader>o"] });
    await render();
    await leader();
    await press("m");
    expect(frame()).not.toContain("Select Model");
    await leader();
    await press("o");
    expect(frame()).toContain("Select Model");
  });

  test("the leader itself can move", async () => {
    writeKeybinds({ leader: ["ctrl+g"] });
    await render();
    await leader();
    expect(frame()).not.toContain("ctrl+g:");
    await press("g", { ctrl: true });
    expect(frame()).toContain("ctrl+g:");
    await press("t");
    expect(frame()).toContain("Select Theme");
  });

  test("an empty leader list turns the leader off", async () => {
    writeKeybinds({ leader: [] });
    await render();
    await leader();
    expect(frame()).not.toContain("ctrl+x:");
  });

  test("a command can have a key of its own, no leader needed", async () => {
    writeKeybinds({ theme: ["alt+t"] });
    await render();
    await press("t", { meta: true });
    expect(frame()).toContain("Select Theme");
  });

  test("the palette lists the keys a command now has", async () => {
    writeKeybinds({ models: ["<leader>o"], theme: ["alt+t"] });
    await render();
    await press("p", { ctrl: true });
    expect(frame()).toContain("ctrl+x o");
    await act(() => screen!.mockInput.typeText("theme"));
    await settle(60);
    expect(frame()).toContain("alt+t");
  });
});
