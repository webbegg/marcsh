import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-trust-short-prefs-"));
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

let dir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-trust-short-"));
  cwd = join(dir, "project");
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
});
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const flat = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const press = async (key: string) => {
  await settle(400);
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(50);
};

async function openPrompt(width: number, height: number) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
  const model = modelRuntime.getModel("faux", "faux-1")!;
  modelRuntime.getAvailable = async () => [model];
  engines.set("pi", createPiEngine({ agentDir: join(dir, "agent"), modelRuntime, pluginPath: null }));
  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }], {
    initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hello", mode: "BUILD", model: "opus" } } }],
  });
  screen = await testRender(<RouterProvider router={router} />, { width, height });
  const start = Date.now();
  while (!flat().includes("d don't trust") && Date.now() - start < 8000) await settle(25);
  await settle(400);
}

// S18: `t` must not arm until the whole list has been on screen, also when the terminal leaves the list one row or none.
for (const [width, height] of [
  [80, 7],
  [80, 8],
  [80, 9],
  [120, 8],
] as const) {
  test(`S18: at ${width}x${height} t and Enter do not trust a list that was never shown whole`, async () => {
    for (let i = 1; i <= 13; i++) writeFileSync(join(cwd, ".pi", "extensions", `e${String(i).padStart(2, "0")}.ts`), "export default function () {}\n");
    writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh", args: ["-c", `touch ${join(dir, "evil-ran")}`] } } }));
    await openPrompt(width, height);

    expect(flat()).toContain("d don't trust");
    expect(flat()).not.toContain("trust (then Enter)");
    await press("t");
    await press("RETURN");
    await settle(300);

    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    expect(existsSync(join(dir, "evil-ran"))).toBe(false);
  }, 30000);
}

const writeExtensions = (count: number) => {
  for (let i = 1; i <= count; i++) writeFileSync(join(cwd, ".pi", "extensions", `e${String(i).padStart(2, "0")}.ts`), "export default function () {}\n");
  writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh", args: ["-c", `touch ${join(dir, "evil-ran")}`] } } }));
};
const pageDown = async (times: number) => {
  for (let i = 0; i < times; i++) {
    await act(async () => screen!.mockInput.pressKey("\u001b[6~" as never));
    await settle(30);
  }
};

test("S18: at 80x9 the terminal is said to be too small, t is never offered, d and Esc still answer", async () => {
  writeExtensions(13);
  await openPrompt(80, 9);

  expect(flat()).toContain("too small to review the list");
  expect(flat()).toContain("make it taller");
  expect(flat()).not.toContain("scroll to the end first");
  await press("t");
  expect(flat()).not.toContain("press Enter to trust");
  await press("d");

  const start = Date.now();
  while (getStorage().getProjectTrust(cwd) === null && Date.now() - start < 5000) await settle(25);
  expect(getStorage().getProjectTrust(cwd)).toBe("untrusted");
  expect(existsSync(join(dir, "evil-ran"))).toBe(false);
}, 30000);

test("S18: after a resize from 80x8 to 80x30 the prompt works normally: t waits for the end of the list, then t and Enter trust", async () => {
  writeExtensions(60);
  await openPrompt(80, 8);
  await press("t");
  await press("RETURN");
  expect(getStorage().getProjectTrust(cwd)).toBeNull();

  await act(async () => screen!.resize(80, 30));
  await settle(400);

  expect(flat()).not.toContain("too small");
  expect(flat()).toContain("scroll to the end first");
  await press("t");
  expect(flat()).not.toContain("press Enter to trust");
  await pageDown(20);
  expect(flat()).not.toContain("scroll to the end first");
  await press("t");
  expect(flat()).toContain("press Enter to trust");
  await press("RETURN");

  const start = Date.now();
  while (getStorage().getProjectTrust(cwd) === null && Date.now() - start < 5000) await settle(25);
  expect(getStorage().getProjectTrust(cwd)).toBe("trusted");
}, 30000);

test("S18: a list read to the end at a tall size cannot be trusted after the terminal shrinks below the minimum", async () => {
  writeExtensions(60);
  await openPrompt(80, 30);
  await pageDown(20);
  await settle(300);
  expect(flat()).toContain("trust (then Enter)");

  await act(async () => screen!.resize(80, 8));
  await settle(400);
  await press("t");
  await press("RETURN");
  await settle(300);

  expect(flat()).toContain("too small to review the list");
  expect(getStorage().getProjectTrust(cwd)).toBeNull();
  expect(existsSync(join(dir, "evil-ran"))).toBe(false);
}, 30000);

// Around the point where the list stops fitting: whatever the size, an unread 60-entry list is never trusted by t + Enter, and d is always on screen.
for (const width of [80, 120] as const) {
  for (const height of [10, 11, 12, 13] as const) {
    test(`S18: at ${width}x${height} an unread list is not trusted by t and Enter, and d is on screen`, async () => {
      writeExtensions(60);
      await openPrompt(width, height);

      expect(flat()).toContain("d don't trust");
      await press("t");
      await press("RETURN");
      await settle(300);

      expect(getStorage().getProjectTrust(cwd)).toBeNull();
      expect(existsSync(join(dir, "evil-ran"))).toBe(false);
    }, 30000);
  }
}
