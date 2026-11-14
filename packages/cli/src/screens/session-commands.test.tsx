import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: preferences, commands and snapshots land in tmp. The variables are put back when the file is done: they
// belong to the whole test process, and a snapshot folder left set would make every later file snapshot its turns.
const home = mkdtempSync(join(tmpdir(), "marcsh-session-commands-"));
const ENV = { MARCSH_PREFERENCES_PATH: join(home, "preferences.json"), MARCSH_SNAPSHOTS_DIR: join(home, "snapshots"), MARCSH_SNAPSHOTS: "on", MARCSH_COMMANDS_DIR: join(home, "commands") };
const savedEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
Object.assign(process.env, ENV);

let calls: { prompt: string; options: any }[] = [];

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
const { Home } = await import("./home");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
import type { ChatMessage } from "../lib/chat-types";
import type { Engine } from "../lib/engine/types";

let piEngine: Engine;
const idlePi = (): Engine => ({ id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} });
beforeAll(() => engines.set("pi", (piEngine = idlePi())));
afterAll(() => {
  engines.set("pi", undefined);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let router: ReturnType<typeof createMemoryRouter>;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const press = async (key: string, modifiers?: { ctrl?: boolean }) => {
  await act(async () => screen!.mockInput.pressKey(key as never, modifiers));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const arrow = async (direction: "up" | "down") => {
  await act(async () => screen!.mockInput.pressArrow(direction));
  await settle(60);
};
// A turn starts after the project's files were snapshotted, which takes a moment the first time.
const until = async (done: () => boolean, ms = 8000) => {
  for (let waited = 0; !done() && waited < ms; waited += 50) await settle(50);
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const run = async (command: string) => {
  await type(command);
  await press("RETURN");
  await settle(120);
};

const user = (id: string, text: string): ChatMessage => ({ id, role: "user", parts: [{ type: "text", text }], metadata: { mode: "BUILD", model: "sonnet" } });
const bot = (id: string, parts: ChatMessage["parts"]): ChatMessage => ({ id, role: "assistant", parts, metadata: { mode: "BUILD", model: "sonnet" } });

const routes = [
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: "sessions/:id", element: <Session /> },
    ],
  },
];

type Options = { engine?: "claude" | "pi"; title?: string; messages?: ChatMessage[]; ref?: string; cwd?: string };

async function openSession(options: Options = {}) {
  calls = [];
  const cwd = options.cwd ?? mkdtempSync(join(home, "project-"));
  const session = getStorage().createSession({ title: options.title ?? "my session", cwd, engine: options.engine ?? "claude" });
  if (options.messages || options.ref) getStorage().saveMessages(session.id, options.messages ?? [], options.ref);
  router = createMemoryRouter(routes, { initialEntries: [`/sessions/${session.id}`] });
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 32 });
  await settle(80);
  return { session, cwd };
}

afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  engines.set("pi", (piEngine = idlePi()));
});

const here = () => router.state.location.pathname;
const storedTitle = (id: string) => getStorage().getSession(id)?.title;

describe("/rename (S3)", () => {
  test("retitles the session and says so", async () => {
    const { session } = await openSession();
    await run("/rename Better name");
    expect(storedTitle(session.id)).toBe("Better name");
    expect(frame()).toContain('Renamed to "Better name"');
  });

  test("without a title it shows the usage and changes nothing", async () => {
    const { session } = await openSession();
    await run("/rename");
    expect(storedTitle(session.id)).toBe("my session");
    expect(frame()).toContain("Usage: /rename <title>");
  });

  test("runs of whitespace in the title become one space", async () => {
    const { session } = await openSession();
    await run("/rename   spaced     out  ");
    expect(storedTitle(session.id)).toBe("spaced out");
  });
});

