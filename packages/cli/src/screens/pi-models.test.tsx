import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import type { ModelRuntime as PiModelRuntime } from "@earendil-works/pi-coding-agent";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-models-screen-"));
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
const { PI_DEFAULT_MODEL } = await import("../lib/models");
type Engine = import("../lib/engine/types").Engine;
type TurnRequest = import("../lib/engine/types").TurnRequest;

function fakeProvider(id: string, name: string, models: { id: string; name: string }[], withLogin = false) {
  const faux = fauxProvider({ provider: id, models });
  return {
    ...faux.provider,
    id,
    name,
    auth: {
      apiKey: {
        name: `${name} API key`,
        ...(withLogin
          ? { login: async (interaction: any) => ({ type: "api_key" as const, key: await interaction.prompt({ type: "secret", message: "Enter your API key" }) }) }
          : {}),
        resolve: async ({ credential }: { credential?: { key?: string } }) =>
          credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
      },
    },
  };
}

let credentials: InstanceType<typeof InMemoryCredentialStore>;
let piRequests: TurnRequest[] = [];
let runtime: PiModelRuntime;
// The machine's own environment (API keys, cloud credentials) must not add models to these tests.
let isolated: typeof runtime;

async function createRuntime(loggedIn: string[]) {
  credentials = new InMemoryCredentialStore();
  for (const id of loggedIn) await credentials.modify(id, async () => ({ type: "api_key", key: `key-${id}` }));
  runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  runtime.registerNativeProvider(fakeProvider("fake-a", "Fake A", [{ id: "a-1", name: "Alpha One" }]));
  runtime.registerNativeProvider(fakeProvider("fake-b", "Fake B", [{ id: "b-1", name: "Beta One" }, { id: "b-2", name: "Beta Two" }]));
  runtime.registerNativeProvider(fakeProvider("fake-key", "Fake Keyed", [{ id: "k-1", name: "Keyed One" }], true));
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
    host.emit({
      type: "reply",
      update: (reply) => ({ ...reply, parts: [...reply.parts, { type: "text", text: "pi answered" }] }),
    });
    return { done: Promise.resolve(), interrupt() {} };
  },
  warmUpCommands: async () => {},
  getRuntime: async () => isolated,
  getDeviceId: async () => "device-1",
};

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};
const pressDown = async () => {
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());
const savedPreferences = () => JSON.parse(readFileSync(prefsPath, "utf8"));

async function openSession(engine: string) {
  const session = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [`/sessions/${session.id}`] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
  await settle(120);
}

async function run(command: string) {
  await type(command);
  await press("RETURN");
  await settle(120);
}

async function send(text: string) {
  await type(text);
  await press("RETURN");
  await settle(100);
}

beforeAll(() => engines.set("pi", fakePi));
afterAll(() => {
  engines.set("pi", undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});

beforeEach(() => createRuntime(["fake-a", "fake-b"]));

afterEach(async () => {
  piRequests = [];
  rmSync(prefsPath, { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("/models on a pi session (S12)", () => {
  test("lists the models that have credentials, marks the current one, and the choice drives the next turn and new sessions", async () => {
    await openSession("pi");
    // Alpha One is the first available model; the saved default pi model is not available here.
    expect(frame()).toContain("fake-a/a-1 · pi");

    await run("/models");

    const listed = frame();
    expect(listed).toContain("Select Model");
    expect(listed).toContain("• fake-a/a-1");
    expect(listed).toContain("Alpha One");
    expect(listed).toContain("fake-b/b-1");
    expect(listed).toContain("Beta Two");
    expect(listed).not.toContain("fake-key/k-1");
    expect(listed).not.toContain("sonnet");

    await pressDown();
    await pressDown();
    await press("RETURN");

    const chosen = frame();
    expect(chosen).toContain("pi will use fake-b/b-2");
    expect(chosen).not.toContain("Select Model");
    expect(chosen).toContain("fake-b/b-2 · pi");
    expect(savedPreferences().piModel).toBe("fake-b/b-2");

    await send("hello");
    expect(piRequests.map((r) => [r.prompt, r.model])).toEqual([["hello", "fake-b/b-2"]]);
    expect(piRequests[0]!.model).not.toBe(PI_DEFAULT_MODEL);

    // The current one is marked when the picker opens again.
    await run("/models");
    expect(frame()).toContain("• fake-b/b-2");
  });

  test("a new pi session starts on the stored model", async () => {
    writeFileSync(prefsPath, JSON.stringify({ piModel: "fake-b/b-1" }), "utf8");

    await openSession("pi");
    expect(frame()).toContain("fake-b/b-1 · pi");

    await send("hello");
    expect(piRequests.map((r) => r.model)).toEqual(["fake-b/b-1"]);
  });

  test("a stored model that is not available falls back to the first available one, and the preference is kept", async () => {
    writeFileSync(prefsPath, JSON.stringify({ piModel: "fake-key/k-1" }), "utf8");

    await openSession("pi");
    await send("hello");

    expect(piRequests.map((r) => r.model)).toEqual(["fake-a/a-1"]);
    expect(savedPreferences().piModel).toBe("fake-key/k-1");

    // Once its provider has credentials again, the stored model is back in use.
    await credentials.modify("fake-key", async () => ({ type: "api_key", key: "key-fake-key" }));
    await runtime.refresh();
    await send("again");
    expect(piRequests.map((r) => r.model)).toEqual(["fake-a/a-1", "fake-key/k-1"]);
  });

  test("with no model that has credentials, a toast points at /login and no dialog opens", async () => {
    await createRuntime([]);
    await openSession("pi");
    expect(frame()).toContain(`${PI_DEFAULT_MODEL} · pi`);

    await run("/models");

    const text = frame();
    expect(text).toContain("No pi model is available yet");
    expect(text).toContain("/login");
    expect(text).not.toContain("Select Model");
    expect(text).not.toContain("Search models");
  });

  test("after /login the picker and the next turn see the new credentials without a restart", async () => {
    await createRuntime([]);
    await openSession("pi");

    await run("/login");
    await type("fake keyed");
    await press("RETURN");
    await type("sk-test-123456");
    await press("RETURN");
    await settle(150);
    expect(frame()).toContain("Saved API key for Fake Keyed");
    expect(frame()).toContain("fake-key/k-1 · pi");

    await run("/models");
    expect(frame()).toContain("• fake-key/k-1");

    await press("ESCAPE");
    await send("hello");
    expect(piRequests.map((r) => r.model)).toEqual(["fake-key/k-1"]);
  });

  test("a Claude session keeps the Claude picker", async () => {
    await openSession("claude");

    await run("/models");

    const text = frame();
    expect(text).toContain("Select Model");
    expect(text).toContain("opus");
    expect(text).toContain("sonnet");
    expect(text).toContain("haiku");
    expect(text).not.toContain("fake-a/a-1");
  });
});
