// S12 (credentials): verifier probes for pi-auth: redaction, cancel during exchange, concurrent logins, logout scope, opener filter.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, InMemoryCredentialStore, type ProviderAuth } from "@earendil-works/pi-ai";
import { listLoginProviders, listStoredLogins, redactSecrets, removeLogin, runLogin, setUrlOpener, type LoginUi } from "./pi-auth";

function fakeProvider(id: string, name: string, auth: ProviderAuth) {
  const faux = fauxProvider({ provider: id, models: [{ id: `${id}-model` }] });
  return { ...faux.provider, id, name, auth };
}
const keyedThrowing = (id: string, makeError: (key: string) => string) =>
  fakeProvider(id, id, {
    apiKey: {
      name: `${id} key`,
      login: async (i) => {
        const key = await i.prompt({ type: "secret", message: "key" });
        throw new Error(makeError(key));
      },
      resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined),
    },
  });
const ui = (answer: string): LoginUi => ({ notify() {}, prompt: async () => answer });

async function runtimeWith(...providers: ReturnType<typeof fakeProvider>[]) {
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  for (const p of providers) runtime.registerNativeProvider(p);
  return { runtime, credentials };
}

let opened: string[] = [];
beforeEach(() => { opened = []; setUrlOpener((u) => void opened.push(u)); });
afterEach(() => setUrlOpener(undefined));

describe("V1 error redaction of what the user typed", () => {
  const cases: [string, string, (k: string) => string][] = [
    ["plain echo, short key", "sk-ab12", (k) => `invalid key ${k}`],
    ["json body", "sk-proj-Ab12Cd34", (k) => `401 {"error":{"message":"bad","key":"${k}"}}`],
    ["url query", "AIzaShort123", (k) => `GET https://api.example.test/v1?key=${k}&x=1 failed`],
    ["key with slash/plus/equals", "abc/DEF+ghi=jkl", (k) => `rejected ${k}`],
    ["long std base64 key", "Zm9vYmFyYmF6cXV4/Zm9vYmFyYmF6cXV4+Zm9vYmFyYmF6cXV4==", (k) => `rejected ${k}`],
    ["key in quoted, escaped JSON", 'sk-quote"d\\x', (k) => `body=${JSON.stringify({ key: k })}`],
    ["key at offset >300 chars", "sk-late-1234", (k) => `${"x ".repeat(200)} ${k}`],
    ["key partially echoed (last 8)", "sk-ant-api03-abcdefghij-XYZ12345", (k) => `Incorrect API key provided: sk-ant-***${k.slice(-8)}`],
  ];
  for (const [name, key, make] of cases) {
    test(name, async () => {
      const { runtime, credentials } = await runtimeWith(keyedThrowing("v-throw", make));
      const outcome = await runLogin(runtime, { id: "v-throw", authType: "api_key" }, ui(key));
      expect(outcome.status).toBe("failed");
      const msg = (outcome as { message: string }).message;

      expect(msg).not.toContain(key);
      expect(await credentials.list()).toEqual([]);
    });
  }
});

