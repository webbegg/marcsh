import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";

// Fake query(): init → Agent tool call → a hidden subagent tool call → task messages → result.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: any) => {
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "Explore the repo" } }] } };
      yield { type: "assistant", parent_tool_use_id: "t1", message: { content: [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "inner-secret-pattern" } }] } };
      yield { type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "t1", description: "Explore the repo" };
      yield { type: "system", subtype: "task_progress", task_id: "k1", description: "Searching", last_tool_name: "Grep", usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 10 } };
      yield { type: "system", subtype: "task_notification", task_id: "k1", status: "completed", summary: "Found three modules", output_file: "/tmp/out", usage: { total_tokens: 1500, tool_uses: 4, duration_ms: 20 } };
      yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0 };
    })();
    return Object.assign(messages, { interrupt: async () => {} });
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
// Joins word-wrapped lines (and the line's left border) back into one string.
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");

async function openSession() {
  const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 30 });
  await settle(100);
  return session;
}

afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("subagent task progress (S11b)", () => {
  test("shows one compact task line with its summary and hides the subagent's inner tool call", async () => {
    await openSession();
    const frame = collapse(screen!.captureCharFrame());

    expect(frame).toContain("Task: Searching · completed · Grep · 4 tools · 1500 tok");
    expect(frame).toContain("Found three modules");
    expect(frame).not.toContain("inner-secret-pattern");
    expect(frame.match(/Task:/g)).toHaveLength(1);
  });

  test("persists the task part with the saved message", async () => {
    const session = await openSession();
    const saved = getStorage().getSession(session.id)!;
    const parts = saved.messages.at(-1)!.parts;

    expect(parts.filter((p) => p.type === "task")).toEqual([
      {
        type: "task",
        taskId: "k1",
        description: "Searching",
        status: "completed",
        lastToolName: "Grep",
        toolUses: 4,
        totalTokens: 1500,
        summary: "Found three modules",
      },
    ]);
    expect(parts.some((p) => p.type === "tool" && p.toolCallId === "t2")).toBe(false);
  });
});
