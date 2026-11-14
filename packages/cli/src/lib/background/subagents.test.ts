import { afterEach, describe, expect, test } from "bun:test";
import type { QuitTurn } from "../quit";
import type { ChildRun } from "../engine/pi-subagent";
import { backgroundResultsText, createBackgroundHub, type BackgroundBatch, type BackgroundHub } from "./hub";
import { subagentsFor } from "./session-subagents";
import {
  buildSubagentResult,
  createSubagents,
  MAX_RUNNING_SUBAGENTS,
  MAX_TOOL_INPUT_CHARS,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_PARTS,
  type BackgroundSubagents,
  type SubagentRunContext,
  type SubagentSnapshot,
} from "./subagents";

// S4: the background subagents of one session: at most 4 run, each can be cancelled, and each result goes to the hub once.

const made: BackgroundSubagents[] = [];
const hubs: BackgroundHub[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((subagents) => subagents.dispose()));
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
});

const wait = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 4000) {
  const start = Date.now();
  while (!check() && Date.now() - start < timeoutMs) await wait(5);
  expect(check()).toBe(true);
}

const FINISHED: ChildRun = { text: "Found it in src/app.ts.", toolUses: 3, totalTokens: 1200, costUsd: 0.02 };

/** A run that ends only when its signal aborts (or never, with `ignoreAbort`). */
const hanging =
  ({ ignoreAbort = false } = {}) =>
  ({ signal }: SubagentRunContext) =>
    new Promise<ChildRun>((_resolve, reject) => {
      if (ignoreAbort) return;
      if (signal.aborted) return reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

function setup(options: Parameters<typeof createSubagents>[0] = {}) {
  const settled: SubagentSnapshot[] = [];
  const turns: QuitTurn[] = [];
  const unregistered: QuitTurn[] = [];
  const subagents = createSubagents({
    onSettled: (snapshot) => settled.push(snapshot),
    registerTurn: (turn) => {
      turns.push(turn);
      return () => void unregistered.push(turn);
    },
    ...options,
  });
  made.push(subagents);
  return { subagents, settled, turns, unregistered };
}

describe("background subagents (S4)", () => {
  test("start returns a running snapshot at once, then settles completed with the child's text and usage", async () => {
    const { subagents, settled } = setup();
    let finish!: (run: ChildRun) => void;
    const snap = subagents.start({ description: "Find the entry point", prompt: "Where does it start?", run: () => new Promise((resolve) => (finish = resolve)) });

    expect(snap).toMatchObject({ id: "sa-1", status: "running", description: "Find the entry point", prompt: "Where does it start?" });
    expect(subagents.running()).toBe(1);
    finish(FINISHED);
    await subagents.settled(snap.id);

    expect(snap).toMatchObject({ status: "completed", text: FINISHED.text, toolUses: 3, totalTokens: 1200, costUsd: 0.02 });
    expect(snap.settledAt).toBeGreaterThanOrEqual(snap.createdAt);
    expect(settled).toEqual([snap]);
    expect(subagents.running()).toBe(0);
  });

  test("a child that fails settles failed with its error", async () => {
    const { subagents, settled } = setup();
    const snap = subagents.start({ description: "Doomed", prompt: "go", run: async () => Promise.reject(new Error("The model is overloaded")) });
    await subagents.settled(snap.id);
    expect(snap).toMatchObject({ status: "failed", error: "The model is overloaded" });
    expect(settled).toHaveLength(1);
  });

  test(`at most ${MAX_RUNNING_SUBAGENTS} run: the slot is taken before the run awaits anything, so starts in one go cannot pass the cap`, async () => {
    expect(MAX_RUNNING_SUBAGENTS).toBe(4);
    const { subagents } = setup();
    const outcomes: string[] = [];
    // Six starts in the same tick: each run awaits before doing anything.
    for (let at = 0; at < 6; at++) {
      try {
        outcomes.push(
          subagents.start({
            description: `job ${at}`,
            prompt: "go",
            run: async (context) => {
              await wait(5);
              return hanging()(context);
            },
          }).id,
        );
      } catch (error) {
        outcomes.push((error as Error).message);
      }
    }
    expect(outcomes.slice(0, 4)).toEqual(["sa-1", "sa-2", "sa-3", "sa-4"]);
    expect(outcomes[4]).toContain("At most 4 background subagents can run at once");
    expect(outcomes[5]).toContain("At most 4");
    expect(subagents.running()).toBe(4);

    // A slot frees when one settles.
    await subagents.cancel(["sa-1"]);
    expect(subagents.start({ description: "next", prompt: "go", run: hanging() }).id).toBe("sa-5");
  });

  test("cancel aborts the child; one that stops settles stopped at once", async () => {
    const { subagents, settled } = setup();
    let signal!: AbortSignal;
    const snap = subagents.start({ description: "Slow", prompt: "go", run: (context) => ((signal = context.signal), hanging()(context)) });
    const [result] = await subagents.cancel([snap.id]);
    expect(signal.aborted).toBe(true);
    expect(result).toBe(snap);
    expect(snap.status).toBe("stopped");
    expect(settled).toEqual([snap]);
  });

  test("a child that ignores the abort is marked stopped after the grace, and its late answer changes nothing", async () => {
    const { subagents, settled } = setup({ stopGraceMs: 60 });
    let finish!: (run: ChildRun) => void;
    const snap = subagents.start({ description: "Stubborn", prompt: "go", run: () => new Promise((resolve) => (finish = resolve)) });
    const started = Date.now();
    await subagents.cancel([snap.id]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(snap.status).toBe("stopped");
    expect(subagents.running()).toBe(0);
    finish(FINISHED);
    await wait();
    expect(snap.status).toBe("stopped");
    expect(settled).toHaveLength(1);
  });

  test("requestCancel stops one without waiting (the dialog's x)", async () => {
    const { subagents } = setup();
    const snap = subagents.start({ description: "Slow", prompt: "go", run: hanging() });
    subagents.requestCancel(snap.id);
    await subagents.settled(snap.id);
    expect(snap.status).toBe("stopped");
  });

  test("each running subagent is registered with quit; quit's stop marks it stopped after the shorter quit grace", async () => {
    const { subagents, turns, unregistered } = setup({ stopGraceMs: 5_000, quitGraceMs: 40 });
    const snap = subagents.start({ description: "Stubborn", prompt: "go", run: hanging({ ignoreAbort: true }) });
    expect(turns).toHaveLength(1);
    const started = Date.now();
    turns[0]!.stop();
    await turns[0]!.done;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(snap.status).toBe("stopped");
    expect(unregistered).toEqual([turns[0]!]);
  });

  test("dispose stops everything, announces nothing, and refuses new starts", async () => {
    const { subagents, settled } = setup({ quitGraceMs: 30 });
    const polite = subagents.start({ description: "Polite", prompt: "go", run: hanging() });
    const stubborn = subagents.start({ description: "Stubborn", prompt: "go", run: hanging({ ignoreAbort: true }) });
    await subagents.dispose();
    expect(polite.status).toBe("stopped");
    expect(stubborn.status).toBe("stopped");
    expect(settled).toEqual([]);
    expect(() => subagents.start({ description: "Late", prompt: "go", run: hanging() })).toThrow("shutting down");
  });

  test("the child's events build a live transcript, its latest text and usage; listeners hear each change", async () => {
    const { subagents } = setup();
    let heard = 0;
    subagents.subscribe(() => void heard++);
    let context!: SubagentRunContext;
    const snap = subagents.start({ description: "Explore", prompt: "go", run: (given) => ((context = given), hanging()(given)) });
    const before = heard;
    context.onEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Looking at src first." }], usage: { input: 10, output: 5, cost: { total: 0.01 } } },
    } as never);
    context.onProgress({ lastToolName: "grep", toolUses: 1, totalTokens: 15 });

    expect(snap.transcript.parts).toEqual([{ type: "text", text: "Looking at src first." }]);
    expect(snap.text).toBe("Looking at src first.");
    expect(snap).toMatchObject({ lastToolName: "grep", toolUses: 1, totalTokens: 15, costUsd: 0.01 });
    expect(heard).toBeGreaterThan(before);
    expect(snap.version).toBeGreaterThan(0);
  });

  test("the live transcript is capped: long tool inputs are cut with a marker, and only the newest parts and text are kept, also once settled (R4-4)", async () => {
    const { subagents } = setup();
    let context!: SubagentRunContext;
    let finish!: (run: ChildRun) => void;
    const snap = subagents.start({ description: "Chatty", prompt: "go", run: (given) => ((context = given), new Promise((resolve) => (finish = resolve))) });
    const say = (content: unknown[]) => context.onEvent({ type: "message_end", message: { role: "assistant", content } } as never);

    say([{ type: "toolCall", id: "w1", name: "write", arguments: { path: "big.txt", content: "x".repeat(10_000) } }]);
    const tool = snap.transcript.parts[0]!;
    if (tool.type !== "tool") throw new Error("expected a tool part");
    expect(tool.input.path).toBe("big.txt");
    expect(String(tool.input.content).length).toBeLessThan(MAX_TOOL_INPUT_CHARS + 50);
    expect(String(tool.input.content)).toEndWith("[truncated]");

    for (let at = 0; at < MAX_TRANSCRIPT_PARTS + 100; at++) say([{ type: "text", text: `${at}:${"y".repeat(2_000)}` }]);
    const size = () => snap.transcript.parts.reduce((sum, part) => sum + (part.type === "text" || part.type === "reasoning" ? part.text.length : 0), 0);
    expect(snap.transcript.parts.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_PARTS);
    expect(size()).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    const last = snap.transcript.parts.at(-1)!;
    expect(last.type === "text" && last.text.startsWith(`${MAX_TRANSCRIPT_PARTS + 99}:`)).toBe(true);

    // One message over the whole cap keeps its tail.
    say([{ type: "text", text: `${"z".repeat(MAX_TRANSCRIPT_CHARS)}THE-END` }]);
    finish(FINISHED);
    await subagents.settled(snap.id);
    expect(snap.transcript.parts).toHaveLength(1);
    expect(size()).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS + 50);
    const tail = snap.transcript.parts[0]!;
    expect(tail.type === "text" && tail.text.endsWith("THE-END") && tail.text.startsWith("[truncated]")).toBe(true);
  });
});

