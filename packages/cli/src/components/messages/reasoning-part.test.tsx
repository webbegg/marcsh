import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-reasoning-part-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../../providers/theme");
const { TranscriptViewProvider, createTranscriptViewStore } = await import("../../providers/transcript-view");
const { ReasoningPart } = await import("./reasoning-part");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});
const settle = async (ms = 60) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};

async function render(part: { text: string; durationMs?: number }, options: { thinking?: boolean; width?: number; live?: boolean } = {}) {
  const store = createTranscriptViewStore();
  if (options.thinking) store.toggle("thinking");
  screen = await testRender(
    <ThemeProvider>
      <TranscriptViewProvider store={store}>
        <ReasoningPart part={{ type: "reasoning", ...part }} live={options.live} />
      </TranscriptViewProvider>
    </ThemeProvider>,
    { width: options.width ?? 80, height: 12 },
  );
  await settle();
  return screen.captureCharFrame().replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

describe("an empty thinking block", () => {
  test("shows nothing, collapsed or not", async () => {
    expect(await render({ text: "" })).toBe("");
    await act(async () => screen!.renderer.destroy());
    expect(await render({ text: " \n\t " }, { thinking: true })).toBe("");
    await act(async () => screen!.renderer.destroy());
    expect(await render({ text: "", durationMs: 900 })).toBe("");
  });
});

describe("a collapsed thinking block", () => {
  test("is one line with its duration and the first words", async () => {
    const frame = await render({ text: "Let me look at the failing test first.\nThen the fix.", durationMs: 2300 });
    expect(frame.split("\n")).toHaveLength(1);
    expect(frame).toContain("Thinking · 2.3s");
    expect(frame).toContain("Let me look at the failing test first.");
    expect(frame).toContain("ctrl+x h");
    expect(frame).not.toContain("Then the fix");
  });

  test("without a duration (Claude) is just `Thinking`", async () => {
    const frame = await render({ text: "Considering the options" });
    expect(frame).toMatch(/^ {3}◇ Thinking · Considering the options/);
    expect(frame).not.toMatch(/\ds/);
  });

  test("cuts the first words to the width with an ellipsis, and drops them when nothing fits", async () => {
    const long = "word ".repeat(40);
    const narrow = await render({ text: long, durationMs: 1000 }, { width: 50 });
    expect(narrow.split("\n")).toHaveLength(1);
    expect(narrow).toContain("Thinking · 1s");
    expect(narrow).toContain("…");
    await act(async () => screen!.renderer.destroy());
    const tiny = await render({ text: long, durationMs: 1000 }, { width: 22 });
    expect(tiny.split("\n")).toHaveLength(1);
    expect(tiny).toContain("Thinking · 1s");
    expect(tiny).not.toContain("word");
  });

  test("shows a control character as an escape", async () => {
    const frame = await render({ text: "x\u001b[2Jy" });
    expect(frame).toContain("\\u001b[2Jy");
    expect(frame).not.toContain("\u001b");
  });
});

describe("a titled thought", () => {
  test("shows its title instead of its first words", async () => {
    const frame = await render({ text: "**Planning the change**\n\nFirst the files, then the edit.", durationMs: 1200 });
    expect(frame).toBe("   ◇ Thought: Planning the change · 1.2s (ctrl+x h)");
  });

  test("shows a control character in its title as an escape", async () => {
    const frame = await render({ text: "**Plan\u001b]0;x\u0007**\n\nBody." });
    expect(frame).toContain("Thought: Plan\\u001b]0;x\\u0007");
    expect(frame).not.toContain("\u001b");
  });

  test("collapsed, cuts a long title to stay on one line", async () => {
    const frame = await render({ text: `**${"Planning ".repeat(20).trim()}**\n\nBody.`, durationMs: 1200 }, { width: 50 });
    expect(frame.split("\n")).toHaveLength(1);
    expect(frame).toContain("Thought: Planning");
    expect(frame).toContain("… · 1.2s");
  });

  test("expanded, shows the rest under the title", async () => {
    const frame = await render({ text: "**Planning**\n\nFirst the files." }, { thinking: true });
    expect(frame.split("\n")).toEqual(["   ◇ Thought: Planning", "   │ First the files."]);
  });
});

describe("a thought still being written", () => {
  test("has a spinner in the place of its glyph", async () => {
    const frame = await render({ text: "Considering" }, { live: true });
    expect(frame).toMatch(/^ {3}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking/);
  });
});

describe("an expanded thinking block", () => {
  test("shows the whole text behind a rule, under the label", async () => {
    const frame = await render({ text: "first thought\nsecond thought", durationMs: 2300 }, { thinking: true });
    expect(frame.split("\n")).toEqual(["   ◇ Thinking · 2.3s", "   │ first thought", "   │ second thought"]);
  });
});
