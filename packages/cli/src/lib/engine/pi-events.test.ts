import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatMessage } from "../chat-types";
import { applyPiEvent, createErrorTracker, createReplyFeed, isStreamDelta, withDuration } from "./pi-events";
import { finishReply } from "../reply";
import type { EngineEvent } from "./types";

const empty: ChatMessage = { id: "r1", role: "assistant", parts: [], metadata: { mode: "BUILD", model: "faux/faux-1" } };

const event = (value: Record<string, unknown>) => value as unknown as AgentSessionEvent;

const usage = (total: number) => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const assistantEnd = (content: unknown[], extra: Record<string, unknown> = {}) =>
  event({
    type: "message_end",
    message: { role: "assistant", content, usage: usage(0), stopReason: "stop", ...extra },
  });

describe("applyPiEvent", () => {
  test("adds text, reasoning and running tool parts from an assistant message", () => {
    const reply = applyPiEvent(
      empty,
      assistantEnd([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "hello" },
        { type: "toolCall", id: "t1", name: "echo", arguments: { text: "x" } },
      ]),
    );

    expect(reply.parts).toEqual([
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "hello" },
      { type: "tool", toolCallId: "t1", toolName: "echo", input: { text: "x" }, state: "running" },
    ]);
  });

  test("sums assistant usage cost across the turn", () => {
    let reply = applyPiEvent(empty, assistantEnd([{ type: "text", text: "a" }], { usage: usage(0.25) }));
    reply = applyPiEvent(reply, assistantEnd([{ type: "text", text: "b" }], { usage: usage(0.5) }));

    expect(reply.metadata).toEqual({ mode: "BUILD", model: "faux/faux-1", costUsd: 0.75 });
  });

  test("marks a tool done when its execution ends", () => {
    const running = applyPiEvent(empty, assistantEnd([{ type: "toolCall", id: "t1", name: "echo", arguments: {} }]));

    const reply = applyPiEvent(
      running,
      event({ type: "tool_execution_end", toolCallId: "t1", toolName: "echo", result: { content: [] }, isError: false }),
    );

    expect(reply.parts[0]).toMatchObject({ type: "tool", toolCallId: "t1", state: "done" });
  });

  test("marks a tool as an error with the result text", () => {
    const running = applyPiEvent(empty, assistantEnd([{ type: "toolCall", id: "t1", name: "echo", arguments: {} }]));

    const reply = applyPiEvent(
      running,
      event({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "echo",
        result: { content: [{ type: "text", text: "boom" }, { type: "image" }, { type: "text", text: "!" }] },
        isError: true,
      }),
    );

    expect(reply.parts[0]).toMatchObject({ state: "error", errorText: "boom!" });
  });

  test("redacts keys and bearer tokens in a tool error", () => {
    const withTool = applyPiEvent(empty, assistantEnd([{ type: "toolCall", id: "t1", name: "echo", arguments: {} }]));

    const reply = applyPiEvent(
      withTool,
      event({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "echo",
        result: { content: [{ type: "text", text: "401 for key sk-ant-api03-AbCdEf0123456789 with Authorization: Bearer abc.def-123_456" }] },
        isError: true,
      }),
    );

    const part = reply.parts.find((p) => p.type === "tool");
    expect(part).toMatchObject({ state: "error" });
    const text = part?.type === "tool" ? part.errorText : "";
    expect(text).toContain("401 for key");
    expect(text).not.toContain("sk-ant");
    expect(text).not.toContain("abc.def");
  });

  test("ignores a tool result for an unknown call", () => {
    const reply = applyPiEvent(
      empty,
      event({ type: "tool_execution_end", toolCallId: "nope", toolName: "echo", result: {}, isError: true }),
    );

    expect(reply).toBe(empty);
  });

  test("ignores events of subagent tool calls", () => {
    const running = applyPiEvent(empty, assistantEnd([{ type: "toolCall", id: "t1", name: "echo", arguments: {} }]));

    const reply = applyPiEvent(
      running,
      event({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "echo",
        result: {},
        isError: false,
        parentToolCallId: "outer",
      }),
    );

    expect(reply).toBe(running);
  });

  test("ignores user messages, compaction and lifecycle events", () => {
    for (const ignored of [
      event({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      event({ type: "compaction_start", reason: "threshold" }),
      event({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false }),
      event({ type: "agent_settled", aborted: false }),
      event({ type: "message_update", message: {}, assistantMessageEvent: {} }),
    ]) {
      expect(applyPiEvent(empty, ignored)).toBe(empty);
    }
  });
});

