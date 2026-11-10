import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import type { ModelRuntime as PiModelRuntime } from "@earendil-works/pi-coding-agent";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-status-screen-"));
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
const { PI_DEFAULT_MODEL } = await import("../lib/models");
const { piModelCheck } = await import("../providers/prompt-config");
type Engine = import("../lib/engine/types").Engine;
type TurnRequest = import("../lib/engine/types").TurnRequest;

function fakeProvider(id: string, name: string, models: { id: string; name: string }[]) {
  const faux = fauxProvider({ provider: id, models });
  return {
    ...faux.provider,
    id,
    name,
    auth: {
      apiKey: {
        name: `${name} API key`,
        login: async (interaction: any) => ({ type: "api_key" as const, key: await interaction.prompt({ type: "secret", message: "Enter your API key" }) }),
        resolve: async ({ credential }: { credential?: { key?: string } }) =>
          credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
      },
    },
  };
}

let credentials: InstanceType<typeof InMemoryCredentialStore>;
let runtime: PiModelRuntime;
let isolated: typeof runtime;
let piRequests: TurnRequest[] = [];
// Holds back the runtime until released, to look at the status line while the model check is still running.
let runtimeGate: Promise<void> = Promise.resolve();
// When set, asking for the runtime fails with it.
let runtimeError: Error | null = null;

