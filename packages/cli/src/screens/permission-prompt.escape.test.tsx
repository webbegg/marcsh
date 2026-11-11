import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-prompt-escape-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../providers/theme");
const { KeyboardLayerProvider } = await import("../providers/keyboard-layer");
const { PermissionPrompt } = await import("../components/permission-prompt");
const { LOCKED_LINE, setDraft } = await import("../lib/prompt-lock");
const { useRenderer } = await import("@opentui/react");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let answers: string[] = [];

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  answers = [];
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const GUTTER = "┊";
const BORDER = "│";
const ELLIPSIS = "…";
const RLO = "‮";
const ZWSP = "​";
const ISOLATE = "⁦";
const BOM = "﻿";
const LINE_SEP = " ";
// Anything that would reach the terminal raw: ESC, BEL, C1 CSI, and the invisible characters above.
const RAW_UNSAFE = new RegExp(`[\\u001b\\u0007\\u009b${RLO}${ZWSP}${ISOLATE}${BOM}${LINE_SEP}]`);

/** Renders the prompt and waits out its quiet window, so the real hint row is showing. */
async function show(ask: Record<string, unknown>) {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  const request = { kind: "permission", toolName: "Bash", input: {}, respond: (decision: string) => answers.push(decision), ...ask } as any;
  screen = await testRender(
    <ThemeProvider>
      <KeyboardLayerProvider>
        <PermissionPrompt request={request} />
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
// Rows that look like the prompt's own hint row: they start with the `y` key and offer `allow once`.
const hintRows = (frame: string) => rowsOf(frame).filter((row) => /^y\s.*allow once/.test(row));

const FAKE_HINT = "y allow once  a always allow  n deny";

describe("PermissionPrompt escapes what the engine supplies", () => {
  test("shows ESC, CSI and OSC sequences in a command as visible escapes", async () => {
    const frame = await show({ input: { command: "echo \u001b[31mred\u001b]0;pwned\u0007 \u009b2J" } });
    expect(frame).toContain("echo \\u001b[31mred\\u001b]0;pwned\\u0007 \\u009b2J");
    expect(frame).not.toMatch(RAW_UNSAFE);
  });

  test("shows a carriage return as \\r instead of moving the cursor", async () => {
    const frame = await show({ input: { command: "echo safe\rrm -rf /" } });
    expect(frame).toContain("echo safe\\rrm -rf /");
    expect(frame).not.toContain("\r");
  });

  test("shows bidi and zero-width characters as visible escapes", async () => {
    const frame = await show({ input: { command: `ls ${RLO}txt.exe${ZWSP}${ISOLATE}${BOM}` } });
    expect(frame).toContain("ls \\u202etxt.exe\\u200b\\u2066\\ufeff");
    expect(frame).not.toMatch(RAW_UNSAFE);
  });

  test("escapes the tool name, title, description, reason and blocked path", async () => {
    const frame = await show({
      toolName: "Ba\u001b[2Jsh",
      input: { command: "ls" },
      description: `list${RLO} files`,
      decisionReason: `because${ZWSP}`,
      blockedPath: "/tmp/a\u001b]0;x\u0007",
    });
    expect(frame).toContain("Allow Ba\\u001b[2Jsh?");
    expect(frame).toContain("list\\u202e files");
    expect(frame).toContain("Reason: because\\u200b");
    expect(frame).toContain("Path: /tmp/a\\u001b]0;x\\u0007");
    expect(frame).not.toMatch(RAW_UNSAFE);

    const titled = await show({ title: `Run ${RLO}this\u001b[0m`, input: { command: "ls" } });
    expect(titled).toContain("Run \\u202ethis\\u001b[0m");
    expect(titled).not.toMatch(RAW_UNSAFE);
  });

  test("keeps real lines of a command as separate lines, each behind a dim gutter", async () => {
    const frame = await show({ input: { command: "echo one\necho two\necho three" } });
    const rows = rowsOf(frame);
    expect(rows).toContain(`${GUTTER} echo one`);
    expect(rows).toContain(`${GUTTER} echo two`);
    expect(rows).toContain(`${GUTTER} echo three`);
    expect(frame).not.toContain("\\n");
  });

  test("a fake hint line after a newline in a command cannot look like the hint row", async () => {
    const frame = await show({ input: { command: `ls\n${FAKE_HINT}` } });
    expect(rowsOf(frame)).toContain(`${GUTTER} ${FAKE_HINT}`);
    expect(hintRows(frame)).toHaveLength(1);
    expect(hintRows(frame)[0]).toMatch(/^y\s+allow once\s+a\s+always allow\s+n\s+deny$/);
  });

  test("a fake hint line behind a CRLF stays behind the gutter", async () => {
    const frame = await show({ input: { command: `ls\r\n${FAKE_HINT}` } });
    expect(rowsOf(frame)).toContain(`${GUTTER} ls\\r`);
    expect(rowsOf(frame)).toContain(`${GUTTER} ${FAKE_HINT}`);
    expect(hintRows(frame)).toHaveLength(1);
  });

  test("a newline in the decision reason or blocked path cannot start a fake row", async () => {
    const frame = await show({ input: { command: "ls" }, decisionReason: `needs review\n${FAKE_HINT}`, blockedPath: `/tmp/x\n${FAKE_HINT}` });
    expect(frame).toContain(`Reason: needs review\\n${FAKE_HINT}`);
    expect(frame).toContain(`Path: /tmp/x\\n${FAKE_HINT}`);
    expect(hintRows(frame)).toHaveLength(1);
  });

  test("escapes the JSON detail lines and keeps the cap", async () => {
    const input = { command: "ls", note: `a${RLO}b`, items: Array.from({ length: 40 }, (_, index) => `item ${index}`) };
    const frame = await show({ input });
    expect(frame).toContain('"note": "a\\u202eb"');
    expect(frame).not.toMatch(RAW_UNSAFE);
    expect(frame).toMatch(new RegExp(`${ELLIPSIS} \\d+ more lines`));
    expect(frame).not.toContain("item 39");
  });

  test("escapes control characters inside fields other than the command", async () => {
    const frame = await show({ toolName: "Fetch", input: { url: "https://x.test/\u001b[31m", method: `GET${LINE_SEP}POST` } });
    expect(frame).toContain("https://x.test/\\u001b[31m");
    expect(frame).toContain("GET\\u2028POST");
    expect(frame).not.toMatch(RAW_UNSAFE);
  });

  test("a plain command sits behind the gutter, and the hint row and keys are unchanged", async () => {
    const frame = await show({ input: { command: "echo hi" } });
    expect(rowsOf(frame)).toContain(`${GUTTER} echo hi`);
    expect(hintRows(frame)).toEqual(["y  allow once  a  always allow  n  deny"]);

    await act(async () => screen!.mockInput.pressKey("y" as never));
    await settle();
    expect(answers).toEqual(["allow"]);
  });
});

// The user was composing when it opened, so it is locked; once the quiet window has passed it must still draw one hint row.
function Composing({ children }: { children: React.ReactNode }) {
  setDraft(useRenderer(), true);
  return <>{children}</>;
}

describe("a locked PermissionPrompt", () => {
  const showLocked = async (ask: Record<string, unknown> = {}) => {
    const request = { kind: "permission", toolName: "Bash", input: { command: "ls" }, respond: (decision: string) => answers.push(decision), ...ask } as any;
    screen = await testRender(
      <ThemeProvider>
        <KeyboardLayerProvider>
          <Composing>
            <PermissionPrompt request={request} />
          </Composing>
        </KeyboardLayerProvider>
      </ThemeProvider>,
      { width: 110, height: 30 },
    );
    await settle(400);
    await screen.renderOnce();
    return screen.captureCharFrame();
  };
  const keyRows = (frame: string) => rowsOf(frame).filter((row) => /^y\s.*allow once/.test(row));
  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  test("draws its dim hint row once after the quiet window, each key once", async () => {
    const frame = await showLocked();
    expect(frame).toContain(LOCKED_LINE);
    expect(keyRows(frame)).toEqual(["y allow once  a always allow  n deny"]);
    expect(occurrences(frame, "always allow")).toBe(1);
    expect(occurrences(frame, "n deny")).toBe(1);
  });

  test("the confirm-first variant has no always-allow key and still one row", async () => {
    const frame = await showLocked({ defaultToNo: true });
    expect(keyRows(frame)).toEqual(["y allow once (then Enter)  n deny"]);
    expect(occurrences(frame, "deny")).toBe(1);
  });
});
