import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
process.env.MARCSH_PREFERENCES_PATH = join(mkdtempSync(join(tmpdir(), "marcsh-session-streaming-prefs-")), "preferences.json");

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

// A turn that has written the start of a reply (an emphasis not closed yet) and runs until `finish`.
let finish = () => {};
const fakeEngine: Engine = {
  id: "claude",
  startTurn(request: TurnRequest, host: TurnHost) {
    let release = () => {};
    const done = (async () => {
      host.emit({ type: "reply", update: (r) => ({ ...r, parts: [{ type: "text", text: "so **bo" }] }) });
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

describe("the reply being written is streamed markdown (S8)", () => {
  test("an unclosed emphasis is drawn as closed while the turn runs, and as written once it ends", async () => {
    const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd", engine: "claude" });
    await open(session.id, { message: "go", mode: "BUILD", model: "haiku" });

    await settle(300);
    expect(frame()).toContain("so bo");
    expect(frame()).not.toContain("**bo");

    await act(async () => finish());
    await settle(300);
    expect(frame()).toContain("so **bo");
  });

  test("a reply stopped with Esc is drawn as written", async () => {
    const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd", engine: "claude" });
    await open(session.id, { message: "go", mode: "BUILD", model: "haiku" });
    await settle(300);
    expect(frame()).not.toContain("**bo");

    await act(async () => screen!.mockInput.pressEscape());
    await settle(300);
    expect(frame()).toContain("interrupted");
    expect(frame()).toContain("so **bo");
  });

  test("a reply that was saved is complete when the session is opened", async () => {
    const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd", engine: "claude" });
    await open(session.id, { message: "go", mode: "BUILD", model: "haiku" });
    await act(async () => finish());
    await settle(300);
    await act(async () => screen!.renderer.destroy());

    await open(session.id);
    expect(frame()).toContain("so **bo");
  });
});
