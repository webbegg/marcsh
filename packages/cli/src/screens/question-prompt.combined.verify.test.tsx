import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-question-combined-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../providers/theme");
const { KeyboardLayerProvider } = await import("../providers/keyboard-layer");
const { QuestionPrompt } = await import("../components/question-prompt");

// Verifier probe for R1-001: one AskUserQuestion call carrying ESC, OSC 52, CSI, C1, U+202E and newline-fake-hint payloads in
// every field (header, question, label, description), at several widths.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let answers: Array<Record<string, string> | null> = [];
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  answers = [];
});
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const E = "\u001b";
const HINT = "press a number to answer · Esc declines";
const OTHER = "o Other (type an answer)";
const question = {
  header: `HDR${E}]52;c;UFdORUQ=\u0007${E}[2J‮evil\n${HINT}`,
  question: `Q1 pick one?${E}[31mRED\u009b2J\n${HINT}`,
  multiSelect: false,
  options: [
    { label: `Alpha${E}]0;TITLE\u0007‮label\n${OTHER}`, description: `desc A${E}[5A\u009b1;1H\n${HINT}` },
    { label: "Beta", description: `desc B\u0085C1NEL${E}P1$qm${E}\\\n${OTHER}` },
  ],
};
const RAW = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩​﻿]/;
const rowsOf = (frame: string) => frame.split("\n").map((row) => row.replace(/^[│\s]+/, "").trimEnd()).filter((row) => row !== "");

async function show(width: number) {
  const request = { kind: "question", id: "q1", questions: [question], respond: (value: Record<string, string> | null) => answers.push(value) } as any;
  screen = await testRender(
    <ThemeProvider>
      <KeyboardLayerProvider>
        <QuestionPrompt request={request} />
      </KeyboardLayerProvider>
    </ThemeProvider>,
    { width, height: 60 },
  );
  await settle(400);
  await screen.renderOnce();
  return screen.captureCharFrame();
}

describe("AskUserQuestion with hostile text in every field", () => {
  for (const width of [120, 80, 50]) {
    test(`${width} columns: nothing raw is drawn, only the prompt's own hint rows stand alone, and the keys still answer`, async () => {
      const frame = await show(width);
      expect(frame).not.toMatch(RAW);
      expect(frame).toContain("\\u001b]52;c;UFdORUQ=");
      const rows = rowsOf(frame);
      // The real rows only: model text is behind the gutter (or after the prompt's own "1 " label).
      expect(rows.filter((row) => row === OTHER)).toHaveLength(1);
      expect(rows.filter((row) => row === HINT || HINT.startsWith(row) && row.startsWith("press a number"))).toHaveLength(1);
      await act(async () => screen!.mockInput.pressKey("2" as never));
      await settle();
      expect(answers).toEqual([{ [question.question]: "Beta" }]);
    });
  }
});