describe("/fork (S3)", () => {
  test("copies the messages into a new session without the engine reference and opens it at once", async () => {
    const messages = [user("u1", "question"), bot("a1", [{ type: "text", text: "answer" }])];
    const { session } = await openSession({ messages, ref: "claude-ref-1" });
    await run("/fork");

    const forkId = here().split("/").pop()!;
    expect(forkId).not.toBe(session.id);
    const fork = getStorage().getSession(forkId)!;
    expect(fork.title).toBe("my session (fork)");
    expect(fork.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(fork.engineSessionRef).toBeNull();
    // the original keeps its own
    expect(getStorage().getSession(session.id)!.engineSessionRef).toBe("claude-ref-1");
    expect(frame()).toContain("answer");
  });
});

describe("/export (S3)", () => {
  const messages = [user("u1", "question"), bot("a1", [{ type: "text", text: "the answer" }])];

  test("writes markdown to the default file name in the session's folder and never overwrites", async () => {
    const { session, cwd } = await openSession({ messages });
    const name = `marcsh-${session.id.slice(0, 8)}-`;
    await run("/export");
    const written = () => [...new Bun.Glob(`${name}*`).scanSync({ cwd })].sort();
    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatch(/\.md$/);
    expect(readFileSync(join(cwd, written()[0]!), "utf8")).toContain("the answer");
    expect(frame()).toContain("Exported to");

    await run("/export");
    const files = written();
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith("-1.md"))).toBe(true);
    // the first file is untouched
    expect(readFileSync(join(cwd, files.find((file) => !file.endsWith("-1.md"))!), "utf8")).toContain("the answer");
  });

  test("json and a path: the path is resolved against the session's folder", async () => {
    const { cwd } = await openSession({ messages });
    mkdirSync(join(cwd, "out"));
    await run("/export json out/talk.json");
    const parsed = JSON.parse(readFileSync(join(cwd, "out", "talk.json"), "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.messages).toHaveLength(2);
    expect(frame()).toContain("Exported to");
  });

  test("md with a path, and a name that exists gets -1", async () => {
    const { cwd } = await openSession({ messages });
    writeFileSync(join(cwd, "notes.md"), "mine");
    await run("/export md notes.md");
    expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("mine");
    expect(readFileSync(join(cwd, "notes-1.md"), "utf8")).toContain("the answer");
  });

  test("a folder that does not exist is an error and nothing is written", async () => {
    const { cwd } = await openSession({ messages });
    await run("/export missing/dir/x.md");
    expect(existsSync(join(cwd, "missing"))).toBe(false);
    expect(frame()).toContain("Could not export");
  });
});

describe("deleting a session from the sessions dialog (S3)", () => {
  const openDialog = async () => {
    await type("/sessions");
    await press("RETURN");
    await settle(80);
  };

  test("asks first: cancelling keeps the session", async () => {
    const { session } = await openSession({ title: "keep me" });
    await openDialog();
    await press("d", { ctrl: true });
    expect(frame()).toContain("Delete session");
    expect(frame()).toContain("keep me");
    // the first row is the safe one
    await press("RETURN");
    expect(getStorage().getSession(session.id)).not.toBeNull();
    expect(here()).toBe(`/sessions/${session.id}`);
  });

  test("deleting another session leaves the open one open", async () => {
    const other = getStorage().createSession({ title: "zzz other one", cwd: "/tmp", engine: "claude" });
    const { session } = await openSession({ title: "open one" });
    await openDialog();
    await type("zzz");
    await press("d", { ctrl: true });
    expect(frame()).toContain("zzz other one");
    await arrow("down");
    await press("RETURN");
    expect(getStorage().getSession(other.id)).toBeNull();
    expect(getStorage().getSession(session.id)).not.toBeNull();
    expect(here()).toBe(`/sessions/${session.id}`);
    expect(frame()).toContain("Deleted");
  });

  test("deleting the open session goes home", async () => {
    const { session } = await openSession({ title: "going away" });
    await openDialog();
    await type("going");
    await press("d", { ctrl: true });
    await arrow("down");
    await press("RETURN");
    expect(getStorage().getSession(session.id)).toBeNull();
    expect(here()).toBe("/");
  });

  test("with nothing matching, ctrl+d deletes nothing", async () => {
    const { session } = await openSession({ title: "still here" });
    await openDialog();
    await type("qqqqqqqq");
    await press("d", { ctrl: true });
    expect(frame()).not.toContain("Delete session");
    expect(getStorage().getSession(session.id)).not.toBeNull();
  });
});

describe("/copy (S6)", () => {
  // OSC 52 is what a terminal gets when there is no pbcopy: the test captures it from stdout.
  async function copying(body: () => Promise<void>): Promise<string[]> {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const write = process.stdout.write.bind(process.stdout);
    const copied: string[] = [];
    Object.defineProperty(process, "platform", { value: "linux" });
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      const match = typeof chunk === "string" ? /\u001b\]52;c;([A-Za-z0-9+/=]*)\u0007/.exec(chunk) : null;
      if (match) {
        copied.push(Buffer.from(match[1]!, "base64").toString());
        return true;
      }
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      await body();
    } finally {
      process.stdout.write = write;
      Object.defineProperty(process, "platform", platform);
    }
    return copied;
  }

  test("copies the text of the last reply only, not its tools, and says how", async () => {
    const messages = [
      user("u1", "q1"),
      bot("a1", [{ type: "text", text: "first answer" }]),
      user("u2", "q2"),
      bot("a2", [
        { type: "text", text: "part one" },
        { type: "tool", toolCallId: "t", toolName: "Bash", input: { command: "ls" }, state: "done" },
        { type: "reasoning", text: "secret thoughts" },
        { type: "text", text: "part two" },
      ]),
    ];
    await openSession({ messages });
    const copied = await copying(() => run("/copy"));
    expect(copied).toEqual(["part one\n\npart two"]);
    expect(frame()).toContain("Sent the last reply");
  });

  test("with no reply there is nothing to copy", async () => {
    await openSession({ messages: [user("u1", "hi")] });
    const copied = await copying(() => run("/copy"));
    expect(copied).toEqual([]);
    expect(frame()).toContain("no reply to copy");
  });
});

