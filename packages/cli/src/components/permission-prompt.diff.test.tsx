import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useState } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-prompt-diff-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");
const workDir = mkdtempSync(join(tmpdir(), "marcsh-prompt-diff-work-"));

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../providers/theme");
const { KeyboardLayerProvider } = await import("../providers/keyboard-layer");
const { PermissionPrompt } = await import("./permission-prompt");
const { previewEdit } = await import("../lib/edit-preview");

type Previewer = typeof previewEdit;

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let answers: unknown[] = [];

afterAll(() => {
  rmSync(prefsDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  answers = [];
});

// OpenTUI 0.9 paints a committed update on a later frame (and a frame cannot be read mid-paint): draw it before it is read.
const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};

const requestFor = (toolName: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    kind: "permission",
    toolName,
    input,
    respond: (decision: unknown) => answers.push(decision),
    ...extra,
  }) as any;

/** Renders the prompt and waits out its quiet window, so the real hint rows are showing. */
async function show(request: any, options: { previewer?: Previewer; height?: number; width?: number } = {}) {
  screen = await testRender(
    <ThemeProvider>
      <KeyboardLayerProvider>
        <PermissionPrompt request={request} cwd={workDir} previewer={options.previewer} />
      </KeyboardLayerProvider>
    </ThemeProvider>,
    { width: options.width ?? 110, height: options.height ?? 40 },
  );
  await settle(400);
  await screen.renderOnce();
  return screen.captureCharFrame();
}

const frameNow = async () => {
  await screen!.renderOnce();
  return screen!.captureCharFrame();
};

const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle();
};

/** Each row without the border and trailing blanks. */
const rowsOf = (frame: string) => frame.split("\n").map((row) => row.replace(/^│/, "").trimEnd());

let fileCount = 0;
function tempFile(text: string) {
  const path = join(workDir, `file-${++fileCount}.ts`);
  writeFileSync(path, text);
  return path;
}

