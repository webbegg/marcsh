import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-tool-part-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../../providers/theme");
const { TranscriptViewProvider, createTranscriptViewStore } = await import("../../providers/transcript-view");
const { ToolPart } = await import("./tool-part");

type Part = Parameters<typeof ToolPart>[0]["part"];

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

const tool = (extra: Record<string, unknown> = {}, toolName = "Bash", input: Record<string, unknown> = { command: "npm test" }): Part =>
  ({ type: "tool", toolCallId: "t1", toolName, input, state: "done", ...extra }) as Part;

async function render(part: Part, options: { details?: boolean; width?: number; height?: number } = {}) {
  const store = createTranscriptViewStore();
  if (options.details) store.toggle("details");
  screen = await testRender(
    <ThemeProvider>
      <TranscriptViewProvider store={store}>
        <ToolPart part={part} />
      </TranscriptViewProvider>
    </ThemeProvider>,
    { width: options.width ?? 80, height: options.height ?? 30 },
  );
  await settle();
  return screen.captureCharFrame().replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}

const numbered = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");

describe("a tool call without stored output", () => {
  test("is the one dim line it always was", async () => {
    const frame = await render(tool());
    expect(frame).toBe("│  Bash: npm test");
  });

  test("while running ends in an ellipsis; an error shows its text on the line", async () => {
    expect(await render(tool({ state: "running" }))).toBe("│  Bash: npm test …");
    await act(async () => screen!.renderer.destroy());
    expect(await render(tool({ state: "error", errorText: "exit 2" }))).toBe("│  Bash: npm test exit 2");
  });
});

describe("the output preview of a Bash call", () => {
  test("shows the last 4 lines under the call and counts the rest", async () => {
    const frame = await render(tool({ output: numbered(10) }));
    console.log(`--- collapsed Bash preview ---\n${frame}\n---`);
    expect(frame.split("\n")).toEqual([
      "│  Bash: npm test",
      "│    … 6 more lines (ctrl+x o)",
      "│    line 7",
      "│    line 8",
      "│    line 9",
      "│    line 10",
    ]);
  });

  test("shows a short output as it is, with no marker", async () => {
    const frame = await render(tool({ output: "one\ntwo" }));
    expect(frame.split("\n")).toEqual(["│  Bash: npm test", "│    one", "│    two"]);
  });

  test("says when the stored output was cut", async () => {
    const frame = await render(tool({ output: numbered(10), outputTruncated: true }));
    expect(frame).toContain("… 6+ more lines (ctrl+x o)");
    await act(async () => screen!.renderer.destroy());
    const short = await render(tool({ output: "a\nb", outputTruncated: true }));
    expect(short).toContain("… earlier lines not kept");
    expect(short).not.toContain("ctrl+x o");
  });

  test("with details on shows every stored line, and the cut marker", async () => {
    const frame = await render(tool({ output: numbered(10), outputTruncated: true }), { details: true });
    for (let i = 1; i <= 10; i++) expect(frame).toContain(`line ${i}`);
    expect(frame).toContain("… earlier lines not kept");
    expect(frame).not.toContain("more lines");
  });

  test("an error shows in full, whatever the toggle", async () => {
    const errorText = numbered(8, "failure");
    const frame = await render(tool({ state: "error", errorText }));
    for (let i = 1; i <= 8; i++) expect(frame).toContain(`failure ${i}`);
  });

  test("a control character in the output is shown as an escape and never reaches the terminal", async () => {
    const frame = await render(tool({ output: "ok\u001b[31mred\u001b[0m\nbell\u0007" }));
    expect(frame).toContain("\\u001b[31mred\\u001b[0m");
    expect(frame).toContain("bell\\u0007");
    expect(frame).not.toContain("\u001b");
    expect(frame).not.toContain("\u0007");
  });

  test("other tools show a preview too", async () => {
    const frame = await render(tool({ output: "src/a.ts\nsrc/b.ts" }, "Grep", { pattern: "foo" }));
    expect(frame.split("\n")).toEqual(["│  Grep: foo", "│    src/a.ts", "│    src/b.ts"]);
  });

  test("a running call shows no output", async () => {
    const frame = await render(tool({ state: "running", output: "stale" }));
    expect(frame).toBe("│  Bash: npm test …");
  });
});

