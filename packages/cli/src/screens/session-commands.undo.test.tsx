import { afterAll, afterEach, beforeAll, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

// Every turn runs real git (a snapshot before and after); on a loaded machine that takes longer than Bun's 5 s. A test that times out
// inside act() leaves the act pending and fails every later screen test in the process ("overlapping act() calls").
setDefaultTimeout(60_000);

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: not the preferences, and above all not the shadow repos, which hold copies of project files. The variables
// are put back when the file is done: they belong to the whole test process, and a snapshot folder left set would make every later
// file snapshot its turns.
const home = mkdtempSync(join(tmpdir(), "marcsh-session-undo-"));
const ENV = { MARCSH_PREFERENCES_PATH: join(home, "preferences.json"), MARCSH_SNAPSHOTS_DIR: join(home, "snapshots"), MARCSH_SNAPSHOTS: "on", MARCSH_COMMANDS_DIR: join(home, "commands") };
const savedEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
Object.assign(process.env, ENV);

// What the turn "does to the project": the fake query() runs it between init and result, in the session's folder.
let doInProject: (cwd: string, prompt: string) => void = () => {};
let prompts: string[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    prompts.push(prompt);
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      doInProject(options.cwd, prompt);
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0.25 };
    })();
    return Object.assign(messages, { interrupt: async () => {}, supportedCommands: async () => [] });
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
import type { ChatMessage } from "../lib/chat-types";

beforeAll(() => engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} }));
afterAll(() => {
  engines.set("pi", undefined);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let sessionId = "";
let project = "";
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};
const arrow = async (direction: "up" | "down") => {
  await act(async () => screen!.mockInput.pressArrow(direction));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const until = async (done: () => boolean, ms = 10_000) => {
  for (let waited = 0; !done() && waited < ms; waited += 50) await settle(50);
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const stored = (): ChatMessage[] => getStorage().getSession(sessionId)!.messages;
const replies = () => stored().filter((message) => message.role === "assistant");
const file = (name: string) => join(project, name);

async function open(messages: ChatMessage[] = []) {
  prompts = [];
  project = mkdtempSync(join(home, "project-"));
  const session = getStorage().createSession({ title: "undo", cwd: project, engine: "claude" });
  sessionId = session.id;
  if (messages.length > 0) getStorage().saveMessages(session.id, messages);
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <text>HOME</text> }, { path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [`/sessions/${session.id}`] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 34 });
  await settle(80);
}

/** Sends a prompt and waits until the turn has ended and been saved with its snapshot. */
async function turn(text: string, change: (cwd: string) => void) {
  const before = replies().length;
  doInProject = (cwd) => change(cwd);
  await type(text);
  await press("RETURN");
  await until(() => replies().length > before && replies().at(-1)?.metadata?.snapshot !== undefined);
  await settle(80);
}

const command = async (text: string) => {
  await type(text);
  await press("RETURN");
};
/** A command that asks a question first, answered with its second row. */
const confirmSecond = async () => {
  await arrow("down");
  await press("RETURN");
};
const lastSnapshot = () => replies().at(-1)?.metadata?.snapshot;

afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  doInProject = () => {};
});

describe("each turn is snapshotted (S4)", () => {
  test("the snapshot is stored on the turn's reply, and the real home's snapshots are never used", async () => {
    await open();
    await turn("make a file", (cwd) => writeFileSync(join(cwd, "a.txt"), "hello"));
    const snapshot = lastSnapshot();
    expect(snapshot?.before).toMatch(/^[0-9a-f]{40,64}$/);
    expect(snapshot?.after).toMatch(/^[0-9a-f]{40,64}$/);
    expect(snapshot?.before).not.toBe(snapshot?.after);
    expect(existsSync(join(home, "snapshots"))).toBe(true);
  });

  test("the cost of each reply is its own: the engine's running total is not summed again", async () => {
    await open();
    await turn("one", () => {});
    await turn("two", () => {});
    const costs = replies().map((reply) => reply.metadata?.usage?.costUsd);
    // The fake SDK reports 0.25 for the first turn and the same running total for the second: nothing new was spent.
    expect(costs[0]).toBe(0.25);
    expect(costs[1]).toBe(0);
    expect(replies().at(-1)?.metadata?.usage?.cumulativeCostUsd).toBe(0.25);
  });
});

