import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";

const { testRender } = await import("@opentui/react/test-utils");
const { useChat } = await import("./use-chat");
const { getStorage } = await import("../lib/storage");
const { createSnapshotStore } = await import("../lib/snapshot");
import type { ChatMessage } from "../lib/chat-types";
import type { Engine, TurnHost, TurnRequest } from "../lib/engine/types";
import type { SnapshotStore, SnapshotStoreResult } from "../lib/snapshot";

let base: string;
let project: string;
let latest: ReturnType<typeof useChat>;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 20) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "marcsh-chat-snapshots-"));
  project = join(base, "project");
  mkdirSync(project);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function realStore(): SnapshotStoreResult {
  return createSnapshotStore({ cwd: project, root: join(base, "snapshots") });
}

function scriptedEngine(run: (request: TurnRequest, host: TurnHost) => Promise<void> | void) {
  const requests: TurnRequest[] = [];
  const engine: Engine = {
    id: "fake",
    startTurn(request, host) {
      requests.push(request);
      return { done: Promise.resolve(run(request, host)), interrupt() {} };
    },
    warmUpCommands: async () => {},
  };
  return { engine, requests };
}

function Probe({ engine, id, snapshots, timeout }: { engine: Engine; id: string; snapshots?: SnapshotStoreResult; timeout?: number }) {
  latest = useChat(getStorage().getSession(id)!, engine, { snapshots, snapshotTimeoutMs: timeout });
  return <text>probe</text>;
}

async function open(engine: Engine, options: { snapshots?: SnapshotStoreResult; timeout?: number; messages?: ChatMessage[]; ref?: string } = {}) {
  const session = getStorage().createSession({ title: "t", cwd: project });
  if (options.messages || options.ref) getStorage().saveMessages(session.id, options.messages ?? [], options.ref);
  screen = await testRender(<Probe engine={engine} id={session.id} snapshots={options.snapshots} timeout={options.timeout} />, { width: 40, height: 5 });
  await settle();
  return session.id;
}

async function turn(text = "hi") {
  let finished = false;
  const done = latest.submit({ userText: text, mode: "BUILD", model: "opus" }).then(() => {
    finished = true;
  });
  for (let i = 0; i < 400 && !finished; i++) await settle(10);
  await done;
  await settle();
}

const lastReply = () => [...latest.messages].reverse().find((m) => m.role === "assistant")!;

afterEach(() => {
  screen?.renderer.destroy();
  screen = null;
});

describe("a turn's snapshot (S4)", () => {
  test("is tracked before and after the turn and stored on its last reply, saved with the session", async () => {
    const store = realStore();
    if (!store.available) throw new Error(store.reason);
    const { engine } = scriptedEngine(() => {
      writeFileSync(join(project, "made.txt"), "made by the turn");
    });
    const id = await open(engine, { snapshots: store });
    await turn();

    const snapshot = lastReply().metadata?.snapshot;
    expect(snapshot?.before).toMatch(/^[0-9a-f]{40,64}$/);
    expect(snapshot?.after).toMatch(/^[0-9a-f]{40,64}$/);
    expect(snapshot?.before).not.toBe(snapshot?.after);
    expect(await store.store.changedFiles(snapshot!.before, snapshot!.after)).toEqual(["made.txt"]);
    const saved = getStorage().getSession(id)!.messages.at(-1)!;
    expect(saved.metadata?.snapshot).toEqual(snapshot!);
  });

  test("the turn starts only after the files before it were captured", async () => {
    const store = realStore();
    if (!store.available) throw new Error(store.reason);
    writeFileSync(join(project, "ordered.txt"), "v1");
    let seen: string | undefined;
    const { engine } = scriptedEngine(async () => {
      seen = await store.store.track();
      writeFileSync(join(project, "ordered.txt"), "v2");
    });
    await open(engine, { snapshots: store });
    await turn();
    // `before` is the tree the engine saw at its start, which is still v1.
    expect(lastReply().metadata?.snapshot?.before).toBe(seen!);
  });

  test("without a store nothing is tracked and the turn runs", async () => {
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine);
    await turn();
    expect(requests).toHaveLength(1);
    expect(lastReply().metadata?.snapshot).toBeUndefined();
    expect(latest.snapshotIssue()).toBeUndefined();
  });

  test("a snapshot that fails never stops the turn, and the reason is kept for /undo", async () => {
    const failing = { available: true, store: { track: async () => Promise.reject(new Error("shadow repo is locked")) } as unknown as SnapshotStore } as const;
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine, { snapshots: failing });
    await turn();
    expect(requests).toHaveLength(1);
    expect(latest.error).toBeNull();
    expect(lastReply().metadata?.snapshot).toBeUndefined();
    expect(latest.snapshotIssue()).toBe("shadow repo is locked");
  });

  test("a snapshot that takes too long is given up on", async () => {
    const slow = { available: true, store: { track: () => new Promise<string>(() => {}) } as unknown as SnapshotStore } as const;
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine, { snapshots: slow, timeout: 30 });
    await turn();
    expect(requests).toHaveLength(1);
    expect(lastReply().metadata?.snapshot).toBeUndefined();
    expect(latest.snapshotIssue()).toContain("took longer than");
  });

  test("after one gave up, the session's later turns are not held up by another", async () => {
    let tracked = 0;
    const slow = { available: true, store: { track: () => (tracked++, new Promise<string>(() => {})) } as unknown as SnapshotStore } as const;
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine, { snapshots: slow, timeout: 30 });
    await turn("one");
    await turn("two");
    expect(requests).toHaveLength(2);
    expect(tracked).toBe(1);
    expect(latest.snapshotIssue()).toContain("took longer than");
  });

  test("a new turn after an undo makes the undone replies final", async () => {
    const undone: ChatMessage = {
      id: "old",
      role: "assistant",
      parts: [{ type: "text", text: "done" }],
      metadata: { snapshot: { before: "a".repeat(40), after: "b".repeat(40), undone: true } },
    };
    const store = realStore();
    if (!store.available) throw new Error(store.reason);
    const { engine } = scriptedEngine(() => {});
    await open(engine, { snapshots: store, messages: [undone] });
    await turn();
    expect(latest.messages.find((m) => m.id === "old")!.metadata?.snapshot).toMatchObject({ undone: true, abandoned: true });
  });
});

