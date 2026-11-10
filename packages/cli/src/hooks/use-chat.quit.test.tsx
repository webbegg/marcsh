import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";

const { testRender } = await import("@opentui/react/test-utils");
const { useChat } = await import("./use-chat");
const { getStorage } = await import("../lib/storage");
const { quitApp, quitEnv, resetQuit } = await import("../lib/quit");
import type { Engine, TurnHost, TurnRequest } from "../lib/engine/types";

let latest: ReturnType<typeof useChat>;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 20) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const realEnv = { ...quitEnv };
let exits: number[];

beforeEach(() => {
  resetQuit();
  exits = [];
  quitEnv.exit = (code) => void exits.push(code);
});

afterEach(() => {
  // Test files share one module registry: a finished quit must not stop the turns of the files that run after this one.
  resetQuit();
  Object.assign(quitEnv, realEnv);
  screen?.renderer.destroy();
  screen = null;
});

// An engine like pi's: the turn asks for approval, and after an abort it needs a moment to clean up before `done` settles.
function engineWithCleanup(cleanupMs: number) {
  const seen = { signal: null as AbortSignal | null, decision: null as string | null, cleanedUp: false, exitsAtCleanup: -1 };
  const engine: Engine = {
    id: "fake",
    startTurn(request: TurnRequest, host: TurnHost) {
      seen.signal = request.signal;
      const done = (async () => {
        seen.decision = await host.askPermission({ toolName: "Bash", input: { command: "sleep 30" } }, request.signal);
        await new Promise((resolve) => setTimeout(resolve, cleanupMs));
        seen.cleanedUp = true;
        seen.exitsAtCleanup = exits.length;
      })();
      return { done, interrupt() {} };
    },
    warmUpCommands: async () => {},
  };
  return { engine, seen };
}

function Probe({ engine, id }: { engine: Engine; id: string }) {
  latest = useChat(getStorage().getSession(id)!, engine);
  return <text>probe</text>;
}

async function open(engine: Engine) {
  const session = getStorage().createSession({ title: "t", cwd: "/tmp/x" });
  screen = await testRender(<Probe engine={engine} id={session.id} />, { width: 40, height: 5 });
  await settle();
  return session;
}

describe("useChat and quit (S20)", () => {
  test("quitting aborts the running turn, declines its pending ask, waits for the turn to settle and saves it, then exits", async () => {
    const { engine, seen } = engineWithCleanup(60);
    const session = await open(engine);
    void latest.submit({ userText: "go", mode: "BUILD", model: "opus" });
    await settle();
    expect(latest.pendingRequest?.kind).toBe("permission");

    const quitting = quitApp({ destroy() {} });
    expect(seen.signal!.aborted).toBe(true);
    await settle();
    expect(seen.decision).toBe("deny");
    expect(latest.pendingRequest).toBeNull();
    // The turn is still cleaning up: no exit yet.
    expect(seen.cleanedUp).toBe(false);
    expect(exits).toEqual([]);

    await act(() => quitting);
    expect(seen.cleanedUp).toBe(true);
    expect(seen.exitsAtCleanup).toBe(0);
    expect(exits).toEqual([0]);
    // The reply made so far was saved before the exit.
    expect(getStorage().getSession(session.id)!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("a second quit while the turn is cleaning up exits at once", async () => {
    const { engine } = engineWithCleanup(300);
    await open(engine);
    void latest.submit({ userText: "go", mode: "BUILD", model: "opus" });
    await settle();

    void quitApp({ destroy() {} });
    await settle();
    expect(exits).toEqual([]);
    void quitApp({ destroy() {} });
    expect(exits).toEqual([0]);
  });

  test("with no turn running the quit is immediate, and a finished turn is not waited for", async () => {
    const { engine } = engineWithCleanup(0);
    await open(engine);
    void latest.submit({ userText: "go", mode: "BUILD", model: "opus" });
    await settle();
    latest.pendingRequest!.kind === "permission" && latest.pendingRequest!.respond("allow");
    await settle(50);
    expect(latest.status).toBe("ready");

    await quitApp({ destroy() {} });
    expect(exits).toEqual([0]);
  });
});
