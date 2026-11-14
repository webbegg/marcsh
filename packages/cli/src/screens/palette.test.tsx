import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

const root = join(tmpdir(), `marcsh-palette-${process.pid}`);
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
    else if (name === "up" || name === "down") input.pressArrow(name);
    else input.pressKey(name as never, modifiers);
  });
  await settle();
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const ctrlP = () => press("p", { ctrl: true });

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

describe("the command palette (S8)", () => {
  test("Ctrl+P opens the palette listing the commands, and Esc closes it", async () => {
    await render();
    expect(frame()).not.toContain("Command Palette");
    await ctrlP();
    expect(frame()).toContain("Command Palette");
    for (const name of ["/new", "/agents", "/models", "/sessions"]) expect(frame()).toContain(name);
    await press("escape");
    expect(frame()).not.toContain("Command Palette");
  });

  test("Ctrl+P puts nothing in the prompt", async () => {
    await render();
    await ctrlP();
    await press("escape");
    expect(frame()).toContain("Ask anything");
  });

  test("each row shows the keys that run it", async () => {
    await render();
    await ctrlP();
    expect(frame()).toContain("ctrl+x n");
  });

  test("typing filters the list with fuzzy matching", async () => {
    await render();
    await ctrlP();
    await type("mdl");
    expect(frame()).toContain("/models");
    expect(frame()).not.toContain("/theme");
    expect(frame()).not.toContain("/sessions");
  });

  test("a filter that matches nothing says so", async () => {
    await render();
    await ctrlP();
    await type("qqzz");
    expect(frame()).toContain("No matching commands");
  });

  test("Enter runs the highlighted command the way the typed /command does", async () => {
    await render();
    await ctrlP();
    await type("theme");
    await press("return");
    expect(frame()).not.toContain("Command Palette");
    expect(frame()).toContain("Select Theme");
  });

  test("Up and Down move the highlight", async () => {
    await render();
    await ctrlP();
    // The list opens on /new; one Down is /agents.
    await press("down");
    await press("return");
    expect(frame()).toContain("Select Agent");
  });

  test("a command that takes an argument puts /name in the prompt instead of running", async () => {
    const session = openSession();
    await render([`/sessions/${session.id}`]);
    await ctrlP();
    await type("rename");
    await press("return");
    expect(frame()).not.toContain("Command Palette");
    expect(frame()).toContain("/rename");
    expect(frame()).not.toContain("Ask anything");
  });

  test("the session's own commands are listed in a session, and not on the home screen", async () => {
    await render();
    await ctrlP();
    await type("undo");
    expect(frame()).toContain("No matching commands");
    await press("escape");
    await act(() => router.navigate(`/sessions/${openSession().id}`));
    await settle(80);
    await ctrlP();
    await type("undo");
    expect(frame()).toContain("/undo");
    expect(frame()).not.toContain("No matching commands");
  });

  test("a custom command is listed, and picking it puts /name in the prompt", async () => {
    mkdirSync(process.env.MARCSH_COMMANDS_DIR!, { recursive: true });
    writeFileSync(join(process.env.MARCSH_COMMANDS_DIR!, "review.md"), "---\ndescription: Review a file\n---\nReview $1\n");
    await render();
    await ctrlP();
    await type("review");
    expect(frame()).toContain("/review");
    await press("return");
    expect(frame()).not.toContain("Command Palette");
    expect(frame()).toContain("/review");
  });

  test("a draft in the prompt survives a command run from the palette", async () => {
    await render();
    await type("half typed draft");
    await ctrlP();
    await type("theme");
    await press("return");
    expect(frame()).toContain("Select Theme");
    await press("escape");
    expect(frame()).toContain("half typed draft");
  });

  test("a command that needs an argument leaves a draft alone and says so", async () => {
    const session = openSession();
    await render([`/sessions/${session.id}`]);
    await type("half typed draft");
    await ctrlP();
    await type("rename");
    await press("return");
    expect(frame()).toContain("half typed draft");
    expect(frame()).toContain("Clear the prompt");
  });

  test("Ctrl+P does nothing while a dialog is open", async () => {
    await render();
    await ctrlP();
    await type("theme");
    await press("return");
    expect(frame()).toContain("Select Theme");
    await ctrlP();
    expect(frame()).toContain("Select Theme");
    expect(frame()).not.toContain("Command Palette");
  });

  test("Ctrl+P does nothing while the / menu is open", async () => {
    await render();
    await type("/mo");
    await ctrlP();
    expect(frame()).not.toContain("Command Palette");
  });

  test("Ctrl+P does nothing while the input is off for a turn", async () => {
    hang = true;
    const session = openSession();
    await render([`/sessions/${session.id}`]);
    await type("hello");
    await press("return");
    await settle(100);
    await ctrlP();
    expect(frame()).not.toContain("Command Palette");
  });
});

describe("keybinds.json (S8)", () => {
  const writeKeybinds = (value: unknown) => writeFileSync(process.env.MARCSH_KEYBINDS_PATH!, typeof value === "string" ? value : JSON.stringify(value));

  test("the palette can be moved to another key", async () => {
    writeKeybinds({ palette: ["ctrl+k"] });
    await render();
    await ctrlP();
    expect(frame()).not.toContain("Command Palette");
    await press("k", { ctrl: true });
    expect(frame()).toContain("Command Palette");
  });

  test("an empty list turns the palette off", async () => {
    writeKeybinds({ palette: [] });
    await render();
    await ctrlP();
    expect(frame()).not.toContain("Command Palette");
  });

  test("an invalid file shows one warning toast and the defaults work", async () => {
    writeKeybinds("{ not json");
    await render();
    expect(frame()).toContain("Invalid keybinds file");
    await ctrlP();
    expect(frame()).toContain("Command Palette");
  });

  test("an unknown action is ignored with a warning, the rest of the file applies", async () => {
    writeKeybinds({ banana: ["ctrl+b"], palette: ["ctrl+k"] });
    await render();
    expect(frame()).toContain('unknown action "banana" ignored');
    await press("k", { ctrl: true });
    expect(frame()).toContain("Command Palette");
  });

  test("a good file or none shows no toast", async () => {
    await render();
    expect(frame()).not.toContain("Keybinds");
  });
});
