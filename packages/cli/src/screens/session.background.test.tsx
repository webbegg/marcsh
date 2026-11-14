import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-session-background-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { createPiEngine } = await import("../lib/engine/pi");
const { backgroundMessageText } = await import("../lib/background/hub");
type FauxResponseStep = import("@earendil-works/pi-ai").FauxResponseStep;
type Engine = import("../lib/engine/types").Engine;
type TurnRequest = import("../lib/engine/types").TurnRequest;
type ChatMessage = import("../lib/chat-types").ChatMessage;

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-session-background-"));
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
const collapse = (frame: string) => frame.replace(/[│┃\s]+/g, " ");
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

function userTexts(messages: ReadonlyArray<{ role: string; content?: unknown }>): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""),
    );
}

// A real pi engine on pi's faux provider (no network) that records each turn's request, which carries the session's hub.
async function openPiSession(responses: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 3000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("faux", "faux-1")!;
  modelRuntime.getAvailable = async () => [model];
  faux.setResponses(responses);
  const real = createPiEngine({ agentDir, modelRuntime });
  const requests: TurnRequest[] = [];
  engines.set("pi", { ...real, startTurn: (request, host) => (requests.push(request), real.startTurn(request, host)) });
  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  await openScreen(session.id, { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } });
  return { faux, session, requests };
}

async function openScreen(id: string, state?: unknown) {
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${id}`, state }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
  await settle();
}

describe("background results on the session screen (S2)", () => {
  test("a result that finishes while the session is idle starts a turn whose notice shows, and the model gets the result", async () => {
    const contexts: string[][] = [];
    const second: FauxResponseStep = (context) => {
      contexts.push(userTexts(context.messages));
      return fauxAssistantMessage([fauxText("the build passed")]);
    };
    const { faux, session, requests } = await openPiSession([fauxAssistantMessage([fauxText("first answer")]), second]);
    await frameContaining("first answer");
    // The first turn has ended (its request carried the hub).
    const start = Date.now();
    while (getStorage().getSession(session.id)!.messages.length < 2 && Date.now() - start < 8000) await settle(25);
    await settle(100);
    const hub = requests[0]!.background!;
    expect(hub).toBeDefined();

    await act(async () => hub.finish({ id: "bg-1", kind: "terminal", title: "build", text: "BUILD-LOG-TAIL exit code 0" }));
    const after = await frameContaining("the build passed");
    expect(faux.state.callCount).toBe(2);
    expect(contexts[0]).toEqual(["hi", "BUILD-LOG-TAIL exit code 0"]);
    expect(after).toContain("[background] build finished");
    // Only the notice is shown: the result itself is for the model.
    expect(after).not.toContain("BUILD-LOG-TAIL");
    // The turn runs as the session's agent and model at that moment, as a background prompt with the same hub.
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ prompt: "BUILD-LOG-TAIL exit code 0", promptKind: "background", mode: "BUILD", model: "faux/faux-1" });
    expect(requests[1]!.background).toBe(hub);

    while (getStorage().getSession(session.id)!.messages.length < 4 && Date.now() - start < 8000) await settle(25);
    const saved = getStorage().getSession(session.id)!.messages;
    expect(saved[2]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: backgroundMessageText({ notice: "[background] build finished", text: "BUILD-LOG-TAIL exit code 0" }) }],
      metadata: { background: true },
    });

    // Leaving the session disposes its hub.
    await act(async () => screen!.renderer.destroy());
    await settle();
    expect(hub.disposed).toBe(true);
  }, 30000);

  test("a resumed session shows a saved background message as its notice", async () => {
    const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
    const text = backgroundMessageText({ notice: "[background] tests finished", text: "SECRET-TAIL-OF-OUTPUT" });
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "run the tests" }], metadata: { mode: "BUILD" } },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "started them" }], metadata: { mode: "BUILD", model: "faux/faux-1" } },
      { id: "u2", role: "user", parts: [{ type: "text", text }], metadata: { mode: "BUILD", background: true } },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "all green" }], metadata: { mode: "BUILD", model: "faux/faux-1" } },
    ];
    getStorage().saveMessages(session.id, messages);
    const fake: Engine = { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt: () => {} }), warmUpCommands: async () => {} };
    engines.set("pi", fake);
    await openScreen(session.id);
    const shown = await frameContaining("all green");
    expect(shown).toContain("run the tests");
    expect(shown).toContain("[background] tests finished");
    expect(shown).not.toContain("SECRET-TAIL-OF-OUTPUT");
  }, 30000);

  test("a Claude session has no hub", async () => {
    const requests: TurnRequest[] = [];
    const fake: Engine = {
      id: "claude",
      startTurn: (request) => (requests.push(request), { done: Promise.resolve(), interrupt: () => {} }),
      warmUpCommands: async () => {},
    };
    engines.set("claude", fake);
    const session = getStorage().createSession({ title: "claude chat", cwd, engine: "claude" });
    await openScreen(session.id, { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } });
    const start = Date.now();
    while (requests.length === 0 && Date.now() - start < 5000) await settle(25);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.background).toBeUndefined();
  }, 30000);
});
