import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, InMemoryCredentialStore, type OAuthCredential, type ProviderAuth } from "@earendil-works/pi-ai";
import { Mode } from "../modes";
import { createPiEngine } from "./pi";
import type { EngineEvent } from "./types";
import {
  friendlyPiError,
  listLoginProviders,
  listStoredLogins,
  redactSecrets,
  removeLogin,
  runLogin,
  setUrlOpener,
  type LoginNotice,
  type LoginPrompt,
  type LoginUi,
} from "./pi-auth";

const oauthCredential = (code: string): OAuthCredential => ({
  type: "oauth",
  access: `access-${code}`,
  refresh: `refresh-${code}`,
  expires: Date.now() + 3_600_000,
});

function fakeProvider(id: string, name: string, auth: ProviderAuth, models: string[] = [`${id}-model`]) {
  const faux = fauxProvider({ provider: id, models: models.map((model) => ({ id: model, name: `${model} name` })) });
  return { ...faux.provider, id, name, auth };
}

// "Subscription" provider: authorization URL, then a pasted code.
const subscription = fakeProvider(
  "fake-sub",
  "Fake Subscription",
  {
    oauth: {
      name: "Fake Subscription (Pro)",
      isSubscription: true,
      login: async (interaction) => {
        interaction.notify({ type: "auth_url", url: "https://auth.example.test/authorize?state=abc", instructions: "Open the link" });
        interaction.notify({ type: "progress", message: "Waiting for the browser" });
        const code = await interaction.prompt({ type: "manual_code", message: "Paste the authorization code" });
        if (code.startsWith("bad")) throw new Error(`token exchange failed for code ${code}`);
        return oauthCredential(code);
      },
      refresh: async (credential) => credential,
      toAuth: async (credential) => ({ apiKey: credential.access }),
    },
  },
  ["sub-model-1", "sub-model-2"],
);

// Device-code provider: shows a code and a verification page, no prompt.
const device = fakeProvider("fake-device", "Fake Device", {
  oauth: {
    name: "Fake Device",
    login: async (interaction) => {
      interaction.notify({ type: "device_code", userCode: "WDJB-MJHT", verificationUri: "https://device.example.test/activate" });
      return oauthCredential("device");
    },
    refresh: async (credential) => credential,
    toAuth: async (credential) => ({ apiKey: credential.access }),
  },
});

// API-key provider that asks for the key with a secret prompt.
const keyed = fakeProvider(
  "fake-key",
  "Fake Keyed",
  {
    apiKey: {
      name: "Fake Keyed API key",
      login: async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "API key" }) }),
      resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined),
    },
  },
  ["keyed-model"],
);

// Configured outside marcsh (environment, profile): no login to run.
const ambient = fakeProvider("fake-ambient", "Fake Ambient", {
  apiKey: { name: "Fake ambient", resolve: async () => ({ auth: { apiKey: "from-env" }, source: "FAKE_KEY" }) },
});

async function setup() {
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  for (const provider of [subscription, device, keyed, ambient]) runtime.registerNativeProvider(provider);
  return { runtime, credentials };
}

function scriptedUi(answer: (prompt: LoginPrompt) => string | Promise<string> = () => "") {
  const notices: LoginNotice[] = [];
  const prompts: LoginPrompt[] = [];
  const ui: LoginUi = {
    notify: (notice) => void notices.push(notice),
    prompt: async (prompt) => {
      prompts.push(prompt);
      return answer(prompt);
    },
  };
  return { ui, notices, prompts };
}

let opened: string[] = [];
beforeEach(() => {
  opened = [];
  setUrlOpener((url) => void opened.push(url));
});
afterEach(() => setUrlOpener(undefined));

const own = <T extends { id: string }>(providers: T[]) => providers.filter((p) => p.id.startsWith("fake-"));

describe("login providers", () => {
  test("lists the providers that can log in, OAuth ones first, and skips ambient-only ones", async () => {
    const { runtime } = await setup();

    const listed = own(listLoginProviders(runtime));

    expect(listed.map((p) => [p.id, p.authType, p.subscription, p.loggedIn])).toEqual([
      ["fake-device", "oauth", false, false],
      ["fake-sub", "oauth", true, false],
      ["fake-key", "api_key", false, false],
    ]);
    expect(listed.find((p) => p.id === "fake-sub")).toMatchObject({ name: "Fake Subscription", label: "Fake Subscription (Pro)" });
  });

  test("includes pi's built-in subscription and API-key providers", async () => {
    const { runtime } = await setup();

    const listed = listLoginProviders(runtime).map((p) => `${p.id}:${p.authType}`);

    for (const entry of ["anthropic:oauth", "anthropic:api_key", "openai:oauth", "github-copilot:oauth", "openrouter:api_key"]) {
      expect(listed).toContain(entry);
    }
  });

  test("marks a provider logged in after login, on the row of the credential type in use", async () => {
    const { runtime } = await setup();
    await runLogin(runtime, listLoginProviders(runtime).find((p) => p.id === "fake-sub")!, scriptedUi(() => "code1").ui);

    const listed = own(listLoginProviders(runtime));

    expect(listed.map((p) => [p.id, p.loggedIn])).toEqual([
      ["fake-device", false],
      ["fake-sub", true],
      ["fake-key", false],
    ]);
  });
});

