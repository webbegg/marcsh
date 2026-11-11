import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-steer-closing-prefs-"));
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
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-steer-closing-"));
  agentDir = join(dir, "agent");
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


// S4 B2 recheck: text typed while pi shuts the session down (after the answer, before the turn is over) is never dropped.
describe("typing while the turn is ending (S4)", () => {
  test("keys typed after the answer, during session shutdown, stay in the input and are sent once the turn ends", async () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "slow-shutdown.ts"),
      `export default function (pi: any) { pi.on("session_shutdown", async () => { await new Promise((r) => setTimeout(r, 2000)); }); }\n`,
    );
    const first = gated(() => [fauxText("first answer")]);
    const { faux } = await openPiSession([first.step, fauxAssistantMessage([fauxText("second answer")])]);
    await first.started;
    first.release();

    // The answer is in and pi is shutting down; the user types the next message now.
    const closing = await frameContaining("turn ending");
    expect(closing).toContain("first answer");
    await type("typed while ending");
    expect(frame()).toContain("typed while ending");

    await frameWithout("turn ending", 15000);
    expect(frame()).toContain("typed while ending");
    await enter();
    const done = await frameContaining("second answer");
    expect(faux.state.callCount).toBe(2);
    expect(occurrences(done, "typed while ending")).toBe(1);
  }, 40000);

  test("Enter, Alt+Enter and /queue while the turn is ending send nothing, keep the text in the input and keep taking keys", async () => {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "slow-shutdown.ts"),
      `export default function (pi: any) { pi.on("session_shutdown", async () => { await new Promise((r) => setTimeout(r, 2000)); }); }\n`,
    );
    const first = gated(() => [fauxText("first answer")]);
    const { faux } = await openPiSession([first.step, fauxAssistantMessage([fauxText("second answer")])]);
    await first.started;
    first.release();

    expect(await frameContaining("turn ending")).toContain("first answer");
    await type("/queue keep this");
    await enter();
    await enter({ meta: true });
    expect(frame()).toContain("/queue keep this");
    expect(frame()).toContain("turn ending");
    expect(faux.state.callCount).toBe(1);
    expect(occurrences(frame(), "keep this")).toBe(1);
    await type(" more");
    expect(frame()).toContain("/queue keep this more");

    await frameWithout("turn ending", 15000);
    expect(frame()).toContain("/queue keep this more");
    await enter();
    await frameContaining("second answer");
    expect(faux.state.callCount).toBe(2);
  }, 40000);
});
