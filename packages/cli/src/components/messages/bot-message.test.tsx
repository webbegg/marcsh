import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-bot-message-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../../layouts/root-layout");
const { Session } = await import("../../screens/session");
const { getStorage } = await import("../../lib/storage");
const { ThemeProvider } = await import("../../providers/theme");
const { BotMessage } = await import("./bot-message");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});
// OpenTUI 0.9 paints a committed update on a later frame (and a frame cannot be read mid-paint): draw it before it is read.
const settle = async (ms = 60) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

describe("the label of a reply", () => {
  test("is the name of the agent that answered", async () => {
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "text", text: "hi" }]} model="opus" mode="PLAN" agentName="Reviewer" />
      </ThemeProvider>,
      { width: 80, height: 10 },
    );
    await settle();
    expect(frame()).toContain("Reviewer › opus");
    expect(frame()).not.toContain("Plan › opus");
  });

  test("is the mode's name when no agent is known", async () => {
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "text", text: "plan reply" }]} model="m-plan" mode="PLAN" />
        <BotMessage parts={[{ type: "text", text: "build reply" }]} model="m-build" mode="BUILD" />
      </ThemeProvider>,
      { width: 80, height: 14 },
    );
    await settle();
    expect(frame()).toContain("Plan › m-plan");
    expect(frame()).toContain("Build › m-build");
  });

  test("of a stored message comes from its `agent` metadata; older messages without it show Plan or Build", async () => {
    const session = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine: "claude" });
    const reply = (id: string, metadata: Record<string, unknown>) => ({ id, role: "assistant" as const, parts: [{ type: "text" as const, text: `reply ${id}` }], metadata });
    getStorage().saveMessages(session.id, [
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      reply("a1", { mode: "PLAN", model: "m-one", agent: "Reviewer" }),
      reply("a2", { mode: "PLAN", model: "m-two" }),
      reply("a3", { mode: "BUILD", model: "m-three" }),
    ] as never);
    const router = createMemoryRouter(
      [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
      { initialEntries: [`/sessions/${session.id}`] },
    );
    screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 50 });
    await settle(200);
    await screen.renderOnce();

    const text = frame();
    expect(text).toContain("Reviewer › m-one");
    expect(text).toContain("Plan › m-two");
    expect(text).toContain("Build › m-three");
    expect(text).not.toContain("Plan › m-one");
  });
});

describe("the footer of an interrupted reply (S6)", () => {
  test("ends with `interrupted` after the duration; a reply that was not interrupted has none", async () => {
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "text", text: "cut" }]} model="haiku" mode="BUILD" durationMs={3700} interrupted />
        <BotMessage parts={[{ type: "text", text: "whole" }]} model="opus" mode="BUILD" durationMs={2100} />
      </ThemeProvider>,
      { width: 80, height: 14 },
    );
    await settle();
    expect(frame()).toContain("Build › haiku › 3.7s › interrupted");
    expect(frame()).toContain("Build › opus › 2.1s");
    expect(frame().match(/interrupted/g)).toHaveLength(1);
  });

  test("still says interrupted when no duration was reported", async () => {
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "text", text: "cut" }]} model="haiku" mode="BUILD" interrupted />
      </ThemeProvider>,
      { width: 80, height: 8 },
    );
    await settle();
    expect(frame()).toContain("Build › haiku › interrupted");
  });
});

describe("the text of a reply is markdown (S8)", () => {
  test("shows bold, a heading and a fenced block without their markers, and keeps the footer", async () => {
    const text = "# Plan\n\nuse **bold** here\n\n```ts\nconst answer = 42;\n```";
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "text", text }]} model="opus" mode="BUILD" />
      </ThemeProvider>,
      { width: 80, height: 20 },
    );
    await settle();
    expect(frame()).toContain("Plan");
    expect(frame()).not.toContain("# Plan");
    expect(frame()).toContain("use bold here");
    expect(frame()).toContain("const answer = 42;");
    expect(frame()).not.toContain("```");
    expect(frame()).toContain("Build › opus");
  });

  test("an ESC in a reply still shows as \\u001b", async () => {
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "text", text: "a\u001b[2Jb" }]} model="opus" mode="BUILD" />
      </ThemeProvider>,
      { width: 80, height: 8 },
    );
    await settle();
    expect(frame()).toContain("a\\u001b[2Jb");
  });

  test("while streaming, only the last text part is treated as unfinished; earlier parts and a final message are complete", async () => {
    const parts = [
      { type: "text" as const, text: "first **one" },
      { type: "tool" as const, toolCallId: "t1", toolName: "Read", input: { file_path: "/tmp/a.txt" }, state: "done" as const },
      { type: "text" as const, text: "second **two" },
    ];
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={parts} model="opus" mode="BUILD" streaming />
      </ThemeProvider>,
      { width: 80, height: 14 },
    );
    await settle();
    // The unclosed marker of the part still streaming is hidden; the earlier part is complete, so its marker is text.
    expect(frame()).toContain("first **one");
    expect(frame()).toContain("second two");
    expect(frame()).not.toContain("**two");
  });

  test("a final reply (not streaming) is complete: an unclosed marker stays visible", async () => {
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "text", text: "so **bo" }]} model="opus" mode="BUILD" />
      </ThemeProvider>,
      { width: 80, height: 8 },
    );
    await settle();
    expect(frame()).toContain("so **bo");
  });

  test("a streaming reply with an unclosed emphasis renders", async () => {
    screen = await testRender(
      <ThemeProvider>
        <BotMessage parts={[{ type: "text", text: "so **bo" }]} model="opus" mode="BUILD" streaming />
      </ThemeProvider>,
      { width: 80, height: 8 },
    );
    await settle();
    expect(frame()).toContain("so bo");
  });
});