describe("runLogin", () => {
  test("OAuth: shows the URL, opens the browser, takes the pasted code, stores the credential through pi", async () => {
    const { runtime, credentials } = await setup();
    const { ui, notices, prompts } = scriptedUi(() => "code1");
    const provider = listLoginProviders(runtime).find((p) => p.id === "fake-sub")!;

    const outcome = await runLogin(runtime, provider, ui);

    expect(outcome).toEqual({ status: "success" });
    expect(notices).toEqual([
      { type: "auth_url", url: "https://auth.example.test/authorize?state=abc", instructions: "Open the link" },
      { type: "progress", message: "Waiting for the browser" },
    ]);
    expect(prompts).toEqual([{ kind: "manual_code", message: "Paste the authorization code" }]);
    expect(opened).toEqual(["https://auth.example.test/authorize?state=abc"]);
    expect(await credentials.read("fake-sub")).toMatchObject({ type: "oauth", access: "access-code1" });
    // The next model lookup sees the new credentials without a restart.
    expect((await runtime.getAvailable("fake-sub")).map((m) => m.id)).toEqual(["sub-model-1", "sub-model-2"]);
  });

  test("device code: passes the code and page to the UI and opens the page", async () => {
    const { runtime, credentials } = await setup();
    const { ui, notices } = scriptedUi();

    const outcome = await runLogin(runtime, listLoginProviders(runtime).find((p) => p.id === "fake-device")!, ui);

    expect(outcome).toEqual({ status: "success" });
    expect(notices).toEqual([{ type: "device_code", userCode: "WDJB-MJHT", verificationUri: "https://device.example.test/activate" }]);
    expect(opened).toEqual(["https://device.example.test/activate"]);
    expect(await credentials.read("fake-device")).toMatchObject({ type: "oauth" });
  });

  test("API key: the key goes from a secret prompt into pi's credential store", async () => {
    const { runtime, credentials } = await setup();
    const { ui, prompts } = scriptedUi(() => "sk-test-123456");

    const outcome = await runLogin(runtime, listLoginProviders(runtime).find((p) => p.id === "fake-key")!, ui);

    expect(outcome).toEqual({ status: "success" });
    expect(prompts).toEqual([{ kind: "secret", message: "API key" }]);
    expect(await credentials.read("fake-key")).toEqual({ type: "api_key", key: "sk-test-123456" });
    expect((await runtime.getAvailable("fake-key")).map((m) => m.id)).toEqual(["keyed-model"]);
  });

  test("only http and https URLs are opened, and a failing opener is ignored", async () => {
    const { runtime } = await setup();
    const provider = fakeProvider("fake-urls", "Fake URLs", {
      oauth: {
        name: "Fake URLs",
        login: async (interaction) => {
          for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url", "https://ok.example.test/a"]) {
            interaction.notify({ type: "auth_url", url });
          }
          return oauthCredential("urls");
        },
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    });
    runtime.registerNativeProvider(provider);
    setUrlOpener((url) => {
      opened.push(url);
      throw new Error("no browser here");
    });
    const { ui, notices } = scriptedUi();

    const outcome = await runLogin(runtime, listLoginProviders(runtime).find((p) => p.id === "fake-urls")!, ui);

    expect(outcome).toEqual({ status: "success" });
    expect(opened).toEqual(["https://ok.example.test/a"]);
    expect(notices).toHaveLength(4);
  });

  test("cancelling while a prompt is open aborts the flow and stores nothing", async () => {
    const { runtime, credentials } = await setup();
    const controller = new AbortController();
    const { ui } = scriptedUi(() => new Promise<string>(() => {}));
    const running = runLogin(runtime, listLoginProviders(runtime).find((p) => p.id === "fake-sub")!, ui, { signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    expect(await running).toEqual({ status: "cancelled" });
    expect(await credentials.read("fake-sub")).toBeUndefined();
  });

  test("a prompt the flow cancels itself (manual code raced against a callback) rejects for the UI", async () => {
    const { runtime } = await setup();
    const callbackWon = new AbortController();
    const provider = fakeProvider("fake-race", "Fake Race", {
      oauth: {
        name: "Fake Race",
        login: async (interaction) => {
          const pending = interaction.prompt({ type: "manual_code", message: "Paste or wait", signal: callbackWon.signal });
          setTimeout(() => callbackWon.abort(), 10);
          await pending.catch(() => {});
          return oauthCredential("race");
        },
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    });
    runtime.registerNativeProvider(provider);
    const { ui } = scriptedUi(() => new Promise<string>(() => {}));

    const outcome = await runLogin(runtime, listLoginProviders(runtime).find((p) => p.id === "fake-race")!, ui);

    expect(outcome).toEqual({ status: "success" });
  });

  test("a failure is reported without the secrets the user typed", async () => {
    const { runtime, credentials } = await setup();
    const { ui } = scriptedUi(() => "bad-code-98765");

    const outcome = await runLogin(runtime, listLoginProviders(runtime).find((p) => p.id === "fake-sub")!, ui);

    expect(outcome.status).toBe("failed");
    const message = (outcome as { message: string }).message;
    expect(message).toContain("token exchange failed");
    expect(message).not.toContain("bad-code-98765");
    expect(await credentials.read("fake-sub")).toBeUndefined();
  });

  test("a UI that throws while showing a notice does not break the login", async () => {
    const { runtime } = await setup();
    const ui: LoginUi = { notify: () => { throw new Error("render failed"); }, prompt: async () => "code1" };

    const outcome = await runLogin(runtime, listLoginProviders(runtime).find((p) => p.id === "fake-sub")!, ui);

    expect(outcome).toEqual({ status: "success" });
  });

  test("passes a stable device id to the login", async () => {
    const { runtime } = await setup();
    let seen: string | undefined;
    runtime.registerNativeProvider(
      fakeProvider("fake-id", "Fake Id", {
        oauth: {
          name: "Fake Id",
          login: async (_interaction, options) => {
            seen = options?.getDeviceId?.();
            return oauthCredential("id");
          },
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      }),
    );

    await runLogin(runtime, listLoginProviders(runtime).find((p) => p.id === "fake-id")!, scriptedUi().ui, { deviceId: "device-1" });

    expect(seen).toBe("device-1");
  });
});

describe("logout", () => {
  test("lists stored logins by provider name and removes one through pi", async () => {
    const { runtime, credentials } = await setup();
    await runLogin(runtime, listLoginProviders(runtime).find((p) => p.id === "fake-sub")!, scriptedUi(() => "code1").ui);
    await runLogin(runtime, listLoginProviders(runtime).find((p) => p.id === "fake-key")!, scriptedUi(() => "sk-test-123456").ui);

    const stored = await listStoredLogins(runtime);
    expect(stored.map((l) => [l.id, l.name, l.authType])).toEqual([
      ["fake-key", "Fake Keyed", "api_key"],
      ["fake-sub", "Fake Subscription", "oauth"],
    ]);

    expect(await removeLogin(runtime, stored[1]!)).toEqual({ status: "success", message: "Logged out of Fake Subscription" });
    expect(await removeLogin(runtime, stored[0]!)).toEqual({
      status: "success",
      message: "Removed stored API key for Fake Keyed. Environment variables are unchanged.",
    });
    expect(await credentials.list()).toEqual([]);
    expect(await listStoredLogins(runtime)).toEqual([]);
    expect(await runtime.getAvailable("fake-sub")).toEqual([]);
  });

  test("reports a failing store without leaking anything else", async () => {
    const { runtime } = await setup();
    const broken = { ...runtime, logout: async () => { throw new Error("disk full"); } } as unknown as typeof runtime;

    const outcome = await removeLogin(broken, { id: "fake-sub", name: "Fake Subscription", authType: "oauth" });

    expect(outcome).toEqual({ status: "failed", message: "Logout failed: disk full" });
  });
});

describe("redactSecrets", () => {
  test("masks the given secrets, bearer tokens and long token-like strings", () => {
    const text = `bad sk-live-abcdef1234 / Bearer abc.def-123 / ${"a1".repeat(20)} / eyJhbGciOiJIUzI1NiJ9abcdef.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig_nature-1234`;

    const redacted = redactSecrets(text, ["sk-live-abcdef1234"]);

    expect(redacted).not.toContain("sk-live-abcdef1234");
    expect(redacted).not.toContain("abc.def-123");
    expect(redacted).not.toContain("a1a1a1a1");
    expect(redacted).not.toContain("eyJzdWIi");
    expect(redacted).toContain("•••");
  });

  test("leaves ordinary messages and URLs alone", () => {
    const text = "Request to https://auth.example.test/oauth/token/some/long/path/segments/here failed with status 400";
    expect(redactSecrets(text, [])).toBe(text);
  });
});

describe("friendlyPiError", () => {
  test("points a missing API key at /login instead of pi's docs", () => {
    const pi = 'No API key found for anthropic.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /x/node_modules/@earendil-works/pi-coding-agent/docs/providers.md\n  /x/node_modules/@earendil-works/pi-coding-agent/docs/models.md';
    for (const message of [pi, 'No API key found for "anthropic"', "No API key for anthropic/claude-opus-5-5", "No API key for provider: anthropic"]) {
      const friendly = friendlyPiError(message);
      expect(friendly).toBe("No API key for anthropic. Run /login to sign in to a provider, or /models to pick a model that has one.");
    }
  });

  test("strips docs paths from other login hints and leaves everything else", () => {
    const hint = "No models available. Use /login to log into a provider via OAuth or API key. See:\n  /x/node_modules/pkg/docs/providers.md\n  /x/node_modules/pkg/docs/models.md";
    expect(friendlyPiError(hint)).toBe("No models available. Run /login to sign in to a provider.");
    expect(friendlyPiError("provider exploded")).toBe("provider exploded");
  });
});

describe("pi engine wiring", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "marcsh-pi-wiring-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function turn(engine: ReturnType<typeof createPiEngine>, model: string) {
    const events: EngineEvent[] = [];
    await engine.startTurn(
      { prompt: "hello", cwd: dir, mode: Mode.BUILD, model, signal: new AbortController().signal },
      { emit: (e) => events.push(e), askPermission: async () => "deny", askQuestions: async () => null },
    ).done;
    return events.flatMap((e) => (e.type === "error" ? [e.message] : []));
  }

  test("the engine hands out the runtime it runs turns with, so a login is seen by the next turn", async () => {
    const { runtime } = await setup();
    const engine = createPiEngine({ agentDir: join(dir, "agent"), modelRuntime: runtime, permissionRules: { addPermissionRule() {}, hasPermissionRule: () => false } });
    expect(await engine.getRuntime()).toBe(runtime);
    expect(await engine.getRuntime()).toBe(runtime);

    expect((await runtime.getAvailable("fake-key")).length).toBe(0);
    await runLogin(await engine.getRuntime(), listLoginProviders(runtime).find((p) => p.id === "fake-key")!, scriptedUi(() => "sk-test-123456").ui);
    expect((await (await engine.getRuntime()).getAvailable("fake-key")).length).toBe(1);
  });

  test("a turn without credentials fails with a message that names /login, not pi's docs paths", async () => {
    const { runtime } = await setup();
    const engine = createPiEngine({ agentDir: join(dir, "agent"), modelRuntime: runtime, permissionRules: { addPermissionRule() {}, hasPermissionRule: () => false } });

    const errors = await turn(engine, "anthropic/claude-opus-5-5");

    expect(errors).toEqual(["No API key for anthropic. Run /login to sign in to a provider, or /models to pick a model that has one."]);
  });

  test("the device id comes from pi's settings under the agent dir and stays the same", async () => {
    const { runtime } = await setup();
    const agentDir = join(dir, "agent");
    const engine = createPiEngine({ agentDir, modelRuntime: runtime });

    const first = await engine.getDeviceId();

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await engine.getDeviceId()).toBe(first);
    expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).deviceId).toBe(first);
  });
});

