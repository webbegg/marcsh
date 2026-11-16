import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import type { ClipboardReadResult, ClipboardService as CoreClipboardService } from "@opentui/core";
import type { ChatMessage } from "../lib/chat-types";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: clipboard images land in tmp too.
const home = mkdtempSync(join(tmpdir(), "marcsh-clipboard-home-"));
process.env.MARCSH_PREFERENCES_PATH = join(home, "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(home, "agents");
process.env.MARCSH_COMMANDS_DIR = join(home, "commands");
process.env.MARCSH_HISTORY_PATH = join(home, "history.jsonl");
const attachmentsDir = join(home, "attachments");
process.env.MARCSH_ATTACHMENTS_DIR = attachmentsDir;

let calls: { prompt: unknown; options: any }[] = [];

// The fake SDK of attachments.test.tsx: it records what the turn was sent.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    calls.push({ prompt, options });
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0 };
    })();
    return Object.assign(messages, { interrupt: async () => {}, supportedCommands: async () => [] });
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { clearDrafts } = await import("../lib/prompt-history");
const { clipboardService } = await import("../lib/clipboard");
const { ClipboardProvider } = await import("../providers/clipboard");

// S2–S4: Ctrl+V (and an empty paste) reads the clipboard; an image becomes an attachment, text goes in like pasted text.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let sessionId: string;
let dir: string;
let reads = 0;
/** What the next clipboard read answers; a test can hold it back to answer later. */
let answer: () => Promise<ClipboardReadResult> = async () => ({ status: "empty" });
let copied: string[] = [];

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

// The OpenTUI clipboard under the app's service: the status mapping is the real one.
const core: CoreClipboardService = {
  read: async () => {
    reads++;
    return answer();
  },
  writeText: async (text) => {
    copied.push(text);
    return { host: { status: "written" }, terminal: { status: "not-attempted", capability: "unknown" } };
  },
  clear: async () => ({ host: { status: "cleared" }, terminal: { status: "not-attempted", capability: "unknown" } }),
  dispose: async () => {},
};
const clipboard = clipboardService(core, { capabilitiesKnown: () => true });

const image = (bytes: Uint8Array = PNG) => async (): Promise<ClipboardReadResult> => ({ status: "read", representation: { mimeType: "image/png", bytes } });
const text = (value: string) => async (): Promise<ClipboardReadResult> => ({ status: "read", representation: { mimeType: "text/plain", bytes: new TextEncoder().encode(value) } });

const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

beforeEach(() => {
  calls = [];
  copied = [];
  reads = 0;
  answer = async () => ({ status: "empty" });
  clearDrafts();
  dir = mkdtempSync(join(tmpdir(), "marcsh-clipboard-project-"));
});
afterEach(() => {
  if (screen && !(screen.renderer as any).isDestroyed) act(() => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

async function open(messages: ChatMessage[] = []) {
  sessionId = getStorage().createSession({ title: "t", cwd: dir, engine: "claude" }).id;
  if (messages.length > 0) getStorage().saveMessages(sessionId, messages);
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [`/sessions/${sessionId}`] },
  );
  screen = await testRender(
    <ClipboardProvider value={clipboard}>
      <RouterProvider router={router} />
    </ClipboardProvider>,
    { width: 120, height: 30, kittyKeyboard: true },
  );
  await settle(100);
}
const ctrlV = async () => {
  await act(async () => screen!.mockInput.pressKey("v", { ctrl: true }));
  await settle(80);
};
const paste = async (value: string) => {
  await act(() => screen!.mockInput.pasteBracketedText(value));
  await settle(80);
};
const type = async (value: string) => {
  await act(() => screen!.mockInput.typeText(value));
  await settle(50);
};
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(200);
};
const consume = async (prompt: unknown) => {
  const messages: any[] = [];
  for await (const message of prompt as AsyncIterable<any>) messages.push(message);
  return messages;
};
const mode = (path: string) => statSync(path).mode & 0o777;

