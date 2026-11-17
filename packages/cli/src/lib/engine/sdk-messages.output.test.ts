import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChatMessage } from "../chat-types";
import { applySdkMessage } from "../sdk-messages";
import { MAX_OUTPUT_LINES } from "../tool-output";

const emptyReply = (): ChatMessage => ({ id: "a1", role: "assistant", parts: [], metadata: { mode: "BUILD", model: "opus" } });

const sdk = (message: unknown) => message as SDKMessage;

const assistant = (content: unknown[]) => sdk({ type: "assistant", message: { content }, parent_tool_use_id: null, session_id: "s1" });

const toolUse = (name: string, input: Record<string, unknown> = {}) => assistant([{ type: "tool_use", id: "t1", name, input }]);

const toolResult = (block: Record<string, unknown>, toolUseResult?: unknown) =>
  sdk({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", ...block }] },
    parent_tool_use_id: null,
    session_id: "s1",
    ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
  });

const toolPart = (reply: ChatMessage) => {
  const part = reply.parts.find((p) => p.type === "tool");
  if (!part || part.type !== "tool") throw new Error("no tool part");
  return part;
};

const run = (name: string, result: SDKMessage, input: Record<string, unknown> = {}) => toolPart(applySdkMessage(applySdkMessage(emptyReply(), toolUse(name, input)), result));

describe("Claude tool output", () => {
  test("a successful Bash call keeps its output", () => {
    expect(run("Bash", toolResult({ content: "a.txt\nb.txt\n" }), { command: "ls" })).toEqual({
      type: "tool",
      toolCallId: "t1",
      toolName: "Bash",
      input: { command: "ls" },
      state: "done",
      output: "a.txt\nb.txt",
    });
  });

  test("reads the text of block content", () => {
    expect(run("Bash", toolResult({ content: [{ type: "text", text: "hi" }, { type: "text", text: " there" }] })).output).toBe("hi there");
  });

  test("a long output keeps the tail and says it was cut", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
    const part = run("Bash", toolResult({ content: text }));

    expect(part.outputTruncated).toBe(true);
    expect(part.output!.split("\n")).toHaveLength(MAX_OUTPUT_LINES);
    expect(part.output!.split("\n").at(-1)).toBe("line 500");
  });

  test("a secret in the output is redacted", () => {
    const part = run("Bash", toolResult({ content: "KEY=sk-abcdefghijklmnop1234\nok" }));

    expect(part.output).not.toContain("sk-abcdefghijklmnop1234");
    expect(part.output).toContain("ok");
  });

  test("a call without output has none", () => {
    const part = run("Bash", toolResult({ content: "" }));

    expect(part).not.toHaveProperty("output");
    expect(part.state).toBe("done");
  });

  test("an error text is redacted and no output is kept", () => {
    const part = run("Bash", toolResult({ is_error: true, content: [{ type: "text", text: "denied: sk-abcdefghijklmnop1234" }] }));

    expect(part.state).toBe("error");
    expect(part.errorText).toContain("denied");
    expect(part.errorText).not.toContain("sk-abcdefghijklmnop1234");
    expect(part).not.toHaveProperty("output");
  });

  test("an Edit keeps a unified patch built from structuredPatch", () => {
    const structuredPatch = [{ oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, lines: [" keep", "-old", "+new", " tail"] }];
    const part = run("Edit", toolResult({ content: "The file f.ts has been updated." }, { filePath: "f.ts", structuredPatch, userModified: false }));

    expect(part.patch).toBe("@@ -3,3 +3,3 @@\n keep\n-old\n+new\n tail");
  });

  test("a Write and a MultiEdit keep their patch too", () => {
    const structuredPatch = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+hello"] }];

    expect(run("Write", toolResult({ content: "created" }, { type: "create", filePath: "f.ts", structuredPatch, originalFile: null })).patch).toBe("@@ -0,0 +1,1 @@\n+hello");
    expect(run("MultiEdit", toolResult({ content: "ok" }, { filePath: "f.ts", structuredPatch })).patch).toBe("@@ -0,0 +1,1 @@\n+hello");
  });

  test("no patch for other tools, or when the edit gave no hunks", () => {
    const structuredPatch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }];

    expect(run("Bash", toolResult({ content: "x" }, { structuredPatch }))).not.toHaveProperty("patch");
    expect(run("Edit", toolResult({ content: "x" }, { structuredPatch: [] }))).not.toHaveProperty("patch");
    expect(run("Edit", toolResult({ content: "x" }))).not.toHaveProperty("patch");
  });

  test("a failed Edit keeps no patch", () => {
    const structuredPatch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }];

    expect(run("Edit", toolResult({ is_error: true, content: "no match" }, { structuredPatch }))).not.toHaveProperty("patch");
  });

  test("reasoning gets no duration", () => {
    const reply = applySdkMessage(emptyReply(), assistant([{ type: "thinking", thinking: "hmm" }]));

    expect(reply.parts).toEqual([{ type: "reasoning", text: "hmm" }]);
  });

  test("messages without results are unchanged", () => {
    const reply = applySdkMessage(emptyReply(), toolUse("Bash", { command: "ls" }));

    expect(reply.parts).toEqual([{ type: "tool", toolCallId: "t1", toolName: "Bash", input: { command: "ls" }, state: "running" }]);
  });
});
