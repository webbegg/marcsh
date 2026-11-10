import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh/preferences.json: a missing file reads as no preferences, and writes land in tmp.
process.env.MARCSH_PREFERENCES_PATH = join(tmpdir(), `marcsh-screen-prefs-${process.pid}`, "preferences.json");

type Question = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
};

const COLOR: Question = {
  question: "Which color do you prefer?",
  header: "Color",
  options: [
    { label: "Red", description: "A warm color" },
    { label: "Green", description: "A natural color" },
    { label: "Blue", description: "A cool color" },
  ],
  multiSelect: false,
};
const SIZE: Question = {
  question: "Which size do you need?",
  header: "Size",
  options: [
    { label: "Small", description: "Fits in a pocket" },
    { label: "Large", description: "Fits in a backpack" },
  ],
  multiSelect: false,
};
const TOPPINGS: Question = {
  question: "Which toppings?",
  header: "Toppings",
  options: [
    { label: "Cheese", description: "Melted" },
    { label: "Olives", description: "Salty" },
    { label: "Basil", description: "Fresh" },
  ],
  multiSelect: true,
};

let calls: { prompt: string; options: any }[] = [];
let results: any[] = [];
let askInput: Record<string, unknown> = { questions: [COLOR] };
let releaseAsk: () => void = () => {};
// When set, the fake asks without awaiting, then ends the stream on endTurn(), leaving the question pending at turn end.
let leaveAskPending = false;
let pendingAsk: Promise<any> | null = null;
let endTurn: () => void = () => {};

// Fake query(): init → one AskUserQuestion tool call that asks once released → result.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    calls.push({ prompt, options });
    const ask = new AbortController();
    options.abortController.signal.addEventListener("abort", () => ask.abort(), { once: true });
    const gate = new Promise<void>((resolve) => (releaseAsk = resolve));
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: askInput }] } };
      // An interrupt before the prompt ends the turn (the real SDK stops the stream).
      await Promise.race([gate, new Promise<void>((resolve) => ask.signal.addEventListener("abort", () => resolve(), { once: true }))]);
      if (ask.signal.aborted) return;
      if (leaveAskPending) {
        pendingAsk = options.canUseTool("AskUserQuestion", askInput, { signal: ask.signal, toolUseID: "t1", requestId: "r1" });
        await new Promise<void>((resolve) => (endTurn = resolve));
        return;
      }
      const result = await options.canUseTool("AskUserQuestion", askInput, {
        signal: ask.signal, toolUseID: "t1", requestId: "r1",
      });
      results.push(result);
      yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: result.behavior === "deny", content: "" }] } };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0 };
    })();
    return Object.assign(messages, { interrupt: async () => ask.abort() });
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");

// pi is the default engine and its status line asks the pi runtime: a stand-in without one keeps the real pi engine from loading.
beforeAll(() => engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} }));
afterAll(() => engines.set("pi", undefined));

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
// The prompt ignores keys until the keyboard has been quiet for 300 ms.
const QUIET_MS = 350;
let lastActivityAt = 0;
const pressNow = async (key: string, modifiers?: { ctrl?: boolean }) => {
  lastActivityAt = Date.now();
  await act(async () => screen!.mockInput.pressKey(key as never, modifiers));
};
// Like a user who pauses before answering: waits out the quiet window since the last key or prompt.
const press = async (key: string, modifiers?: { ctrl?: boolean }) => {
  const wait = QUIET_MS - (Date.now() - lastActivityAt);
  if (wait > 0) await settle(wait);
  await pressNow(key, modifiers);
  await settle();
};
const type = async (text: string) => {
  lastActivityAt = Date.now();
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
// Joins word-wrapped lines (and the prompt's left border) back into one string.
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");
// A state change can land a render frame after settle(); wait for the expected text instead of racing it.
const frameContaining = async (text: string, timeoutMs = 1000) => {
  const start = Date.now();
  let frame = collapse(screen!.captureCharFrame());
  while (!frame.includes(text) && Date.now() - start < timeoutMs) {
    await settle(10);
    frame = collapse(screen!.captureCharFrame());
  }
  return frame;
};
const showPrompt = async () => {
  await act(async () => releaseAsk());
  lastActivityAt = Date.now();
  await settle();
};

async function openSession(input: Record<string, unknown>) {
  calls = [];
  results = [];
  pendingAsk = null;
  askInput = input;
  const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 40 });
  await settle();
  return session;
}

