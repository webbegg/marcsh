import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-status-widths-prefs-"));
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
type FauxResponseStep = import("@earendil-works/pi-ai").FauxResponseStep;

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-status-widths-"));
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

// A response held back until `release()`; `started` resolves once the model is asked for it.
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

async function openPiSession(responses: FauxResponseStep[], width: number) {
  const faux = fauxProvider({ models: [{ id: "fake-model-1" }], tokensPerSecond: 3000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("faux", "fake-model-1")!;
  modelRuntime.getAvailable = async () => [model];
  faux.setResponses(responses);
  engines.set("pi", createPiEngine({ agentDir, modelRuntime }));
  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width, height: 40 });
  await settle();
}

// S5 + the L10 choice: during a pi turn the input's status line stays on one row; the engine label is never cut, only the hint
// shortens or goes. Wide terminals keep the full wording.
describe("the pi status line during a turn, by terminal width", () => {
  for (const [width, hint] of [[120, "enter steers · alt+enter queues"], [80, "steer"], [66, null], [60, null]] as const) {
    test(`${width} columns: one row, \`· pi v\` label whole${hint ? `, hint shows ${hint}` : ""}`, async () => {
      const first = gated(() => [fauxText("first answer")]);
      await openPiSession([first.step], width);
      await first.started;
      await settle(100);

      const rows = screen!.captureCharFrame().split("\n");
      const status = rows.findLastIndex((row) => row.includes("Build ›"));
      expect(status).toBeGreaterThanOrEqual(0);
      expect(rows[status]).toMatch(/faux\/fake-model-1 · pi v\d+\.\d+\.\d+/);
      if (hint) expect(rows[status]).toContain(hint);
      // Nothing of the line spilled onto the row below it.
      expect(rows[status + 1]).not.toMatch(/queue|steer|pi v|\d+\.\d+/);
      first.release();
    }, 30000);
  }
});
