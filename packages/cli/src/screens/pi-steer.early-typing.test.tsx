import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-early-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
type Engine = import("../lib/engine/types").Engine;
type TurnHost = import("../lib/engine/types").TurnHost;

// S4 (L7): on a pi session the input takes keys whenever no prompt is open, also while the session starts (the model check,
// status submitted) and before the turn can take steers. Only sending waits: Enter, Alt+Enter and /queue keep the text.

let dir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-early-"));
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
const enter = async (modifiers?: { meta?: boolean }) => {
  await act(async () => screen!.mockInput.pressEnter(modifiers));
  await settle(60);
};
const backspace = async () => {
  await act(async () => screen!.mockInput.pressBackspace());
  await settle(60);
};

const LOCK_LINE = "press ↓ to answer";
const STARTING = "turn starting";

// A pi-like engine whose model check (`getRuntime`) waits on `checkModel()`. The first turn runs until `finish()` and asks
// the given prompts one after the other; a later turn ends at once. Everything the turn is handed is recorded.
function openSession(prompts: ((host: TurnHost, signal: AbortSignal) => Promise<unknown>)[] = []) {
  const modelCheck = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const record = { prompts: [] as string[], steers: [] as string[], followUps: [] as string[], answers: [] as unknown[] };
  const engine: Engine = {
    id: "pi",
    getRuntime: () => modelCheck.promise.then(() => Promise.reject(new Error("no runtime in this test"))),
    getDeviceId: async () => "test-device",
    startTurn: (request, host) => {
      const first = record.prompts.length === 0;
      record.prompts.push(request.prompt);
      return {
        done: first
          ? (async () => {
              for (const ask of prompts) record.answers.push(await ask(host, request.signal));
              await finished.promise;
            })()
          : Promise.resolve(),
        interrupt: () => finished.resolve(),
        steer: async (text) => void record.steers.push(text),
        followUp: async (text) => void record.followUps.push(text),
      };
    },
    warmUpCommands: async () => {},
  } as Engine; // `getRuntime` and `getDeviceId` are what the model check reads from the pi engine
  engines.set("pi", engine);
  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
  );
  return {
    record,
    checkModel: async () => {
      modelCheck.resolve();
      await settle(100);
    },
    finish: async () => {
      finished.resolve();
      await settle(100);
    },
    mount: async () => {
      screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
      await settle(100);
    },
  };
}

const bash = (host: TurnHost, signal: AbortSignal) => host.askPermission({ toolName: "bash", input: { command: "echo hello" } }, signal);

describe("typing before the turn can take steers (S4)", () => {
  test("keys typed during the model check reach the input and stay there, with a hint that the turn is starting", async () => {
    const turn = openSession();
    await turn.mount();
    expect(turn.record.prompts).toEqual([]); // the model check is still running

    await type("early words");
    const typed = frame();
    expect(typed).toContain("early words");
    expect(typed).toContain(STARTING);
    expect(typed).toContain("enter steers once it runs");
  }, 30000);

  test("Enter, Alt+Enter and /queue keep the text and send nothing until the turn runs; then Enter steers it", async () => {
    const turn = openSession();
    await turn.mount();

    await type("early words");
    await enter();
    await enter({ meta: true });
    expect(frame()).toContain("early words");
    expect(turn.record.steers).toEqual([]);
    expect(turn.record.followUps).toEqual([]);
    expect(turn.record.prompts).toEqual([]);

    await turn.checkModel();
    expect(turn.record.prompts).toEqual(["hi"]);
    expect(await frameContaining("enter steers · alt+enter queues")).toContain("early words");
    expect(frame()).not.toContain(STARTING);

    await enter();
    expect(turn.record.steers).toEqual(["early words"]);
    expect(turn.record.followUps).toEqual([]);
  }, 30000);

  test("/queue <text> typed before the turn runs stays in the input; once it runs it queues", async () => {
    const turn = openSession();
    await turn.mount();

    await type("/queue later");
    await enter();
    expect(frame()).toContain("/queue later");
    expect(turn.record.followUps).toEqual([]);
    expect(turn.record.steers).toEqual([]);
    expect(turn.record.prompts).toEqual([]);

    await turn.checkModel();
    await frameContaining("enter steers");
    await enter();
    expect(turn.record.followUps).toEqual(["later"]);
    expect(turn.record.steers).toEqual([]);
  }, 30000);

  test("early text is sent as the next prompt when Enter is pressed after the turn ends", async () => {
    const turn = openSession();
    await turn.mount();

    await type("next thing");
    await turn.checkModel();
    await turn.finish();
    await frameContaining("Ask anything", 2000);
    expect(frame()).toContain("next thing");

    await enter();
    expect(turn.record.steers).toEqual([]);
    expect(turn.record.prompts).toEqual(["hi", "next thing"]);
  }, 30000);

  test("a prompt that opens after early typing opens locked: the next keys answer nothing", async () => {
    const turn = openSession([bash]);
    await turn.mount();
    await type("please check the ");
    await turn.checkModel();

    expect(await frameContaining("Allow")).toContain(LOCK_LINE);
    await settle(400);
    await press("a");
    await press("y");
    expect(turn.record.answers).toEqual([]);
    expect(frame()).toContain("please check the");
  }, 30000);

  test("answering a prompt with y is not typing: a second prompt right after opens unlocked", async () => {
    const turn = openSession([bash, bash]);
    await turn.mount();
    // Typed, then deleted and left alone for longer than the composing window, so the first prompt opens unlocked.
    await type("x");
    await backspace();
    await settle(2100);
    await turn.checkModel();

    expect(await frameContaining("Allow")).not.toContain(LOCK_LINE);
    await settle(400);
    await press("y");
    expect(turn.record.answers).toEqual(["allow"]);

    await settle(100);
    const second = await frameContaining("Allow");
    expect(second).not.toContain(LOCK_LINE);
    await settle(400);
    await press("y");
    expect(turn.record.answers).toEqual(["allow", "allow"]);
  }, 30000);
});
