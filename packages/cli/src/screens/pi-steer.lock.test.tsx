import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useEffect } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-lock-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMockKeys } = await import("@opentui/core/testing");
const { useRenderer } = await import("@opentui/react");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
type Engine = import("../lib/engine/types").Engine;
type TurnHost = import("../lib/engine/types").TurnHost;

// S4 B1: a prompt that opens while the user is composing (a draft in the input, or a key typed in the last 2 s) opens
// locked: nothing answers it until ↓ is pressed, then the usual rules apply (quiet window, two-step confirms).

let dir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-lock-"));
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());
const frameContaining = async (text: string, timeoutMs = 8000) => {
  const start = Date.now();
  let current = frame();
  while (!current.includes(text) && Date.now() - start < timeoutMs) {
    await settle(25);
    current = frame();
  }
  return current;
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(60);
};
const down = async () => {
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle(60);
};
const backspace = async () => {
  await act(async () => screen!.mockInput.pressBackspace());
  await settle(60);
};

// Keys that reach a new input bar in the commit that mounts it, before its mount effects have run (the home → session hand-off
// under a fast typist): sibling layout effects run after the bar's textarea exists and before any passive effect.
function TypeOnMount({ text }: { text: string }) {
  const renderer = useRenderer();
  useEffect(() => {
    const keys = createMockKeys(renderer);
    for (const char of text) keys.pressKey(char);
  }, [renderer, text]);
  return null;
}

// A pi-like engine (its turn takes steers, so the input is on) that asks once `open()` is called, and records the answer.
function openSession(ask: (host: TurnHost, signal: AbortSignal) => Promise<unknown>, burstOnMount?: string) {
  const gate = Promise.withResolvers<void>();
  const answers: unknown[] = [];
  const engine: Engine = {
    id: "pi",
    startTurn: (request, host) => ({
      done: gate.promise.then(async () => {
        answers.push(await ask(host, request.signal));
      }),
      interrupt: () => gate.resolve(),
      steer: async () => {},
      followUp: async () => {},
    }),
    warmUpCommands: async () => {},
  };
  engines.set("pi", engine);
  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <>{burstOnMount ? <TypeOnMount text={burstOnMount} /> : null}<Session /></> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
  );
  return {
    answers,
    open: async () => {
      gate.resolve();
      await settle(60);
    },
    mount: async () => {
      screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
      await settle(100);
    },
  };
}

const bash = (host: TurnHost, signal: AbortSignal) => host.askPermission({ toolName: "bash", input: { command: "echo hello" } }, signal);
const LOCK_LINE = "press ↓ to answer";

