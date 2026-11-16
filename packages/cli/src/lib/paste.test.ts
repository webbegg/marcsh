import { describe, expect, test } from "bun:test";
import { collapsedLabel, expandPastedRanges, normalizePastedText } from "./paste";

describe("normalizePastedText", () => {
  test("drops escape sequences and makes every line end a \\n", () => {
    expect(normalizePastedText("red\u001b[31m text\u001b[0m")).toBe("red text");
    expect(normalizePastedText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

describe("collapsedLabel", () => {
  test("3 lines or more, or over 150 characters, collapse into a placeholder", () => {
    expect(collapsedLabel("a\nb\nc")).toBe("[Pasted ~3 lines]");
    expect(collapsedLabel("x".repeat(151))).toBe("[Pasted ~1 lines]");
  });
  test("a short paste stays as it is", () => {
    expect(collapsedLabel("a\nb")).toBeNull();
    expect(collapsedLabel("x".repeat(150))).toBeNull();
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