describe("the result the model gets", () => {
  test("names the subagent and how it ended, then the child's text", async () => {
    const { subagents } = setup();
    const done = subagents.start({ description: "Find it", prompt: "go", run: async () => FINISHED });
    const failed = subagents.start({ description: "Doomed", prompt: "go", run: async () => Promise.reject(new Error("overloaded")) });
    const silent = subagents.start({ description: "Silent", prompt: "go", run: async () => ({ ...FINISHED, text: "" }) });
    await Promise.all([done, failed, silent].map((snap) => subagents.settled(snap.id)));

    expect(buildSubagentResult(done)).toMatch(/^Background subagent sa-1 "Find it" completed in \d+s \(3 tool uses, 1200 tokens\)\.\n\nFound it in src\/app\.ts\.$/);
    expect(buildSubagentResult(failed)).toContain('Background subagent sa-2 "Doomed" failed');
    expect(buildSubagentResult(failed)).toContain("overloaded");
    expect(buildSubagentResult(silent)).toContain("without returning any text");
  });
});

describe("subagentsFor(hub)", () => {
  function hubWithIdle() {
    const turns: QuitTurn[] = [];
    const hub = createBackgroundHub({ debounceMs: 5, registerTurn: (turn) => (turns.push(turn), () => {}) });
    hubs.push(hub);
    const idle: BackgroundBatch[] = [];
    hub.setIdleSink((batch) => (idle.push(batch), true));
    return { hub, idle, turns };
  }

  test("is one manager per hub; a settled subagent's result is delivered through the hub as a subagent result", async () => {
    const { hub, idle, turns } = hubWithIdle();
    const subagents = subagentsFor(hub);
    expect(subagentsFor(hub)).toBe(subagents);
    const snap = subagents.start({ description: "Find it", prompt: "go", run: async () => FINISHED });
    expect(turns).toHaveLength(1);
    await until(() => idle.length === 1);
    expect(idle[0]!.ids).toEqual([snap.id]);
    expect(idle[0]!.notice).toBe("[background] Find it finished");
    expect(idle[0]!.text).toBe(backgroundResultsText([{ id: snap.id, kind: "subagent", text: buildSubagentResult(snap) }]));
  });

  test("the hub's dispose stops its subagents", async () => {
    const { hub } = hubWithIdle();
    const snap = subagentsFor(hub).start({ description: "Slow", prompt: "go", run: hanging() });
    await hub.dispose();
    expect(snap.status).toBe("stopped");
    expect(subagentsFor(hub).disposed).toBe(true);
  });
});
