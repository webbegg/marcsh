import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-hardening-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { testRender } = await import("@opentui/react/test-utils");
const { useRenderer } = await import("@opentui/react");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { createPiEngine } = await import("../lib/engine/pi");
const { handOffDraft, LOCKED_LINE } = await import("../lib/prompt-lock");
type FauxResponseStep = import("@earendil-works/pi-ai").FauxResponseStep;
type Engine = import("../lib/engine/types").Engine;

// Pre-PR hardening of S4 (typed text is never silently lost) and the prompt lock (Claude sessions unchanged).

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-hardening-"));
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
const collapse = (frame: string) => frame.replace(/[│┃\s]+/g, " ");
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
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(60);
};
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};

function gated(content: () => Parameters<typeof fauxAssistantMessage>[0]) {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const step: FauxResponseStep = async () => {
    started.resolve();
    await gate.promise;
    return fauxAssistantMessage(content());
  };
  return { step, started: started.promise, release: () => gate.resolve() };
}

async function openPiSession(responses: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 3000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("faux", "faux-1")!;
  modelRuntime.getAvailable = async () => [model];
  faux.setResponses(responses);
  engines.set("pi", createPiEngine({ agentDir, modelRuntime }));
  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
  await settle();
  return { faux, session };
}

const writeExtension = (name: string, source: string) => {
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", `${name}.ts`), source);
};

describe("text typed before pi has the prompt (R1-002, R4-001)", () => {
  // pi takes a second or so to start (an extension's session_start here): the turn exists and accepts text, but nothing was sent yet.
  const SLOW_START = `export default function (pi: any) { pi.on("session_start", async () => { await new Promise((r) => setTimeout(r, 1500)); }); }\n`;

  test("is shown as pending, and Esc gives it back to the input beside what was typed since, nothing replaced", async () => {
    writeExtension("slow-start", SLOW_START);
    const { faux } = await openPiSession([fauxAssistantMessage([fauxText("never asked")])]);
    await frameContaining("enter steers");

    await type("first words that must survive");
    await enter();
    const pending = await frameContaining("steer · pending");
    expect(pending).toContain("first words that must survive");
    // The input is empty again (the placeholder is back) until the user types more.
    expect(pending).toContain("Ask anything");

    await type("second draft");
    await press("ESCAPE");
    const after = await frameWithout("steer · pending");

    expect(after).toContain("first words that must survive second draft");
    expect(occurrences(after, "first words that must survive")).toBe(1);
    expect(after).not.toContain("Ask anything");
    expect(faux.state.callCount).toBe(0);
    // Said in a notice too, so the user knows why the text came back.
    expect(after).toContain("interrupted before the message was sent");
  }, 30000);

  test("a text pi refuses (an extension command) comes back whole with the reason, and is not left pending", async () => {
    writeExtension("probe-cmd", `export default function (pi: any) { pi.registerCommand("probe-cmd", { description: "probe", handler: async () => {} }); }\n`);
    const first = gated(() => [fauxText("first answer")]);
    await openPiSession([first.step]);
    await first.started;
    await frameContaining("enter steers");

    await type("/probe-cmd now please look at the whole auth folder");
    await enter();
    const after = await frameContaining("cannot be queued");

    expect(after).toContain("Warning:");
    expect(after).toContain("back in the input");
    expect(occurrences(after, "/probe-cmd now please look at the whole auth folder")).toBe(1);
    expect(after).not.toContain("pending");
    first.release();
  }, 30000);
});

describe("a Claude session's carried draft does not lock its prompts (R3-003)", () => {
  // The previous screen's input handed this text over; the session's own input is off for the whole turn.
  function Carried({ text, children }: { text: string; children: React.ReactNode }) {
    handOffDraft(useRenderer(), text);
    return <>{children}</>;
  }

  test("the approval prompt opens unlocked and answers to its own keys", async () => {
    const decisions: string[] = [];
    const claude: Engine = {
      id: "claude",
      startTurn: (_request, host) => {
        // The SDK asks after its query has started, not inside startTurn: by then the input is off.
        const done = new Promise<void>((resolve) => setTimeout(resolve, 50))
          .then(() => host.askPermission({ toolName: "Bash", input: { command: "ls" } }, new AbortController().signal))
          .then((decision) => void decisions.push(decision));
        return { done, interrupt: () => {} };
      },
      warmUpCommands: async () => {},
    };
    engines.set("claude", claude);
    const session = getStorage().createSession({ title: "chat", cwd, engine: "claude" });
    const router = createMemoryRouter(
      [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
      { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
    );
    screen = await testRender(
      <Carried text="a draft from the screen before">
        <RouterProvider router={router} />
      </Carried>,
      { width: 110, height: 40 },
    );
    await frameContaining("Allow");
    // Past the quiet window, as a user who pauses before answering.
    await settle(500);

    const shown = frame();
    expect(shown).toContain("a draft from the screen before");
    expect(shown).not.toContain(LOCKED_LINE);

    await press("y");
    await settle(100);
    expect(decisions).toEqual(["allow"]);
  }, 30000);
});
