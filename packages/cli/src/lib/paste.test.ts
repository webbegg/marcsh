import { describe, expect, test } from "bun:test";
import type { TextareaRenderable } from "@opentui/core";
import { collapsedLabel, expandPastedRanges, fullText, normalizePastedText } from "./paste";

describe("normalizePastedText", () => {
  test("drops escape sequences and makes every line end a \\n", () => {
    expect(normalizePastedText("red\u001b[31m text\u001b[0m")).toBe("red text");
    expect(normalizePastedText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
  test("drops the other control characters (C0, DEL and C1) but keeps tabs and line ends", () => {
    expect(normalizePastedText("a\u0007b\bc\u0000d\u000be\u000cf\u001fg\u007fh\u0085i\u0099j")).toBe("abcdefghij");
    expect(normalizePastedText("col1\tcol2\nnext")).toBe("col1\tcol2\nnext");
  });
});

describe("collapsedLabel", () => {
  test("3 lines or more, or over 150 characters, collapse into a placeholder that starts with the first line", () => {
    expect(collapsedLabel("a\nb\nc")).toBe("[Pasted ~3 lines: a]");
    expect(collapsedLabel("x".repeat(151))).toBe(`[Pasted ~1 lines: ${"x".repeat(30)}…]`);
  });
  test("a short paste stays as it is", () => {
    expect(collapsedLabel("a\nb")).toBeNull();
    expect(collapsedLabel("x".repeat(150))).toBeNull();
  });
  test("the preview is the first line with text, its spaces collapsed, cut at 30 characters", () => {
    expect(collapsedLabel("\n   \n  const   value = 1;\nb\nc")).toBe("[Pasted ~5 lines: const value = 1;]");
    expect(collapsedLabel("The quick brown fox jumps over the lazy dog\nb\nc")).toBe("[Pasted ~3 lines: The quick brown fox jumps over…]");
  });
  test("the preview has no brackets or invisible characters that could fake or break the label", () => {
    expect(collapsedLabel("] [Pasted ~1 lines: ok]‮​\tdone\nb\nc")).toBe("[Pasted ~3 lines: Pasted ~1 lines: ok done]");
  });
  test("cuts between characters, not inside one", () => {
    expect(collapsedLabel(`${"👍🏽".repeat(40)}\nb\nc`)).toBe(`[Pasted ~3 lines: ${"👍🏽".repeat(30)}…]`);
  });
  test("a paste with no visible first line has no preview", () => {
    expect(collapsedLabel("[]\n[]\n[]")).toBe("[Pasted ~3 lines]");
  });
});

describe("expandPastedRanges", () => {
  test("puts the full text in place of each range, whatever their order", () => {
    const text = "see [A] and [B]!";
    expect(
      expandPastedRanges(text, [
        { start: 4, end: 7, text: "alpha\nlines" },
        { start: 12, end: 15, text: "beta" },
      ]),
    ).toBe("see alpha\nlines and beta!");
    expect(expandPastedRanges(text, [{ start: 12, end: 15, text: "beta" }, { start: 4, end: 7, text: "alpha" }])).toBe("see alpha and beta!");
  });
  test("no ranges leaves the text alone", () => {
    expect(expandPastedRanges("plain", [])).toBe("plain");
  });
});

describe("fullText", () => {
  // A textarea holding one placeholder whose offsets cannot be turned into string indices.
  const broken = () => {
    const label = "[Pasted ~3 lines: a]";
    const mark = { id: 1, start: 0, end: label.length, data: { pasted: "a\nb\nc", label } };
    return {
      plainText: label,
      getTextRange: () => label,
      extmarks: { getTypeId: () => 7, getAllForTypeId: () => [mark], delete: () => {} },
      editBuffer: {
        cellOffsetToStringIndex: () => {
          throw new Error("no index");
        },
      },
    } as unknown as TextareaRenderable;
  };
  test("falls back to the text as shown for a draft or the history", () => {
    expect(fullText(broken())).toBe("[Pasted ~3 lines: a]");
  });
  test("strict (what is sent) throws instead of sending the label", () => {
    expect(() => fullText(broken(), { strict: true })).toThrow("no index");
  });
});
