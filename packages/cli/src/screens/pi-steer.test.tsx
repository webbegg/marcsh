import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-steer-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { createPiEngine } = await import("../lib/engine/pi");
type FauxResponseStep = import("@earendil-works/pi-ai").FauxResponseStep;
type Engine = import("../lib/engine/types").Engine;

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-steer-screen-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  engines.set("claude", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
// Joins word-wrapped lines (and the line's left border) back into one string.
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const frameContaining = async (text: string, timeoutMs = 8000) => {
  const start = Date.now();
  let current = frame();
  while (!current.includes(text) && Date.now() - start < timeoutMs) {
    await settle(25);
    current = frame();
  }
  return current;
};
const frameWithout = async (text: string, timeoutMs = 8000) => {
  const start = Date.now();
  let current = frame();
  while (current.includes(text) && Date.now() - start < timeoutMs) {
    await settle(25);
    current = frame();
  }
  return current;
};

const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const enter = async (modifiers?: { meta?: boolean }) => {
  await act(async () => screen!.mockInput.pressEnter(modifiers));
  await settle(60);
};
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};

// A response held back until `release()`; `started` resolves once the model is asked for it.
function gated(content: () => Parameters<typeof fauxAssistantMessage>[0], options?: Parameters<typeof fauxAssistantMessage>[1]) {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const step: FauxResponseStep = async () => {
    started.resolve();
    await gate.promise;
    return fauxAssistantMessage(content(), options);
  };
  return { step, started: started.promise, release: () => gate.resolve() };
}

// A real pi engine on pi's faux provider (no network).
async function openPiSession(responses: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 3000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("faux", "faux-1")!;
  modelRuntime.getAvailable = async () => [model];
  faux.setResponses(responses);
  engines.set("pi", createPiEngine({ agentDir, modelRuntime }));
  return { faux, session: await openScreen() };
}

async function openScreen() {
  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
  await settle();
  return session;
}

const PLACEHOLDER = "Ask anything";

describe("typing during a pi turn (S4)", () => {
  test("the input stays on while the turn runs, and says what Enter and Alt+Enter do", async () => {
    const first = gated(() => [fauxText("first answer")]);
    await openPiSession([first.step]);
    await first.started;
    await settle();

    const during = frame();
    expect(during).toContain(PLACEHOLDER);
    expect(during).toContain("esc to interrupt");
    expect(during).toContain("enter steers");
    expect(during).toContain("alt+enter queues");

    await type("keep going");
    expect(frame()).toContain("keep going");
    first.release();
  }, 30000);

  test("Enter sends the text as a steer: it shows where it was delivered, with a marker, and the answer continues below", async () => {
    const first = gated(() => [fauxText("first answer")]);
    const { faux, session } = await openPiSession([first.step, fauxAssistantMessage([fauxText("second answer")])]);
    await first.started;

    await type("take the other road");
    await enter();
    // Waiting to be delivered: dim, marked as pending.
    const waiting = await frameContaining("take the other road");
    expect(waiting).toContain("steer · pending");

    first.release();
    const done = await frameContaining("second answer");
    await settle(100);
    const after = frame();

    expect(faux.state.callCount).toBe(2);
    expect(after).not.toContain("steer · pending");
    expect(after).toContain("↳ steer");
    expect(occurrences(after, "take the other road")).toBe(1);
    expect(done.indexOf("first answer")).toBeLessThan(done.indexOf("take the other road"));
    expect(after.indexOf("take the other road")).toBeLessThan(after.indexOf("second answer"));
    // The input is empty again and the session is saved with the steer in place.
    expect(after).toContain(PLACEHOLDER);
    const saved = getStorage().getSession(session.id)!.messages;
    expect(saved.map((m) => [m.role, m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(""), m.metadata?.steered === true])).toEqual([
      ["user", "hi", false],
      ["assistant", "first answer", false],
      ["user", "take the other road", true],
      ["assistant", "second answer", false],
    ]);
  }, 30000);

  test("Alt+Enter queues a follow-up: pending and dim until it is sent, then a normal user message", async () => {
    const first = gated(() => [fauxText("first answer")]);
    const { faux, session } = await openPiSession([first.step, fauxAssistantMessage([fauxText("second answer")])]);
    await first.started;

    await type("and then this");
    await enter({ meta: true });
    const waiting = await frameContaining("queued");
    expect(waiting).toContain("and then this");
    expect(faux.state.callCount).toBe(1);

    first.release();
    await frameContaining("second answer");
    await settle(100);
    const after = frame();

    expect(faux.state.callCount).toBe(2);
    expect(after).not.toContain("queued");
    expect(after).not.toContain("↳ steer");
    expect(occurrences(after, "and then this")).toBe(1);
    expect(after.indexOf("first answer")).toBeLessThan(after.indexOf("and then this"));
    expect(after.indexOf("and then this")).toBeLessThan(after.indexOf("second answer"));
    const saved = getStorage().getSession(session.id)!.messages;
    expect(saved.map((m) => [m.role, m.metadata?.steered === true])).toEqual([
      ["user", false],
      ["assistant", false],
      ["user", false],
      ["assistant", false],
    ]);
  }, 30000);

  test("/queue <text> does the same where the terminal cannot send Alt+Enter", async () => {
    const first = gated(() => [fauxText("first answer")]);
    const { faux } = await openPiSession([first.step, fauxAssistantMessage([fauxText("second answer")])]);
    await first.started;

    await type("/queue and then this");
    await enter();
    const waiting = await frameContaining("queued");
    expect(waiting).toContain("and then this");
    expect(waiting).not.toContain("/queue");

    first.release();
    await frameContaining("second answer");
    expect(faux.state.callCount).toBe(2);
  }, 30000);

  test("Enter on an empty input does nothing", async () => {
    const first = gated(() => [fauxText("first answer")]);
    const { faux } = await openPiSession([first.step]);
    await first.started;

    await enter();
    await type("   ");
    await enter();
    await enter({ meta: true });
    const during = frame();
    expect(during).not.toContain("queued");
    expect(during).not.toContain("pending");

    first.release();
    await frameContaining("first answer");
    await settle(150);
    expect(faux.state.callCount).toBe(1);
  }, 30000);

  test("Esc interrupts the turn and discards the follow-ups not sent yet", async () => {
    const first = gated(() => [fauxText("first answer")]);
    const next = fauxAssistantMessage([fauxText("never shown")]);
    const { faux, session } = await openPiSession([first.step, next]);
    await first.started;

    await type("later words");
    await enter({ meta: true });
    await frameContaining("queued");

    await press("ESCAPE");
    const cleared = await frameWithout("queued");
    first.release();
    await settle(200);
    const after = frame();

    expect(cleared).not.toContain("queued");
    expect(after).not.toContain("later words");
    expect(after).not.toContain("never shown");
    expect(faux.state.callCount).toBe(1);
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(getStorage().getSession(session.id)!.messages.some((m) => m.parts.some((p) => p.type === "text" && p.text === "later words"))).toBe(false);
  }, 30000);

  test("an approval prompt that opens while typing is not answered by the typed keys, and the input is off while it is open", async () => {
    const first = gated(() => [fauxToolCall("bash", { command: "echo hello" }, { id: "b1" })], { stopReason: "toolUse" });
    const { faux } = await openPiSession([first.step, fauxAssistantMessage([fauxText("all done")])]);
    await first.started;

    await type("draft");
    first.release();
    // Typing goes on as the prompt appears: these keys are for the input (or nobody), never for the prompt.
    const withPrompt = await frameContaining("Allow");
    await act(() => screen!.mockInput.typeText("yyny"));
    await settle(60);

    const typedOver = frame();
    expect(typedOver).toContain("Allow");
    expect(typedOver).toContain("echo hello");
    expect(typedOver).not.toContain("all done");
    // The prompt is open: the input took none of them and shows nothing to steer with.
    expect(typedOver).toContain("draft");
    expect(typedOver).not.toContain("draftyyny");
    expect(typedOver).not.toContain("enter steers");
    expect(withPrompt).toContain("Allow");

    // Still disabled once the keyboard is quiet: more keys change nothing in the input.
    await settle(400);
    await act(() => screen!.mockInput.typeText("zzz"));
    await settle(60);
    expect(frame()).not.toContain("zzz");
    expect(frame()).toContain("Allow");

    // It opened while the user was composing, so it is locked until ↓; then it answers to its own keys, and the input is back with the draft intact.
    expect(frame()).toContain("press ↓ to answer");
    await act(async () => screen!.mockInput.pressArrow("down"));
    await settle(400);
    await press("y");
    const done = await frameContaining("all done");
    await settle(100);
    expect(done).toContain("all done");
    expect(faux.state.callCount).toBe(2);
    expect(frame()).toContain("draft");
    expect(frame()).not.toContain("draftzzz");
  }, 30000);
});

