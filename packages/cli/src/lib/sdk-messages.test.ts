import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  applySdkMessage,
  buildAnswer,
  finishReply,
  parseAskUserQuestion,
  resultError,
  toAnswersResult,
  toDeclinedResult,
  toPermissionMode,
  toPermissionResult,
} from "./sdk-messages";
import type { ChatMessage } from "./chat-types";

const emptyReply = (): ChatMessage => ({
  id: "a1",
  role: "assistant",
  parts: [],
  metadata: { mode: "BUILD", model: "opus" },
});

const sdk = (message: unknown) => message as SDKMessage;

const assistant = (content: unknown[], parentToolUseId: string | null = null) =>
  sdk({
    type: "assistant",
    message: { content },
    parent_tool_use_id: parentToolUseId,
    session_id: "s1",
  });

const toolResult = (block: Record<string, unknown>, parentToolUseId: string | null = null) =>
  sdk({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", ...block }] },
    parent_tool_use_id: parentToolUseId,
    session_id: "s1",
  });

describe("applySdkMessage", () => {
  test("appends text, thinking, and tool calls from assistant messages", () => {
    let reply = emptyReply();
    reply = applySdkMessage(reply, assistant([{ type: "thinking", thinking: "Let me look" }]));
    reply = applySdkMessage(reply, assistant([{ type: "text", text: "Reading the file." }]));
    reply = applySdkMessage(
      reply,
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }]),
    );

    expect(reply.parts).toEqual([
      { type: "reasoning", text: "Let me look" },
      { type: "text", text: "Reading the file." },
      { type: "tool", toolCallId: "t1", toolName: "Read", input: { file_path: "a.ts" }, state: "running" },
    ]);
  });

  test("marks a tool call done when its result arrives", () => {
    let reply = applySdkMessage(
      emptyReply(),
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
    );
    reply = applySdkMessage(reply, toolResult({ tool_use_id: "t1", content: "file body" }));

    expect(reply.parts[0]).toMatchObject({ type: "tool", state: "done" });
  });

  test("marks a failed tool call as an error with its message", () => {
    let reply = applySdkMessage(
      emptyReply(),
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    );
    reply = applySdkMessage(
      reply,
      toolResult({ tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "denied" }] }),
    );

    expect(reply.parts[0]).toMatchObject({ type: "tool", state: "error", errorText: "denied" });
  });

  test("ignores subagent messages", () => {
    const reply = applySdkMessage(emptyReply(), assistant([{ type: "text", text: "inner" }], "t1"));

    expect(reply.parts).toEqual([]);
  });

  test("records duration and cost from the result", () => {
    const reply = applySdkMessage(
      emptyReply(),
      sdk({ type: "result", subtype: "success", is_error: false, duration_ms: 1200, total_cost_usd: 0.05, result: "ok" }),
    );

    expect(reply.metadata).toEqual({ mode: "BUILD", model: "opus", durationMs: 1200, costUsd: 0.05 });
  });

  test("leaves the reply untouched for other message types", () => {
    const reply = emptyReply();

    expect(applySdkMessage(reply, sdk({ type: "system", subtype: "init", session_id: "s1" }))).toBe(reply);
  });
});

describe("finishReply", () => {
  const tool = (toolCallId: string, state: "running" | "done" | "error") =>
    ({ type: "tool", toolCallId, toolName: "Bash", input: {}, state }) as const;

  test("marks tools still running as interrupted errors", () => {
    const reply: ChatMessage = {
      ...emptyReply(),
      parts: [{ type: "text", text: "hi" }, tool("t1", "running"), tool("t2", "done")],
    };

    const finished = finishReply(reply);

    expect(finished.parts).toEqual([
      { type: "text", text: "hi" },
      { ...tool("t1", "error"), errorText: "Interrupted" },
      tool("t2", "done"),
    ]);
  });

  test("returns the same reply when no tool is running", () => {
    const reply: ChatMessage = { ...emptyReply(), parts: [tool("t1", "done"), tool("t2", "error")] };

    expect(finishReply(reply)).toBe(reply);
    expect(finishReply(emptyReply())).toEqual(emptyReply());
  });
});

describe("resultError", () => {
  test("returns null for a successful result", () => {
    expect(resultError(sdk({ type: "result", subtype: "success", is_error: false, result: "ok" }))).toBeNull();
  });

  test("returns the result text when a successful result is flagged as an error", () => {
    expect(
      resultError(sdk({ type: "result", subtype: "success", is_error: true, result: "Not logged in" })),
    ).toBe("Not logged in");
  });

  test("describes error results by subtype", () => {
    expect(resultError(sdk({ type: "result", subtype: "error_max_turns", is_error: true }))).toBe(
      "Claude stopped: error_max_turns",
    );
  });

  test("returns null for non-result messages", () => {
    expect(resultError(sdk({ type: "system", subtype: "init" }))).toBeNull();
  });
});

