import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

// S2 scope (verifier): transcript escaping covers control and escape sequences only; ordinary text (emoji ZWJ sequences,
// ZWNJ/ZWJ in Persian or Hindi, soft hyphens, CRLF line ends) and the user's own messages render as before.
process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-transcript-ordinary-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");
const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../providers/theme");
const { UserMessage } = await import("../components/messages");
const { escapeTranscriptText } = await import("../lib/display-text");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const ORDINARY = ["👩‍💻 dev", "🏳️‍🌈 flag", "می‌خواهم", "क्‍ष", "soft­hyphen", "Plain **bold** and `code`\n\n- item\n\ttabbed 漢字 🔥 é"];

describe("ordinary text in the transcript", () => {
  for (const text of ORDINARY) test(`unchanged: ${JSON.stringify(text)}`, () => expect(escapeTranscriptText(text)).toBe(text));

  test("CRLF line ends are line breaks, not a visible \\r", () => expect(escapeTranscriptText("one\r\ntwo")).not.toContain("\\r"));

  test("escape sequences are still shown as escapes", () => {
    const shown = escapeTranscriptText("a\u001b]52;c;SGk=\u0007b\u009b2Jc‮d\re");
    for (const raw of ["\u001b", "\u0007", "\u009b", "‮"]) expect(shown).not.toContain(raw);
  });

  test("the user's own message keeps an emoji ZWJ sequence and ZWNJ", async () => {
    screen = await testRender(<ThemeProvider><UserMessage {...({ message: "hi 👩‍💻 می‌خواهم", mode: "BUILD" } as any)} /></ThemeProvider>, { width: 80, height: 8 });
    await act(() => new Promise<void>((r) => setTimeout(r, 60)));
    await screen.renderOnce();
    const frame = screen.captureCharFrame();
    expect(frame).not.toContain("\\u200d");
    expect(frame).not.toContain("\\u200c");
  });
});
