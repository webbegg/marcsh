import { describe, expect, test } from "bun:test";
import { escapedLines, escapeTranscriptText, wrapByWidth, wrappedRows } from "./display-text";

const RLO = String.fromCharCode(0x202e);

describe("wrapByWidth", () => {
  test("cuts ASCII at the width", () => {
    expect(wrapByWidth("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });

  test("an empty line and a line that fits are one row", () => {
    expect(wrapByWidth("", 5)).toEqual([""]);
    expect(wrapByWidth("abcde", 5)).toEqual(["abcde"]);
  });

  test("counts CJK characters as two columns", () => {
    expect(wrapByWidth("日本語のテキスト", 6)).toEqual(["日本語", "のテキ", "スト"]);
    for (const row of wrapByWidth("日本語のテキスト", 5)) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(5);
  });

  test("moves a wide character that does not fit to the next row", () => {
    expect(wrapByWidth("abc日", 4)).toEqual(["abc", "日"]);
  });

  test("never splits an emoji or a combined character", () => {
    const family = "👨‍👩‍👧";
    const rows = wrapByWidth(`a${family}b${family}`, 3);
    expect(rows.join("")).toBe(`a${family}b${family}`);
    for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(3);
    expect(rows.filter((row) => row.includes("👨"))).toHaveLength(2);
    expect(wrapByWidth("ééé", 2)).toEqual(["éé", "é"]);
  });

  test("breaks after a space in the second half of the row, keeping every character", () => {
    const rows = wrapByWidth("aaaa bbbb cccc dddd", 12);
    expect(rows).toEqual(["aaaa bbbb ", "cccc dddd"]);
    expect(rows.join("")).toBe("aaaa bbbb cccc dddd");
    // The only space is early in the row: cut by width instead.
    expect(wrapByWidth("a bbbbbbbbbbbbbbb", 8)).toEqual(["a bbbbbb", "bbbbbbbb", "b"]);
    expect(wrapByWidth(" ".repeat(25), 10).join("")).toBe(" ".repeat(25));
  });

  test("a character wider than the width gets its own row", () => {
    expect(wrapByWidth("日本", 1)).toEqual(["日", "本"]);
  });
});

describe("escaping", () => {
  test("escapedLines keeps real newlines as line breaks and shows the rest as escapes", () => {
    expect(escapedLines("a\u001b[2Jb\nc\r\nd")).toEqual(["a\\u001b[2Jb", "c\\r", "d"]);
  });

  test("escapeTranscriptText keeps newlines and tabs, escapes everything else", () => {
    expect(escapeTranscriptText(`a\tb\nc\u001b]52;c;eA==\u0007${RLO}\u009b2J`)).toBe("a\tb\nc\\u001b]52;c;eA==\\u0007\\u202e\\u009b2J");
  });

  test("plain text comes back unchanged", () => {
    const text = "# Title\n\n- item `code` **bold**\n\tindent 日本語 🙂";
    expect(escapeTranscriptText(text)).toBe(text);
  });
});

describe("wrappedRows", () => {
  test("escapes first, then wraps what is drawn", () => {
    expect(wrappedRows("\u001bab\nz", 4)).toEqual(["\\u00", "1bab", "z"]);
  });
});
