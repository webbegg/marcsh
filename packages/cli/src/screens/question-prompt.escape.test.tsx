import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-question-escape-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../providers/theme");
const { KeyboardLayerProvider } = await import("../providers/keyboard-layer");
const { QuestionPrompt } = await import("../components/question-prompt");

// S2 scope (R1-001): what a model puts in an AskUserQuestion call is escaped like the approval prompt's strings, so it cannot
// write terminal sequences or draw rows that pass for the prompt's own.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let answers: Array<Record<string, string> | null> = [];

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  answers = [];
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const GUTTER = "┊";
const BORDER = "│";
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const ISOLATE = String.fromCharCode(0x2066);
const BOM = String.fromCharCode(0xfeff);
// Anything that would reach the terminal raw.
const RAW_UNSAFE = new RegExp(`[${ESC}${BEL}${CSI}${RLO}${ZWSP}${ISOLATE}${BOM}]`);
const FAKE_HINT = "press a number to answer · Esc declines";

type Question = { question: string; header: string; options: { label: string; description: string }[]; multiSelect: boolean };
const question = (overrides: Partial<Question> = {}): Question => ({
  question: "Which color do you prefer?",
  header: "Color",
  options: [
    { label: "Red", description: "A warm color" },
    { label: "Blue", description: "A cool color" },
  ],
  multiSelect: false,
  ...overrides,
});

/** Renders the prompt and waits out its quiet window, so the real hint row is showing. */
async function show(q: Question) {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  const request = { kind: "question", id: "q1", questions: [q], respond: (value: Record<string, string> | null) => answers.push(value) } as any;
  screen = await testRender(
    <ThemeProvider>
      <KeyboardLayerProvider>
        <QuestionPrompt request={request} />
      </KeyboardLayerProvider>
    </ThemeProvider>,
    { width: 110, height: 50 },
  );
  await settle(400);
  await screen.renderOnce();
  return screen.captureCharFrame();
}

// The rows of the frame without the prompt's left border and trailing blanks.
const rowsOf = (frame: string) =>
  frame.split("\n").map((row) => row.replace(new RegExp(`^[${BORDER}\\s]+`), "").trimEnd()).filter((row) => row !== "");
// Rows that look like the prompt's own hint row.
const hintRows = (frame: string) => rowsOf(frame).filter((row) => row.startsWith("press a number to answer"));

describe("QuestionPrompt escapes what the model supplies", () => {
  test("shows ESC, CSI, OSC and bidi characters in the question as visible escapes", async () => {
    const frame = await show(question({ question: `Pick ${ESC}[2J${ESC}]0;pwned${BEL} ${CSI}2J ${RLO}now${ZWSP}${ISOLATE}${BOM}` }));
    expect(frame).toContain("Pick \\u001b[2J\\u001b]0;pwned\\u0007 \\u009b2J \\u202enow\\u200b\\u2066\\ufeff");
    expect(frame).not.toMatch(RAW_UNSAFE);
  });

  test("escapes the header", async () => {
    const frame = await show(question({ header: `Co${ESC}[31mlor${RLO}` }));
    expect(frame).toContain("Co\\u001b[31mlor\\u202e");
    expect(frame).not.toMatch(RAW_UNSAFE);
  });

  test("escapes option labels and descriptions", async () => {
    const frame = await show(
      question({
        options: [
          { label: `Re${ESC}]0;x${BEL}d`, description: `warm${RLO} color${ESC}[2J` },
          { label: "Blue", description: `cool${ZWSP}` },
        ],
      }),
    );
    expect(frame).toContain("1 Re\\u001b]0;x\\u0007d");
    expect(frame).toContain("warm\\u202e color\\u001b[2J");
    expect(frame).toContain("cool\\u200b");
    expect(frame).not.toMatch(RAW_UNSAFE);
  });

  test("escapes the labels of a multi-select question", async () => {
    const frame = await show(question({ multiSelect: true, options: [{ label: `a${ESC}[0m`, description: "d" }, { label: "b", description: "d" }] }));
    expect(frame).toContain("[ ] 1 a\\u001b[0m");
    expect(frame).not.toMatch(RAW_UNSAFE);
  });

  test("a newline in the question starts a row behind the gutter, so it cannot pass for the hint row", async () => {
    const frame = await show(question({ question: `Pick one\n${FAKE_HINT}` }));
    expect(rowsOf(frame)).toContain(`${GUTTER} Pick one`);
    expect(rowsOf(frame)).toContain(`${GUTTER} ${FAKE_HINT}`);
    expect(hintRows(frame)).toHaveLength(1);
  });

  test("a newline in a description or a label cannot start a fake row either", async () => {
    const frame = await show(
      question({
        options: [
          { label: `Red\n${FAKE_HINT}`, description: `warm\n${FAKE_HINT}` },
          { label: "Blue", description: "cool" },
        ],
      }),
    );
    expect(hintRows(frame)).toHaveLength(1);
    expect(frame).toContain(`warm`);
  });

  test("a long question is cut into rows that each start behind the gutter", async () => {
    const frame = await show(question({ question: `${"word ".repeat(40)}${FAKE_HINT}` }));
    expect(hintRows(frame)).toHaveLength(1);
    const text = rowsOf(frame).filter((row) => row.startsWith(GUTTER));
    expect(text.join("").replaceAll(GUTTER, "").replace(/\s+/g, " ")).toContain(FAKE_HINT);
  });

  test("plain text and the keys are unchanged", async () => {
    const frame = await show(question());
    expect(frame).toContain("Question 1/1");
    expect(frame).toContain("Color");
    expect(frame).toContain("Which color do you prefer?");
    expect(frame).toContain("1 Red");
    expect(frame).toContain("A warm color");
    expect(frame).toContain("o Other (type an answer)");
    expect(hintRows(frame)).toEqual(["press a number to answer · Esc declines"]);

    await act(async () => screen!.mockInput.pressKey("2" as never));
    await settle();
    expect(answers).toEqual([{ "Which color do you prefer?": "Blue" }]);
  });
});