describe("Ctrl+V with an image in the clipboard", () => {
  test("saves it as a private PNG under the session, shows a chip, and the next message sends it as an image block", async () => {
    answer = image();
    await open();

    await ctrlV();
    expect(reads).toBe(1);
    expect(frame()).toContain("[image: clipboard-1.png]");
    const saved = join(attachmentsDir, sessionId, "clipboard-1.png");
    expect(existsSync(saved)).toBe(true);
    expect(mode(saved)).toBe(0o600);
    expect(mode(join(attachmentsDir, sessionId))).toBe(0o700);

    await type("what is this?");
    await enter();

    expect(calls).toHaveLength(1);
    const [message] = await consume(calls[0]!.prompt);
    expect(message.message.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
    ]);
    const stored = getStorage().getSession(sessionId)!.messages.find((m) => m.role === "user")!;
    expect(stored.metadata?.attachments).toEqual([{ path: saved, mime: "image/png", kind: "image" }]);
  });

  test("each image gets the next free number", async () => {
    answer = image();
    await open();

    await ctrlV();
    await ctrlV();

    expect(frame()).toContain("[image: clipboard-1.png] [image: clipboard-2.png]");
  });

  test("an image over 20 MB is not saved or attached, and a toast says why", async () => {
    answer = image(new Uint8Array(20 * 1024 * 1024 + 1));
    await open();

    await ctrlV();

    expect(frame()).toContain("larger than 20 MB, so it was not attached.");
    expect(frame()).not.toContain("[image:");
    expect(existsSync(join(attachmentsDir, sessionId))).toBe(false);
  });
});

describe("Ctrl+V with text in the clipboard", () => {
  test("puts the text in the input, where it is sent like typed text", async () => {
    answer = text("hello from the clipboard");
    await open();

    await ctrlV();
    expect(frame()).toContain("hello from the clipboard");

    await enter();
    expect(calls[0]!.prompt).toBe("hello from the clipboard");
  });

  test("a copied path to an image attaches it, like a pasted one", async () => {
    writeFileSync(join(dir, "shot.png"), PNG);
    answer = text(join(dir, "shot.png"));
    await open();

    await ctrlV();

    expect(frame()).toContain("[image: shot.png]");
  });
});

describe("an empty bracketed paste", () => {
  test("reads the clipboard (what some terminals send for an image)", async () => {
    answer = image();
    await open();

    await paste("");

    expect(reads).toBe(1);
    expect(frame()).toContain("[image: clipboard-1.png]");
  });

  test("a paste with text does not read the clipboard", async () => {
    await open();

    await paste("typed by the terminal");

    expect(reads).toBe(0);
    expect(frame()).toContain("typed by the terminal");
  });
});

describe("when the clipboard cannot be read", () => {
  const cases: [ClipboardReadResult, string][] = [
    [{ status: "unsupported" }, "Clipboard not available here"],
    [{ status: "timed-out" }, "Clipboard read timed out"],
    [{ status: "limit-exceeded" }, "Clipboard content is too large"],
    [{ status: "failed", error: new Error("pasteboard is locked") }, "pasteboard is locked"],
  ];
  for (const [result, message] of cases) {
    test(`${result.status}: a toast says "${message}"`, async () => {
      answer = async () => result;
      await open();

      await ctrlV();

      expect(frame()).toContain(message);
    });
  }

  test("an empty clipboard does nothing", async () => {
    await open();

    await ctrlV();

    expect(reads).toBe(1);
    expect(frame()).not.toContain("Clipboard");
  });
});

describe("a read that ends after the input changed", () => {
  test("is dropped: the text typed meanwhile stays, the clipboard's is not added", async () => {
    let release: (result: ClipboardReadResult) => void = () => {};
    answer = () => new Promise((resolve) => (release = resolve));
    await open();

    await ctrlV();
    await type("abc");
    await act(async () => release({ status: "read", representation: { mimeType: "text/plain", bytes: new TextEncoder().encode("late paste") } }));
    await settle(80);

    expect(frame()).toContain("abc");
    expect(frame()).not.toContain("late paste");
  });

  test("pastes run one at a time, in order", async () => {
    const releases: ((result: ClipboardReadResult) => void)[] = [];
    answer = () => new Promise((resolve) => releases.push(resolve));
    await open();

    await ctrlV();
    await ctrlV();
    expect(releases).toHaveLength(1);

    await act(async () => releases[0]!({ status: "read", representation: { mimeType: "text/plain", bytes: new TextEncoder().encode("first ") } }));
    await settle(80);
    expect(releases).toHaveLength(2);
    await act(async () => releases[1]!({ status: "read", representation: { mimeType: "text/plain", bytes: new TextEncoder().encode("second") } }));
    await settle(80);

    expect(frame()).toContain("first second");
  });
});

describe("/copy", () => {
  test("writes the last reply through the app's clipboard", async () => {
    await open([
      { id: "u1", role: "user", parts: [{ type: "text", text: "q" }], metadata: { mode: "BUILD", model: "sonnet" } },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "the answer" }], metadata: { mode: "BUILD", model: "sonnet" } },
    ]);

    await type("/copy");
    await enter();

    expect(copied).toEqual(["the answer"]);
    expect(frame()).toContain("Copied the last reply to the clipboard");
  });
});
