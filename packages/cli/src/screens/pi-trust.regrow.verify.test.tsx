import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-trust-regrow-prefs-"));
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
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-trust-regrow-"));
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


const writeProject = () => {
  for (let i = 1; i <= 60; i++) writeFileSync(join(cwd, ".pi", "extensions", `e${String(i).padStart(2, "0")}.ts`), "export default function () {}\n");
  writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh", args: ["-c", `touch ${join(dir, "evil-ran")}`] } } }));
};
const rawLines = () => screen!.captureCharFrame().split("\n");

// S18: a prompt that opened too small must lay out like a fresh one once the terminal grows, so the list keeps every
// row it would have and the footer stays one block (warning right above the hints) at the bottom.
for (const [width, height] of [
  [80, 30],
  [80, 14],
  [120, 12],
] as const) {
  test(`S18: opened at 80x8 then grown to ${width}x${height}, the prompt matches a fresh one: list scrolls, footer pinned`, async () => {
    writeProject();
    await openPrompt(80, 8);
    expect(flat()).toContain("too small to review the list");

    await act(async () => screen!.resize(width, height));
    const start = Date.now();
    while (!flat().includes("PgUp/PgDn") && Date.now() - start < 3000) await settle(25);
    await settle(300);

    const lines = rawLines();
    expect(flat()).not.toContain("too small");
    expect(flat()).toContain("scroll to the end first");
    expect(lines[height - 2]).toMatch(/d {2}don't trust {2}Esc {2}not now \(this turn only\)/);
    expect(lines[height - 3]).toContain("Trusting lets pi load these files and run their code with your permissions.");
    expect(lines[height - 4]).toMatch(/rows 1–\d+ of \d+ · ↑\/↓ PgUp\/PgDn/);

    await press("t");
    await press("RETURN");
    await settle(300);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    expect(existsSync(join(dir, "evil-ran"))).toBe(false);
  }, 30000);
}
