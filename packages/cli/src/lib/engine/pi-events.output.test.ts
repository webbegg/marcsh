import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatMessage } from "../chat-types";
import { MAX_OUTPUT_LINES } from "../tool-output";
import { applyPiEvent } from "./pi-events";

const empty: ChatMessage = { id: "r1", role: "assistant", parts: [], metadata: { mode: "BUILD", model: "faux/faux-1" } };

const event = (value: Record<string, unknown>) => value as unknown as AgentSessionEvent;

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const assistantEnd = (content: unknown[]) => event({ type: "message_end", message: { role: "assistant", content, usage, stopReason: "stop" } });

const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });

const toolEnd = (toolCallId: string, text: string, isError = false, details?: unknown) =>
  event({
    type: "tool_execution_end",
    toolCallId,
    toolName: "x",
    result: { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) },
    isError,
  });

const withTool = (name: string, args: Record<string, unknown> = {}) => applyPiEvent(empty, assistantEnd([toolCall("t1", name, args)]));

const toolPart = (reply: ChatMessage) => {
  const part = reply.parts.find((p) => p.type === "tool");
  if (!part || part.type !== "tool") throw new Error("no tool part");
  return part;
};

describe("pi tool output", () => {
  test("a successful bash call keeps its output", () => {
    const reply = applyPiEvent(withTool("bash", { command: "ls" }), toolEnd("t1", "a.txt\nb.txt\n"));

    expect(toolPart(reply)).toEqual({
      type: "tool",
      toolCallId: "t1",
      toolName: "bash",
      input: { command: "ls" },
      state: "done",
      output: "a.txt\nb.txt",
    });
  });

  test("a long output keeps the tail and says it was cut", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
    const part = toolPart(applyPiEvent(withTool("bash"), toolEnd("t1", text)));

    expect(part.outputTruncated).toBe(true);
    const kept = part.output!.split("\n");
    expect(kept).toHaveLength(MAX_OUTPUT_LINES);
    expect(kept.at(-1)).toBe("line 500");
  });

  test("a secret in the output is redacted", () => {
    const part = toolPart(applyPiEvent(withTool("bash"), toolEnd("t1", "KEY=sk-abcdefghijklmnop1234\nok")));

    expect(part.output).not.toContain("sk-abcdefghijklmnop1234");
    expect(part.output).toContain("ok");
  });

  test("a call without output has none", () => {
    const part = toolPart(applyPiEvent(withTool("bash"), toolEnd("t1", "")));

    expect(part).not.toHaveProperty("output");
    expect(part).not.toHaveProperty("outputTruncated");
    expect(part.state).toBe("done");
  });

  test("an error keeps only its redacted error text, as before", () => {
    const part = toolPart(applyPiEvent(withTool("bash"), toolEnd("t1", "failed with sk-abcdefghijklmnop1234", true)));

    expect(part.state).toBe("error");
    expect(part.errorText).not.toContain("sk-abcdefghijklmnop1234");
    expect(part.errorText).toContain("failed with");
    expect(part).not.toHaveProperty("output");
  });

  test("an edit keeps the patch pi made", () => {
    const patch = "--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n";
    const part = toolPart(
      applyPiEvent(withTool("edit", { path: "f.ts" }), toolEnd("t1", "Successfully replaced 1 block(s) in f.ts.", false, { diff: "-1 a\n+1 b", patch, firstChangedLine: 1 })),
    );

    expect(part.patch).toBe(patch);
    expect(part.output).toBe("Successfully replaced 1 block(s) in f.ts.");
  });

  test("falls back to the diff pi made when it gave no patch", () => {
    const part = toolPart(applyPiEvent(withTool("write"), toolEnd("t1", "Wrote f.ts", false, { diff: "+1 hello" })));

    expect(part.patch).toBe("+1 hello");
  });

  test("a tool that has no patch gets none", () => {
    const part = toolPart(applyPiEvent(withTool("bash"), toolEnd("t1", "x", false, { truncation: {} })));

    expect(part).not.toHaveProperty("patch");
  });

  test("a result for a call that is unknown changes nothing", () => {
    expect(applyPiEvent(empty, toolEnd("nope", "x"))).toBe(empty);
  });
});

describe("pi reasoning duration", () => {
  const delta = (delta: string, contentIndex = 0) =>
    event({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_delta", contentIndex, delta } });

  const clock = (...times: number[]) => {
    let at = 0;
    return () => times[Math.min(at++, times.length - 1)]!;
  };

  const reasoning = (reply: ChatMessage) => reply.parts.filter((p) => p.type === "reasoning");

  test("the final part carries the time from the first thinking delta to the last", () => {
    const options = { now: clock(1_000, 1_400, 3_500) };
    let reply = applyPiEvent(empty, delta("a"), options);
    reply = applyPiEvent(reply, delta("b"), options);
    reply = applyPiEvent(reply, delta("c"), options);
    reply = applyPiEvent(reply, assistantEnd([{ type: "thinking", thinking: "abc" }, { type: "text", text: "hi" }]), options);

    expect(reasoning(reply)).toEqual([{ type: "reasoning", text: "abc", durationMs: 2_500 }]);
  });

  test("each thinking block keeps its own time, matched by content index", () => {
    const options = { now: clock(0, 100, 5_000, 5_700) };
    let reply = applyPiEvent(empty, delta("a", 0), options);
    reply = applyPiEvent(reply, delta("a2", 0), options);
    reply = applyPiEvent(reply, delta("b", 2), options);
    reply = applyPiEvent(reply, delta("b2", 2), options);
    reply = applyPiEvent(
      reply,
      assistantEnd([{ type: "thinking", thinking: "aa2" }, { type: "toolCall", id: "t1", name: "bash", arguments: {} }, { type: "thinking", thinking: "bb2" }]),
      options,
    );

    expect(reasoning(reply)).toEqual([
      { type: "reasoning", text: "aa2", durationMs: 100 },
      { type: "reasoning", text: "bb2", durationMs: 700 },
    ]);
  });

  test("a block whose deltas all came at one moment has no duration", () => {
    const options = { now: () => 1_000 };
    let reply = applyPiEvent(empty, delta("a"), options);
    reply = applyPiEvent(reply, assistantEnd([{ type: "thinking", thinking: "a" }]), options);

    expect(reasoning(reply)).toEqual([{ type: "reasoning", text: "a" }]);
  });

  test("thinking that never streamed has no duration", () => {
    const reply = applyPiEvent(empty, assistantEnd([{ type: "thinking", thinking: "hmm" }]));

    expect(reply.parts).toEqual([{ type: "reasoning", text: "hmm" }]);
  });

  test("the streamed part has no duration saved, only the final one", () => {
    const options = { now: clock(0, 50) };
    let reply = applyPiEvent(empty, delta("a"), options);
    reply = applyPiEvent(reply, delta("b"), options);

    expect(reasoning(reply)).toEqual([{ type: "reasoning", text: "ab" }]);
  });
});
