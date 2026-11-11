import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-engine-screen-"));
const prefsPath = join(prefsDir, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

let claudeCalls: { prompt: string; options: any }[] = [];
// When set, a Claude turn waits for it before it ends.
let claudeHold: Promise<void> | null = null;

// Fake query(): init → result, so a Claude turn needs no model.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    claudeCalls.push({ prompt, options });
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      await claudeHold;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0 };
    })();
    return Object.assign(messages, { interrupt: async () => {}, supportedCommands: async () => [] });
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { NewSession } = await import("./new-session");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { PI_DEFAULT_MODEL } = await import("../lib/models");
type Engine = import("../lib/engine/types").Engine;
type TurnRequest = import("../lib/engine/types").TurnRequest;

let piRequests: TurnRequest[] = [];
const fakePi: Engine = {
  id: "pi",
  startTurn: (request, host) => {
    piRequests.push(request);
    host.emit({
      type: "reply",
      update: (reply) => ({ ...reply, parts: [...reply.parts, { type: "text", text: "pi answered" }] }),
    });
    return { done: Promise.resolve(), interrupt() {} };
  },
  warmUpCommands: async () => {},
};

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};
const pressDown = async () => {
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());

const savedPreferences = () => JSON.parse(readFileSync(prefsPath, "utf8"));

async function open(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <RootLayout />,
        children: [
          { index: true, element: <Home /> },
          { path: "sessions/new", element: <NewSession /> },
          { path: "sessions/:id", element: <Session /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 30 });
  // A pi screen first asks which pi model it can use; this fake pi engine has no runtime, so that fails and the status line says pi is unavailable.
  // (The turn itself still goes out with the stored or built-in model, which pi then reports on.)
  await settle(120);
}

const openSession = (engine?: string) => {
  const session = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine });
  return open(`/sessions/${session.id}`).then(() => session);
};

const sessionByTitle = (title: string) => {
  const summary = getStorage().listSessions().find((s) => s.title === title);
  return summary ? getStorage().getSession(summary.id) : null;
};

beforeAll(() => engines.set("pi", fakePi));
afterAll(() => {
  engines.set("pi", undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});

afterEach(async () => {
  claudeCalls = [];
  claudeHold = null;
  piRequests = [];
  rmSync(prefsPath, { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("each session runs on its own engine (S2)", () => {
  test("a Claude session sends its alias to the Claude engine and labels the status line claude", async () => {
    await openSession("claude");
    expect(frame()).toContain("Build › opus · claude");

    await type("hello");
    await press("RETURN");
    await settle(80);

    expect(claudeCalls.map((c) => [c.prompt, c.options.model])).toEqual([["hello", "opus"]]);
    expect(piRequests).toEqual([]);
  });

  test("a session without an engine column value is a Claude session", async () => {
    await openSession();
    await type("hello");
    await press("RETURN");
    await settle(80);

    expect(claudeCalls).toHaveLength(1);
    expect(piRequests).toEqual([]);
  });

  test("a pi session sends the pi model ref to the pi engine, never a Claude alias, and labels itself pi", async () => {
    await openSession("pi");
    expect(frame()).toContain("pi unavailable");
    expect(frame()).not.toContain(PI_DEFAULT_MODEL);

    await type("hello");
    await press("RETURN");
    await settle(80);

    expect(piRequests.map((r) => [r.prompt, r.model])).toEqual([["hello", PI_DEFAULT_MODEL]]);
    expect(claudeCalls).toEqual([]);
    expect(frame()).toContain("pi answered");
  });

  test("/models on a pi session does not open the Claude model picker", async () => {
    await openSession("pi");

    await type("/models");
    await press("RETURN");

    const text = frame();
    expect(text).not.toContain("Select Model");
    expect(text).not.toContain("sonnet");
  });

  test("/models on a Claude session still opens the picker", async () => {
    await openSession("claude");

    await type("/models");
    await press("RETURN");

    const text = frame();
    expect(text).toContain("Select Model");
    expect(text).toContain("sonnet");
  });

  test("a session with an unknown engine shows the error and runs nothing", async () => {
    await openSession("gpt");
    expect(frame()).toContain("· gpt");

    await type("hello");
    await press("RETURN");
    await settle(80);

    expect(frame()).toContain("This session uses an unknown engine: gpt");
    expect(claudeCalls).toEqual([]);
    expect(piRequests).toEqual([]);
  });
});

describe("/engine (S2)", () => {
  test("lists both engines, sets the default for new sessions, shows a toast and leaves the open session on its engine", async () => {
    const session = await openSession("claude");

    await type("/engine");
    await press("RETURN");
    const listed = frame();
    expect(listed).toContain("Claude (Agent SDK)");
    expect(listed).toContain("pi");

    await pressDown();
    await press("RETURN");

    expect(savedPreferences().defaultEngine).toBe("pi");
    const after = frame();
    expect(after).toContain("New sessions will use pi");
    expect(after).not.toContain("Claude (Agent SDK)");
    expect(getStorage().getSession(session.id)!.engine).toBe("claude");
    expect(after).toContain("Build › opus · claude");

    // The open session still runs on Claude.
    await type("hello");
    await press("RETURN");
    await settle(80);
    expect(claudeCalls).toHaveLength(1);
    expect(piRequests).toEqual([]);
  });

  test("works from the home screen and can switch back to Claude", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");
    await open("/");

    await type("/engine");
    await press("RETURN");
    await press("RETURN");

    expect(savedPreferences().defaultEngine).toBe("claude");
    expect(frame()).toContain("New sessions will use Claude (Agent SDK)");
  });

  test("the home screen shows the engine a new session will use", async () => {
    await open("/");
    expect(frame()).toContain("pi unavailable");
    expect(frame()).not.toContain(PI_DEFAULT_MODEL);

    rmSync(prefsPath, { force: true });
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude" }), "utf8");
    await act(async () => screen!.renderer.destroy());
    await open("/");
    expect(frame()).toContain("Build › opus · claude");
  });
});

describe("new sessions take the default engine (S2)", () => {
  test("with no preference a new session is a pi session (S19)", async () => {
    await open("/");

    await type("first default chat");
    await press("RETURN");
    await settle(150);

    expect(sessionByTitle("first default chat")?.engine).toBe("pi");
    expect(piRequests.map((r) => [r.prompt, r.model])).toEqual([["first default chat", PI_DEFAULT_MODEL]]);
    expect(claudeCalls).toEqual([]);
  });

  test("with Claude stored as the default a new session is a Claude session", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude" }), "utf8");
    await open("/");

    await type("first claude chat");
    await press("RETURN");
    await settle(150);

    expect(sessionByTitle("first claude chat")?.engine).toBe("claude");
    expect(claudeCalls.map((c) => c.options.model)).toEqual(["opus"]);
    expect(piRequests).toEqual([]);
  });

  test("an unknown stored default falls back to pi", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "gpt" }), "utf8");
    await open("/");

    await type("first fallback chat");
    await press("RETURN");
    await settle(150);

    expect(sessionByTitle("first fallback chat")?.engine).toBe("pi");
    expect(claudeCalls).toEqual([]);
  });

  test("with pi as the default a new session is a pi session and its first turn gets the pi model", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");
    await open("/");

    await type("first pi chat");
    await press("RETURN");
    await settle(150);

    expect(sessionByTitle("first pi chat")?.engine).toBe("pi");
    expect(piRequests.map((r) => [r.prompt, r.model])).toEqual([["first pi chat", PI_DEFAULT_MODEL]]);
    expect(claudeCalls).toEqual([]);
  });
});