async function createRuntime(loggedIn: string[]) {
  credentials = new InMemoryCredentialStore();
  for (const id of loggedIn) await credentials.modify(id, async () => ({ type: "api_key", key: `key-${id}` }));
  runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  runtime.registerNativeProvider(fakeProvider("fake-a", "Fake A", [{ id: "a-1", name: "Alpha One" }]));
  runtime.registerNativeProvider(fakeProvider("fake-b", "Fake B", [{ id: "b-1", name: "Beta One" }]));
  runtime.registerNativeProvider(fakeProvider("fake-key", "Fake Keyed", [{ id: "k-1", name: "Keyed One" }]));
  // The machine's own environment (API keys, cloud credentials) must not add models to these tests.
  isolated = new Proxy(runtime, {
    get(target, property) {
      if (property === "getAvailable") {
        return async (...args: Parameters<typeof target.getAvailable>) =>
          (await target.getAvailable(...args)).filter((model) => model.provider.startsWith("fake-"));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const fakePi: Engine & { getRuntime: () => Promise<typeof runtime>; getDeviceId: () => Promise<string> } = {
  id: "pi",
  startTurn: (request, host) => {
    piRequests.push(request);
    host.emit({ type: "reply", update: (reply) => ({ ...reply, parts: [...reply.parts, { type: "text", text: "pi answered" }] }) });
    return { done: Promise.resolve(), interrupt() {} };
  },
  warmUpCommands: async () => {},
  getRuntime: async () => {
    await runtimeGate;
    if (runtimeError) throw runtimeError;
    return isolated;
  },
  getDeviceId: async () => "device-1",
};

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());
const savedPreferences = () => JSON.parse(readFileSync(prefsPath, "utf8"));

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

async function run(command: string) {
  await type(command);
  await press("RETURN");
  await settle(120);
}

const DEFAULT_CHECK_TIMEOUT_MS = piModelCheck.timeoutMs;

beforeAll(() => engines.set("pi", fakePi));
afterAll(() => {
  engines.set("pi", undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});

beforeEach(() => createRuntime(["fake-a", "fake-b"]));

afterEach(async () => {
  piRequests = [];
  runtimeGate = Promise.resolve();
  runtimeError = null;
  piModelCheck.timeoutMs = DEFAULT_CHECK_TIMEOUT_MS;
  rmSync(prefsPath, { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("the status line on pi (S17)", () => {
  test("a pi session shows the model the next turn will use, not the built-in default", async () => {
    await openSession("pi");

    expect(frame()).toContain("fake-a/a-1 · pi");
    expect(frame()).not.toContain(PI_DEFAULT_MODEL);

    await type("hello");
    await press("RETURN");
    await settle(80);
    expect(piRequests.map((r) => r.model)).toEqual(["fake-a/a-1"]);
  });

  test("the stored model is shown while it is available", async () => {
    writeFileSync(prefsPath, JSON.stringify({ piModel: "fake-b/b-1" }), "utf8");

    await openSession("pi");

    expect(frame()).toContain("fake-b/b-1 · pi");
  });

  test("an unavailable stored model shows the fallback in use, and the stored choice is kept", async () => {
    writeFileSync(prefsPath, JSON.stringify({ piModel: "fake-key/k-1" }), "utf8");

    await openSession("pi");

    expect(frame()).toContain("fake-a/a-1 · pi");
    expect(frame()).not.toContain("fake-key/k-1");
    expect(savedPreferences().piModel).toBe("fake-key/k-1");
  });

  test("with no model that has credentials, it says to run /login instead of naming a model", async () => {
    await createRuntime([]);

    await openSession("pi");

    const text = frame();
    expect(text).toContain("/login");
    expect(text).toContain("· pi");
    expect(text).not.toContain(PI_DEFAULT_MODEL);
  });

  test("it does not name the built-in default while the first check is still running", async () => {
    let release: () => void = () => {};
    runtimeGate = new Promise<void>((resolve) => (release = resolve));

    await openSession("pi");
    expect(frame()).not.toContain(PI_DEFAULT_MODEL);

    release();
    await settle(150);
    expect(frame()).toContain("fake-a/a-1 · pi");
  });

  test("after /login the hint is replaced by the new model without a restart", async () => {
    await createRuntime([]);
    await openSession("pi");
    expect(frame()).toContain("/login");

    await run("/login");
    await type("fake keyed");
    await press("RETURN");
    await type("sk-test-123456");
    await press("RETURN");
    await settle(150);

    expect(frame()).toContain("fake-key/k-1 · pi");
    expect(frame()).not.toContain("run /login");
  });

  test("after /logout of the last provider the hint comes back", async () => {
    await createRuntime(["fake-a"]);
    await openSession("pi");
    expect(frame()).toContain("fake-a/a-1 · pi");

    await run("/logout");
    await type("fake a");
    await press("RETURN");
    await settle(150);

    expect(frame()).not.toContain("fake-a/a-1 · pi");
    expect(frame()).toContain("run /login");
  });

  test("the home screen with pi as the default engine shows the model too", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");

    await open("/");

    expect(frame()).toContain("fake-a/a-1 · pi");
    expect(frame()).not.toContain(PI_DEFAULT_MODEL);
  });

  test("the home screen with pi as the default engine and no model says to run /login", async () => {
    await createRuntime([]);
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");

    await open("/");

    expect(frame()).toContain("run /login");
    expect(frame()).not.toContain(PI_DEFAULT_MODEL);
  });

  test("a failed model check says pi is unavailable instead of naming the built-in default", async () => {
    runtimeError = new Error("cannot load pi");

    await openSession("pi");

    expect(frame()).toContain("pi unavailable");
    expect(frame()).not.toContain(PI_DEFAULT_MODEL);
    expect(frame()).not.toContain("run /login");
  });

  test("a failed check does not show the built-in default on the home screen either, with or without a stored model", async () => {
    runtimeError = new Error("cannot load pi");
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");
    await open("/");
    expect(frame()).toContain("pi unavailable");
    expect(frame()).not.toContain(PI_DEFAULT_MODEL);

    await act(async () => screen!.renderer.destroy());
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi", piModel: "fake-b/b-1" }), "utf8");
    await open("/");
    expect(frame()).toContain("pi unavailable");
    expect(frame()).not.toContain(PI_DEFAULT_MODEL);
  });

  test("a check that hangs becomes the same failure after its time limit, and the next check recovers", async () => {
    piModelCheck.timeoutMs = 200;
    let release: () => void = () => {};
    runtimeGate = new Promise<void>((resolve) => (release = resolve));

    await openSession("pi");
    expect(frame()).not.toContain("pi unavailable");
    expect(frame()).not.toContain(PI_DEFAULT_MODEL);

    await settle(400);
    expect(frame()).toContain("pi unavailable");
    expect(frame()).not.toContain(PI_DEFAULT_MODEL);

    // The runtime comes back: the next turn checks again and the line names the model it uses.
    release();
    await type("hello");
    await press("RETURN");
    await settle(150);
    expect(piRequests.map((r) => r.model)).toEqual(["fake-a/a-1"]);
    expect(frame()).toContain("fake-a/a-1 · pi");
    expect(frame()).not.toContain("pi unavailable");
  });

  test("a Claude session is unchanged", async () => {
    await openSession("claude");

    expect(frame()).toContain("Build › opus");
    expect(frame()).not.toContain("/login");
  });
});
