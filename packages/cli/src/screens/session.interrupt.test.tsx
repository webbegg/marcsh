import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
process.env.MARCSH_PREFERENCES_PATH = join(mkdtempSync(join(tmpdir(), "marcsh-session-interrupt-prefs-")), "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
import type { Engine, TurnHost, TurnRequest } from "../lib/engine/types";

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
// OpenTUI 0.9 paints a committed update on a later frame (and a frame cannot be read mid-paint): draw it before it is read.
const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

// A turn that answers in part, then runs until it is interrupted or finishes on `finish`.
let finish = () => {};
const fakeEngine: Engine = {
  id: "claude",
  startTurn(request: TurnRequest, host: TurnHost) {
    let release = () => {};
    const done = (async () => {
      host.emit({ type: "reply", update: (r) => ({ ...r, parts: [{ type: "text", text: "partial answer" }], metadata: { ...r.metadata, durationMs: 3700 } }) });
      await new Promise<void>((resolve) => {
        release = resolve;
        finish = resolve;
        request.signal.addEventListener("abort", () => resolve());
      });
    })();
    return { done, interrupt: () => release() };
  },
  warmUpCommands: async () => {},
};

// pi is the default engine and its status line asks the pi runtime: a stand-in without one keeps the real pi engine from loading.
beforeAll(() => {
  engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} });
  engines.set("claude", fakeEngine);
});
afterAll(() => {
  engines.set("pi", undefined);
  engines.set("claude", undefined);
});
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

async function open(id: string, initialPrompt?: { message: string; mode: "BUILD"; model: string }) {
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${id}`, state: initialPrompt ? { initialPrompt } : undefined }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 30 });
  await settle(100);
}

describe("the footer of an interrupted reply (S6)", () => {
  test("Esc ends the turn and its footer says interrupted, live and after the session is opened again", async () => {
    const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd", engine: "claude" });
    await open(session.id, { message: "go", mode: "BUILD", model: "haiku" });
    expect(frame()).toContain("partial answer");
    expect(frame()).not.toContain("interrupted");

    await settle(400);
    await act(async () => screen!.mockInput.pressEscape());
    await settle(400);
    expect(frame()).toContain("Build › haiku › 3.7s › interrupted");

    // A reload: the screen is built again from what was stored.
    await act(async () => screen!.renderer.destroy());
    await open(session.id);
    expect(frame()).toContain("partial answer");
    expect(frame()).toContain("Build › haiku › 3.7s › interrupted");
  });

  test("a reply that finished on its own has no marker", async () => {
    const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd", engine: "claude" });
    await open(session.id, { message: "go", mode: "BUILD", model: "haiku" });
    await act(async () => finish());
    await settle(150);
    expect(frame()).toContain("Build › haiku › 3.7s");
    expect(frame()).not.toContain("interrupted");
  });
});
