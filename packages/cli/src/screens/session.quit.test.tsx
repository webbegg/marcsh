import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
process.env.MARCSH_PREFERENCES_PATH = join(mkdtempSync(join(tmpdir(), "marcsh-session-quit-prefs-")), "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { quitApp, quitEnv, resetQuit } = await import("../lib/quit");
import type { Engine, TurnHost, TurnRequest } from "../lib/engine/types";

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const realEnv = { ...quitEnv };
let exits: number[];

// What the fake engine's turn saw: its signal, the answer to its approval, and whether its cleanup ran before the exit.
let seen: { signal: AbortSignal | null; decision: string | null; cleanedUp: boolean; exitsAtCleanup: number };

// A Claude-engine stand-in: the turn asks for approval, and after an abort it needs a moment to clean up.
const fakeEngine: Engine = {
  id: "claude",
  startTurn(request: TurnRequest, host: TurnHost) {
    seen.signal = request.signal;
    const done = (async () => {
      seen.decision = await host.askPermission({ toolName: "Bash", input: { command: "sleep 30" } }, request.signal);
      await new Promise((resolve) => setTimeout(resolve, 80));
      seen.cleanedUp = true;
      seen.exitsAtCleanup = exits.length;
    })();
    return { done, interrupt() {} };
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

beforeEach(() => {
  resetQuit();
  exits = [];
  seen = { signal: null, decision: null, cleanedUp: false, exitsAtCleanup: -1 };
  quitEnv.exit = (code) => void exits.push(code);
});

afterEach(async () => {
  // Test files share one module registry: a finished quit must not stop the turns of the files that run after this one.
  resetQuit();
  Object.assign(quitEnv, realEnv);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

async function openSession(initialPrompt?: { message: string; mode: "BUILD"; model: string }) {
  const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: initialPrompt ? { initialPrompt } : undefined }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 30 });
  await settle();
  return session;
}

const ctrlC = async () => act(async () => screen!.mockInput.pressKey("c" as never, { ctrl: true }));

describe("quitting from the session screen (S20)", () => {
  test("Ctrl+C during a turn aborts it, declines the pending approval, waits for the turn, then exits with 0", async () => {
    await openSession({ message: "go", mode: "BUILD", model: "opus" });
    await settle(50);
    expect(screen!.captureCharFrame()).toContain("Allow Bash?");
    expect(seen.signal!.aborted).toBe(false);

    await ctrlC();
    expect(seen.signal!.aborted).toBe(true);
    expect((screen!.renderer as any).isDestroyed).toBe(true);
    await settle(20);
    expect(seen.decision).toBe("deny");
    expect(exits).toEqual([]);

    await settle(200);
    expect(seen.cleanedUp).toBe(true);
    expect(seen.exitsAtCleanup).toBe(0);
    expect(exits).toEqual([0]);
  });

  test("a second Ctrl+C while the turn is cleaning up exits at once", async () => {
    await openSession({ message: "go", mode: "BUILD", model: "opus" });
    await settle(50);
    await ctrlC();
    expect(exits).toEqual([]);
    // The renderer is gone after the first Ctrl+C, so the second request comes from a signal or `/exit`.
    void quitApp({ destroy() {} });
    expect(exits).toEqual([0]);
  });

  test("Ctrl+C with no turn running exits at once", async () => {
    await openSession();
    await ctrlC();
    expect(exits).toEqual([0]);
    expect((screen!.renderer as any).isDestroyed).toBe(true);
  });

  test("/exit with no turn running exits at once", async () => {
    await openSession();
    await act(() => screen!.mockInput.typeText("/exit"));
    await settle(60);
    await act(async () => screen!.mockInput.pressKey("RETURN" as never));
    await settle();
    expect(exits).toEqual([0]);
    expect((screen!.renderer as any).isDestroyed).toBe(true);
  });
});