describe("keys typed on the new-session screen (S4)", () => {
  // The keys arrive while /sessions/new is up, just before it creates the session and moves on to it.
  const burstOnNewSession = (burst: string) => {
    const storage = getStorage();
    const createSession = storage.createSession.bind(storage);
    storage.createSession = ((...args: Parameters<typeof createSession>) => {
      storage.createSession = createSession;
      for (const ch of burst) screen!.mockInput.pressKey(ch as never);
      return createSession(...args);
    }) as typeof storage.createSession;
  };

  test("on a pi session the burst is in the session input, and the first prompt is sent once", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");
    await open("/");
    burstOnNewSession("and then");

    await type("first words");
    await press("RETURN");
    await settle(200);

    expect(piRequests.map((r) => r.prompt)).toEqual(["first words"]);
    expect(frame()).toContain("and then");

    await press("RETURN");
    await settle(100);
    expect(piRequests.map((r) => r.prompt)).toEqual(["first words", "and then"]);
  });

  test("on a Claude session the burst stays in the disabled input during the turn and is not lost", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude" }), "utf8");
    const hold = Promise.withResolvers<void>();
    claudeHold = hold.promise;
    await open("/");
    burstOnNewSession("and then");

    await type("first words");
    await press("RETURN");
    await settle(200);

    expect(claudeCalls.map((c) => c.prompt)).toEqual(["first words"]);
    expect(frame()).toContain("and then");
    // The turn is running: the input is off, so more keys and Enter change nothing.
    await press("RETURN");
    expect(claudeCalls).toHaveLength(1);

    hold.resolve();
    await settle(200);
    expect(frame()).toContain("and then");
    expect(claudeCalls).toHaveLength(1);

    await press("RETURN");
    await settle(100);
    expect(claudeCalls.map((c) => c.prompt)).toEqual(["first words", "and then"]);
  });

  test("Enter on the new-session screen sends nothing and keeps the text", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");
    await open("/");
    const storage = getStorage();
    const createSession = storage.createSession.bind(storage);
    storage.createSession = ((...args: Parameters<typeof createSession>) => {
      storage.createSession = createSession;
      screen!.mockInput.pressKey("x" as never);
      screen!.mockInput.pressEnter();
      screen!.mockInput.pressKey("y" as never);
      return createSession(...args);
    }) as typeof storage.createSession;

    await type("first words");
    await press("RETURN");
    await settle(200);

    expect(piRequests.map((r) => r.prompt)).toEqual(["first words"]);
    expect(frame()).toContain("xy");
  });
});