describe("toPermissionMode", () => {
  test("maps Plan to plan mode and Build to default approvals", () => {
    expect(toPermissionMode("PLAN")).toBe("plan");
    expect(toPermissionMode("BUILD")).toBe("default");
  });
});

describe("toPermissionResult", () => {
  const input = { command: "ls" };
  const suggestions = [
    { type: "addRules" as const, rules: [{ toolName: "Bash" }], behavior: "allow" as const, destination: "session" as const },
  ];

  test("allows once with the original input", () => {
    expect(toPermissionResult("allow", input, suggestions)).toEqual({ behavior: "allow", updatedInput: input });
  });

  test("allows always by applying the suggested rules", () => {
    expect(toPermissionResult("always", input, suggestions)).toEqual({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: suggestions,
    });
  });

  test("never applies suggested rules when always-allow is suppressed", () => {
    expect(toPermissionResult("always", input, suggestions, { suppressAlwaysAllowRule: true })).toEqual({
      behavior: "allow",
      updatedInput: input,
    });
  });

  test("denies with a message for Claude", () => {
    expect(toPermissionResult("deny", input, suggestions)).toEqual({
      behavior: "deny",
      message: "The user denied this tool call.",
    });
  });
});

const colorQuestion = {
  question: "Which colors?",
  header: "Colors",
  options: [
    { label: "Red", description: "Warm" },
    { label: "Green", description: "Natural" },
    { label: "Blue", description: "Cool" },
  ],
  multiSelect: true,
};

describe("parseAskUserQuestion", () => {
  test("accepts 1-4 questions with 2+ options each", () => {
    const input = { questions: [colorQuestion] };
    expect(parseAskUserQuestion(input)).toEqual(input);
    expect(parseAskUserQuestion({ questions: [colorQuestion, colorQuestion, colorQuestion, colorQuestion].map((q, i) => ({ ...q, question: `Q${i}` })) })).not.toBeNull();
  });

  test("ignores extra fields instead of rejecting the input", () => {
    const parsed = parseAskUserQuestion({ questions: [{ ...colorQuestion, options: colorQuestion.options.map((o) => ({ ...o, preview: "p" })) }], metadata: { source: "x" } });
    expect(parsed?.questions).toHaveLength(1);
  });

  test.each([
    ["no questions", { questions: [] }],
    ["five questions", { questions: Array.from({ length: 5 }, (_, i) => ({ ...colorQuestion, question: `Q${i}` })) }],
    ["questions missing", {}],
    ["questions not an array", { questions: "nope" }],
    ["one option", { questions: [{ ...colorQuestion, options: [colorQuestion.options[0]] }] }],
    ["option without description", { questions: [{ ...colorQuestion, options: [{ label: "A" }, { label: "B" }] }] }],
    ["missing header", { questions: [{ ...colorQuestion, header: undefined }] }],
    ["multiSelect not a boolean", { questions: [{ ...colorQuestion, multiSelect: "yes" }] }],
    ["duplicate question text", { questions: [colorQuestion, colorQuestion] }],
  ])("rejects %s", (_name, input) => {
    expect(parseAskUserQuestion(input as Record<string, unknown>)).toBeNull();
  });
});

describe("buildAnswer", () => {
  test("single-select answers with the chosen label", () => {
    expect(buildAnswer({ ...colorQuestion, multiSelect: false }, { picked: [1] })).toBe("Green");
  });

  test("multi-select joins the chosen labels with \", \" in option order", () => {
    expect(buildAnswer(colorQuestion, { picked: [2, 0] })).toBe("Red, Blue");
  });

  test("Other text is the answer, and follows the chosen labels in multi-select", () => {
    expect(buildAnswer({ ...colorQuestion, multiSelect: false }, { picked: [], other: "Teal" })).toBe("Teal");
    expect(buildAnswer(colorQuestion, { picked: [1], other: "Teal" })).toBe("Green, Teal");
  });
});

describe("toAnswersResult and toDeclinedResult", () => {
  test("allows with the original input plus the answers keyed by question text", () => {
    const input = { questions: [colorQuestion] };
    expect(toAnswersResult(input, { "Which colors?": "Red" })).toEqual({
      behavior: "allow",
      updatedInput: { questions: [colorQuestion], answers: { "Which colors?": "Red" } },
    });
  });

  test("declines with a message for Claude", () => {
    expect(toDeclinedResult()).toEqual({ behavior: "deny", message: "The user declined to answer." });
  });
});