const PATCH = "@@ -3,3 +3,3 @@\n keep one\n-old line\n+new line\n keep two";

describe("the diff of an Edit", () => {
  test("shows what the edit changed, with line numbers", async () => {
    const frame = await render(tool({ patch: PATCH }, "Edit", { file_path: "src/a.ts" }));
    console.log(`--- edit diff ---\n${frame}\n---`);
    expect(frame).toContain("Edit: src/a.ts");
    for (const text of ["keep one", "old line", "new line", "keep two"]) expect(frame).toContain(text);
    expect(frame).not.toContain("@@");
    expect(frame).toMatch(/3\s.*keep one/);
  });

  test("is coloured: added rows and removed rows have their own background", async () => {
    await render(tool({ patch: PATCH }, "Edit", { file_path: "src/a.ts" }));
    const rows = screen!.captureSpans().lines;
    const bgOf = (text: string) => {
      const line = rows.find((row) => row.spans.map((span) => span.text).join("").includes(text))!;
      const span = line.spans.find((candidate) => candidate.text.includes(text))!;
      return JSON.stringify(span.bg);
    };
    expect(bgOf("new line")).not.toBe(bgOf("keep one"));
    expect(bgOf("old line")).not.toBe(bgOf("keep one"));
    expect(bgOf("old line")).not.toBe(bgOf("new line"));
  });

  test("a Write shows its diff too", async () => {
    const frame = await render(tool({ patch: "@@ -0,0 +1,2 @@\n+first\n+second" }, "Write", { file_path: "n.txt" }));
    expect(frame).toContain("first");
    expect(frame).toContain("second");
  });

  test("a long diff is cut to about 12 lines and counts the rest", async () => {
    const body = Array.from({ length: 30 }, (_, i) => `+added ${i + 1}`).join("\n");
    const frame = await render(tool({ patch: `@@ -0,0 +1,30 @@\n${body}` }, "Write", { file_path: "big.txt" }));
    expect(frame).toContain("added 1");
    expect(frame).toContain("added 11");
    expect(frame).not.toContain("added 12");
    expect(frame).not.toContain("added 30");
    expect(frame).toContain("… 19 more lines (ctrl+x o)");
  });

  test("with details on a long diff shows all of it", async () => {
    const body = Array.from({ length: 30 }, (_, i) => `+added ${i + 1}`).join("\n");
    const frame = await render(tool({ patch: `@@ -0,0 +1,30 @@\n${body}` }, "Write", { file_path: "big.txt" }), { details: true, height: 50 });
    expect(frame).toContain("added 1");
    expect(frame).toContain("added 30");
    expect(frame).not.toContain("more lines");
  });

  test("a control character in the diff is shown as an escape", async () => {
    const frame = await render(tool({ patch: "@@ -0,0 +1,1 @@\n+boom\u001b[2Jx" }, "Write", { file_path: "n.txt" }));
    expect(frame).toContain("\\u001b[2Jx");
    expect(frame).not.toContain("\u001b");
  });

  test("a patch that is not a unified diff is listed as plain lines instead of failing", async () => {
    const frame = await render(tool({ patch: "-1 a\n+1 b" }, "edit", { path: "f.ts" }));
    expect(frame).toContain("-1 a");
    expect(frame).toContain("+1 b");
  });

  test("a call that failed shows no diff", async () => {
    const frame = await render(tool({ state: "error", errorText: "no match", patch: PATCH }, "Edit", { file_path: "src/a.ts" }));
    expect(frame).not.toContain("new line");
    expect(frame).toContain("no match");
  });
});

describe("a part saved before these fields existed", () => {
  test("renders exactly as before", async () => {
    const frame = await render({ type: "tool", toolCallId: "t9", toolName: "Read", input: { file_path: "/tmp/x.ts" }, state: "done" });
    expect(frame).toBe("│  Read: /tmp/x.ts");
  });
});
