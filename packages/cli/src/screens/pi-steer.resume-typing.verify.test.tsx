import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-steer-resume-prefs-"));
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
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-steer-resume-"));
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
// S4: "keys typed into the input never answer a prompt". With the input on during a pi turn, the user composes a steer;
// an approval opening while they pause (here 0.5 s, longer than the 300 ms quiet window) must not be answered by the
// next word they type into what they believe is still the input ("auth" starts with `a` = always allow).
// Such a prompt opens locked: only ↓ unlocks it, and then it answers to its own keys as usual.
describe("an approval that opens while the user is composing a steer (S4)", () => {
  test("resuming typing after a short pause does not answer it", async () => {
    const first = gated(() => [fauxToolCall("bash", { command: "echo hello" }, { id: "b1" })], { stopReason: "toolUse" });
    const { faux } = await openPiSession([first.step, fauxAssistantMessage([fauxText("all done")])]);
    await first.started;

    await type("please check the ");
    first.release();
    await frameContaining("Allow");
    await settle(500);
    await type("auth module");
    await settle(100);

    expect(frame()).toContain("Allow");
    expect(frame()).not.toContain("all done");
    expect(faux.state.callCount).toBe(1);
    expect(getStorage().hasPermissionRule({ cwd, toolName: "bash", command: "echo hello" })).toBe(false);

    // The user sees it is locked, unlocks it on purpose, and then answers it.
    expect(frame()).toContain("press ↓ to answer");
    await act(async () => screen!.mockInput.pressArrow("down"));
    await settle(60);
    await settle(400);
    await press("y");
    expect(await frameContaining("all done")).toContain("all done");
    expect(faux.state.callCount).toBe(2);
  }, 30000);
});
