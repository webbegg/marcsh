// S12/S5: verifier screen probes: masking (long/ANSI paste, typed keys), redacted toasts, Esc on select and during exchange, Claude sessions untouched, picker persistence and fallback.
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

describe("secrets in the TUI", () => {
  test("S-a very long paste with ANSI and newlines: masked, capped, stored clean; chat input untouched afterwards", async () => {
    const body = secret("sk-LONG-" + Array.from({ length: 5000 }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[(i * 7) % 36]).join(""));
    await openSession("pi");
    await run("/login");
    await type("v keyed");
    await press("RETURN");
    await paste(`\x1b[31m${body.slice(0, 2500)}\n${body.slice(2500)}\x1b[0m\r\n`);
    const f = raw();
    expect(noWindow(f, body)).toBeNull();
    expect(f).toContain(`(${body.length}`); // the "characters" suffix is cut off at the dialog width (advisory)
    const dotsLine = f.split("\n").find((l) => l.includes("•"))!;
    expect((dotsLine.match(/•/g) ?? []).length).toBeLessThanOrEqual(40);
    await press("RETURN");
    await settle(150);
    expect(frame()).toContain("Saved API key for V Keyed");
    expect(await credentials.read("v-key")).toEqual({ type: "api_key", key: body });
    await type("hello there");
    const after = raw();
    expect(after).toContain("hello there");
    expect(noWindow(after, body)).toBeNull();
  });

  test("S-a2 keys typed into the masked field never reach the chat textarea", async () => {
    const key = secret("sk-typed-Q9w8e7r6");
    await openSession("claude");
    await run("/login");
    await type("v keyed");
    await press("RETURN");
    await type(key);
    await press("ESCAPE");
    await settle(80);
    expect(frame()).toContain("Login to V Keyed cancelled");
    expect(raw()).not.toContain("Q9w8e7r6");
    await type("x");
    await press("RETURN");
    await settle(120);
    expect(claudeRequests.map((r) => r.prompt)).toEqual(["x"]);
    expect(await credentials.list()).toEqual([]);
  });

  test("S-c a provider error echoing the key (JSON body + URL) is redacted in the toast", async () => {
    const key = secret("sk-echo-7Hh3Kk2");
    await openSession("pi");
    await run("/login");
    await type("v echo");
    await press("RETURN");
    await type(key);
    await press("RETURN");
    await settle(150);
    const f = frame();

    expect(f).toContain("Failed to log in to V Echo");
    expect(noWindow(raw(), key, 6)).toBeNull();
  });

  test("S-e Esc on a select prompt cancels and stores nothing", async () => {
    await openSession("pi");
    await run("/login");
    await type("v select");
    await press("RETURN");
    expect(frame()).toContain("Pick a method");
    await press("ESCAPE");
    await settle(80);
    expect(frame()).toContain("Login to V Select cancelled");
    expect(frame()).not.toContain("Pick a method");
    expect(await credentials.list()).toEqual([]);
  });

  test("S-f Esc after submitting the code, during the exchange: cancelled, no later success, nothing stored", async () => {
    await openSession("pi");
    await run("/login");
    await type("v slow");
    await press("RETURN");
    await paste(secret("code-SLOW-55aa"));
    await press("RETURN");
    await press("ESCAPE");
    await settle(600);
    expect(exchangeDone).toBe(true);
    const f = frame();
    expect(f).toContain("Login to V Slow cancelled");
    expect(f).not.toContain("Logged in to V Slow");
    expect(await credentials.list()).toEqual([]);
  });
});

describe("models and Claude sessions", () => {
  test("S-g a Claude session sends its Claude alias and never asks the pi runtime", async () => {
    // Claude is the stored default here: with pi as the default, the status line asks the runtime for its model.
    writeFileSync(prefsPath, JSON.stringify({ piModel: "v-key/v-key-m", defaultEngine: "claude" }));
    await openSession("claude");
    await type("hi");
    await press("RETURN");
    await settle(150);
    expect(claudeRequests.map((r) => r.model)).toEqual(["opus"]);
    expect(runtimeCalls).toBe(0);
    expect(frame()).not.toContain("v-key");
  });

  test("S-h picker lists only models with credentials; choice persists; others prefs kept; fallback keeps the file byte-identical", async () => {
    writeFileSync(prefsPath, JSON.stringify({ themeName: "nord", defaultEngine: "pi" }));
    await credentials.modify("v-key", async () => ({ type: "api_key", key: "k" }));
    await runtime.refresh();
    await openSession("pi");
    await run("/models");
    const f = frame();
    expect(f).toContain("v-key/v-key-m");
    expect(f).not.toContain("v-echo/");
    expect(f).not.toContain("v-select/");
    await press("RETURN");
    await settle(80);
    expect(JSON.parse(readFileSync(prefsPath, "utf8"))).toEqual({ themeName: "nord", defaultEngine: "pi", piModel: "v-key/v-key-m" });
    await screen!.renderer.destroy(); screen = null;

    // log out; a new mount falls back but the stored file stays byte-identical
    await credentials.delete("v-key");
    await credentials.modify("v-select", async () => ({ type: "oauth", access: "x", refresh: "y", expires: Date.now() + 1e6 }));
    await runtime.refresh();
    const hash = createHash("sha256").update(readFileSync(prefsPath)).digest("hex");
    await openSession("pi");
    await settle(150);
    expect(frame()).toContain("v-select/v-select-m · pi");
    expect(createHash("sha256").update(readFileSync(prefsPath)).digest("hex")).toBe(hash);
  });
});
