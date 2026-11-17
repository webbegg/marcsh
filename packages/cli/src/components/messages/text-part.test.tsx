import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-text-part-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../../providers/theme");
const { useSyntaxStyle } = await import("../../hooks/use-syntax-style");
const { TextPart } = await import("./text-part");

// S8: a reply's text is markdown. Highlighting runs in a worker and lands on a later frame: no test waits for it.

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
const frame = () => screen!.captureCharFrame();

function Part({ text, streaming }: { text: string; streaming?: boolean }) {
  const syntaxStyle = useSyntaxStyle();
  return <TextPart part={{ type: "text", text }} syntaxStyle={syntaxStyle} streaming={streaming} />;
}

async function render(text: string, streaming?: boolean, size = { width: 80, height: 20 }) {
  screen = await testRender(
    <ThemeProvider>
      <Part text={text} streaming={streaming} />
    </ThemeProvider>,
    size,
  );
  await settle();
}

describe("a long reply at width 100", () => {
  test("keeps prose, lists, code blocks, a table and a quote readable", async () => {
    const md = "# Release notes\n\nThis reply has **bold**, *italic*, `inline code` and a [link](https://example.com). Here is a long paragraph that should wrap at the width of the terminal so we can see how the wrapping behaves with markdown on.\n\n- first item\n- second item with `code`\n\n```ts\nexport function add(a: number, b: number): number {\n  // sum\n  return a + b;\n}\n```\n\n```python\ndef f():\n    return 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\nesc: \u001b[2J end";
    await render(md, false, { width: 100, height: 45 });
    await settle(300);
    const text = frame();
    expect(text).toContain("Release notes");
    expect(text).toContain("This reply has bold, italic, inline code and a link (https://example.com).");
    expect(text).toContain("- first item");
    expect(text).toContain("export function add(a: number, b: number): number {");
    expect(text).toContain("    return 1");
    expect(text).toContain("quoted");
    expect(text).toContain("esc: \\u001b[2J end");
    expect(text).not.toContain("```");
  });
});

describe("a text part renders markdown", () => {
  test("bold text shows without its markers", async () => {
    await render("a **bold** word and `code`");
    expect(frame()).toContain("a bold word and code");
    expect(frame()).not.toContain("**");
    expect(frame()).not.toContain("`");
  });

  test("a heading shows without its hash", async () => {
    await render("# Big Title\n\nbody");
    expect(frame()).toContain("Big Title");
    expect(frame()).not.toContain("# Big Title");
    expect(frame()).toContain("body");
  });

  test("a list shows its items", async () => {
    await render("- first\n- second");
    expect(frame()).toContain("first");
    expect(frame()).toContain("second");
  });

  test("a fenced ts block shows its code, not the fence", async () => {
    await render("before\n\n```ts\nconst answer = 42;\n```\n\nafter");
    expect(frame()).toContain("const answer = 42;");
    expect(frame()).not.toContain("```");
    expect(frame()).toContain("before");
    expect(frame()).toContain("after");
  });

  test("a fenced block in a language with no grammar shows as plain text, not an error", async () => {
    await render("```brainfuck\n+++[->++<]>.\n```");
    expect(frame()).toContain("+++[->++<]>.");
    expect(frame().toLowerCase()).not.toContain("error");
  });

  test("a fenced block with no language shows its code", async () => {
    await render("```\nplain line\n```");
    expect(frame()).toContain("plain line");
  });

  test("a long line wraps inside the width", async () => {
    await render(`${"word ".repeat(40)}end`, false, { width: 40, height: 20 });
    expect(frame()).toContain("end");
  });
});

describe("a text part keeps escaping what could drive the terminal", () => {
  test("an ESC in the text shows as \\u001b, and no raw control character reaches the frame", async () => {
    await render("hello \u001b[2Jworld \u0007 ‮ done");
    expect(frame()).toContain("hello \\u001b[2Jworld \\u0007 \\u202e done");
    expect(frame()).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮]/);
  });

  test("an escape inside a fenced block shows as \\u001b too", async () => {
    await render("```ts\nconst s = '\u001b[31m';\n```");
    expect(frame()).toContain("\\u001b[31m");
    expect(frame()).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
  });

  test("a carriage return is shown, and CRLF is a line break", async () => {
    await render("one\r\ntwo\rthree");
    expect(frame()).toContain("one");
    expect(frame()).toContain("two\\rthree");
  });

  test("the shown escape is not eaten by markdown (a backslash before a letter is a backslash)", async () => {
    await render("see \u001b]0;title\u0007 and \u0000 end");
    expect(frame()).toContain("\\u001b]0;title\\u0007");
    expect(frame()).toContain("\\u0000 end");
  });
});

describe("a text part while the reply streams", () => {
  test("an unclosed emphasis renders without throwing and shows its text", async () => {
    await render("so **bo", true);
    expect(frame()).toContain("so bo");
  });

  test("an unclosed fence in a language with no grammar shows its code so far at once", async () => {
    await render("intro\n\n```brainfuck\n+++\n>>", true);
    await settle(300);
    expect(frame()).toContain("intro");
    expect(frame()).toContain("+++");
  });

  test("an unclosed ts fence renders without throwing (its colour, and its first paint, wait for the highlight)", async () => {
    await render("intro\n\n```ts\nconst a = 1;\nconst b", true);
    expect(frame()).toContain("intro");
  });

  test("a ts fence that is final shows its code without waiting for the highlight", async () => {
    await render("intro\n\n```ts\nconst a = 1;\nconst b", false);
    expect(frame()).toContain("const a = 1;");
    expect(frame()).toContain("const b");
  });

  test("the same text, final, shows what it says", async () => {
    await render("so **bold** done", false);
    expect(frame()).toContain("so bold done");
  });
});
