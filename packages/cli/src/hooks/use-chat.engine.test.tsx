import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";

const { testRender } = await import("@opentui/react/test-utils");
const { useChat } = await import("./use-chat");
const { getStorage } = await import("../lib/storage");
import type { Engine, TurnHost, TurnRequest } from "../lib/engine/types";

let latest: ReturnType<typeof useChat>;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 20) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

// An engine whose turn is driven step by step from the test.
function scriptedEngine(run: (request: TurnRequest, host: TurnHost) => Promise<void>, onInterrupt = () => {}) {
  const requests: TurnRequest[] = [];
  const engine: Engine = {
    id: "fake",
    startTurn(request, host) {
      requests.push(request);
      return { done: run(request, host), interrupt: onInterrupt };
    },
    warmUpCommands: async () => {},
  };
  return { engine, requests };
}

function Probe({ engine, id }: { engine: Engine; id: string }) {
  latest = useChat(getStorage().getSession(id)!, engine);
  return <text>probe</text>;
}

async function open(engine: Engine, id = getStorage().createSession({ title: "t", cwd: "/tmp/x" }).id) {
  screen = await testRender(<Probe engine={engine} id={id} />, { width: 40, height: 5 });
  await settle();
  return id;
}

// Starts a turn outside act, so the test can watch the hook re-render while the turn runs.
function start(text = "hi") {
  let finished = false;
  const done = latest.submit({ userText: text, mode: "BUILD", model: "opus" }).then(() => {
    finished = true;
  });
  return { done, finished: () => finished };
}

async function turn(text = "hi") {
  const running = start(text);
  for (let i = 0; i < 100 && !running.finished(); i++) await settle(10);
  await running.done;
  await settle();
}

afterEach(() => {
  screen?.renderer.destroy();
  screen = null;
});

describe("useChat over an Engine (S1)", () => {
  test("an approval resolves once with the user's first answer", async () => {
    const decisions: string[] = [];
    const { engine } = scriptedEngine(async (_request, host) => {
      const signal = new AbortController().signal;
      decisions.push(await host.askPermission({ toolName: "Bash", input: { command: "ls" } }, signal));
    });
    await open(engine);
    const running = start();
    await settle();
    const request = latest.pendingRequest!;
    expect(request.kind).toBe("permission");
    if (request.kind === "permission") {
      request.respond("allow");
      request.respond("deny");
    }
    await running.done;
    await settle();
    expect(decisions).toEqual(["allow"]);
    expect(latest.pendingRequest).toBeNull();
  });

  test("aborting the request's signal declines it; asks still pending at turn end are declined", async () => {
    const results: unknown[] = [];
    const { engine } = scriptedEngine(async (_request, host) => {
      const ac = new AbortController();
      const asked = host.askPermission({ toolName: "Bash", input: {} }, ac.signal);
      ac.abort();
      results.push(await asked);
      void host.askPermission({ toolName: "Edit", input: {} }, new AbortController().signal).then((d) => results.push(d));
      void host.askQuestions([], new AbortController().signal).then((a) => results.push(a));
    });
    await open(engine);
    await turn();
    expect(results).toEqual(["deny", "deny", null]);
    expect(latest.pendingRequest).toBeNull();
    expect(latest.status).toBe("ready");
  });

  test("interrupt hides the turn's error; the next turn shows its own", async () => {
    let interrupted = 0;
    const { engine } = scriptedEngine(
      async (request, host) => {
        if (request.prompt === "one") {
          await Promise.resolve();
          latest.interrupt();
          host.emit({ type: "error", message: "stopped" });
          throw new Error("stream closed");
        }
        host.emit({ type: "error", message: "real failure" });
      },
      () => interrupted++,
    );
    await open(engine);
    await turn("one");
    expect(interrupted).toBe(1);
    expect(latest.error).toBeNull();
    await turn("two");
    expect(latest.error).toBe("real failure");
  });

  test("commands are cached without touching status; the session ref is saved and resumed", async () => {
    const statuses: string[] = [];
    const { engine, requests } = scriptedEngine(async (_request, host) => {
      host.emit({ type: "commands", commands: [{ name: "deploy", description: "Ship", argumentHint: "" }] });
      await new Promise((r) => setTimeout(r, 30));
      statuses.push(latest.status);
      host.emit({ type: "session", ref: "ref-1" });
      host.emit({ type: "reply", update: (reply) => ({ ...reply, parts: [{ type: "text", text: "ok" }] }) });
      await new Promise((r) => setTimeout(r, 30));
      statuses.push(latest.status);
    });
    const id = await open(engine);
    await turn();
    expect(statuses).toEqual(["submitted", "streaming"]);
    expect(getStorage().getClaudeCommands().map((c) => c.name)).toEqual(["deploy"]);
    expect(getStorage().getSession(id)!.engineSessionRef).toBe("ref-1");
    screen!.renderer.destroy();
    await open(engine, id);
    await turn();
    expect(requests.map((r) => r.resumeRef)).toEqual([undefined, "ref-1"]);
  });
});
