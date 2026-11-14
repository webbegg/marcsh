import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogDir, openLog, OutputBuffer, outputLines, sanitizeText } from "./output";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "marcsh-bg-output-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("OutputBuffer (S1)", () => {
  test("keeps the newest output: whole old chunks are evicted once the cap is passed, and counted", () => {
    const buffer = new OutputBuffer(10);
    buffer.push("aaaa");
    buffer.push("bbbb");
    buffer.push("cccc");
    const view = buffer.view();
    expect(view.text).toBe("bbbbcccc");
    expect(view.totalBytes).toBe(12);
    expect(view.truncatedBytes).toBe(4);
  });

  test("a single chunk larger than the cap keeps only its tail", () => {
    const buffer = new OutputBuffer(4);
    buffer.push("12");
    buffer.push("abcdefgh");
    expect(buffer.view()).toMatchObject({ text: "efgh", totalBytes: 10, truncatedBytes: 6 });
  });

  test("the text is kept as it came: ANSI codes are not stripped at capture", () => {
    const buffer = new OutputBuffer(1024);
    buffer.push("\u001b[31mred\u001b[0m\n");
    expect(buffer.view().text).toBe("\u001b[31mred\u001b[0m\n");
  });

  test("every chunk goes to the log, before any eviction", async () => {
    const dir = createLogDir(base);
    const path = dir.file("bt-1.stdout.log")!;
    const log = openLog(path)!;
    const buffer = new OutputBuffer(4, log);
    buffer.push("hello ");
    buffer.push("world");
    await log.end();
    expect(buffer.view().text).toBe("orld");
    expect(buffer.view().logPath).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("hello world");
  });
});

describe("the full log (S1)", () => {
  test("lives in a private directory that dispose removes", () => {
    const dir = createLogDir(base);
    expect(dir.path).toBeUndefined();
    const path = dir.file("bt-1.stdout.log")!;
    expect(dir.path).toBeDefined();
    expect(statSync(dir.path!).mode & 0o777).toBe(0o700);
    expect(path.startsWith(dir.path!)).toBe(true);
    dir.dispose();
    expect(existsSync(dir.path!)).toBe(false);
    expect(dir.file("bt-2.stdout.log")).toBeUndefined();
  });

  test("stops at its cap and says so", async () => {
    const dir = createLogDir(base);
    const path = dir.file("bt-1.stdout.log")!;
    const log = openLog(path, { maxBytes: 8 })!;
    log.write("12345");
    log.write("67890");
    log.write("abc");
    await log.end();
    expect(readFileSync(path, "utf8")).toBe("12345");
    expect(log.note).toMatch(/limit/);
  });
});

describe("rendering output", () => {
  test("strips ANSI codes and control characters", () => {
    expect(sanitizeText("\u001b[1;31mred\u001b[0m \u001b]0;title\u0007ok\u0001")).toBe("red ok");
  });

  test("keeps the last state of a carriage-return progress line and drops the trailing empty line", () => {
    expect(outputLines("one\n10%\r50%\r100%\n\u001b[32mtwo\u001b[0m\n")).toEqual(["one", "100%", "two"]);
  });
});
