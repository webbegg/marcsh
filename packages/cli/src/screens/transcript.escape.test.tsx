import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

// S2 scope (A1): text from a model, tool or MCP server reaches the terminal as visible escapes, never as raw sequences.
process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-transcript-escape-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { ThemeProvider } = await import("../providers/theme");
const { BotMessage, ErrorMessage, UserMessage } = await import("../components/messages");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});
const settle = (ms = 60) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const ESC = "\u001b";
const BEL = "\u0007";
const RLO = String.fromCharCode(0x202e);
// Anything that would reach the terminal raw: ESC, BEL, other C0 controls (tab and newline aside), DEL, C1 controls (CSI, OSC, ST), zero-width and bidi characters.
const isRaw = (char: string) => {
  const code = char.codePointAt(0)!;
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
};
const hasRaw = (text: string) => [...text].some(isRaw);

/** Every character the screen holds, spans and chars alike: nothing of it may be raw. */
const everything = (s: NonNullable<typeof screen>) => {
  const spans = s.captureSpans().lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n");
  return `${spans}\n${s.captureCharFrame()}`;
};
// Joins wrapped rows back together (and drops the left border), so a long escape can be searched whole.
const collapse = (text: string) => text.replace(/[│┃\s]+/g, "");

const COMMAND = `echo ${ESC}]0;pwned${BEL}${ESC}]52;c;ZXZpbA==${BEL}${ESC}[2J${ESC}[10;10H \u009b2J ${RLO}txt`;

describe("the transcript shows model, tool and MCP text as visible escapes", () => {
  test("a stored session with a hostile tool call, task, reasoning and reply", async () => {
    const session = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine: "claude" });
    getStorage().saveMessages(session.id, [
      { id: "u1", role: "user", parts: [{ type: "text", text: "do it" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: `think ${ESC}[2J hard` },
          { type: "tool", toolCallId: "t1", toolName: "Bash", input: { command: COMMAND }, state: "error", errorText: `boom ${ESC}]52;c;AAAA${BEL} ${RLO}done` },
          { type: "task", taskId: "k1", description: `task ${ESC}[H`, status: "failed", lastToolName: `Edit${ESC}[2J`, summary: `sum ${ESC}]0;t${BEL}`, error: `err${ESC}c` },
          { type: "text", text: `Hello ${ESC}[31mred${ESC}[0m world${BEL}\nsecond\tline` },
        ],
        metadata: { mode: "BUILD", model: "opus" },
      },
    ]);
    const router = createMemoryRouter(
      [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
      { initialEntries: [`/sessions/${session.id}`] },
    );
    screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 50 });
    await settle(200);
    await screen.renderOnce();

    const all = everything(screen);
    expect(hasRaw(all)).toBe(false);
    const flat = collapse(all);
    expect(flat).toContain("think\\u001b[2Jhard");
    expect(flat).toContain("Bash:echo\\u001b]0;pwned\\u0007\\u001b]52;c;ZXZpbA==\\u0007\\u001b[2J");
    expect(flat).toContain("boom\\u001b]52;c;AAAA\\u0007\\u202edone");
    expect(flat).toContain("task\\u001b[H");
    expect(flat).toContain("Edit\\u001b[2J");
    expect(flat).toContain("sum\\u001b]0;t\\u0007");
    expect(flat).toContain("Hello\\u001b[31mred\\u001b[0mworld\\u0007");
    expect(flat).toContain("second");
  });

  test("a failed task's error is escaped too", async () => {
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "task", taskId: "k", description: "d", status: "failed", error: `bad${ESC}[2Jnews` }]} model="m" mode="BUILD" />
      </ThemeProvider>,
      { width: 100, height: 20 },
    );
    await settle();
    await screen.renderOnce();
    expect(hasRaw(everything(screen))).toBe(false);
    expect(collapse(everything(screen))).toContain("bad\\u001b[2Jnews");
  });

  test("an error message and a user message are escaped", async () => {
    screen = await testRender(
      <ThemeProvider>
        <ErrorMessage message={`failed ${ESC}]0;x${BEL}`} />
        <UserMessage message={`pasted ${ESC}[2J ${RLO}x`} mode="BUILD" />
      </ThemeProvider>,
      { width: 100, height: 20 },
    );
    await settle();
    await screen.renderOnce();
    const all = everything(screen);
    expect(hasRaw(all)).toBe(false);
    expect(all).toContain("failed \\u001b]0;x\\u0007");
    expect(all).toContain("pasted \\u001b[2J \\u202ex");
  });

  test("ordinary text keeps its look: markdown characters, tabs, newlines and wide characters", async () => {
    const text = "# Title\n\n- item `code` **bold**\n\tindented 日本語 🙂";
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "reasoning", text: "plain thought" }, { type: "tool", toolCallId: "t", toolName: "Read", input: { file_path: "/tmp/日本.txt" }, state: "done" }, { type: "text", text }]} model="m" mode="BUILD" />
      </ThemeProvider>,
      { width: 100, height: 30 },
    );
    await settle();
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    expect(frame).toContain("# Title");
    expect(frame).toContain("- item `code` **bold**");
    expect(frame).toContain("indented 日本語 🙂");
    expect(frame).toContain("Thinking: plain thought");
    expect(frame).toContain("Read: /tmp/日本.txt");
    expect(frame).not.toContain("\\");
  });
});