describe("V2 generic redaction (no typed secret)", () => {
  const probes: [string, string][] = [
    ["Bearer", "Authorization: Bearer sk-ant-oat01-short"],
    ["JWT", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["refresh token", "refresh_token=rt_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"],
    ["json access_token", '{"access_token":"sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789","refresh_token":"sk-ant-ort01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"}'],
    ["url token", "https://x.test/cb?code=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789&state=1"],
    ["github token", "ghu_16C7e42F292c6912E7710c838347Ae178B4a"],
    ["copilot token", "tid=abc;exp=1700000000;sku=x;8kp=1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
  ];
  for (const [name, text] of probes) {
    test(name, () => {
      const out = redactSecrets(text);
      expect(out).toContain("•••");
      for (const token of text.match(/[A-Za-z0-9_-]{20,}/g) ?? []) expect(out).not.toContain(token);

    });
  }
});

describe("V3 cancel during the exchange phase stores nothing", () => {
  test("abort after the code is submitted, before the exchange resolves", async () => {
    let finished = false;
    const slow = fakeProvider("v-slow", "Slow", {
      oauth: {
        name: "Slow OAuth",
        login: async (i) => {
          await i.prompt({ type: "manual_code", message: "code" });
          await new Promise((r) => setTimeout(r, 200));
          finished = true;
          return { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 1e6 };
        },
        refresh: async (c) => c,
        toAuth: async (c) => ({ apiKey: c.access }),
      },
    });
    const { runtime, credentials } = await runtimeWith(slow);
    const controller = new AbortController();
    const p = runLogin(runtime, { id: "v-slow", authType: "oauth" }, { notify() {}, prompt: async () => { setTimeout(() => controller.abort(), 20); return "the-code"; } }, { signal: controller.signal });
    expect(await p).toEqual({ status: "cancelled" });
    await new Promise((r) => setTimeout(r, 300));
    expect(finished).toBe(true);
    expect(await credentials.list()).toEqual([]);
  });
});

describe("V4 concurrent logins", () => {
  const instant = (id: string, delay: number) => fakeProvider(id, id, {
    apiKey: {
      name: `${id} key`,
      login: async (i) => { const key = await i.prompt({ type: "secret", message: "k" }); await new Promise((r) => setTimeout(r, delay)); return { type: "api_key", key }; },
      resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined),
    },
  });
  test("two providers at once both store; cancelling one leaves the other", async () => {
    const { runtime, credentials } = await runtimeWith(instant("v-a", 50), instant("v-b", 50), instant("v-c", 50));
    const c = new AbortController();
    const [a, b, cc] = await Promise.all([
      runLogin(runtime, { id: "v-a", authType: "api_key" }, ui("key-aaaa")),
      runLogin(runtime, { id: "v-b", authType: "api_key" }, ui("key-bbbb")),
      runLogin(runtime, { id: "v-c", authType: "api_key" }, { notify() {}, prompt: () => { setTimeout(() => c.abort(), 10); return new Promise(() => {}); } }, { signal: c.signal }),
    ]);
    expect([a.status, b.status, cc.status]).toEqual(["success", "success", "cancelled"]);
    expect((await credentials.list()).map((x) => x.providerId).sort()).toEqual(["v-a", "v-b"]);
  });
  test("same provider twice: the later one wins, no error", async () => {
    const { runtime, credentials } = await runtimeWith(instant("v-a", 30));
    const [a, b] = await Promise.all([
      runLogin(runtime, { id: "v-a", authType: "api_key" }, ui("key-first")),
      runLogin(runtime, { id: "v-a", authType: "api_key" }, ui("key-second")),
    ]);
    expect([a.status, b.status]).toEqual(["success", "success"]);
    expect(await credentials.read("v-a")).toEqual({ type: "api_key", key: "key-second" });
  });
  test("a cancelled login does not block the next login of the same provider", async () => {
    const { runtime, credentials } = await runtimeWith(instant("v-a", 10));
    const c = new AbortController();
    const first = runLogin(runtime, { id: "v-a", authType: "api_key" }, { notify() {}, prompt: () => new Promise(() => {}) }, { signal: c.signal });
    setTimeout(() => c.abort(), 10);
    expect(await first).toEqual({ status: "cancelled" });
    expect(await runLogin(runtime, { id: "v-a", authType: "api_key" }, ui("key-next"))).toEqual({ status: "success" });
    expect(await credentials.read("v-a")).toEqual({ type: "api_key", key: "key-next" });
  });
});

describe("V5 logout removes only the chosen provider", () => {
  test("three stored, remove one", async () => {
    const mk = (id: string) => fakeProvider(id, `Name ${id}`, { apiKey: { name: id, login: async () => ({ type: "api_key", key: "x" }), resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined) } });
    const { runtime, credentials } = await runtimeWith(mk("v-a"), mk("v-b"), mk("v-c"));
    for (const id of ["v-a", "v-b", "v-c"]) await credentials.modify(id, async () => ({ type: "api_key", key: `secret-${id}` }));
    await runtime.refresh();
    const logins = await listStoredLogins(runtime);
    const out = await removeLogin(runtime, logins.find((l) => l.id === "v-b")!);
    expect(out.status).toBe("success");
    expect((await credentials.list()).map((c) => c.providerId).sort()).toEqual(["v-a", "v-c"]);
    expect(await credentials.read("v-a")).toEqual({ type: "api_key", key: "secret-v-a" });
  });
});

describe("V6 opener filter", () => {
  test("only http(s) is passed on, as parsed href", async () => {
    const urls = ["javascript:alert(1)", "file:///etc/passwd", "-a Calculator", "open -a Calculator", "ssh://x", "HTTPS://Example.test/a b", "https://x.test/$(touch /tmp/pwn)`id`", "data:text/html,hi", "  https://lead.space.test  "];
    const p = fakeProvider("v-url", "U", { oauth: { name: "U", login: async (i) => { for (const url of urls) i.notify({ type: "auth_url", url }); i.notify({ type: "device_code", userCode: "X", verificationUri: "vbscript:x" }); return { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 1e6 }; }, refresh: async (c) => c, toAuth: async (c) => ({ apiKey: c.access }) } });
    const { runtime } = await runtimeWith(p);
    await runLogin(runtime, { id: "v-url", authType: "oauth" }, ui(""));
    console.log("V6 opened", JSON.stringify(opened));
    for (const u of opened) expect(u.startsWith("http://") || u.startsWith("https://")).toBe(true);
  });
});
