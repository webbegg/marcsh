import { describe, expect, test } from "bun:test";
import { fitText } from "./fit-text";

describe("fitText", () => {
  test("text that fits is unchanged", () => {
    expect(fitText("Start a new conversation", 24)).toBe("Start a new conversation");
    expect(fitText("", 5)).toBe("");
  });

  test("text that is too long is cut and ends with …, in exactly the given cells", () => {
    const cut = fitText("Start a new conversation", 10);
    expect(cut).toBe("Start a n…");
    expect(Bun.stringWidth(cut)).toBe(10);
  });

  test("wide characters and emoji count as two cells and are never split", () => {
    expect(fitText("日本語のテキスト", 7)).toBe("日本語…");
    expect(Bun.stringWidth(fitText("日本語のテキスト", 7))).toBeLessThanOrEqual(7);
    expect(fitText("ok 👍🏽 done", 5)).toBe("ok …");
  });

  test("one cell or less leaves only what fits", () => {
    expect(fitText("abc", 1)).toBe("…");
    expect(fitText("abc", 0)).toBe("");
    expect(fitText("a", 1)).toBe("a");
  });
});
