import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh.
const home = mkdtempSync(join(tmpdir(), "marcsh-attachments-home-"));
process.env.MARCSH_PREFERENCES_PATH = join(home, "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(home, "agents");
process.env.MARCSH_COMMANDS_DIR = join(home, "commands");
process.env.MARCSH_HISTORY_PATH = join(home, "history.jsonl");

let calls: { prompt: unknown; options: any }[] = [];

// The fake SDK of session.wiring.test.tsx: it records what the turn was sent.
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

// S6: pasting or dropping a path to an image or file attaches it to the next message.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let dir: string;
let sessionId: string;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-attachments-screen-"));
  writeFileSync(join(dir, "shot.png"), PNG);
  writeFileSync(join(dir, "spec.pdf"), "%PDF-1.4 fake");
  writeFileSync(join(dir, "notes.txt"), "some notes");
  writeFileSync(join(dir, "big.png"), Buffer.alloc(20 * 1024 * 1024 + 1));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  clearDrafts();
});
afterEach(() => {
  if (screen && !(screen.renderer as any).isDestroyed) act(() => screen!.renderer.destroy());
  screen = null;
});

async function open() {
  sessionId = getStorage().createSession({ title: "t", cwd: dir, engine: "claude" }).id;
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [`/sessions/${sessionId}`] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 30, kittyKeyboard: true });
  await settle(100);
}
const paste = async (text: string) => {
  await act(() => screen!.mockInput.pasteBracketedText(text));
  await settle(80);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(50);
};
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(200);
};
const backspace = async () => {
  await act(async () => screen!.mockInput.pressBackspace());
  await settle(50);
};
const count = (text: string, part: string) => text.split(part).length - 1;
const consume = async (prompt: unknown) => {
  const messages: any[] = [];
  for await (const message of prompt as AsyncIterable<any>) messages.push(message);
  return messages;
};

describe("pasting a path attaches the file", () => {
  test("a pasted image shows as a chip, and the next message sends it as an image block after the text", async () => {
    await open();

    await paste(join(dir, "shot.png"));
    expect(frame()).toContain("[image: shot.png]");

    await type("what is this?");
    await enter();

    expect(calls).toHaveLength(1);
    expect(typeof calls[0]!.prompt).not.toBe("string");
    expect(await consume(calls[0]!.prompt)).toEqual([
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
          ],
        },
      },
    ]);
    // The message shows its attachment, the input's chip is gone, and only path/mime/kind are stored.
    expect(count(frame(), "[image: shot.png]")).toBe(1);
    const stored = getStorage().getSession(sessionId)!.messages.find((m) => m.role === "user")!;
    expect(stored.metadata?.attachments).toEqual([{ path: join(dir, "shot.png"), mime: "image/png", kind: "image" }]);
    expect(JSON.stringify(stored)).not.toContain(PNG.toString("base64"));
  });

  test("an attachment alone, without text, can be sent", async () => {
    await open();

    await paste(join(dir, "spec.pdf"));
    await enter();

    expect(calls).toHaveLength(1);
    const [message] = await consume(calls[0]!.prompt);
    expect(message.message.content.map((block: any) => block.type)).toEqual(["document"]);
  });

  test("a quoted dropped path attaches", async () => {
    await open();

    await paste(`'${join(dir, "shot.png")}'`);

    expect(frame()).toContain("[image: shot.png]");
  });

  test("Backspace on an empty input removes the last chip, and not before the text is gone", async () => {
    await open();
    await paste(`${join(dir, "shot.png")} ${join(dir, "spec.pdf")}`);
    expect(frame()).toContain("[image: shot.png] [pdf: spec.pdf]");

    await type("a");
    await backspace();
    expect(frame()).toContain("[pdf: spec.pdf]");

    await backspace();
    expect(frame()).toContain("[image: shot.png]");
    expect(frame()).not.toContain("[pdf: spec.pdf]");

    await backspace();
    expect(frame()).not.toContain("[image: shot.png]");
  });

  test("a file that is not an image or PDF is inserted as an @path mention in the text, not as a chip", async () => {
    await open();

    await paste(join(dir, "notes.txt"));

    expect(frame()).toContain("@notes.txt");
    expect(frame()).not.toContain("[file:");

    await enter();
    expect(calls[0]!.prompt).toBe("@notes.txt");
  });

  test("text that is not a path stays ordinary text", async () => {
    await open();

    await paste("please fix the parser");

    expect(frame()).toContain("please fix the parser");
    expect(frame()).not.toContain("[");
  });

  test("a path that does not exist stays ordinary text", async () => {
    await open();

    await paste(join(dir, "nothing.png"));

    expect(frame()).toContain("nothing.png");
    expect(frame()).not.toContain("[image:");
  });

  test("an image over 20 MB is not attached and a toast gives the reason", async () => {
    await open();

    await paste(join(dir, "big.png"));

    expect(frame()).toContain("big.png is larger than 20 MB, so it was not attached.");
    expect(frame()).not.toContain("[image: big.png]");
  });
});