describe("/undo and /redo (S4, A3)", () => {
  test("undo puts the turn's files back and adds a notice naming them; redo re-applies; the conversation stays", async () => {
    await open();
    writeFileSync(file("keep.txt"), "kept");
    writeFileSync(file("edit.txt"), "v1");
    await turn("change things", (cwd) => {
      writeFileSync(join(cwd, "edit.txt"), "v2");
      writeFileSync(join(cwd, "new.txt"), "new");
    });
    const messagesBefore = stored().length;

    await command("/undo");
    await until(() => replies().at(-1)?.metadata?.snapshot?.undone === true);
    expect(readFileSync(file("edit.txt"), "utf8")).toBe("v1");
    expect(existsSync(file("new.txt"))).toBe(false);
    expect(readFileSync(file("keep.txt"), "utf8")).toBe("kept");
    expect(frame()).toContain("Undid the last turn's file changes: restored edit.txt; deleted new.txt");
    expect(frame()).toContain("The conversation is unchanged");
    expect(stored()).toHaveLength(messagesBefore);

    await command("/redo");
    await until(() => replies().at(-1)?.metadata?.snapshot?.undone === undefined);
    expect(readFileSync(file("edit.txt"), "utf8")).toBe("v2");
    expect(readFileSync(file("new.txt"), "utf8")).toBe("new");
    expect(frame()).toContain("Redid the file changes");
  });

  test("a file the user changed after the turn is listed first, and kept when they say so", async () => {
    await open();
    await turn("edit", (cwd) => writeFileSync(join(cwd, "mine.txt"), "from the turn"));
    writeFileSync(file("mine.txt"), "edited by hand");

    await command("/undo");
    await until(() => frame().includes("Overwrite changed files?"));
    expect(frame()).toContain("mine.txt");
    // The first row keeps the user's changes.
    await press("RETURN");
    await settle(100);
    expect(readFileSync(file("mine.txt"), "utf8")).toBe("edited by hand");
    expect(lastSnapshot()?.undone).toBeUndefined();
  });

  test("a file the user changed after the turn is overwritten when they confirm", async () => {
    await open();
    await turn("edit", (cwd) => writeFileSync(join(cwd, "mine.txt"), "from the turn"));
    writeFileSync(file("mine.txt"), "edited by hand");

    await command("/undo");
    await until(() => frame().includes("Overwrite changed files?"));
    await confirmSecond();
    await until(() => lastSnapshot()?.undone === true);
    expect(existsSync(file("mine.txt"))).toBe(false);
  });

  test("undo goes back one turn at a time, newest first, and says when nothing is left", async () => {
    await open();
    await turn("one", (cwd) => writeFileSync(join(cwd, "one.txt"), "1"));
    await turn("two", (cwd) => writeFileSync(join(cwd, "two.txt"), "2"));

    await command("/undo");
    await until(() => replies().at(-1)?.metadata?.snapshot?.undone === true);
    expect(existsSync(file("two.txt"))).toBe(false);
    expect(existsSync(file("one.txt"))).toBe(true);

    await command("/undo");
    await until(() => replies().at(0)?.metadata?.snapshot?.undone === true);
    expect(existsSync(file("one.txt"))).toBe(false);

    await command("/undo");
    await settle(200);
    expect(frame()).toContain("Nothing left to undo");

    // redo in the opposite order: the oldest undone first
    await command("/redo");
    await until(() => replies().at(0)?.metadata?.snapshot?.undone === undefined);
    expect(existsSync(file("one.txt"))).toBe(true);
    expect(existsSync(file("two.txt"))).toBe(false);
  });

  test("a turn that changed no files is passed over", async () => {
    await open();
    await turn("one", (cwd) => writeFileSync(join(cwd, "one.txt"), "1"));
    await turn("talk only", () => {});

    await command("/undo");
    await until(() => replies().at(0)?.metadata?.snapshot?.undone === true);
    expect(existsSync(file("one.txt"))).toBe(false);
    expect(frame()).toContain("1 later turn changed no files");
  });

  test("a new turn after an undo ends the redo", async () => {
    await open();
    await turn("one", (cwd) => writeFileSync(join(cwd, "one.txt"), "1"));
    await command("/undo");
    await until(() => lastSnapshot()?.undone === true);

    await turn("another", (cwd) => writeFileSync(join(cwd, "other.txt"), "x"));
    expect(replies().at(0)?.metadata?.snapshot).toMatchObject({ undone: true, abandoned: true });

    await command("/redo");
    await settle(200);
    expect(frame()).toContain("Nothing to redo");
    expect(existsSync(file("one.txt"))).toBe(false);
  });

  test("a restore the store refuses is an error, nothing outside the project is written, and the reply stays not undone", async () => {
    await open();
    const outside = mkdtempSync(join(home, "outside-"));
    await turn("make a folder", (cwd) => {
      mkdirSync(join(cwd, "d"));
      writeFileSync(join(cwd, "d", "f.txt"), "inside");
    });
    // The folder is swapped for a link to somewhere else after the turn.
    rmSync(file("d"), { recursive: true });
    symlinkSync(outside, file("d"));

    await command("/undo");
    await until(() => frame().includes("Overwrite changed files?"));
    await confirmSecond();
    await until(() => frame().includes("Could not undo"));
    expect(frame()).toContain("symlink");
    expect(existsSync(join(outside, "f.txt"))).toBe(false);
    expect(lastSnapshot()?.undone).toBeUndefined();
    expect(frame()).not.toContain("Undid the last turn");
  });

  test("a session with no snapshots says why", async () => {
    await open([
      { id: "u", role: "user", parts: [{ type: "text", text: "hi" }], metadata: { mode: "BUILD", model: "sonnet" } },
      { id: "a", role: "assistant", parts: [{ type: "text", text: "yo" }], metadata: { mode: "BUILD", model: "sonnet" } },
    ]);
    await command("/undo");
    await settle(150);
    expect(frame()).toContain("No turn in this session has a file snapshot");
    await command("/redo");
    await settle(150);
    expect(frame()).toContain("Nothing to redo");
  });

  test("without git the turn still runs and /undo says why it cannot help", async () => {
    const path = process.env.PATH;
    process.env.PATH = "";
    try {
      await open();
    } finally {
      process.env.PATH = path;
    }
    doInProject = () => {};
    await type("hello");
    await press("RETURN");
    await until(() => replies().length > 0);
    expect(prompts).toEqual(["hello"]);
    expect(lastSnapshot()).toBeUndefined();
    await command("/undo");
    await settle(150);
    expect(frame()).toContain("File undo is unavailable: git is not installed");
  });
});

