import { describe, expect, test } from "bun:test";
import { capOutput, MAX_OUTPUT_BYTES, MAX_OUTPUT_LINES, MAX_PATCH_BYTES, patchFromHunks, storedOutput } from "./tool-output";

const lines = (count: number, make: (n: number) => string = (n) => `line ${n}`) =>
  Array.from({ length: count }, (_, i) => make(i + 1)).join("\n");

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("capOutput", () => {
  test("leaves short output as it is", () => {
    expect(capOutput("a\nb\nc")).toEqual({ text: "a\nb\nc", truncated: false });
  });

  test("drops the newlines that end the output", () => {
    expect(capOutput("a\nb\n\n")).toEqual({ text: "a\nb", truncated: false });
  });

  test("keeps the last 200 lines and says it cut", () => {
    const capped = capOutput(lines(500));

    expect(capped.truncated).toBe(true);
    const kept = capped.text.split("\n");
    expect(kept).toHaveLength(MAX_OUTPUT_LINES);
    expect(kept[0]).toBe("line 301");
    expect(kept.at(-1)).toBe("line 500");
  });

  test("keeps exactly 200 lines without cutting", () => {
    expect(capOutput(lines(200)).truncated).toBe(false);
  });

  test("keeps the last 16 KB when that is fewer lines, and never half a line", () => {
    const text = lines(150, (n) => `${String(n).padStart(3, "0")} ${"x".repeat(396)}`); // 400 bytes a line, 60 KB
    const capped = capOutput(text);

    expect(capped.truncated).toBe(true);
    expect(bytes(capped.text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    const kept = capped.text.split("\n");
    expect(kept.at(-1)!.startsWith("150 ")).toBe(true);
    for (const line of kept) expect(line).toHaveLength(400);
    // The first kept line is a whole one: the next line up did not fit.
    expect(bytes(capped.text) + 401).toBeGreaterThan(MAX_OUTPUT_BYTES);
  });

  test("a single line longer than the cap keeps its tail without breaking a character", () => {
    const capped = capOutput("é".repeat(20_000)); // 2 bytes each, 40 KB

    expect(capped.truncated).toBe(true);
    expect(bytes(capped.text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(capped.text).not.toContain("�");
    expect(/^é+$/.test(capped.text)).toBe(true);
  });

  test("a tail cut inside a four-byte character drops the whole character", () => {
    const capped = capOutput("😀".repeat(10_000));

    expect(bytes(capped.text)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(capped.text).not.toContain("�");
    expect(/^(?:😀)+$/u.test(capped.text)).toBe(true);
  });

  test("an empty output stays empty", () => {
    expect(capOutput("")).toEqual({ text: "", truncated: false });
  });
});

describe("storedOutput", () => {
  test("gives nothing for output that is empty or only blank", () => {
    expect(storedOutput("")).toEqual({});
    expect(storedOutput("  \n\n")).toEqual({});
  });

  test("redacts secrets before it keeps the output", () => {
    const stored = storedOutput("token sk-abcdefghijklmnop done\nAuthorization: Bearer abc.def-123");

    expect(stored.output).not.toContain("sk-abcdefghijklmnop");
    expect(stored.output).not.toContain("abc.def-123");
    expect(stored.output).toContain("done");
    expect(stored.outputTruncated).toBeUndefined();
  });

  test("redacts a secret that sits in the part of the output that is cut off, and keeps the rest", () => {
    const stored = storedOutput(`${"sk-abcdefghijklmnop"}\n${lines(300)}`);

    expect(stored.outputTruncated).toBe(true);
    expect(stored.output).not.toContain("sk-");
    expect(stored.output!.split("\n")).toHaveLength(MAX_OUTPUT_LINES);
  });

  test("marks a cut output", () => {
    expect(storedOutput(lines(300)).outputTruncated).toBe(true);
  });
});

describe("patchFromHunks", () => {
  test("writes standard unified hunks", () => {
    const patch = patchFromHunks([
      { oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [" keep", "-old", "+new", "+added", " tail"] },
      { oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: ["-a", "+b"] },
    ]);

    expect(patch).toBe(["@@ -3,3 +3,4 @@", " keep", "-old", "+new", "+added", " tail", "@@ -20,1 +21,1 @@", "-a", "+b"].join("\n"));
  });

  test("a new file has an empty old side", () => {
    expect(patchFromHunks([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+a", "+b"] }])).toBe("@@ -0,0 +1,2 @@\n+a\n+b");
  });

  test("gives nothing when there are no hunks or they are malformed", () => {
    expect(patchFromHunks([])).toBeUndefined();
    expect(patchFromHunks(undefined)).toBeUndefined();
    expect(patchFromHunks("nope")).toBeUndefined();
    expect(patchFromHunks([{ oldStart: 1 }])).toBeUndefined();
  });

  test("gives nothing for a patch over the size the message may carry", () => {
    const huge = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+" + "x".repeat(MAX_PATCH_BYTES)] }];

    expect(patchFromHunks(huge)).toBeUndefined();
  });
});
