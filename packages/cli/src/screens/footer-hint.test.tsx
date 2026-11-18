import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

const root = join(tmpdir(), `marcsh-footer-hint-${process.pid}`);
process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh.
process.env.MARCSH_PREFERENCES_PATH = join(root, "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(root, "agents");
process.env.MARCSH_COMMANDS_DIR = join(root, "commands");
process.env.MARCSH_KEYBINDS_PATH = join(root, "keybinds.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { setDefaultEngine } = await import("../lib/preferences");
const { resetKeybinds } = await import("../lib/keybinds");
const { clearDrafts } = await import("../lib/prompt-history");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
// OpenTUI 0.9 paints a committed update on a later frame (and a frame cannot be read mid-paint): draw it before it is read.
const settle = async (ms = 40) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

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

async function openAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 30 });
  await settle(100);
}
const openHome = () => openAt("/");
const openSession = async () => {
  const session = getStorage().createSession({ title: "t", cwd: process.cwd(), engine: "claude" });
  await openAt(`/sessions/${session.id}`);
};
const useKeybinds = (config: object) => writeFileSync(process.env.MARCSH_KEYBINDS_PATH!, JSON.stringify(config));

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  resetKeybinds();
  clearDrafts();
  setDefaultEngine("claude");
  // The session screen asks its engine for commands: a stand-in keeps the real one from starting.
  engines.set("claude", { id: "claude", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} });
});

afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  engines.set("claude", undefined);
});

describe("the footer hint names the palette (S15)", () => {
  test("home shows `ctrl+p commands` next to `tab agents`", async () => {
    await openHome();
    expect(frame()).toContain("ctrl+p commands tab agents");
  });

  test("a session shows `ctrl+p commands` next to `tab agents`", async () => {
    await openSession();
    expect(frame()).toContain("ctrl+p commands tab agents");
  });

  test("a rebound palette shows its new key", async () => {
    useKeybinds({ palette: ["ctrl+k"] });
    await openHome();
    expect(frame()).toContain("ctrl+k commands tab agents");
    expect(frame()).not.toContain("ctrl+p");
  });

  test("a palette on a key after the leader shows the leader and the key", async () => {
    useKeybinds({ palette: ["<leader>k"] });
    await openSession();
    expect(frame()).toContain("ctrl+x k commands tab agents");
  });

  test("an unbound palette leaves the hint out and keeps `tab agents`", async () => {
    useKeybinds({ palette: [] });
    await openHome();
    expect(frame()).toContain("tab agents");
    expect(frame()).not.toContain("commands tab");
    expect(frame()).not.toContain("ctrl+p");
  });

  test("an unbound palette leaves the hint out in a session too", async () => {
    useKeybinds({ palette: [] });
    await openSession();
    expect(frame()).toContain("tab agents");
    expect(frame()).not.toContain("ctrl+p");
  });
});
