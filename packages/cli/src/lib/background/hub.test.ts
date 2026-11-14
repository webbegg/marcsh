import { describe, expect, test } from "bun:test";
import type { QuitTurn } from "../quit";
import { backgroundMessageText, createBackgroundHub, noticeOf, type BackgroundBatch, type BackgroundResult } from "./hub";

const wait = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const result = (id: string, overrides: Partial<BackgroundResult> = {}): BackgroundResult => ({
  id,
  kind: "terminal",
  title: `job ${id}`,
  text: `${id} exited with code 0`,
  ...overrides,
});

// A sink that takes (or refuses) every batch and keeps what it took.
function sink(accept = true) {
  const batches: BackgroundBatch[] = [];
  const offered: BackgroundBatch[] = [];
  const take = (batch: BackgroundBatch) => {
    offered.push(batch);
    if (!state.accept) return false;
    batches.push(batch);
    return true;
  };
  const state = { accept, batches, offered, take };
  return state;
}

describe("background hub (S2)", () => {
  test("a finished result is announced once, as a notice and the text the model gets", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const idle = sink();
    hub.setIdleSink(idle.take);
    hub.finish(result("bg-1"));
    await wait();
    expect(idle.batches).toEqual([{ ids: ["bg-1"], notice: "[background] job bg-1 finished", text: "bg-1 exited with code 0" }]);
    // Announced already: a tool that collects it later is told it was not first, and nothing is announced again.
    expect(hub.consume(["bg-1"])).toEqual([]);
    hub.retry();
    await wait();
    expect(idle.batches).toHaveLength(1);
    expect(hub.pending()).toEqual([]);
  });

  test("a result collected by a tool first is never announced", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const idle = sink();
    hub.setIdleSink(idle.take);
    hub.finish(result("bg-1"));
    expect(hub.pending().map((r) => r.id)).toEqual(["bg-1"]);
    expect(hub.consume(["bg-1", "bg-2"])).toEqual(["bg-1", "bg-2"]);
    expect(hub.pending()).toEqual([]);
    // bg-2 was collected (killed) before it finished: its result is not announced either.
    hub.finish(result("bg-2"));
    hub.finish(result("bg-1"));
    await wait();
    expect(idle.offered).toEqual([]);
    expect(hub.consume(["bg-1"])).toEqual([]);
  });

  test("results that finish together go out as one batch", async () => {
    const hub = createBackgroundHub({ debounceMs: 20 });
    const idle = sink();
    hub.setIdleSink(idle.take);
    hub.finish(result("bg-1"));
    await wait(5);
    hub.finish(result("bg-2", { notice: "[background] tests finished" }));
    await wait(60);
    expect(idle.batches).toEqual([
      {
        ids: ["bg-1", "bg-2"],
        notice: "[background] job bg-1 finished\n[background] tests finished",
        text: "bg-1 exited with code 0\n\nbg-2 exited with code 0",
      },
    ]);
  });

  test("the running turn takes results before the idle path; refused results wait for the next retry", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const idle = sink(false);
    const turn = sink(false);
    hub.setIdleSink(idle.take);
    const detach = hub.attachTurn(turn.take);
    hub.finish(result("bg-1"));
    await wait();
    // Both refused (the turn is not streaming, the chat is busy): the result stays pending.
    expect(turn.offered).toHaveLength(1);
    expect(idle.offered).toHaveLength(1);
    expect(hub.pending().map((r) => r.id)).toEqual(["bg-1"]);

    turn.accept = true;
    hub.retry();
    await wait();
    expect(turn.batches.map((b) => b.ids)).toEqual([["bg-1"]]);
    expect(idle.batches).toEqual([]);

    // The turn ended before it sent it: requeued, it goes to the idle path once that takes it.
    detach();
    hub.requeue(["bg-1"]);
    expect(hub.pending().map((r) => r.id)).toEqual(["bg-1"]);
    idle.accept = true;
    hub.retry();
    await wait();
    expect(idle.batches.map((b) => b.ids)).toEqual([["bg-1"]]);
    expect(turn.offered).toHaveLength(2);
  });

  test("a turn that attaches picks up what is pending", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    hub.finish(result("bg-1"));
    await wait();
    expect(hub.pending()).toHaveLength(1);
    const turn = sink();
    hub.attachTurn(turn.take);
    await wait();
    expect(turn.batches.map((b) => b.ids)).toEqual([["bg-1"]]);
  });

  test("a requeue never brings back a result a tool has collected meanwhile", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const idle = sink();
    hub.setIdleSink(idle.take);
    hub.finish(result("bg-1"));
    await wait();
    hub.consume(["bg-1"]);
    hub.requeue(["bg-1", "unknown"]);
    expect(hub.pending()).toEqual([]);
  });

  test("subscribers hear every change until they unsubscribe", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    let calls = 0;
    const unsubscribe = hub.subscribe(() => calls++);
    hub.finish(result("bg-1"));
    expect(calls).toBe(1);
    hub.changed();
    expect(calls).toBe(2);
    hub.consume(["bg-1"]);
    expect(calls).toBe(3);
    unsubscribe();
    hub.changed();
    expect(calls).toBe(3);
  });

  test("dispose runs every registered disposer once and the hub takes nothing more", async () => {
    const turns: QuitTurn[] = [];
    const hub = createBackgroundHub({ debounceMs: 5, registerTurn: (turn) => (turns.push(turn), () => void turns.splice(turns.indexOf(turn), 1)) });
    const idle = sink();
    hub.setIdleSink(idle.take);
    const killed: string[] = [];
    hub.onDispose(() => void killed.push("terminals"));
    hub.onDispose(async () => {
      await wait(5);
      killed.push("subagents");
    });
    const dropped = hub.onDispose(() => void killed.push("dropped"));
    dropped();

    // Each running item registers with quit through the hub.
    const unregister = hub.registerTurn({ stop: () => {}, done: Promise.resolve() });
    expect(turns).toHaveLength(1);
    unregister();
    expect(turns).toHaveLength(0);

    hub.host = { askPermission: async () => "allow" };
    hub.finish(result("bg-1"));
    await hub.dispose();
    await hub.dispose();
    expect(killed).toEqual(["terminals", "subagents"]);
    expect(hub.disposed).toBe(true);
    expect(hub.host).toBeUndefined();
    hub.finish(result("bg-2"));
    hub.retry();
    await wait();
    expect(idle.offered).toEqual([]);
  });

  test("the transcript keeps the notice and the text; only the notice is shown", () => {
    const batch = { ids: ["a", "b"], notice: "[background] a finished\n[background] b finished", text: "A\n\nB" };
    const message = backgroundMessageText(batch);
    expect(message).toBe("[background] a finished\n[background] b finished\n\nA\n\nB");
    expect(noticeOf(message)).toBe(batch.notice);
    expect(noticeOf("no blank line")).toBe("no blank line");
  });
});
