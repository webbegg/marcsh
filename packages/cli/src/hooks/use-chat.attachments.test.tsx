import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";

const { testRender } = await import("@opentui/react/test-utils");
const { useChat } = await import("./use-chat");
const { getStorage } = await import("../lib/storage");
import type { Engine, NoticeLevel, TurnRequest } from "../lib/engine/types";

// S6: attachments reach the engine with their bytes (read when the message is sent), the chat keeps only path/mime/kind.

let latest: ReturnType<typeof useChat>;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let dir: string;
let requests: TurnRequest[];
let notices: [string, NoticeLevel][];
const settle = (ms = 20) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const engine: Engine = {
  id: "fake",
  startTurn(request) {
    requests.push(request);
    return { done: Promise.resolve(), interrupt() {} };
  },
  warmUpCommands: async () => {},
};

function Probe({ id }: { id: string }) {
  latest = useChat(getStorage().getSession(id)!, engine, { notify: (message, level) => notices.push([message, level]) });
  return <text>probe</text>;
}

async function open() {
  const id = getStorage().createSession({ title: "t", cwd: dir, engine: "claude" }).id;
  screen = await testRender(<Probe id={id} />, { width: 40, height: 5 });
  await settle();
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-chat-attachments-"));
  requests = [];
  notices = [];
});
afterEach(() => {
  screen?.renderer.destroy();
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

// Runs the turn outside act, so the hook's updates are seen as they happen.
async function send(attachments?: { path: string; mime: string; kind: "image" | "pdf" | "file" }[], userText = "what is this?") {
  let finished = false;
  const done = latest.submit({ userText, mode: "BUILD", model: "opus", attachments }).then(() => {
    finished = true;
  });
  for (let i = 0; i < 100 && !finished; i++) await settle(10);
  await done;
  await settle();
}

describe("useChat with attachments (S6)", () => {
  test("the engine gets the image's bytes as read when the message is sent; the chat and storage keep only path, MIME type and kind", async () => {
    const path = join(dir, "shot.png");
    const id = await open();
    writeFileSync(path, "first");
    const attached = { path, mime: "image/png", kind: "image" as const };
    // Changed after it was attached: what is sent is what the file holds at send time.
    writeFileSync(path, "second");

    await send([attached]);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toBe("what is this?");
    expect(requests[0]!.attachments).toEqual([{ ...attached, bytes: new Uint8Array(Buffer.from("second")) }]);
    const user = latest.getMessages().find((m) => m.role === "user")!;
    expect(user.metadata?.attachments).toEqual([attached]);
    expect(JSON.stringify(getStorage().getSession(id)!.messages)).not.toContain("bytes");
    expect(getStorage().getSession(id)!.messages.find((m) => m.role === "user")?.metadata?.attachments).toEqual([attached]);
  });

  test("a file that is gone by send time is mentioned as @path instead, with the reason", async () => {
    await open();
    const gone = { path: join(dir, "gone.png"), mime: "image/png", kind: "image" as const };

    await send([gone]);

    expect(requests[0]!.prompt).toBe("what is this?\n@gone.png");
    expect(requests[0]!.attachments).toEqual([]);
    expect(notices).toEqual([["Could not read gone.png: ENOENT. It goes as an @path reference.", "warning"]]);
    // It is still shown on the message the user sent.
    expect(latest.getMessages().find((m) => m.role === "user")?.metadata?.attachments).toEqual([gone]);
  });

  test("a message without attachments is sent as before", async () => {
    await open();

    await send(undefined, "hello");

    expect(requests[0]!.attachments).toBeUndefined();
    expect(latest.getMessages().find((m) => m.role === "user")?.metadata?.attachments).toBeUndefined();
  });

  test("an attachment without text still sends", async () => {
    const path = join(dir, "shot.png");
    writeFileSync(path, "png");
    await open();

    await send([{ path, mime: "image/png", kind: "image" }], "");

    expect(requests[0]!.prompt).toBe("");
    expect(requests[0]!.attachments).toHaveLength(1);
  });
});
