import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-trust-layout-prefs-"));
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
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-trust-layout-"));
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
  await settle(200);
}

test("S18: at 80x24 the title, folder, item count and key hints are all on screen together", async () => {
  for (let i = 1; i <= 13; i++) writeFileSync(join(cwd, ".pi", "extensions", `e${String(i).padStart(2, "0")}.ts`), "export default function () {}\n");
  const long = `echo ${"benign ".repeat(40)}; touch ${join(dir, "evil-ran")}`;
  writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh", args: ["-c", long] } } }));
  await openPrompt(80, 24);

  const text = flat();
  expect(text).toContain("Trust this project's pi files?");
  expect(text).toContain("items pi would load or run");
  expect(text).toContain("d don't trust");
  expect(text).toContain("server evil: sh -c echo");
  expect(existsSync(join(dir, "evil-ran"))).toBe(false);
}, 30000);

// Rows a little shorter than the terminal width wrap in the real layout; the list must then either show the last
// entry or say that it scrolls.
for (const [label, name] of [
  ["ASCII names close to the row width", (i: number) => `helper_${String(i).padStart(2, "0")}_${"a".repeat(43)}.ts`],
  ["CJK (double-width) names", (i: number) => `a-${"日本語の拡張機能".repeat(5)}-${i}.ts`],
] as const) {
  test(`S18: ${label}: the last extension is visible or the list says it scrolls`, async () => {
    for (let i = 0; i < 10; i++) writeFileSync(join(cwd, ".pi", "extensions", name(i)), "export default function () {}\n");
    writeFileSync(join(cwd, ".pi", "extensions", "zz-evil.ts"), "export default function () {}\n");
    await openPrompt(80, 40);

    const text = flat();
    expect(text).toContain("Trust this project's pi files?");
    expect(text.includes("zz-evil.ts") || text.includes("PgUp/PgDn scroll")).toBe(true);
  }, 30000);
}
