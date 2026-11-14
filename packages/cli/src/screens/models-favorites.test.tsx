import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import type { ModelRuntime as PiModelRuntime } from "@earendil-works/pi-coding-agent";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-models-favorites-"));
const prefsPath = join(prefsDir, "preferences.json");
// Never the real ~/.marcsh.
process.env.MARCSH_PREFERENCES_PATH = prefsPath;
process.env.MARCSH_AGENTS_DIR = join(prefsDir, "agents");
process.env.MARCSH_COMMANDS_DIR = join(prefsDir, "commands");

let calls: { prompt: string; options: any }[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    calls.push({ prompt, options });
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0 };
    })();
    return Object.assign(messages, { interrupt: async () => {}, supportedCommands: async () => [] });
  },
}));

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxProvider, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { setNotifyDeps } = await import("../lib/notify");
const { clearDrafts } = await import("../lib/prompt-history");
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
        resolve: async ({ credential }: { credential?: { key?: string } }) =>
          credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
      },
    },
  };
}

let runtime: PiModelRuntime;
// The machine's own environment (API keys, cloud credentials) must not add models to these tests.
let isolated: typeof runtime;
let piRequests: TurnRequest[] = [];

async function createRuntime() {
  const credentials = new InMemoryCredentialStore();
  for (const id of ["fake-a", "fake-b"]) await credentials.modify(id, async () => ({ type: "api_key", key: `key-${id}` }));
  runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  runtime.registerNativeProvider(fakeProvider("fake-a", "Fake A", [{ id: "a-1", name: "Alpha One" }]));
  runtime.registerNativeProvider(fakeProvider("fake-b", "Fake B", [{ id: "b-1", name: "Beta One" }, { id: "b-2", name: "Beta Two" }]));
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
  startTurn: (request) => {
    piRequests.push(request);
    return { done: Promise.resolve(), interrupt() {} };
  },
  warmUpCommands: async () => {},
  getRuntime: async () => isolated,
  getDeviceId: async () => "device-1",
};

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const press = async (key: string, modifiers?: { ctrl?: boolean }) => {
  await act(async () => screen!.mockInput.pressKey(key as never, modifiers));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const savedPreferences = () => JSON.parse(readFileSync(prefsPath, "utf8"));
const seed = (preferences: object) => writeFileSync(prefsPath, JSON.stringify(preferences), "utf8");
/** Where each text first appears in the frame, so the order of a list can be checked. */
const dialogFrame = () => {
  const whole = frame();
  const from = whole.indexOf("Select Model");
  const to = whole.indexOf("Ask anything", from);
  return whole.slice(from, to === -1 ? undefined : to);
};
const order = (...texts: string[]) => texts.map((text) => dialogFrame().indexOf(text));

async function openSession(engine: string) {
  const session = getStorage().createSession({ title: "chat", cwd: process.cwd(), engine });
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
  await settle(150);
}

beforeAll(() => {
  engines.set("pi", fakePi);
  // Turns finishing ring a bell here; never a real one.
  setNotifyDeps({ write: () => {}, spawn: () => {} });
});
afterAll(() => {
  engines.set("pi", undefined);
  setNotifyDeps(undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  calls = [];
  piRequests = [];
  clearDrafts();
  await createRuntime();
});

afterEach(async () => {
  rmSync(prefsPath, { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("/models on a Claude session (S10)", () => {
  test("Ctrl+F toggles the highlighted model as a favorite, and favorites are listed first the next time", async () => {
    await openSession("claude");
    await run("/models");
    await press("ARROW_DOWN");
    await press("ARROW_DOWN");
    await press("f", { ctrl: true });
    expect(savedPreferences().favoriteModels).toEqual({ claude: ["haiku"] });
    expect(frame()).toContain("★");
    // The dialog stays open and the cursor stays where it was.
    expect(frame()).toContain("Select Model");

    await press("ESCAPE");
    await run("/models");
    const [opus, sonnet, haiku] = order("opus", "sonnet", "haiku");
    expect(haiku).toBeLessThan(opus!);
    expect(opus).toBeLessThan(sonnet!);

    // Toggling it again removes it.
    await press("f", { ctrl: true });
    expect(savedPreferences().favoriteModels).toEqual({ claude: [] });
  });

  test("a chosen model is a recent one, listed after the favorites and without repeats", async () => {
    seed({ favoriteModels: { claude: ["haiku"] } });
    await openSession("claude");
    await run("/models");
    // haiku (favorite) is first; sonnet is the third row.
    await press("ARROW_DOWN");
    await press("ARROW_DOWN");
    await press("RETURN");
    expect(savedPreferences().recentModels).toEqual({ claude: ["sonnet"] });

    await run("/models");
    const [haiku, sonnet, opus] = order("haiku", "sonnet", "opus");
    expect(haiku).toBeLessThan(sonnet!);
    expect(sonnet).toBeLessThan(opus!);
    // Each model appears once.
    expect(dialogFrame().split("sonnet").length - 1).toBe(1);
    expect(dialogFrame().split("haiku").length - 1).toBe(1);
  });

  test("a model used for a turn is recorded as recent", async () => {
    await openSession("claude");
    await send("hello");
    expect(savedPreferences().recentModels).toEqual({ claude: ["opus"] });
  });

  test("F2 switches to the next recent model, shows it, and the next turn uses it", async () => {
    seed({ recentModels: { claude: ["sonnet", "haiku"] } });
    await openSession("claude");

    await press("F2");
    expect(frame()).toContain("Model: sonnet");
    await press("F2");
    expect(frame()).toContain("Model: haiku");
    await press("F2");
    expect(frame()).toContain("Model: sonnet");

    await send("hello");
    expect(calls.map((call) => call.options.model)).toEqual(["sonnet"]);
  });

  test("F2 says so when there is no other recent model", async () => {
    await openSession("claude");
    await press("F2");
    expect(frame()).toContain("No other recent model");
  });

  test("F2 does nothing while a dialog has the keys", async () => {
    seed({ recentModels: { claude: ["sonnet", "haiku"] } });
    await openSession("claude");
    await run("/models");
    await press("F2");
    expect(frame()).not.toContain("Model: sonnet");
    expect(frame()).toContain("Select Model");
    await press("ESCAPE");
    await send("hello");
    expect(calls.map((call) => call.options.model)).toEqual(["opus"]);
  });
});

describe("/models on a pi session (S10)", () => {
  test("Ctrl+F favorites a credentialed model, which is listed first; choosing one records it as recent", async () => {
    await openSession("pi");
    await run("/models");
    // Rows are fake-a/a-1, fake-b/b-1, fake-b/b-2: favorite the last.
    await press("ARROW_DOWN");
    await press("ARROW_DOWN");
    await press("f", { ctrl: true });
    expect(savedPreferences().favoriteModels).toEqual({ pi: ["fake-b/b-2"] });
    await press("ESCAPE");

    await run("/models");
    const [b2, a1, b1] = order("fake-b/b-2", "fake-a/a-1", "fake-b/b-1");
    expect(b2).toBeLessThan(a1!);
    expect(a1).toBeLessThan(b1!);

    await press("ARROW_DOWN");
    await press("RETURN");
    expect(savedPreferences().piModel).toBe("fake-a/a-1");
    expect(savedPreferences().recentModels).toEqual({ pi: ["fake-a/a-1"] });
  });

  test("F2 cycles the recent pi models that still have credentials", async () => {
    seed({ piModel: "fake-a/a-1", recentModels: { pi: ["fake-a/a-1", "gone/x-1", "fake-b/b-2"] } });
    await openSession("pi");

    await press("F2");
    expect(frame()).toContain("Model: fake-b/b-2");
    expect(savedPreferences().piModel).toBe("fake-b/b-2");

    await send("hello");
    expect(piRequests.map((request) => request.model)).toEqual(["fake-b/b-2"]);
  });
});