const update = (assistantMessageEvent: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  event({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent, ...extra });
const textDelta = (delta: string, contentIndex = 0) => update({ type: "text_delta", contentIndex, delta });
const thinkingDelta = (delta: string, contentIndex = 0) => update({ type: "thinking_delta", contentIndex, delta });
const fold = (reply: ChatMessage, ...events: AgentSessionEvent[]) => events.reduce(applyPiEvent, reply);

describe("applyPiEvent streaming", () => {
  test("grows one text part in place as deltas arrive", () => {
    const first = fold(empty, textDelta("Hel"));
    const second = fold(first, textDelta("lo "), textDelta("world"));

    expect(first.parts).toEqual([{ type: "text", text: "Hel" }]);
    expect(second.parts).toEqual([{ type: "text", text: "Hello world" }]);
  });

  test("streams thinking and text as separate parts, in the order they start", () => {
    const reply = fold(empty, thinkingDelta("hm"), thinkingDelta("m"), textDelta("ans", 1), textDelta("wer", 1));

    expect(reply.parts).toEqual([
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "answer" },
    ]);
  });

  test("message_end replaces the streamed parts with the final ones, once", () => {
    const streaming = fold(empty, thinkingDelta("hmm"), textDelta("hello", 1));

    const reply = fold(
      streaming,
      assistantEnd([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "hello" },
        { type: "toolCall", id: "t1", name: "echo", arguments: {} },
      ]),
    );

    expect(reply.parts).toEqual([
      { type: "reasoning", text: "hmm" },
      { type: "text", text: "hello" },
      { type: "tool", toolCallId: "t1", toolName: "echo", input: {}, state: "running" },
    ]);
  });

  test("the final text wins over what streamed", () => {
    const reply = fold(empty, textDelta("partial"), assistantEnd([{ type: "text", text: "the whole thing" }]));

    expect(reply.parts).toEqual([{ type: "text", text: "the whole thing" }]);
  });

  test("keeps several assistant messages of one turn apart, in order with the tools between them", () => {
    const reply = fold(
      empty,
      textDelta("let me look"),
      assistantEnd([
        { type: "text", text: "let me look" },
        { type: "toolCall", id: "t1", name: "echo", arguments: {} },
      ]),
      event({ type: "tool_execution_end", toolCallId: "t1", toolName: "echo", result: { content: [] }, isError: false }),
      textDelta("found "),
      textDelta("it"),
    );

    expect(reply.parts).toEqual([
      { type: "text", text: "let me look" },
      { type: "tool", toolCallId: "t1", toolName: "echo", input: {}, state: "done" },
      { type: "text", text: "found it" },
    ]);

    const ended = fold(reply, assistantEnd([{ type: "text", text: "found it" }]));
    expect(ended.parts).toEqual([
      { type: "text", text: "let me look" },
      { type: "tool", toolCallId: "t1", toolName: "echo", input: {}, state: "done" },
      { type: "text", text: "found it" },
    ]);
  });

  test("an interrupted message with no final content keeps the text streamed so far", () => {
    const reply = fold(empty, textDelta("half an ans"), assistantEnd([], { stopReason: "aborted" }));

    expect(reply.parts).toEqual([{ type: "text", text: "half an ans" }]);
  });

  test("an interrupted message with partial content leaves the text once", () => {
    const reply = fold(empty, textDelta("half an ans"), assistantEnd([{ type: "text", text: "half an ans" }], { stopReason: "aborted" }));

    expect(reply.parts).toEqual([{ type: "text", text: "half an ans" }]);
  });

  test("text kept from an interrupted message is not grown by the next message", () => {
    const reply = fold(empty, textDelta("kept"), assistantEnd([], { stopReason: "aborted" }), textDelta("fresh"));

    expect(reply.parts).toEqual([
      { type: "text", text: "kept" },
      { type: "text", text: "fresh" },
    ]);
  });

  test("ending an interrupted turn keeps the streamed text and marks running tools interrupted", () => {
    const reply = fold(
      empty,
      assistantEnd([{ type: "toolCall", id: "t1", name: "echo", arguments: {} }]),
      textDelta("streaming when stopped"),
    );

    expect(finishReply(reply).parts).toEqual([
      { type: "tool", toolCallId: "t1", toolName: "echo", input: {}, state: "error", errorText: "Interrupted" },
      { type: "text", text: "streaming when stopped" },
    ]);
  });

  test("streamed parts are plain parts: nothing streaming-only is saved", () => {
    const reply = fold(empty, thinkingDelta("a"), textDelta("b", 1));

    expect(JSON.parse(JSON.stringify(reply.parts))).toEqual([
      { type: "reasoning", text: "a" },
      { type: "text", text: "b" },
    ]);
    expect(reply.parts.map((p) => Object.keys(p))).toEqual([["type", "text"], ["type", "text"]]);
  });

  test("shows tool calls only when complete, not while their arguments stream", () => {
    const reply = fold(
      empty,
      update({ type: "toolcall_start", contentIndex: 0 }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: "{\"a\"" }),
      update({ type: "text_start", contentIndex: 1 }),
      update({ type: "start" }),
      textDelta("", 1),
    );

    expect(reply).toBe(empty);
  });

  test("ignores deltas of subagent tool calls", () => {
    const reply = applyPiEvent(empty, update({ type: "text_delta", contentIndex: 0, delta: "inner" }, { parentToolCallId: "outer" }));

    expect(reply).toBe(empty);
  });

  test("isStreamDelta tells the deltas a reply shows from the rest", () => {
    expect(isStreamDelta(textDelta("a"))).toBe(true);
    expect(isStreamDelta(thinkingDelta("a"))).toBe(true);
    expect(isStreamDelta(update({ type: "toolcall_delta", contentIndex: 0, delta: "x" }))).toBe(false);
    expect(isStreamDelta(update({ type: "text_delta", contentIndex: 0, delta: "x" }, { parentToolCallId: "outer" }))).toBe(false);
    expect(isStreamDelta(assistantEnd([]))).toBe(false);
  });
});

