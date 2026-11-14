import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogDir, openLog, OutputBuffer, outputLines, outputTail, sanitizeText, sweepStaleLogDirs } from "./output";

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

  // R4-1: a normal quit calls process.exit before any dispose runs; the logs must not stay behind.
  test("is removed when the process exits", () => {
    const script = `const { createLogDir } = await import(${JSON.stringify(join(import.meta.dir, "output.ts"))});
      const dir = createLogDir(${JSON.stringify(base)});
      require("node:fs").writeFileSync(dir.file("bt-1.stdout.log"), "out");
      console.log(dir.path);
      process.exit(0);`;
    const result = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    const path = result.stdout.toString().trim();
    expect(path.startsWith(join(base, "marcsh-bg-"))).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("records its owner and registers one exit handler, which dispose takes back", () => {
    const before = process.listenerCount("exit");
    const dir = createLogDir(base);
    dir.file("bt-1.stdout.log");
    dir.file("bt-1.stderr.log");
    expect(readFileSync(join(dir.path!, "owner.pid"), "utf8")).toBe(String(process.pid));
    expect(process.listenerCount("exit")).toBe(before + 1);
    dir.dispose();
    expect(process.listenerCount("exit")).toBe(before);
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

describe("stale log directories (R4-1)", () => {
  const make = (name: string, pid?: number) => {
    const path = join(base, name);
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "bt-1.stdout.log"), "old");
    if (pid !== undefined) writeFileSync(join(path, "owner.pid"), String(pid));
    return path;
  };

  test("removes the ones whose owner is gone, and keeps those of a live process, of this one and without an owner", () => {
    const deadPid = Bun.spawnSync(["true"]).pid;
    const live = Bun.spawn(["sleep", "30"]);
    try {
      const dead = make("marcsh-bg-dead", deadPid);
      const alive = make("marcsh-bg-alive", live.pid);
      const mine = make("marcsh-bg-mine", process.pid);
      const unowned = make("marcsh-bg-unowned");
      const other = make("other-dead", deadPid);
      sweepStaleLogDirs(base);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(alive)).toBe(true);
      expect(existsSync(mine)).toBe(true);
      expect(existsSync(unowned)).toBe(true);
      expect(existsSync(other)).toBe(true);
    } finally {
      live.kill();
    }
  });

  test("never fails on a base that does not exist", () => {
    expect(() => sweepStaleLogDirs(join(base, "missing"))).not.toThrow();
  });
});

describe("rendering output", () => {
  test("strips ANSI codes and control characters", () => {
    expect(sanitizeText("\u001b[1;31mred\u001b[0m \u001b]0;title\u0007ok\u0001")).toBe("red ok");
  });

  // R4-5: the /ps view only draws the end, so only the end is sanitized.
  test("the tail of the raw text: the last lines, at most so many characters, and whether it was cut", () => {
    expect(outputTail("a\nb\nc\n", 2, 100)).toEqual({ text: "b\nc\n", cut: true });
    expect(outputTail("a\nb\nc", 2, 100)).toEqual({ text: "b\nc", cut: true });
    expect(outputTail("a\nb\n", 2, 100)).toEqual({ text: "a\nb\n", cut: false });
    expect(outputTail("", 2, 100)).toEqual({ text: "", cut: false });
    expect(outputTail("0123456789", 5, 4)).toEqual({ text: "6789", cut: true });
    const big = "x".repeat(1000) + "\n" + "line\n".repeat(5000);
    const tail = outputTail(big, 3000, 1_000_000);
    expect(tail.cut).toBe(true);
    expect(outputLines(tail.text)).toHaveLength(3000);
  });

  test("keeps the last state of a carriage-return progress line and drops the trailing empty line", () => {
    expect(outputLines("one\n10%\r50%\r100%\n\u001b[32mtwo\u001b[0m\n")).toEqual(["one", "100%", "two"]);
  });
});
