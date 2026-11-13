import { describe, expect, test } from "bun:test";
import { copyToClipboard, osc52 } from "./clipboard";

type Spawned = { command: string[]; input: string };

/** A fake `spawn` that records the command and what was piped to it, then exits with `code`. */
function fakeSpawn(spawned: Spawned[], code = 0) {
  return async (command: string[], input: string) => {
    spawned.push({ command, input });
    return code;
  };
}

describe("osc52", () => {
  test("encodes the text as a clipboard write", () => {
    expect(osc52("héllo")).toBe(`\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`);
  });
});

describe("copyToClipboard", () => {
  test("pipes the text to pbcopy on macOS and writes no escape sequence", async () => {
    const spawned: Spawned[] = [];
    const written: string[] = [];

    const result = await copyToClipboard("hello", { platform: "darwin", spawn: fakeSpawn(spawned), write: (s) => written.push(s) });

    expect(result).toEqual({ method: "pbcopy" });
    expect(spawned).toEqual([{ command: ["pbcopy"], input: "hello" }]);
    expect(written).toEqual([]);
  });

  test("falls back to OSC 52 when pbcopy exits non-zero", async () => {
    const written: string[] = [];

    const result = await copyToClipboard("hello", { platform: "darwin", spawn: fakeSpawn([], 1), write: (s) => written.push(s) });

    expect(result).toEqual({ method: "osc52" });
    expect(written).toEqual([osc52("hello")]);
  });

  test("falls back to OSC 52 when pbcopy cannot be started", async () => {
    const written: string[] = [];

    const result = await copyToClipboard("hello", {
      platform: "darwin",
      spawn: async () => {
        throw new Error("spawn pbcopy ENOENT");
      },
      write: (s) => written.push(s),
    });

    expect(result).toEqual({ method: "osc52" });
    expect(written).toEqual([osc52("hello")]);
  });

  test("uses OSC 52 without spawning anything on other platforms", async () => {
    const spawned: Spawned[] = [];
    const written: string[] = [];

    const result = await copyToClipboard("hello", { platform: "linux", spawn: fakeSpawn(spawned), write: (s) => written.push(s) });

    expect(result).toEqual({ method: "osc52" });
    expect(spawned).toEqual([]);
    expect(written).toEqual([osc52("hello")]);
  });
});