afterEach(async () => {
  leaveAskPending = false;
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("session questions (S9)", () => {
  // S10d: a question still pending when the turn ends is declined once, then the prompt goes away.
  const settledOnce = async () => {
    let settled = 0;
    // Bounded wait, so a promise that never settles fails the test instead of hanging the suite.
    const outcome = await Promise.race([
      pendingAsk!.then((result) => (settled++, result)),
      new Promise<"unsettled">((resolve) => setTimeout(() => resolve("unsettled"), 500)),
    ]);
    await settle(50);
    return { outcome, settled };
  };

  test("a question still pending when the turn ends is declined once and the prompt disappears", async () => {
    leaveAskPending = true;
    await openSession({ questions: [COLOR] });
    await showPrompt();
    expect(collapse(screen!.captureCharFrame())).toContain("Question 1/1");
    await act(async () => endTurn());
    expect(await settledOnce()).toEqual({ outcome: { behavior: "deny", message: "The user declined to answer." }, settled: 1 });
    expect(collapse(screen!.captureCharFrame())).not.toContain(COLOR.question);
  });

  test("a turn that ends while the Other field is open declines once, and the next turn's Esc still interrupts", async () => {
    leaveAskPending = true;
    await openSession({ questions: [COLOR] });
    await showPrompt();
    await press("o");
    await type("Tea");
    await act(async () => endTurn());
    expect(await settledOnce()).toEqual({ outcome: { behavior: "deny", message: "The user declined to answer." }, settled: 1 });
    expect(await frameContaining("Ask anything")).not.toContain("Esc goes back to the options");

    leaveAskPending = false;
    await type("again");
    await press("RETURN");
    expect(calls[1]?.prompt).toBe("again");
    await showPrompt();
    await press("ESCAPE");
    await settle(50);
    expect(results).toEqual([{ behavior: "deny", message: "The user declined to answer." }]);
  });

  test("a single-select pick answers with the label, keyed by the question text", async () => {
    await openSession({ questions: [COLOR] });
    await showPrompt();
    await press("2");
    expect(results).toEqual([
      { behavior: "allow", updatedInput: { questions: [COLOR], answers: { [COLOR.question]: "Green" } } },
    ]);
  });

  test("two questions are asked one at a time and answered in sequence", async () => {
    await openSession({ questions: [COLOR, SIZE] });
    await showPrompt();
    expect(collapse(screen!.captureCharFrame())).toContain("Question 1/2");
    await press("3");
    expect(results).toEqual([]);
    const second = collapse(screen!.captureCharFrame());
    expect(second).toContain("Question 2/2");
    expect(second).toContain(SIZE.question);
    expect(second).not.toContain(COLOR.question);
    await press("1");
    expect(results).toEqual([
      {
        behavior: "allow",
        updatedInput: { questions: [COLOR, SIZE], answers: { [COLOR.question]: "Blue", [SIZE.question]: "Small" } },
      },
    ]);
  });

  test("multi-select toggles options and Enter joins the labels in option order", async () => {
    await openSession({ questions: [TOPPINGS] });
    await showPrompt();
    await press("3");
    await press("1");
    expect(results).toEqual([]);
    expect(collapse(screen!.captureCharFrame())).toContain("[x] 1 Cheese");
    await press("RETURN");
    expect(results).toEqual([
      { behavior: "allow", updatedInput: { questions: [TOPPINGS], answers: { [TOPPINGS.question]: "Cheese, Basil" } } },
    ]);
  });

  test("multi-select toggles a choice off again and Enter needs at least one choice", async () => {
    await openSession({ questions: [TOPPINGS] });
    await showPrompt();
    await press("RETURN");
    expect(results).toEqual([]);
    await press("2");
    await press("2");
    expect(collapse(screen!.captureCharFrame())).toContain("[ ] 2 Olives");
    await press("RETURN");
    expect(results).toEqual([]);
    await press("2");
    await press("RETURN");
    expect(results[0].updatedInput.answers).toEqual({ [TOPPINGS.question]: "Olives" });
  });

  test("Other: the typed text becomes the answer", async () => {
    await openSession({ questions: [COLOR] });
    await showPrompt();
    expect(collapse(screen!.captureCharFrame())).toContain("o Other (type an answer)");
    await press("o");
    await type("Teal, like the sea");
    await press("RETURN");
    expect(results).toEqual([
      { behavior: "allow", updatedInput: { questions: [COLOR], answers: { [COLOR.question]: "Teal, like the sea" } } },
    ]);
  });

  test("Other: Enter on an empty field submits nothing, and Esc returns to the options without interrupting", async () => {
    await openSession({ questions: [COLOR] });
    await showPrompt();
    await press("o");
    await press("RETURN");
    expect(results).toEqual([]);
    await type("Tea");
    await press("ESCAPE");
    const frame = await frameContaining("1 Red");
    expect(results).toEqual([]);
    expect(frame).toContain(COLOR.question);
    expect(frame).toContain("1 Red");
    await press("1");
    expect(results[0].updatedInput.answers).toEqual({ [COLOR.question]: "Red" });
  });

  test("Esc declines the questions, resolving once", async () => {
    await openSession({ questions: [COLOR, SIZE] });
    await showPrompt();
    await press("ESCAPE");
    await press("1");
    await settle(50);
    expect(results).toEqual([{ behavior: "deny", message: "The user declined to answer." }]);
  });

  test("keys within 300 ms of the prompt appearing do nothing; after a pause they answer", async () => {
    await openSession({ questions: [COLOR] });
    await showPrompt();
    expect(screen!.captureCharFrame()).toContain("waiting for typing to stop");
    await pressNow("1");
    await settle();
    expect(results).toEqual([]);
    await press("1");
    expect(results[0].updatedInput.answers).toEqual({ [COLOR.question]: "Red" });
  });

  test("the next question ignores a key pressed right after the previous answer", async () => {
    await openSession({ questions: [COLOR, SIZE] });
    await showPrompt();
    await press("1");
    await pressNow("2");
    await settle();
    expect(results).toEqual([]);
    await press("2");
    expect(results[0].updatedInput.answers).toEqual({ [COLOR.question]: "Red", [SIZE.question]: "Large" });
  });

  test("ctrl+o does not open the Other field", async () => {
    await openSession({ questions: [COLOR] });
    await showPrompt();
    await press("o", { ctrl: true });
    expect(screen!.captureCharFrame()).not.toContain("Type an answer");
    await press("1");
    expect(results[0].updatedInput.answers).toEqual({ [COLOR.question]: "Red" });
  });

  test("malformed AskUserQuestion input falls back to the generic permission prompt", async () => {
    const malformed = { questions: [{ question: "Which?", header: "Pick", options: [{ label: "Only", description: "one" }], multiSelect: false }] };
    await openSession(malformed);
    await showPrompt();
    const frame = screen!.captureCharFrame();
    expect(frame).toContain("Allow AskUserQuestion?");
    expect(frame).not.toContain("Question 1/1");
    await press("y");
    expect(results).toEqual([{ behavior: "allow", updatedInput: malformed }]);
  });

  test("the prompt shows the header, question, numbered options with descriptions, and Other", async () => {
    await openSession({ questions: [COLOR] });
    await showPrompt();
    const frame = collapse(screen!.captureCharFrame());
    expect(frame).toContain("Question 1/1");
    expect(frame).toContain("Color");
    expect(frame).toContain(COLOR.question);
    for (const [i, option] of COLOR.options.entries()) {
      expect(frame).toContain(`${i + 1} ${option.label}`);
      expect(frame).toContain(option.description);
    }
    expect(frame).toContain("o Other (type an answer)");
    await press("1");
  });
});