describe("a prompt that opens while the user is composing (S4)", () => {
  test("an approval opens locked with a draft in the input: no key answers it until ↓, then the quiet window applies", async () => {
    const turn = openSession(bash);
    await turn.mount();
    await type("steer text");
    await turn.open();

    const locked = await frameContaining("Allow");
    expect(locked).toContain(LOCK_LINE);
    expect(locked).not.toContain("waiting for typing to stop");

    // However long it waits, no answer key does anything.
    await settle(500);
    for (const key of ["y", "a", "n"]) await press(key);
    await enter();
    expect(turn.answers).toEqual([]);
    expect(frame()).toContain("Allow");

    // The keys went nowhere: not into the input either.
    expect(frame()).toContain("steer text");
    expect(frame()).not.toContain("steer textyan");

    await down();
    expect(frame()).not.toContain(LOCK_LINE);
    // Today's rules apply from here: a key inside the quiet window answers nothing...
    await press("y");
    expect(turn.answers).toEqual([]);
    // ...and one after it does.
    await settle(400);
    await press("y");
    expect(turn.answers).toEqual(["allow"]);
  }, 30000);

  test("a key typed in the last 2 s locks it even when the input is empty again, and 2 s later it does not", async () => {
    const recent = openSession(bash);
    await recent.mount();
    await type("x");
    await backspace();
    await recent.open();
    expect(await frameContaining("Allow")).toContain(LOCK_LINE);
    await settle(400);
    await press("a");
    expect(recent.answers).toEqual([]);
    await act(async () => screen!.renderer.destroy());
    screen = null;

    const old = openSession(bash);
    await old.mount();
    await type("x");
    await backspace();
    await settle(2100);
    await old.open();
    expect(await frameContaining("Allow")).not.toContain(LOCK_LINE);
    await settle(400);
    await press("a");
    expect(old.answers).toEqual(["always"]);
  }, 30000);

  test("a prompt that opens while the user is not composing behaves as before", async () => {
    const turn = openSession(bash);
    await turn.mount();
    await turn.open();

    const shown = await frameContaining("Allow");
    expect(shown).not.toContain(LOCK_LINE);
    await settle(400);
    await press("y");
    expect(turn.answers).toEqual(["allow"]);
  }, 30000);

  test("a burst typed into a session's input bar before its mount effects ran still counts: the prompt opens locked", async () => {
    const turn = openSession(bash, "steer burst");
    await turn.mount();
    expect(frame()).toContain("steer burst");
    await turn.open();

    expect(await frameContaining("Allow")).toContain(LOCK_LINE);
    await settle(400);
    await press("y");
    expect(turn.answers).toEqual([]);
  }, 30000);

  test("sending the text ends the composing: a prompt right after does not open locked", async () => {
    const turn = openSession(bash);
    await turn.mount();
    await type("steer text");
    await enter();
    await turn.open();

    expect(await frameContaining("Allow")).not.toContain(LOCK_LINE);
  }, 30000);

  test("a question opens locked: digits and o answer nothing until ↓", async () => {
    const turn = openSession((host, signal) =>
      host.askQuestions(
        [{ question: "Which road?", header: "Road", options: [{ label: "Left", description: "l" }, { label: "Right", description: "r" }], multiSelect: false }],
        signal,
      ),
    );
    await turn.mount();
    await type("draft");
    await turn.open();

    expect(await frameContaining("Which road?")).toContain(LOCK_LINE);
    await settle(400);
    await press("1");
    await press("o");
    await press("2");
    expect(turn.answers).toEqual([]);

    await down();
    await settle(400);
    await press("2");
    expect(turn.answers).toEqual([{ "Which road?": "Right" }]);
  }, 30000);

  test("the trust question opens locked: d and t answer nothing until ↓, and Esc still means not now", async () => {
    const ask = (host: TurnHost, signal: AbortSignal) =>
      host.askProjectTrust!({ cwd, resources: [{ path: ".pi/mcp.json", detail: "fixture-mcp-server" }] }, signal);

    const distrust = openSession(ask);
    await distrust.mount();
    await type("draft");
    await distrust.open();
    expect(await frameContaining("Trust this project's pi files?")).toContain(LOCK_LINE);
    await settle(400);
    await press("d");
    await press("t");
    await enter();
    expect(distrust.answers).toEqual([]);
    await down();
    await settle(400);
    await press("d");
    expect(distrust.answers).toEqual(["distrust"]);
    await act(async () => screen!.renderer.destroy());
    screen = null;

    const skip = openSession(ask);
    await skip.mount();
    await type("draft");
    await skip.open();
    expect(await frameContaining("Trust this project's pi files?")).toContain(LOCK_LINE);
    await press("ESCAPE");
    expect(skip.answers).toEqual(["skip"]);
  }, 30000);

  test("an extension confirm opens locked: y, n and Enter answer nothing until ↓", async () => {
    const turn = openSession((host, signal) => host.confirm!("Delete everything?", "really", signal));
    await turn.mount();
    await type("draft");
    await turn.open();

    expect(await frameContaining("Delete everything?")).toContain(LOCK_LINE);
    await settle(400);
    await press("y");
    await enter();
    await press("n");
    expect(turn.answers).toEqual([]);

    await down();
    await settle(400);
    await press("n");
    expect(turn.answers).toEqual([false]);
  }, 30000);

  test("an extension select and input open locked too: digits, Enter and typed text answer or fill nothing", async () => {
    const select = openSession((host, signal) => host.select!("Pick", ["one", "two"], signal));
    await select.mount();
    await type("draft");
    await select.open();
    expect(await frameContaining("Pick")).toContain(LOCK_LINE);
    await settle(400);
    await press("2");
    await enter();
    expect(select.answers).toEqual([]);
    await down();
    await settle(400);
    await press("2");
    expect(select.answers).toEqual(["two"]);
    await act(async () => screen!.renderer.destroy());
    screen = null;

    const input = openSession((host, signal) => host.input!("Name?", "name", signal));
    await input.mount();
    await type("draft");
    await input.open();
    expect(await frameContaining("Name?")).toContain(LOCK_LINE);
    await settle(400);
    await type("zed");
    await enter();
    expect(input.answers).toEqual([]);
    expect(frame()).not.toContain("zed");
    await down();
    await settle(400);
    await type("amy");
    await enter();
    expect(input.answers).toEqual(["amy"]);
  }, 30000);
});
