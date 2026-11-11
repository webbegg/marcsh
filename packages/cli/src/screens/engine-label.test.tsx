import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import type { ModelRuntime as PiModelRuntime } from "@earendil-works/pi-coding-agent";
import cliPackage from "../../package.json";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-engine-label-"));
const prefsPath = join(prefsDir, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxProvider, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
type Engine = import("../lib/engine/types").Engine;

const PI_VERSION = cliPackage.dependencies["@earendil-works/pi-coding-agent"];

// A pi runtime with one logged-in fake model, so the status line names a model and the engine after it.
let runtime: PiModelRuntime;
async function createRuntime() {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("fake-a", async () => ({ type: "api_key", key: "key-fake-a" }));
  runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const faux = fauxProvider({ provider: "fake-a", models: [{ id: "a-1", name: "Alpha One" }] });
  runtime.registerNativeProvider({
    ...faux.provider,
    id: "fake-a",
    name: "Fake A",
    auth: {
      apiKey: {
        name: "Fake A API key",
        login: async (interaction: any) => ({ type: "api_key" as const, key: await interaction.prompt({ type: "secret", message: "Enter your API key" }) }),
        resolve: async ({ credential }: { credential?: { key?: string } }) =>
          credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
      },
    },
  });
}

const fakePi: Engine & { getRuntime: () => Promise<typeof runtime>; getDeviceId: () => Promise<string> } = {
  id: "pi",
  startTurn: () => ({ done: Promise.resolve(), interrupt() {} }),
  warmUpCommands: async () => {},
  // The machine's own environment (API keys) must not add models to these tests.
  getRuntime: async () =>
    new Proxy(runtime, {
      get(target, property) {
        if (property === "getAvailable") {
          return async (...args: Parameters<typeof target.getAvailable>) =>
            (await target.getAvailable(...args)).filter((model) => model.provider.startsWith("fake-"));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  getDeviceId: async () => "device-1",
};

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());

async function open(path: string) {
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }, { path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [path] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
  await settle(150);
}

const openSession = (engine: string) => {
  const session = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine });
  return open(`/sessions/${session.id}`);
};

beforeAll(() => engines.set("pi", fakePi));
afterAll(() => {
  engines.set("pi", undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});
beforeEach(() => createRuntime());
afterEach(async () => {
  rmSync(prefsPath, { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("the prompt's status line names the engine (S5)", () => {
  test("the pin is an exact version", () => {
    expect(PI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("home with the default engine pi shows pi and its version, and no 'powered by' line", async () => {
    await open("/");
    expect(frame()).toContain(`fake-a/a-1 · pi v${PI_VERSION}`);
    expect(frame()).not.toContain("powered by");
  });

  test("home with Claude as the default engine shows claude, without a version", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude" }), "utf8");
    await open("/");
    expect(frame()).toContain("Build › opus · claude");
    expect(frame()).not.toMatch(/claude v\d/);
    expect(frame()).not.toContain("powered by");
  });

  test("a pi session shows pi and its version", async () => {
    await openSession("pi");
    expect(frame()).toContain(`fake-a/a-1 · pi v${PI_VERSION}`);
  });

  test("a Claude session shows claude even when the default engine is pi", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");
    await openSession("claude");
    expect(frame()).toContain("Build › opus · claude");
    expect(frame()).not.toContain("pi v");
  });

  test("the special states keep the label next to them", async () => {
    // No credentials for any model.
    runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    await openSession("pi");
    expect(frame()).toContain(`no model · run /login · pi v${PI_VERSION}`);
  });
});
