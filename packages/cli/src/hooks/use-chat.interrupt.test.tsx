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
beforeEach(() => {
  resetQuit();
  quitEnv.exit = () => {};
});
afterEach(() => {
  resetQuit();
  Object.assign(quitEnv, realEnv);
  screen?.renderer.destroy();
  screen = null;
});

/** An engine whose turn says something, then waits for `release` (or an abort/interrupt) before it ends. */
function engineThatWaits(then: (host: TurnHost, request: TurnRequest) => void | Promise<void> = () => {}) {
  let release = () => {};
  const engine: Engine = {
    id: "fake",
    startTurn(request, host) {
      const done = (async () => {
        host.emit({ type: "reply", update: (r) => ({ ...r, parts: [{ type: "text", text: "partial" }], metadata: { ...r.metadata, durationMs: 3700 } }) });
        await new Promise<void>((resolve) => {
          release = resolve;
          request.signal.addEventListener("abort", () => resolve());
        });
        await then(host, request);
      })();
      return { done, interrupt: () => release() };
    },
    warmUpCommands: async () => {},
  };
  return { engine, finish: () => release() };
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

const lastReply = (messages: { role: string; metadata?: { interrupted?: boolean; durationMs?: number } }[]) =>
  [...messages].reverse().find((m) => m.role === "assistant")!;

describe("an interrupted turn (S6)", () => {
  test("Esc marks the turn's reply as interrupted, in the chat and in the stored session, keeping the rest of its metadata", async () => {
    const { engine } = engineThatWaits();
    const session = await open(engine);
    const running = latest.submit({ userText: "go", mode: "BUILD", model: "haiku" });
    await settle();
    act(() => latest.interrupt());
    await act(async () => {
      await running;
    });
    await settle();

    expect(lastReply(latest.messages).metadata?.interrupted).toBe(true);
    expect(lastReply(latest.messages).metadata?.durationMs).toBe(3700);
    const stored = lastReply(getStorage().getSession(session.id)!.messages);
    expect(stored.metadata?.interrupted).toBe(true);
    expect(stored.metadata?.durationMs).toBe(3700);
  });

  test("a turn that ends by itself is not marked", async () => {
    const { engine, finish } = engineThatWaits();
    const session = await open(engine);
    const running = latest.submit({ userText: "go", mode: "BUILD", model: "haiku" });
    await settle();
    finish();
    await act(async () => {
      await running;
    });
    await settle();

    expect(lastReply(latest.messages).metadata?.interrupted).toBeUndefined();
    expect(lastReply(getStorage().getSession(session.id)!.messages).metadata?.interrupted).toBeUndefined();
  });

  test("a turn that fails is not marked", async () => {
    const { engine, finish } = engineThatWaits(() => {
      throw new Error("boom");
    });
    const session = await open(engine);
    const running = latest.submit({ userText: "go", mode: "BUILD", model: "haiku" });
    await settle();
    finish();
    await act(async () => {
      await running;
    });
    await settle();

    expect(latest.error).toBe("boom");
    expect(lastReply(getStorage().getSession(session.id)!.messages).metadata?.interrupted).toBeUndefined();
  });

  test("quitting the app is not an interruption", async () => {
    const { engine } = engineThatWaits();
    const session = await open(engine);
    void latest.submit({ userText: "go", mode: "BUILD", model: "haiku" });
    await settle();
    await act(() => quitApp({ destroy() {} }));
    await settle();

    expect(lastReply(getStorage().getSession(session.id)!.messages).metadata?.interrupted).toBeUndefined();
  });

  test("the next turn after an interrupted one is not marked", async () => {
    const { engine, finish } = engineThatWaits();
    await open(engine);
    const first = latest.submit({ userText: "one", mode: "BUILD", model: "haiku" });
    await settle();
    act(() => latest.interrupt());
    await act(async () => {
      await first;
    });
    await settle();

    const second = latest.submit({ userText: "two", mode: "BUILD", model: "haiku" });
    await settle();
    finish();
    await act(async () => {
      await second;
    });
    await settle();

    const replies = latest.messages.filter((m) => m.role === "assistant");
    expect(replies).toHaveLength(2);
    expect(replies[0]!.metadata?.interrupted).toBe(true);
    expect(replies[1]!.metadata?.interrupted).toBeUndefined();
  });
});