describe("editMessages", () => {
  test("changes the messages and saves them", async () => {
    const { engine } = scriptedEngine(() => {});
    const message: ChatMessage = { id: "m", role: "assistant", parts: [{ type: "text", text: "x" }] };
    const id = await open(engine, { messages: [message] });
    let failure: string | undefined = "unset";
    await act(async () => {
      failure = latest.editMessages((prev) => prev.map((m) => ({ ...m, metadata: { mode: "PLAN" as const } })));
    });
    expect(failure).toBeUndefined();
    expect(getStorage().getSession(id)!.messages[0]!.metadata?.mode).toBe("PLAN");
    expect(latest.messages[0]!.metadata?.mode).toBe("PLAN");
  });
});

describe("the cost a resumed turn carries over", () => {
  const replyWith = (usage: object, costUsd: number): ChatMessage => ({ id: "r", role: "assistant", parts: [], metadata: { costUsd, usage } });

  test("the engine is told what the session had cost, to subtract it", async () => {
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine, { messages: [replyWith({ costUsd: 0.1, cumulativeCostUsd: 0.5 }, 0.1)], ref: "claude-1" });
    await turn();
    expect(requests[0]!.priorCostUsd).toBe(0.5);
  });

  test("a reply saved before the running total was kept has it as its cost", async () => {
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine, { messages: [replyWith({ costUsd: 0.7 }, 0.7)], ref: "claude-1" });
    await turn();
    expect(requests[0]!.priorCostUsd).toBe(0.7);
  });

  test("a conversation that was not resumed starts from nothing", async () => {
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine, { messages: [replyWith({ costUsd: 0.7, cumulativeCostUsd: 0.7 }, 0.7)] });
    await turn();
    expect(requests[0]!.priorCostUsd).toBeUndefined();
  });
});

describe("the first turn of a session with messages but no engine conversation (a fork, A2)", () => {
  const said = (id: string, role: "user" | "assistant", text: string): ChatMessage => ({ id, role, parts: [{ type: "text", text }] });
  const earlier = [said("u", "user", "why does the build fail?"), said("a", "assistant", "a missing import")];

  test("is primed with the transcript, and the chat shows only what was typed", async () => {
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine, { messages: earlier });
    await turn("and the tests?");
    expect(requests[0]!.prompt).toContain("a missing import");
    expect(requests[0]!.prompt.endsWith("and the tests?")).toBe(true);
    expect(latest.messages.find((m) => m.role === "user" && m.parts[0]?.type === "text" && m.parts[0].text.includes("and the tests?"))!.parts).toEqual([
      { type: "text", text: "and the tests?" },
    ]);
  });

  test("only the first turn is primed, even when the engine reports no conversation of its own", async () => {
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine, { messages: earlier });
    await turn("one");
    await turn("two");
    expect(requests[0]!.prompt).toContain("a missing import");
    expect(requests[1]!.prompt).toBe("two");
  });

  test("a /command first leaves the priming for the first turn that is not one", async () => {
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine, { messages: earlier });
    await turn("/review");
    await turn("then this");
    expect(requests[0]!.prompt).toBe("/review");
    expect(requests[1]!.prompt).toContain("a missing import");
  });

  test("a session that has its conversation is sent the prompt as typed", async () => {
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine, { messages: earlier, ref: "claude-1" });
    await turn("and the tests?");
    expect(requests[0]!.prompt).toBe("and the tests?");
  });

  test("a new session has nothing to prime with", async () => {
    const { engine, requests } = scriptedEngine(() => {});
    await open(engine);
    await turn("hello");
    expect(requests[0]!.prompt).toBe("hello");
  });
});

