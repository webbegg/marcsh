import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-stream-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { createPiEngine } = await import("../lib/engine/pi");
type FauxResponseStep = import("@earendil-works/pi-ai").FauxResponseStep;

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-stream-screen-"));
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
const frameContaining = async (text: string, timeoutMs = 8000) => {
  const start = Date.now();
  let current = frame();
  while (!current.includes(text) && Date.now() - start < timeoutMs) {
    await settle(25);
    current = frame();
  }
  return current;
};

// A real pi engine on pi's faux provider (no network) that hands the reply out slowly, as a model generating it would.
async function openPiSession(responses: FauxResponseStep[], tokensPerSecond: number) {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }], tokensPerSecond, tokenSize: { min: 1, max: 1 } });
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
  return session;
}

const words = Array.from({ length: 40 }, (_, i) => `word${String(i + 1).padStart(2, "0")}`).join(" ");
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("a pi reply streams on screen (S3)", () => {
  test("shows the text while the reply is still being generated, then once it is whole", async () => {
    // 40 words of 7 characters in 4-character chunks at 70 chunks/s: about 1.6 s.
    await openPiSession([fauxAssistantMessage([fauxText(words)])], 70);

    const partial = await frameContaining("word03");

    expect(partial).toContain("word01 word02 word03");
    expect(partial).not.toContain("word40");
    // The reply is still running: the footer has no duration yet.
    expect(partial).not.toMatch(/Build › \S+ › \d/);

    const whole = await frameContaining("word40");
    await settle(100);

    expect(whole).toContain("word01 word02 word03");
    expect(occurrences(frame(), "word01")).toBe(1);
    expect(occurrences(frame(), "word40")).toBe(1);
  }, 30000);

  test("shows thinking as it streams, above the text", async () => {
    const thinking = Array.from({ length: 24 }, (_, i) => `idea${String(i + 1).padStart(2, "0")}`).join(" ");
    await openPiSession([fauxAssistantMessage([fauxThinking(thinking), fauxText("final answer")])], 70);

    const partial = await frameContaining("idea03");

    expect(partial).toContain("Thinking: idea01 idea02 idea03");
    expect(partial).not.toContain("idea24");
    expect(partial).not.toContain("final answer");

    const whole = await frameContaining("final answer");

    expect(whole).toContain("Thinking: idea01");
    expect(whole.indexOf("idea24")).toBeLessThan(whole.indexOf("final answer"));
    expect(occurrences(whole, "Thinking:")).toBe(1);
  }, 30000);
});