describe("/compact (S5)", () => {
  test("Claude: runs a turn whose prompt is /compact on the session's conversation", async () => {
    await openSession({ messages: [user("u1", "q"), bot("a1", [{ type: "text", text: "a" }])], ref: "claude-ref-1" });
    await run("/compact");
    await until(() => calls.length > 0);
    expect(calls.map((call) => call.prompt)).toEqual(["/compact"]);
    expect(calls[0]!.options.resume).toBe("claude-ref-1");
  });

  test("Claude: with no conversation yet there is nothing to compact and no turn runs", async () => {
    await openSession();
    await run("/compact");
    expect(calls).toEqual([]);
    expect(frame()).toContain("Nothing to compact yet");
  });

  test("pi: asks the engine to compact the conversation and reports the tokens", async () => {
    const seen: { resumeRef: string; cwd: string }[] = [];
    engines.set("pi", (piEngine = { ...idlePi(), compact: async ({ resumeRef, cwd }) => (seen.push({ resumeRef, cwd }), { tokensBefore: 42_000, tokensAfter: 3_000 }) }));
    const { cwd } = await openSession({ engine: "pi", messages: [user("u1", "q"), bot("a1", [{ type: "text", text: "a" }])], ref: "/tmp/pi-session.jsonl" });
    await run("/compact");
    await settle(150);
    expect(seen).toEqual([{ resumeRef: "/tmp/pi-session.jsonl", cwd }]);
    expect(frame()).toContain("Compacted");
    expect(frame()).toContain("42k");
  });

  test("pi: a failure is an error toast", async () => {
    engines.set("pi", (piEngine = { ...idlePi(), compact: async () => Promise.reject(new Error("Nothing to compact (session too small)")) }));
    await openSession({ engine: "pi", messages: [user("u1", "q")], ref: "/tmp/pi-session.jsonl" });
    await run("/compact");
    await settle(150);
    expect(frame()).toContain("Could not compact");
    expect(frame()).toContain("session too small");
  });

  test("an engine that cannot compact says so", async () => {
    await openSession({ engine: "pi", messages: [user("u1", "q")], ref: "/tmp/pi-session.jsonl" });
    await run("/compact");
    expect(frame()).toContain("cannot compact");
  });
});

describe("the commands in the menu and outside a session", () => {
  test("a session's / menu lists them after marcsh's older commands", async () => {
    await openSession();
    await type("/");
    expect(frame()).toContain("/rename <title> Rename this session");
    // The menu shows 10 rows and scrolls: with /permissions among marcsh's older commands, /fork is the 11th, so scroll to it.
    for (let i = 0; i < 10; i++) await arrow("down");
    expect(frame()).toContain("/fork Continue in a copy of this session");
  });

  test.each([
    ["/exp", "/export [md|json] [path] Save this session as markdown or JSON"],
    ["/und", "/undo Put back the files the last turn changed"],
    ["/red", "/redo Re-apply the file changes"],
    ["/dif", "/diff Show the files changed in this session"],
    ["/comp", "/compact Compact this session's context"],
    ["/cop", "/copy Copy the last reply to the clipboard"],
  ])("%s finds its command in a session", async (typed, line) => {
    await openSession();
    await type(typed);
    expect(frame()).toContain(line);
  });

  async function openHome() {
    router = createMemoryRouter(routes, { initialEntries: ["/"] });
    screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 32 });
    await settle(80);
  }

  test("the home screen does not list them", async () => {
    await openHome();
    await type("/");
    expect(frame()).toContain("/sessions Browse past sessions");
    expect(frame()).not.toContain("/rename");
    expect(frame()).not.toContain("/fork");
  });

  test("typing one on the home screen says to open a session, and it is not sent to the engine", async () => {
    await openHome();
    await run("/undo");
    expect(frame()).toContain("/undo works inside a session");
    expect(calls).toEqual([]);
    expect(here()).toBe("/");
  });
});