describe("PermissionPrompt: the diff of an edit", () => {
  test("an Edit on a real file shows the rows it will write, with line numbers", async () => {
    const path = tempFile("one\ntwo\nthree\nfour\n");
    const frame = await show(requestFor("Edit", { file_path: path, old_string: "two\n", new_string: "TWO\nextra\n", replace_all: false }));
    const rows = rowsOf(frame);

    expect(frame).toContain("Allow Edit?");
    expect(frame).not.toContain("old_string");
    expect(rows.find((row) => /^\s*┊ Edit /.test(row))).toMatch(/^\s*┊ Edit {2}\+2 −1 {2}\//);
    expect(frame.replace(/[│┊\s]+/g, "")).toContain(`Edit+2−1${path}`);
    expect(rows.some((row) => /^\s*┊\s+1\s+1\s+one$/.test(row))).toBe(true);
    expect(rows.some((row) => /^\s*┊\s+2\s+- two$/.test(row))).toBe(true);
    expect(rows.some((row) => /^\s*┊\s+2\s+\+ TWO$/.test(row))).toBe(true);
    expect(rows.some((row) => /^\s*┊\s+3\s+\+ extra$/.test(row))).toBe(true);
    expect(rows.some((row) => /^\s*┊\s+3\s+4\s+three$/.test(row))).toBe(true);
    // The keys are still the prompt's own.
    expect(frame).toMatch(/y\s+allow once\s+a\s+always allow\s+n\s+deny/);
  });

  test("a Write of a new file says new file and adds every line", async () => {
    const path = join(workDir, "brand-new.txt");
    const frame = await show(requestFor("Write", { file_path: path, content: "alpha\nbeta\n" }));
    const rows = rowsOf(frame);

    expect(rows.find((row) => /^\s*┊ Write /.test(row))).toMatch(/^\s*┊ Write {2}new file {2}\+2 −0 {2}\//);
    expect(frame.replace(/[│┊\s]+/g, "")).toContain(`Writenewfile+2−0${path}`);
    expect(rows.some((row) => /^\s*┊\s+1\s+\+ alpha$/.test(row))).toBe(true);
    expect(rows.some((row) => /^\s*┊\s+2\s+\+ beta$/.test(row))).toBe(true);
    expect(frame).not.toContain('"content"');
  });

  test("pi's lower case edit is previewed too", async () => {
    const path = tempFile("a\nb\nc\n");
    const frame = await show(requestFor("edit", { path, edits: [{ oldText: "b", newText: "B" }] }));
    const rows = rowsOf(frame);

    expect(rows.some((row) => /^\s*┊\s+2\s+- b$/.test(row))).toBe(true);
    expect(rows.some((row) => /^\s*┊\s+2\s+\+ B$/.test(row))).toBe(true);
  });

  test("a preview that cannot be exact shows today's raw input and the reason", async () => {
    const path = tempFile("one\ntwo\n");
    const input = { file_path: path, old_string: "nope\n", new_string: "yes\n", replace_all: false };
    const frame = await show(requestFor("Edit", input));

    expect(frame).toContain("diff unavailable: old text not found exactly (the tool may match it loosely)");
    expect(frame).toContain('"old_string": "nope\\n"');
    expect(frame).toContain('"new_string": "yes\\n"');
    expect(frame).not.toContain("┊ Edit ");
    expect(frame).not.toContain("preparing diff");
  });

  test("a diff line that looks like the prompt's key row stays behind the gutter", async () => {
    const fake = "y  allow once  a  always allow  n  deny";
    const path = join(workDir, "fake-keys.txt");
    const frame = await show(requestFor("Write", { file_path: path, content: `${fake}\nn  deny\n` }));
    const rows = rowsOf(frame);

    const fakeRows = rows.filter((row) => row.includes(fake));
    // The tool's text and the prompt's own row.
    expect(fakeRows.length).toBe(2);
    expect(fakeRows.filter((row) => /^\s*┊/.test(row)).length).toBe(1);
    // Only the prompt's own row starts with the key: no row of tool text can be read as it.
    expect(rows.filter((row) => /^\s*y\s+allow once/.test(row)).length).toBe(1);
    expect(rows.filter((row) => /^\s*n\s+deny/.test(row)).length).toBe(0);
  });

  test("a long diff is capped with the exact count of the rows it hides", async () => {
    const path = join(workDir, "long.txt");
    const content = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const preview = await previewEdit("Write", { file_path: path, content }, workDir);
    expect(preview.kind).toBe("diff");
    const total = preview.kind === "diff" ? preview.lines.length : 0;

    // 40 rows high: 24 diff rows fit (the hunk header and 23 added lines), the rest are counted.
    const frame = await show(requestFor("Write", { file_path: path, content }), { height: 40 });
    const rows = rowsOf(frame);
    const shown = rows.filter((row) => /^\s*┊\s+\d+\s+\+ line \d+$/.test(row)).length;

    expect(total).toBe(61);
    expect(rows.some((row) => /^\s*┊\s+@@ -0,0 \+1,60 @@$/.test(row))).toBe(true);
    expect(shown).toBe(23);
    expect(frame).toContain("… 37 more lines");
    expect(frame).toContain(`… ${total - 24} more lines`);
    // The keys stay on screen.
    expect(frame).toMatch(/y\s+allow once\s+a\s+always allow\s+n\s+deny/);
  });

  test("a short terminal shows fewer diff rows, never pushing the keys away", async () => {
    const path = join(workDir, "long2.txt");
    const content = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    const frame = await show(requestFor("Write", { file_path: path, content }), { height: 24 });

    expect(frame).toMatch(/y\s+allow once\s+a\s+always allow\s+n\s+deny/);
    expect(frame).toMatch(/… \d+ more lines/);
  });

  test("a tool other than edit and write is unchanged and is never previewed", async () => {
    const calls: string[] = [];
    const previewer: Previewer = async (tool, ...rest) => {
      calls.push(tool);
      return previewEdit(tool, ...rest);
    };
    const frame = await show(requestFor("Bash", { command: "ls -la", description: "list" }), { previewer });

    expect(calls).toEqual([]);
    expect(frame).toContain("┊ ls -la");
    expect(frame).not.toContain("diff unavailable");
    expect(frame).not.toContain("preparing diff");
  });
});

describe("PermissionPrompt: the file the tool writes, and the cost of a render", () => {
  test("a symlink to a file outside the folder is shown as the link, an arrow and the real file", async () => {
    const outside = mkdtempSync(join(tmpdir(), "marcsh-prompt-diff-outside-"));
    try {
      const target = join(realpathSync(outside), "secret.txt");
      writeFileSync(target, "secret\n");
      const link = join(workDir, "innocent.txt");
      symlinkSync(target, link);
      const frame = await show(requestFor("Write", { file_path: link, content: "changed\n" }), { width: 260 });

      // A long temp folder can wrap the header: join the wrapped gutter rows before matching.
      expect(frame.replace(/\s*\n│\s*┊ /g, " ")).toContain(`${link} → ${target} (symlink)`);
      expect(frame).toContain("+1 −1");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a previewer that throws before it returns a promise is the raw fallback, not a crash", async () => {
    const previewer: Previewer = () => {
      throw new Error("boom");
    };
    const frame = await show(requestFor("Write", { file_path: join(workDir, "t.txt"), content: "x\n" }), { previewer });

    expect(frame).toContain("diff unavailable: the preview failed (boom)");
    expect(frame).toMatch(/y\s+allow once\s+a\s+always allow\s+n\s+deny/);
  });

  test("a key press does not wrap the whole diff again", async () => {
    const content = Array.from({ length: 150 }, (_, index) => `line ${index + 1} ${"word ".repeat(8)}`).join("\n") + "\n";
    await show(requestFor("Write", { file_path: join(workDir, "many.txt"), content }), { height: 40 });
    expect(await frameNow()).toContain("more lines");

    const width = spyOn(Bun, "stringWidth");
    try {
      // Any key re-renders the prompt (the quiet window restarts); the wrapped rows are kept, not rebuilt.
      await press("x");
      expect(await frameNow()).toContain("waiting for typing to stop…");
      // Wrapping the 150 lines alone is over 10000 widths; the rest of a render measures a few titles.
      expect(width.mock.calls.length).toBeLessThan(300);
    } finally {
      width.mockRestore();
    }
    // The cap still counts exactly what it hides.
    expect(await frameNow()).toMatch(/… \d+ more lines/);
  });
});

describe("PermissionPrompt: the preview is asynchronous", () => {
  const never: Previewer = () => new Promise(() => {});

  test("while it loads, the raw input shows under a preparing line", async () => {
    const input = { file_path: join(workDir, "x.ts"), old_string: "a", new_string: "b" };
    const frame = await show(requestFor("Edit", input), { previewer: never });

    expect(frame).toContain("preparing diff…");
    expect(frame).toContain('"old_string": "a"');
  });

  test("the keys work while it loads", async () => {
    await show(requestFor("Edit", { file_path: join(workDir, "x.ts"), old_string: "a", new_string: "b" }), { previewer: never });

    await press("y");

    expect(answers).toEqual(["allow"]);
  });

  test("n answers while it loads, and typing protection still ignores early keys", async () => {
    screen = await testRender(
      <ThemeProvider>
        <KeyboardLayerProvider>
          <PermissionPrompt request={requestFor("Write", { file_path: "a", content: "b" })} cwd={workDir} previewer={never} />
        </KeyboardLayerProvider>
      </ThemeProvider>,
      { width: 110, height: 40 },
    );
    await settle(30);
    await press("y");
    expect(answers).toEqual([]);
    expect(await frameNow()).toContain("waiting for typing to stop…");

    await settle(400);
    await press("n");
    expect(answers).toEqual(["deny"]);
  });

  test("a late preview of an earlier request does not land on a newer prompt", async () => {
    const resolvers = new Map<string, (value: Awaited<ReturnType<Previewer>>) => void>();
    const previewer: Previewer = (_tool, input) =>
      new Promise((resolve) => {
        resolvers.set((input as any).file_path, resolve);
      });
    const diffFor = (path: string, text: string) =>
      ({
        kind: "diff",
        path,
        patch: "",
        added: 1,
        removed: 0,
        newFile: true,
        crlf: false,
        lines: [{ kind: "add", text, newLine: 1 }],
      }) as Awaited<ReturnType<Previewer>>;

    const first = requestFor("Write", { file_path: "/first.txt", content: "FIRST-CONTENT" });
    const second = requestFor("Write", { file_path: "/second.txt", content: "SECOND-CONTENT" });
    let showSecond: () => void = () => {};
    function Host() {
      const [request, setRequest] = useState(first);
      showSecond = () => setRequest(second);
      return <PermissionPrompt request={request} cwd={workDir} previewer={previewer} />;
    }
    screen = await testRender(
      <ThemeProvider>
        <KeyboardLayerProvider>
          <Host />
        </KeyboardLayerProvider>
      </ThemeProvider>,
      { width: 110, height: 40 },
    );
    await settle(50);
    await act(async () => showSecond());
    await settle(50);

    // The first request's preview arrives after the second prompt opened.
    await act(async () => resolvers.get("/first.txt")!(diffFor("/first.txt", "FIRST-DIFF-ROW")));
    await settle(50);
    let frame = await frameNow();
    expect(frame).not.toContain("FIRST-DIFF-ROW");
    expect(frame).toContain("preparing diff…");
    expect(frame).toContain("SECOND-CONTENT");

    await act(async () => resolvers.get("/second.txt")!(diffFor("/second.txt", "SECOND-DIFF-ROW")));
    await settle(50);
    frame = await frameNow();
    expect(frame).toContain("SECOND-DIFF-ROW");
    expect(frame).not.toContain("FIRST-DIFF-ROW");
  });
});
