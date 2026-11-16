import { describe, expect, test } from "bun:test";
import {
  createClipboard,
  type ClipboardReadOptions,
  type ClipboardReadResult,
  type ClipboardService as CoreClipboardService,
  type ClipboardWriteOptions,
  type ClipboardWriteResult,
  type HostClipboardService,
  type TerminalClipboardAdapter,
} from "@opentui/core";
import { clipboardService, copyToClipboard, legacyClipboard, osc52 } from "./clipboard";

// The service cases follow opencode's packages/tui/test/clipboard.test.ts (MIT); see THIRD_PARTY_NOTICES.md.

/** An OpenTUI clipboard that answers every read with `read` and every write with `write`, and records what it was asked. */
function coreClipboard(options: {
  read?: ClipboardReadResult;
  write?: ClipboardWriteResult;
  onRead?: (input: ClipboardReadOptions) => void;
  onWrite?: (text: string, input: ClipboardWriteOptions) => void;
}): CoreClipboardService {
  return {
    async read(input) {
      options.onRead?.(input);
      return options.read ?? { status: "empty" };
    },
    async writeText(text, input) {
      options.onWrite?.(text, input);
      return options.write ?? { host: { status: "written" }, terminal: { status: "not-attempted", capability: "unknown" } };
    },
    async clear() {
      return { host: { status: "cleared" }, terminal: { status: "not-attempted", capability: "unknown" } };
    },
    async dispose() {},
  };
}

const readOf = (result: ClipboardReadResult) => clipboardService(coreClipboard({ read: result })).read();

describe("clipboardService: reading", () => {
  test("asks for a PNG first, then text, and gives an image's bytes as they are", async () => {
    const requests: ClipboardReadOptions[] = [];
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const service = clipboardService(coreClipboard({ read: { status: "read", representation: { mimeType: "image/png", bytes } }, onRead: (input) => requests.push(input) }));

    expect(await service.read()).toEqual({ mime: "image/png", bytes });
    expect(requests).toEqual([{ preferredTypes: ["image/png", "text/plain"], selection: "clipboard" }]);
  });

  test("gives text decoded, unchanged", async () => {
    const text = "line 1\r\n\t世界";
    expect(await readOf({ status: "read", representation: { mimeType: "text/plain", bytes: new TextEncoder().encode(text) } })).toEqual({ mime: "text/plain", text });
  });

  test("an empty clipboard, empty text or a cancelled read gives nothing", async () => {
    expect(await readOf({ status: "empty" })).toBeUndefined();
    expect(await readOf({ status: "cancelled" })).toBeUndefined();
    expect(await readOf({ status: "read", representation: { mimeType: "text/plain", bytes: new Uint8Array() } })).toBeUndefined();
  });

  test("each failure is an error with a short reason", async () => {
    await expect(readOf({ status: "unsupported" })).rejects.toThrow("Clipboard not available here");
    await expect(readOf({ status: "timed-out" })).rejects.toThrow("Clipboard read timed out");
    await expect(readOf({ status: "limit-exceeded" })).rejects.toThrow("Clipboard content is too large");
    const failure = new Error("pasteboard is locked");
    expect(await readOf({ status: "failed", error: failure }).then(undefined, (error) => error)).toBe(failure);
    await expect(readOf({ status: "read", representation: { mimeType: "image/tiff", bytes: new Uint8Array([1]) } })).rejects.toThrow("image/tiff");
  });

  test("the fallback service cannot read", async () => {
    await expect(legacyClipboard.read()).rejects.toThrow("Clipboard not available here");
  });
});

describe("clipboardService: writing", () => {
  const host = (writes: { host: number }): HostClipboardService => ({
    maxWriteBytes: 8 * 1024 * 1024,
    async read() {
      return { status: "empty" };
    },
    async writeText() {
      writes.host++;
      return { status: "written" };
    },
    async clear() {
      return { status: "cleared" };
    },
    async dispose() {},
  });
  const remoteTerminal = (writes: { terminal: number }): TerminalClipboardAdapter => ({
    remote: true,
    writeText() {
      writes.terminal++;
      return { status: "attempted", capability: "supported" };
    },
    clear() {
      return { status: "attempted", capability: "supported" };
    },
  });

  test("writes to every route at once; the host clipboard counts as copied", async () => {
    const writes: [string, ClipboardWriteOptions][] = [];
    const service = clipboardService(coreClipboard({ onWrite: (text, input) => writes.push([text, input]) }), { capabilitiesKnown: () => true });

    expect(await service.write("hello")).toEqual({ method: "host" });
    expect(writes).toEqual([["hello", { destination: "all-available", selection: "clipboard", allowRemoteHost: false }]]);
  });

  test("on a remote terminal it skips this machine's clipboard and goes by OSC 52", async () => {
    const writes = { host: 0, terminal: 0 };
    const service = clipboardService(createClipboard({ host: host(writes), terminal: remoteTerminal(writes) }), { capabilitiesKnown: () => true });

    expect(await service.write("hello")).toEqual({ method: "osc52" });
    expect(writes).toEqual({ host: 0, terminal: 1 });
  });

  test("before the terminal is known (it counts as remote) it still tries this machine's clipboard", async () => {
    const writes = { host: 0, terminal: 0 };
    const service = clipboardService(createClipboard({ host: host(writes), terminal: remoteTerminal(writes) }), { capabilitiesKnown: () => false });

    expect(await service.write("hello")).toEqual({ method: "host" });
    expect(writes.host).toBe(1);
  });

  test("removes NUL characters first", async () => {
    const writes: string[] = [];
    const service = clipboardService(coreClipboard({ onWrite: (text) => writes.push(text) }));

    await service.write("before\0after");
    expect(writes).toEqual(["beforeafter"]);
  });

  test("when no route took the text it falls back to pbcopy or OSC 52 the old way", async () => {
    const fellBack: string[] = [];
    const service = clipboardService(
      coreClipboard({ write: { host: { status: "unsupported" }, terminal: { status: "not-attempted", capability: "unsupported" } } }),
      { fallback: async (text) => (fellBack.push(text), { method: "osc52" }) },
    );
    const notTried = clipboardService(
      coreClipboard({ write: { host: { status: "not-attempted" }, terminal: { status: "local-failure", capability: "unknown" } } }),
      { fallback: async (text) => (fellBack.push(text), { method: "pbcopy" }) },
    );

    expect(await service.write("one")).toEqual({ method: "osc52" });
    expect(await notTried.write("two")).toEqual({ method: "pbcopy" });
    expect(fellBack).toEqual(["one", "two"]);
  });
});

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
