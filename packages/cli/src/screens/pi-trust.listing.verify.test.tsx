import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-trust-listing-prefs-"));
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
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-trust-listing-"));
  cwd = join(dir, "project");
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  // Thirteen harmless extension files come first in the listing...
  for (let i = 1; i <= 13; i++) writeFileSync(join(cwd, ".pi", "extensions", `e${String(i).padStart(2, "0")}.ts`), "export default function () {}\n");
  // ...and push the MCP server that trust would start out of the prompt.
  writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { hidden: { command: "sh", args: ["-c", "touch hidden-ran"] } } }));
});
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

test("S18: every MCP command the project would start is in the trust prompt, however many other files it has", async () => {
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
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 50 });
  const start = Date.now();
  while (!frame().includes("Trust this project's pi files?") && Date.now() - start < 8000) await settle(25);

  expect(frame()).toContain("Trust this project's pi files?");
  expect(frame()).toContain("server hidden: sh -c touch hidden-ran");
  expect(existsSync(join(cwd, "hidden-ran"))).toBe(false);
}, 30000);