describe("/diff (S11)", () => {
  test("shows each changed file with its header and +/- lines in a dialog", async () => {
    await open();
    writeFileSync(file("old.txt"), "line one\nline two\n");
    await turn("edit and add", (cwd) => {
      writeFileSync(join(cwd, "old.txt"), "line one\nline 2\n");
      writeFileSync(join(cwd, "added.txt"), "brand new\n");
    });
    await turn("more", (cwd) => writeFileSync(join(cwd, "added.txt"), "brand new\nsecond\n"));

    await command("/diff");
    await until(() => frame().includes("Changes since the first turn"));
    // the list is laid out a moment after the dialog opens
    await settle(300);
    const text = frame();
    expect(text).toContain("2 files");
    expect(text).toContain("added.txt new file +2 -0");
    expect(text).toContain("old.txt modified +1 -1");
    expect(text).toContain("-line two");
    expect(text).toContain("+line 2");
    expect(text).toContain("+brand new");
    expect(text).toContain("+second");
  });

  test("a long diff scrolls", async () => {
    await open();
    await turn("big", (cwd) => writeFileSync(join(cwd, "big.txt"), Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n") + "\n"));
    await command("/diff");
    await until(() => frame().includes("Changes since the first turn"));
    await settle(300);
    expect(frame()).toContain("+row 0");
    expect(frame()).not.toContain("+row 150 ");
    await act(async () => screen!.mockInput.pressKey("END" as never));
    await settle(80);
    expect(frame()).toContain("+row 199");
  });

  test("with nothing changed it says so in a toast", async () => {
    await open();
    await turn("talk only", () => {});
    await command("/diff");
    await until(() => frame().includes("No file changes since this session's first turn"));
    expect(frame()).toContain("No file changes since this session's first turn");
    expect(frame()).not.toContain("Changes since the first turn");
  });

  test("after an undo the files are back and there is nothing to show", async () => {
    await open();
    await turn("one", (cwd) => writeFileSync(join(cwd, "one.txt"), "1"));
    await command("/undo");
    await until(() => lastSnapshot()?.undone === true);
    await command("/diff");
    await until(() => frame().includes("No file changes since this session's first turn"));
    expect(frame()).toContain("No file changes since this session's first turn");
  });

  test("a session with no snapshots says why", async () => {
    await open([{ id: "a", role: "assistant", parts: [{ type: "text", text: "yo" }], metadata: { mode: "BUILD", model: "sonnet" } }]);
    await command("/diff");
    await settle(150);
    expect(frame()).toContain("No turn in this session has a file snapshot");
  });
});
