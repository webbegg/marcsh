import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import type { ModelRuntime as PiModelRuntime } from "@earendil-works/pi-coding-agent";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-login-screen-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

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
type ProviderAuth = import("@earendil-works/pi-ai").ProviderAuth;
type OAuthCredential = import("@earendil-works/pi-ai").OAuthCredential;

const oauthCredential = (code: string): OAuthCredential => ({
  type: "oauth",
  access: `access-${code}`,
  refresh: `refresh-${code}`,
  expires: Date.now() + 3_600_000,
});

function fakeProvider(id: string, name: string, auth: ProviderAuth) {
  const faux = fauxProvider({ provider: id, models: [{ id: `${id}-model` }] });
  return { ...faux.provider, id, name, auth };
}

let loginSignalAborted = false;

const providers = [
  fakeProvider("fake-sub", "Fake Subscription", {
    oauth: {
      name: "Fake Subscription (Pro)",
      isSubscription: true,
      login: async (interaction) => {
        interaction.notify({ type: "auth_url", url: "https://auth.example.test/go", instructions: "Open this link" });
        interaction.signal?.addEventListener("abort", () => (loginSignalAborted = true), { once: true });
        const code = await interaction.prompt({ type: "manual_code", message: "Paste the authorization code" });
        if (code.startsWith("bad")) throw new Error(`exchange failed for ${code}`);
        return oauthCredential(code);
      },
      refresh: async (credential) => credential,
      toAuth: async (credential) => ({ apiKey: credential.access }),
    },
  }),
  fakeProvider("fake-device", "Fake Device", {
    oauth: {
      name: "Fake Device Login",
      login: async (interaction) => {
        interaction.notify({ type: "device_code", userCode: "WDJB-MJHT", verificationUri: "https://dev.example.test/act" });
        // The user finishes the sign-in in the browser; the flow polls until then.
        await new Promise((resolve) => setTimeout(resolve, 150));
        return oauthCredential("device");
      },
      refresh: async (credential) => credential,
      toAuth: async (credential) => ({ apiKey: credential.access }),
    },
  }),
  fakeProvider("fake-key", "Fake Keyed", {
    apiKey: {
      name: "Fake Keyed API key",
      login: async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "Enter your API key" }) }),
      resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined),
    },
  }),
];

let credentials: InstanceType<typeof InMemoryCredentialStore>;
let runtime: PiModelRuntime;
let opened: string[] = [];

const fakePi: Engine & { getRuntime: () => Promise<typeof runtime>; getDeviceId: () => Promise<string> } = {
  id: "pi",
  startTurn: () => ({ done: Promise.resolve(), interrupt() {} }),
  warmUpCommands: async () => {},
  getRuntime: async () => runtime,
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
const paste = async (text: string) => {
  await act(() => screen!.mockInput.pasteBracketedText(text));
  await settle(60);
};
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());

async function openSession(engine: string) {
  const session = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [`/sessions/${session.id}`] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
  await settle();
}

/** Types a slash command, runs it, and gives the async dialog setup time to open. */
async function run(command: string) {
  await type(command);
  await press("RETURN");
  await settle(120);
}

