import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatMessage } from "../chat-types";
import { applyPiEvent, createErrorTracker, withDuration } from "./pi-events";

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