// S5: with the default agent dir, credentials land in ~/.marcsh/agent/auth.json (0600) and ~/.pi is never touched.
// Bun caches os.homedir() at startup, so the default path is checked in a child process with its own HOME.
// The test preload's MARCSH_AGENT_DIR must not reach it, or it would not test the default.
const { MARCSH_AGENT_DIR: _agentDirOverride, ...parentEnv } = process.env;
const child = `
import { createPiEngine } from "./pi.ts";
import { listLoginProviders, runLogin } from "./pi-auth.ts";
const engine = createPiEngine();
const runtime = await engine.getRuntime();
const provider = listLoginProviders(runtime).find((p) => p.id === "openrouter" && p.authType === "api_key");
const outcome = await runLogin(runtime, provider, {
  notify() {},
  prompt: async () => "sk-or-child-secret-123456",
});
console.log(JSON.stringify({ outcome, loggedIn: listLoginProviders(runtime).find((p) => p.id === "openrouter" && p.authType === "api_key").loggedIn }));
`;

describe("default agent dir (S5)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "marcsh-pi-auth-home-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("a login writes ~/.marcsh/agent/auth.json with mode 0600 and leaves ~/.pi alone", async () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    const proc = Bun.spawn([process.execPath, "-e", child], {
      cwd: import.meta.dir,
      env: { ...parentEnv, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({ outcome: { status: "success" }, loggedIn: true });
    const authPath = join(home, ".marcsh", "agent", "auth.json");
    expect(existsSync(authPath)).toBe(true);
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(authPath, "utf8")).openrouter).toEqual({ type: "api_key", key: "sk-or-child-secret-123456" });
    expect(existsSync(join(home, ".pi", "agent", "auth.json"))).toBe(false);
  }, 30000);
});