beforeAll(() => engines.set("pi", fakePi));
afterAll(() => {
  engines.set("pi", undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});

beforeEach(async () => {
  credentials = new InMemoryCredentialStore();
  runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  for (const provider of providers) runtime.registerNativeProvider(provider);
  opened = [];
  loginSignalAborted = false;
  setUrlOpener((url) => void opened.push(url));
});

afterEach(async () => {
  setUrlOpener(undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("/login (S12)", () => {
  test("is in the / menu and lists pi's subscription and API-key providers with a filter", async () => {
    await openSession("claude");

    await type("/log");
    expect(frame()).toContain("Log in to a pi provider");
    expect(frame()).toContain("Remove a pi provider login");
    await press("RETURN");
    await settle(120);

    const listed = frame();
    expect(listed).toContain("Log in");
    expect(listed).toContain("Search providers");

    await type("fake");
    const filtered = frame();
    expect(filtered).toContain("Fake Device Login");
    expect(filtered).toContain("Fake Subscription (Pro)");
    expect(filtered).toContain("subscription");
    expect(filtered).toContain("Fake Keyed API key");
    expect(filtered).toContain("API key");
    expect(filtered).not.toContain("Anthropic");
  });

  test("subscription login on a Claude session: shows the URL, opens the browser, takes the pasted code masked, then toasts and stores the credential in pi", async () => {
    await openSession("claude");
    await run("/login");
    await type("fake subscr");

    await press("RETURN");
    await settle(60);

    const flow = frame();
    expect(flow).toContain("Log in to Fake Subscription");
    expect(flow).toContain("Open this link");
    expect(flow).toContain("https://auth.example.test/go");
    expect(flow).toContain("Paste the authorization code");
    expect(flow).toContain("terms");
    expect(opened).toEqual(["https://auth.example.test/go"]);

    await paste("code-secret-123");
    const masked = frame();
    expect(masked).toContain("•••••••••••••••");
    expect(masked).toContain("(15 characters)");
    expect(masked).not.toContain("code-secret");

    await press("RETURN");
    await settle(100);

    const done = frame();
    expect(done).toContain("Logged in to Fake Subscription");
    expect(done).not.toContain("Paste the authorization code");
    expect(done).not.toContain("code-secret");
    expect(await credentials.read("fake-sub")).toMatchObject({ type: "oauth", access: "access-code-secret-123" });
    expect((await runtime.getAvailable("fake-sub")).map((m) => m.id)).toEqual(["fake-sub-model"]);
  });

  test("typing a pasted code key by key is masked too", async () => {
    await openSession("pi");
    await run("/login");
    await type("fake subscr");
    await press("RETURN");

    await type("abc123");

    const text = frame();
    expect(text).toContain("(6 characters)");
    expect(text).not.toContain("abc123");
  });

  test("a very long paste keeps the whole \"(N characters)\" label inside the dialog", async () => {
    await openSession("pi");
    await run("/login");
    await type("fake subscr");
    await press("RETURN");

    const code = `code-${"abcdefghij".repeat(500)}xyz`;
    expect(code).toHaveLength(5008);
    await paste(code);

    const text = frame();
    expect(text).toContain("(5008 characters)");
    expect(text).not.toContain("abcdefghij");
    const dotsLine = screen!.captureCharFrame().split("\n").find((line) => line.includes("•"))!;
    expect(dotsLine).toContain("(5008 characters)");
  });

  test("device-code login shows the code and page and finishes once the flow does", async () => {
    await openSession("pi");
    await run("/login");
    await type("fake device");

    await press("RETURN");
    await settle(40);

    const flow = frame();
    expect(flow).toContain("WDJB-MJHT");
    expect(flow).toContain("https://dev.example.test/act");
    expect(opened).toEqual(["https://dev.example.test/act"]);

    await settle(250);
    expect(frame()).toContain("Logged in to Fake Device");
    expect(await credentials.read("fake-device")).toMatchObject({ type: "oauth" });
  });

  test("API key login: the key is shown as dots, saved by pi, and never rendered", async () => {
    await openSession("pi");
    await run("/login");
    await type("fake keyed");
    await press("RETURN");
    expect(frame()).toContain("Enter your API key");

    await type("sk-test-123456");
    const masked = frame();
    expect(masked).toContain("(14 characters)");
    expect(masked).not.toContain("sk-test");

    await press("RETURN");
    await settle(100);

    const done = frame();
    expect(done).toContain("Saved API key for Fake Keyed");
    expect(done).not.toContain("sk-test");
    expect(await credentials.read("fake-key")).toEqual({ type: "api_key", key: "sk-test-123456" });
  });

  test("a provider that is logged in is marked in the list", async () => {
    await credentials.modify("fake-key", async () => ({ type: "api_key", key: "sk-test-123456" }));
    await runtime.refresh();
    await openSession("pi");

    await run("/login");
    await type("fake keyed");

    expect(frame()).toContain("✓ Fake Keyed API key");
    expect(frame()).toContain("logged in");
  });

  test("Esc cancels the flow: the dialog closes, a cancelled toast shows and nothing is stored", async () => {
    await openSession("pi");
    await run("/login");
    await type("fake subscr");
    await press("RETURN");
    await paste("half-typed-code");

    await press("ESCAPE");
    await settle(60);

    const text = frame();
    expect(text).not.toContain("Paste the authorization code");
    expect(text).toContain("Login to Fake Subscription cancelled");
    expect(loginSignalAborted).toBe(true);
    expect(await credentials.list()).toEqual([]);
  });

  test("a failed login says so without the code the user pasted", async () => {
    await openSession("pi");
    await run("/login");
    await type("fake subscr");
    await press("RETURN");
    await paste("bad-code-777");
    await press("RETURN");
    await settle(100);

    const text = frame();
    expect(text).toContain("Failed to log in to Fake Subscription");
    // The pasted code in pi's error text is masked.
    expect(text).toContain("failed for •••");
    expect(text).not.toContain("bad-code-777");
    expect(await credentials.list()).toEqual([]);
  });

  test("without a pi runtime (an engine double) it says so instead of opening a dialog", async () => {
    engines.set("pi", { id: "pi", startTurn: fakePi.startTurn, warmUpCommands: async () => {} });
    try {
      await openSession("claude");
      await run("/login");
      expect(frame()).toContain("Could not start pi login: The pi engine has no model");
      expect(frame()).not.toContain("Search providers");
    } finally {
      engines.set("pi", fakePi);
    }
  });
});

describe("/logout (S12)", () => {
  test("lists the stored logins, removes the chosen one through pi and toasts", async () => {
    await credentials.modify("fake-key", async () => ({ type: "api_key", key: "sk-test-123456" }));
    await credentials.modify("fake-sub", async () => oauthCredential("stored"));
    await openSession("claude");

    await run("/logout");

    const listed = frame();
    expect(listed).toContain("Log out");
    expect(listed).toContain("Fake Keyed");
    expect(listed).toContain("Fake Subscription");
    expect(listed).not.toContain("sk-test");

    await type("keyed");
    await press("RETURN");
    await settle(100);

    expect(frame()).toContain("Removed stored API key for Fake Keyed");
    expect((await credentials.list()).map((c) => c.providerId)).toEqual(["fake-sub"]);
  });

  test("with nothing stored it tells the user so", async () => {
    await openSession("pi");

    await run("/logout");

    expect(frame()).toContain("No pi logins to remove");
    expect(frame()).not.toContain("Search logins");
  });
});