describe("the layout of a reply", () => {
  const call = (toolName: string, id: string) => ({ type: "tool" as const, toolCallId: id, toolName, input: {}, state: "done" as const });

  test("keeps a run of lookups together and sets every panel apart", async () => {
    const { groupParts } = await import("./bot-message");
    const groups = groupParts([
      { type: "reasoning", text: "hm" },
      call("Read", "r1"),
      call("Grep", "g1"),
      call("Bash", "b1"),
      call("Edit", "e1"),
      { type: "text", text: "done" },
    ]);
    expect(groups.map((group) => [group.layout, group.parts.length])).toEqual([["row", 3], ["block", 1], ["block", 1], ["text", 1]]);
  });

  test("puts an expanded thought in a group of its own", async () => {
    const { groupParts } = await import("./bot-message");
    const groups = groupParts([{ type: "reasoning", text: "hm" }, call("Read", "r1")], true);
    expect(groups.map((group) => group.layout)).toEqual(["block", "row"]);
  });
});

const { TranscriptViewProvider, createTranscriptViewStore } = await import("../../providers/transcript-view");

describe("a run of lookups", () => {
  type Part = Parameters<typeof BotMessage>[0]["parts"][number];
  const lookup = (toolName: string, id: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Part =>
    ({ type: "tool", toolCallId: id, toolName, input, state: "done", ...extra }) as Part;
  const read = (path: string, id: string, extra: Record<string, unknown> = {}) => lookup("Read", id, { file_path: path }, extra);
  const grep = (pattern: string, id: string) => lookup("Grep", id, { pattern }, { output: "Found 2 files\na\nb" });

  async function render(parts: Part[], options: { details?: boolean; streaming?: boolean } = {}) {
    const store = createTranscriptViewStore();
    if (options.details) store.toggle("details");
    screen = await testRender(
      <ThemeProvider>
        <TranscriptViewProvider store={store}>
          <BotMessage parts={parts} model="opus" mode="BUILD" streaming={options.streaming} />
        </TranscriptViewProvider>
      </ThemeProvider>,
      { width: 80, height: 16 },
    );
    await settle();
    return screen.captureCharFrame().replace(/[ \t]+$/gm, "").split("\n").filter((row) => row.trim() !== "");
  }

  test("is folded to one line that counts what was looked at", async () => {
    const rows = await render([read("/a.ts", "r1"), read("/b.ts", "r2"), grep("foo", "g1"), { type: "text", text: "Found it." }]);
    expect(rows[0]).toBe("   → Explored: 2 reads, 1 search (ctrl+x o)");
    expect(rows.join("\n")).not.toContain("/a.ts");
    expect(rows[1]).toContain("Found it.");
  });

  test("with details on shows every call on its own line", async () => {
    const rows = await render([read("/a.ts", "r1"), read("/b.ts", "r2")], { details: true });
    expect(rows.slice(0, 2)).toEqual(["   → Read /a.ts", "   → Read /b.ts"]);
    expect(rows.join("\n")).not.toContain("Explored");
  });

  test("of one call is that call's own line", async () => {
    const rows = await render([read("/a.ts", "r1"), { type: "text", text: "ok" }]);
    expect(rows[0]).toBe("   → Read /a.ts");
  });

  test("is broken by a thought, so each side folds on its own", async () => {
    const rows = await render([read("/a.ts", "r1"), read("/b.ts", "r2"), { type: "reasoning", text: "hmm" }, read("/c.ts", "r3")]);
    expect(rows[0]).toBe("   → Explored: 2 reads (ctrl+x o)");
    expect(rows[1]).toContain("◇ Thinking");
    expect(rows[2]).toBe("   → Read /c.ts");
  });

  test("still running says Exploring behind a spinner", async () => {
    const rows = await render([read("/a.ts", "r1"), read("/b.ts", "r2", { state: "running" })], { streaming: true });
    expect(rows[0]).toMatch(/^ {3}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Exploring: 2 reads \(ctrl\+x o\)$/);
  });

  test("keeps a failed or refused call out of the fold, with its error", async () => {
    const rows = await render([
      read("/a.ts", "r1"),
      read("/missing.ts", "r2", { state: "error", errorText: "File does not exist." }),
      read("/b.ts", "r3"),
      read("/secret", "r4", { state: "error", errorText: "The user denied this tool call." }),
    ]);
    expect(rows.slice(0, 4)).toEqual([
      "   → Explored: 2 reads (ctrl+x o)",
      "   ✗ Read /missing.ts",
      "     File does not exist.",
      "   ⊘ Read /secret · denied",
    ]);
  });

  test("of calls that all failed shows each of them, with no fold", async () => {
    const rows = await render([
      read("/x", "r1", { state: "error", errorText: "nope" }),
      read("/y", "r2", { state: "error", errorText: "nope" }),
    ]);
    expect(rows.join("\n")).not.toContain("Explored");
    expect(rows[0]).toBe("   ✗ Read /x");
  });
});