describe("compact", () => {
  test("an engine without compact says so, and the session stays ready", async () => {
    const { engine } = scriptedEngine(() => {});
    await open(engine, { ref: "x" });
    let outcome: Awaited<ReturnType<typeof latest.compact>> | undefined;
    await act(async () => {
      outcome = await latest.compact("m");
    });
    expect(outcome).toEqual({ ok: false, reason: "This engine cannot compact its context." });
    expect(latest.status).toBe("ready");
  });

  test("runs the engine's compaction on the session's conversation and keeps the session busy meanwhile", async () => {
    const calls: { resumeRef: string; model: string; cwd: string }[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { engine } = scriptedEngine(() => {});
    engine.compact = async (request) => {
      calls.push({ resumeRef: request.resumeRef, model: request.model, cwd: request.cwd });
      await gate;
      return { tokensBefore: 9000, tokensAfter: 1500 };
    };
    const reply: ChatMessage = { id: "r", role: "assistant", parts: [{ type: "text", text: "x" }], metadata: { usage: { contextTokens: 9000, contextWindow: 20000 } } };
    const id = await open(engine, { messages: [reply], ref: "pi-file" });

    let outcome: Awaited<ReturnType<typeof latest.compact>> | undefined;
    const running = latest.compact("pi/model").then((result) => (outcome = result));
    await settle();
    expect(latest.status).toBe("submitted");
    // The input must not take a message meanwhile: a prompt sent now would be dropped.
    expect(latest.compacting).toBe(true);
    release();
    await act(async () => {
      await running;
    });
    expect(calls).toEqual([{ resumeRef: "pi-file", model: "pi/model", cwd: project }]);
    expect(outcome).toEqual({ ok: true, tokensBefore: 9000, tokensAfter: 1500 });
    expect(latest.status).toBe("ready");
    expect(latest.compacting).toBe(false);
    // The status line shows the new, smaller context until the next reply reports its own.
    expect(latest.messages[0]!.metadata?.usage?.contextTokens).toBe(1500);
    expect(getStorage().getSession(id)!.messages[0]!.metadata?.usage?.contextTokens).toBe(1500);
  });

  test("Esc (interrupt) cancels it: the engine's signal aborts and the outcome says so", async () => {
    let signal: AbortSignal | undefined;
    const { engine } = scriptedEngine(() => {});
    engine.compact = (request) =>
      new Promise((_, reject) => {
        signal = request.signal;
        request.signal.addEventListener("abort", () => reject(new Error("Compaction was cancelled.")));
      });
    await open(engine, { ref: "pi-file" });
    let outcome: Awaited<ReturnType<typeof latest.compact>> | undefined;
    const running = latest.compact("pi/model").then((result) => (outcome = result));
    await settle();
    act(() => latest.interrupt());
    await act(async () => {
      await running;
    });
    expect(signal?.aborted).toBe(true);
    expect(outcome).toEqual({ ok: false, reason: "Compaction was cancelled." });
    expect(latest.status).toBe("ready");
  });

  test("a failure is reported and never leaves the session busy", async () => {
    const { engine } = scriptedEngine(() => {});
    engine.compact = async () => {
      throw new Error("Nothing to compact");
    };
    await open(engine, { ref: "pi-file" });
    let outcome: Awaited<ReturnType<typeof latest.compact>> | undefined;
    await act(async () => {
      outcome = await latest.compact("pi/model");
    });
    expect(outcome).toEqual({ ok: false, reason: "Nothing to compact" });
    expect(latest.status).toBe("ready");
  });

  test("without a conversation there is nothing to compact", async () => {
    const { engine } = scriptedEngine(() => {});
    engine.compact = async () => ({});
    await open(engine);
    let outcome: Awaited<ReturnType<typeof latest.compact>> | undefined;
    await act(async () => {
      outcome = await latest.compact("m");
    });
    expect(outcome).toEqual({ ok: false, reason: "Nothing to compact yet: this session has no conversation." });
  });
});
