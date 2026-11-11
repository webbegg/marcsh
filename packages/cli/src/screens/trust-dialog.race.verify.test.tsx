import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-review-prefs-"));
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
const { reviewProject, sameReview } = await import("../lib/engine/pi-trust");

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

const marker = () => join(cwd, "marker-written.txt");
const extension = (name: string) => join(cwd, ".pi", "extensions", name);
const REPLY = "turn finished";
const TITLE = "Trust this project's pi files?";
const CHANGED = "This project's pi files changed since you trusted them";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-review-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(extension("marker.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker())}, "loaded");\nexport default function () {}\n`);
  writeFileSync(extension("old.ts"), "export default function () {}\n");
  writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "fixture-mcp-server", args: ["--stdio"] } } }));
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const QUIET_MS = 350;
let lastActivityAt = 0;
const pressNow = async (key: string) => {
  lastActivityAt = Date.now();
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(10);
};
const press = async (key: string) => {
  const wait = QUIET_MS - (Date.now() - lastActivityAt);
  if (wait > 0) await settle(wait);
  await pressNow(key);
  await settle();
};
const arrowDown = async () => {
  const wait = QUIET_MS - (Date.now() - lastActivityAt);
  if (wait > 0) await settle(wait);
  lastActivityAt = Date.now();
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle();
};
const type = async (text: string) => {
  lastActivityAt = Date.now();
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const collapse = (frame: string) => frame.replace(/[│┃\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());
const frameContaining = async (text: string, timeoutMs = 8000) => {
  const start = Date.now();
  let current = frame();
  while (!current.includes(text) && Date.now() - start < timeoutMs) {
    await settle(25);
    current = frame();
  }
  lastActivityAt = Date.now();
  return current;
};

async function openPiSession(prompt?: string, size = { width: 110, height: 40 }) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText(REPLY)])]);
  const model = modelRuntime.getModel("faux", "faux-1")!;
  modelRuntime.getAvailable = async () => [model];
  engines.set("pi", createPiEngine({ agentDir, modelRuntime, pluginPath: null }));

  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    {
      initialEntries: [
        { pathname: `/sessions/${session.id}`, state: prompt ? { initialPrompt: { message: prompt, mode: "BUILD", model: "opus" } } : undefined },
      ],
    },
  );
  screen = await testRender(<RouterProvider router={router} />, size);
  await settle();
  return session;
}

/** The project is trusted as it is now; then a file is edited, one is added and one is removed. */
const trustThenChange = () => {
  getStorage().setProjectTrust(cwd, "trusted", reviewProject(cwd).record);
  writeFileSync(extension("marker.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker())}, "loaded again");\nexport default function () {}\n`);
  writeFileSync(extension("new.ts"), "export default function () {}\n");
  rmSync(extension("old.ts"));
};

describe("/trust race (verifier)", () => {
  test("files changed while the /trust listing is open: t + Enter stores nothing new", async () => {
    trustThenChange();
    const before = JSON.stringify(getStorage().getProjectReview(cwd));
    await openPiSession();
    await type("/trust");
    await press("RETURN");
    await frameContaining("Project Trust");
    await arrowDown();
    await press("RETURN");
    await frameContaining(CHANGED);
    writeFileSync(extension("late.ts"), "export default function () {}\n");
    await press("t");
    await press("RETURN");
    await settle(200);
    expect(frame()).toContain("changed while you were reviewing");
    expect(JSON.stringify(getStorage().getProjectReview(cwd))).toBe(before);
    expect(existsSync(marker())).toBe(false);
  }, 30000);
});
