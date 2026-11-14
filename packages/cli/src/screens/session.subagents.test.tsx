import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-session-subagents-prefs-"));
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
const { subagentsFor } = await import("../lib/background/session-subagents");
type TurnRequest = import("../lib/engine/types").TurnRequest;
type BackgroundHub = import("../lib/background/hub").BackgroundHub;
type SubagentRunContext = import("../lib/background/subagents").SubagentRunContext;
type ChildRun = import("../lib/engine/pi-subagent").ChildRun;

// S4a: `/subagents` lists the session's background subagents, shows one's live read-only transcript, and x cancels; the status
// line counts them.

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const hubs: BackgroundHub[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-session-subagents-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  await Promise.all(hubs.splice(0).map((hub) => hub.dispose()));
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const frameWhere = async (check: (frame: string) => boolean, timeoutMs = 8000) => {
  const start = Date.now();
  let current = frame();
  while (!check(current) && Date.now() - start < timeoutMs) {
    await settle(25);
    current = frame();
  }
  return current;
};
const frameContaining = (text: string) => frameWhere((current) => current.includes(text));
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(80);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(80);
};

/** A pi session on pi's faux provider whose first turn has ended; returns its background subagents. */
async function openPiSession() {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 3000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("faux", "faux-1")!;
  modelRuntime.getAvailable = async () => [model];
  faux.setResponses([fauxAssistantMessage([fauxText("first answer")])]);
  const real = createPiEngine({ agentDir, modelRuntime });
  const requests: TurnRequest[] = [];
  engines.set("pi", { ...real, startTurn: (request, host) => (requests.push(request), real.startTurn(request, host)) });
  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
  );
  // Wide enough for the status line to keep its background segment next to the model, usage and hint.
  screen = await testRender(<RouterProvider router={router} />, { width: 140, height: 40 });
  await settle();
  await frameContaining("first answer");
  const start = Date.now();
  while (getStorage().getSession(session.id)!.messages.length < 2 && Date.now() - start < 8000) await settle(25);
  await settle(100);
  const hub = requests[0]!.background!;
  hubs.push(hub);
  return subagentsFor(hub);
}

const said = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } }) as never;

/** A child that says `first`, then runs until it is cancelled; `contexts` collects each run's context. */
function stubRun(first: string, contexts: SubagentRunContext[]) {
  return (context: SubagentRunContext) => {
    contexts.push(context);
    context.onEvent(said(first));
    return new Promise<ChildRun>((_, reject) => context.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  };
}

describe("/subagents (S4a)", () => {
  test("lists the subagents, opens one's live transcript, and cancels it", async () => {
    const subagents = await openPiSession();
    const contexts: SubagentRunContext[] = [];
    const snapshot = await act(async () =>
      subagents.start({ description: "scan the repo", prompt: "Look for PROMPT-MARK everywhere", run: stubRun("CHILD-SAYS-HI", contexts) }),
    );
    expect(await frameContaining("1 background subagent running · /subagents")).toContain("1 background subagent running · /subagents");

    await type("/subagents");
    await press("RETURN");
    const list = await frameContaining("Background subagents");
    expect(list).toMatch(/running scan the repo .*\ds 1 running of 1 · enter transcript · x cancel · esc close/);

    await press("RETURN");
    const transcript = await frameWhere((current) => current.includes("CHILD-SAYS-HI") && current.includes("PROMPT-MARK"));
    expect(transcript).toContain("running · scan the repo");
    expect(transcript).toContain("Look for PROMPT-MARK everywhere");
    expect(transcript).toContain("CHILD-SAYS-HI");

    // The view is live: a later event of the child shows without reopening it.
    await act(async () => contexts[0]!.onEvent(said("CHILD-UPDATE-TWO")));
    expect(await frameContaining("CHILD-UPDATE-TWO")).toContain("CHILD-UPDATE-TWO");

    await type("x");
    await frameWhere(() => snapshot.status !== "running");
    expect(snapshot.status).toBe("stopped");
    expect(await frameContaining("stopped · scan the repo")).toContain("stopped · scan the repo");
    expect(await frameWhere((current) => !current.includes("background subagent running"))).not.toContain("background subagent running");
  }, 30000);

  test("x cancels the highlighted subagent from the list", async () => {
    const subagents = await openPiSession();
    const contexts: SubagentRunContext[] = [];
    const older = await act(async () => subagents.start({ description: "older", prompt: "first job", run: stubRun("ONE", contexts) }));
    const newer = await act(async () => subagents.start({ description: "newer", prompt: "second job", run: stubRun("TWO", contexts) }));
    expect(await frameContaining("2 background subagents running · /subagents")).toContain("2 background subagents running · /subagents");

    await type("/subagents");
    await press("RETURN");
    await frameContaining("2 running of 2");
    // Newest first: the second row is the older one.
    await act(async () => screen!.mockInput.pressArrow("down"));
    await settle(80);
    await type("x");
    await frameWhere(() => older.status !== "running");
    expect(older.status).toBe("stopped");
    expect(newer.status).toBe("running");
    expect(await frameContaining("1 running of 2")).toContain("stopped older");
  }, 30000);
});