describe("an engine without steer keeps today's behavior (S4)", () => {
  test("the input is off during the turn and text typed then goes nowhere", async () => {
    const release = Promise.withResolvers<void>();
    // A Claude session: its turn takes no input, and a pi session's input is on whenever no prompt is open.
    const stub: Engine = {
      id: "claude",
      startTurn: () => ({ done: release.promise, interrupt: () => release.resolve() }),
      warmUpCommands: async () => {},
    };
    engines.set("claude", stub);
    const session = getStorage().createSession({ title: "chat", cwd, engine: "claude" });
    const router = createMemoryRouter(
      [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
      { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
    );
    screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
    await settle(100);

    await type("typed while busy");
    await enter();
    await enter({ meta: true });
    const during = frame();

    expect(during).toContain("esc to interrupt");
    expect(during).not.toContain("typed while busy");
    expect(during).not.toContain("enter steers");
    expect(during).not.toContain("queued");
    release.resolve();
    await settle(100);
  }, 30000);
});

// B2: pi's session shutdown (an extension or MCP server closing) runs after the answer, while the turn still counts as running.
describe("after pi has settled (S4)", () => {
  test("the turn stops advertising steering, a draft stays in the input, and it can be sent once the turn ends", async () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "slow-shutdown.ts"),
      `export default function (pi: any) { pi.on("session_shutdown", async () => { await new Promise((r) => setTimeout(r, 1500)); }); }\n`,
    );
    const first = gated(() => [fauxText("first answer")]);
    const { faux } = await openPiSession([first.step, fauxAssistantMessage([fauxText("second answer")])]);
    await first.started;

    await type("late words");
    expect(frame()).toContain("enter steers");
    first.release();

    // The answer is in and pi is shutting down: no steering is offered, and Enter does not send the draft anywhere.
    const closing = await frameContaining("turn ending");
    expect(closing).toContain("first answer");
    expect(closing).not.toContain("enter steers");
    expect(closing).toContain("late words");
    await enter();
    await enter({ meta: true });
    expect(frame()).toContain("late words");
    expect(frame()).not.toContain("pending");
    expect(frame()).not.toContain("queued");
    expect(faux.state.callCount).toBe(1);

    // Once the turn is over the draft is sent as the next prompt.
    await frameWithout("turn ending", 15000);
    expect(frame()).toContain("late words");
    expect(frame()).not.toContain("enter steers");
    await enter();
    const done = await frameContaining("second answer");
    expect(done).toContain("second answer");
    expect(faux.state.callCount).toBe(2);
    expect(occurrences(done, "late words")).toBe(1);
  }, 40000);
});
