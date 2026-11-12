import { describe, expect, test } from "bun:test";
import { hidesText, printable } from "./safe-text";

// Characters that change how a line reads without showing: a command or a file name of a pack that has one is not what the user read.
const HIDDEN: [string, string][] = [
  ["a line separator (U+2028)", "ls\u2028rm -rf ~"],
  ["a paragraph separator (U+2029)", "ls\u2029rm -rf ~"],
  ["a no-break space", "ls\u00a0-la"],
  ["an ideographic space", "ls\u3000-la"],
  ["an en space", "ls\u2002-la"],
  ["a thin space", "ls\u2009-la"],
  ["a Hangul choseong filler (U+115F)", "ls\u115f"],
  ["a Hangul jungseong filler (U+1160)", "ls\u1160"],
  ["a Hangul filler (U+3164)", "ls\u3164"],
  ["a halfwidth Hangul filler (U+FFA0)", "ls\uffa0"],
  ["a braille blank (U+2800)", "ls\u2800"],
  ["a lone high surrogate", "ls\ud800"],
  ["a lone low surrogate", "ls\udc00x"],
  ["a zero-width space", "ls\u200b"],
  ["an escape sequence", "ls \u001b[2K"],
  ["a line break", "ls\u000arm"],
];

describe("hidesText", () => {
  test.each(HIDDEN)("%s", (_name, text) => {
    expect(hidesText(text)).toBe(true);
  });

  test("plain text, accents, CJK, emoji and ASCII spaces are fine", () => {
    for (const text of ["sh ${CLAUDE_PLUGIN_ROOT}/hooks/check.sh --flag 'a b'", "echo héllo", "echo 日本語", "echo \u{1f389}"]) {
      expect(hidesText(text), text).toBe(false);
    }
  });
});

describe("printable", () => {
  test("also removes the blank-looking letters, the line and paragraph separators and lone surrogates from what is shown", () => {
    expect(printable("a\u115f\u1160\u3164\uffa0\u2800b")).toBe("ab");
    expect(printable("a\u2028b\u2029c")).toBe("abc");
    expect(printable("a\ud800b")).toBe("ab");
    expect(printable("ok \u{1f389}")).toBe("ok \u{1f389}");
  });
});