describe("createReplyFeed", () => {
  // A manual clock and timer: a timer fires when the test advances the clock past it.
  function setup(intervalMs = 33) {
    let now = 1000;
    let nextId = 1;
    const timers = new Map<number, { at: number; run: () => void }>();
    const emitted: EngineEvent[] = [];
    const feed = createReplyFeed((e) => emitted.push(e), {
      intervalMs,
      now: () => now,
      setTimer: (run, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, run });
        return id;
      },
      clearTimer: (id) => void timers.delete(id as number),
    });
    const advance = (ms: number) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    };
    const replyOf = () => emitted.reduce((reply, e) => (e.type === "reply" ? e.update(reply) : reply), empty);
    return { feed, emitted, timers, advance, replyOf };
  }
  const addText = (text: string) => (reply: ChatMessage): ChatMessage => ({
    ...reply,
    parts: [...reply.parts, { type: "text", text }],
  });

  test("holds queued updates until the timer fires, then emits them as one", () => {
    const { feed, emitted, advance, replyOf } = setup();

    feed.push(addText("a"));
    feed.push(addText("b"));
    expect(emitted).toHaveLength(0);

    advance(33);

    expect(emitted).toHaveLength(1);
    expect(replyOf().parts).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
  });

  test("emits at most once per interval however many updates arrive", () => {
    const { feed, emitted, advance } = setup(33);

    // One second of updates every millisecond.
    for (let ms = 0; ms < 1000; ms++) {
      feed.push(addText(String(ms)));
      advance(1);
    }
    feed.close();

    expect(emitted.length).toBeLessThanOrEqual(31 + 1);
    expect(emitted.length).toBeGreaterThan(20);
  });

  test("emitNow sends the queued updates and its own, in order, at once", () => {
    const { feed, emitted, timers, replyOf } = setup();

    feed.push(addText("streamed"));
    feed.emitNow(addText("final"));

    expect(emitted).toHaveLength(1);
    expect(timers.size).toBe(0);
    expect(replyOf().parts).toEqual([{ type: "text", text: "streamed" }, { type: "text", text: "final" }]);
  });

  test("flush sends what is queued and leaves no timer", () => {
    const { feed, emitted, timers } = setup();

    feed.push(addText("a"));
    feed.flush();

    expect(emitted).toHaveLength(1);
    expect(timers.size).toBe(0);
  });

  test("flush with nothing queued emits nothing", () => {
    const { feed, emitted } = setup();

    feed.flush();

    expect(emitted).toHaveLength(0);
  });

  test("close flushes, leaves no timer, and later updates go out at once", () => {
    const { feed, emitted, timers, advance } = setup();

    feed.push(addText("a"));
    feed.close();
    expect(emitted).toHaveLength(1);
    expect(timers.size).toBe(0);

    feed.push(addText("late"));
    expect(emitted).toHaveLength(2);
    expect(timers.size).toBe(0);
    advance(1000);
    expect(emitted).toHaveLength(2);
  });
});

describe("withDuration", () => {
  test("records the turn wall time", () => {
    expect(withDuration(empty, 1234).metadata).toEqual({ mode: "BUILD", model: "faux/faux-1", durationMs: 1234 });
  });
});

describe("createErrorTracker", () => {
  const errored = (errorMessage?: string) => assistantEnd([], { stopReason: "error", errorMessage });

  test("holds an assistant error until the turn ends", () => {
    const tracker = createErrorTracker();

    expect(tracker.observe(errored("overloaded"))).toBeNull();
    expect(tracker.flush()).toBe("overloaded");
    expect(tracker.flush()).toBeNull();
  });

  test("falls back to a generic message when the provider gave none", () => {
    const tracker = createErrorTracker();

    tracker.observe(errored());

    expect(tracker.flush()).toBe("Pi stopped with an error");
  });

  test("reports retries that gave up once, with the final error", () => {
    const tracker = createErrorTracker();

    tracker.observe(errored("overloaded"));
    expect(tracker.observe(event({ type: "auto_retry_end", success: false, attempt: 3, finalError: "still overloaded" }))).toBe(
      "still overloaded",
    );
    expect(tracker.flush()).toBeNull();
  });

  test("drops the error when a retry succeeds", () => {
    const tracker = createErrorTracker();

    tracker.observe(errored("overloaded"));
    expect(tracker.observe(event({ type: "auto_retry_end", success: true, attempt: 1 }))).toBeNull();
    expect(tracker.flush()).toBeNull();
  });

  test("does not report an aborted message", () => {
    const tracker = createErrorTracker();

    tracker.observe(assistantEnd([], { stopReason: "aborted" }));

    expect(tracker.flush()).toBeNull();
  });
});
