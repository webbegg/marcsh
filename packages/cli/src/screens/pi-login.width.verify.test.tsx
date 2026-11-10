// S12 (T11 A2): the masked API-key field keeps the whole "(N characters)" label for a 5,008-char paste at 110 to 40 columns.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import type { ModelRuntime as PiModelRuntime } from "@earendil-works/pi-coding-agent";

process.env.MARCSH_DB_PATH = process.env.VERIFY_DB ?? ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "verify-login-"));
const prefsPath = join(prefsDir, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxProvider, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { setUrlOpener } = await import("../lib/engine/pi-auth");
type Engine = import("../lib/engine/types").Engine;
type TurnRequest = import("../lib/engine/types").TurnRequest;

const SECRETS: string[] = [];
const secret = (s: string) => (SECRETS.push(s), s);

function fp(id: string, name: string, auth: any, models = [{ id: `${id}-m`, name: `${id} model` }]) {
  const faux = fauxProvider({ provider: id, models });
  return { ...faux.provider, id, name, auth };
}
const resolve = async ({ credential }: any) => (credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined);
let exchangeDone = false;
const providers = [
  fp("v-key", "V Keyed", { apiKey: { name: "V Keyed API key", login: async (i: any) => ({ type: "api_key", key: await i.prompt({ type: "secret", message: "Enter your API key" }) }), resolve } }),
  fp("v-echo", "V Echo", { apiKey: { name: "V Echo API key", login: async (i: any) => { const k = await i.prompt({ type: "secret", message: "Enter key" }); throw new Error(`401 Unauthorized: {"error":"invalid_api_key","api_key":"${k}","url":"https://api.test/v1?key=${k}"}`); }, resolve } }),
  fp("v-select", "V Select", { oauth: { name: "V Select OAuth", login: async (i: any) => { await i.prompt({ type: "select", message: "Pick a method", options: [{ id: "a", label: "Method A" }, { id: "b", label: "Method B" }] }); return { type: "oauth", access: "x", refresh: "y", expires: Date.now() + 1e6 }; }, refresh: async (c: any) => c, toAuth: async (c: any) => ({ apiKey: c.access }) } }),
  fp("v-slow", "V Slow", { oauth: { name: "V Slow OAuth", login: async (i: any) => { await i.prompt({ type: "manual_code", message: "Paste code" }); await new Promise((r) => setTimeout(r, 400)); exchangeDone = true; return { type: "oauth", access: "slow-access", refresh: "r", expires: Date.now() + 1e6 }; }, refresh: async (c: any) => c, toAuth: async (c: any) => ({ apiKey: c.access }) } }),
];

let credentials: InstanceType<typeof InMemoryCredentialStore>;
let runtime: PiModelRuntime;
let isolated: PiModelRuntime;
let runtimeCalls = 0;
let claudeRequests: TurnRequest[] = [];
const fakePi: any = {
  id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {},
  getRuntime: async () => (runtimeCalls++, isolated), getDeviceId: async () => "device-1",
};
const fakeClaude: Engine = {
  id: "claude",
  startTurn: (request, host) => { claudeRequests.push(request); host.emit({ type: "reply", update: (r) => ({ ...r, parts: [...r.parts, { type: "text", text: "claude answered" }] }) }); return { done: Promise.resolve(), interrupt() {} }; },
  warmUpCommands: async () => {},
};

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const press = async (key: string) => { await act(async () => screen!.mockInput.pressKey(key as never)); await settle(60); };
const type = async (text: string) => { await act(() => screen!.mockInput.typeText(text)); await settle(60); };
const paste = async (text: string) => { await act(() => screen!.mockInput.pasteBracketedText(text)); await settle(60); };
const raw = () => screen!.captureCharFrame();
const frame = () => raw().replace(/[│\s]+/g, " ");
const noWindow = (text: string, s: string, w = 8) => { for (let i = 0; i + w <= s.length; i += 1) if (text.includes(s.slice(i, i + w))) return s.slice(i, i + w); return null; };

async function openSession(engine: string, size = { width: 110, height: 40 }) {
  const session = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine });
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }], { initialEntries: [`/sessions/${session.id}`] });
  screen = await testRender(<RouterProvider router={router} />, size);
  await settle(120);
}
async function run(command: string) { await type(command); await press("RETURN"); await settle(120); }

beforeAll(() => { engines.set("pi", fakePi); engines.set("claude", fakeClaude); });
afterAll(() => { engines.set("pi", undefined); engines.set("claude", undefined); });
beforeEach(async () => {
  credentials = new InMemoryCredentialStore();
  runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  for (const p of providers) runtime.registerNativeProvider(p as any);
  isolated = new Proxy(runtime, { get(t, p) { if (p === "getAvailable") return async (...a: any[]) => (await (t.getAvailable as any)(...a)).filter((m: any) => m.provider.startsWith("v-")); const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; } });
  setUrlOpener(() => {});
  exchangeDone = false; runtimeCalls = 0; claudeRequests = [];
});
afterEach(async () => { setUrlOpener(undefined); if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy()); screen = null; });

const key5008 = "sk-" + "abcdefghij".repeat(500) + "XYZab";
describe("A2 probe", () => {
  for (const width of [110, 80, 60, 50, 40]) {
    test(`api-key dialog at ${width}x30 shows the full (5008 characters) label`, async () => {
      expect(key5008).toHaveLength(5008);
      await openSession("pi", { width, height: 30 });
      await run("/login");
      await type("v keyed");
      await press("RETURN");
      await paste(key5008);
      const f = raw();
      const line = f.split("\n").find((l) => l.includes("•")) ?? "";
      expect(line).toContain("(5008 characters)");
      expect(noWindow(f, key5008.slice(3))).toBeNull();
      // label stays inside the dialog: the line's right border is still after the label
      const idx = line.indexOf("(5008 characters)");
      expect(line.slice(idx + 17).length).toBeGreaterThanOrEqual(2);
      await press("RETURN");
      await settle(150);
      expect(await credentials.read("v-key")).toEqual({ type: "api_key", key: key5008 });
    });
  }
  test("short typed key still reads (3 characters)", async () => {
    await openSession("pi", { width: 80, height: 30 });
    await run("/login");
    await type("v keyed");
    await press("RETURN");
    await type("abc");
    expect(raw().split("\n").find((l) => l.includes("•"))).toContain("••• (3 characters)");
  });
});
