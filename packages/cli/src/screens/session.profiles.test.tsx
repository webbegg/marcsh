import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: preferences, agents and profiles all live in tmp. The variables are put back when the file is done.
const home = mkdtempSync(join(tmpdir(), "marcsh-session-profiles-"));
const profilesFile = join(home, "profiles.json");
const agentsDir = join(home, "agents");
const ENV = { MARCSH_PREFERENCES_PATH: join(home, "preferences.json"), MARCSH_PROFILES_PATH: profilesFile, MARCSH_AGENTS_DIR: agentsDir };
const savedEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
Object.assign(process.env, ENV);

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

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { getSessionProfile, setSessionProfile } = await import("../lib/profiles");

// pi is the default engine and its status line asks the pi runtime: a stand-in without one keeps the real pi engine from loading.
beforeAll(() => engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} }));
afterAll(() => {
  engines.set("pi", undefined);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

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
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const run = async (command: string) => {
  await type(command);
  await press("RETURN");
  await settle(120);
};

const PROFILES = {
  version: 1,
  profiles: {
    claudeish: { primary: { model: "sonnet", fallback: [{ model: "openai/gpt-5" }, { model: "haiku" }] }, "*": { model: "haiku" } },
    pionly: { primary: { model: "anthropic/claude-haiku-5-5" }, "*": { model: "anthropic/claude-haiku-5-5" } },
  },
};

async function openSession(engine: "claude" | "pi" = "claude") {
  calls = [];
  const session = getStorage().createSession({ title: "profiles", cwd: "/tmp/marcsh-cwd", engine });
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }], { initialEntries: [`/sessions/${session.id}`] });
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 32 });
  await settle(80);
  return session;
}

beforeEach(() => {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "refuter.md"), "---\nname: Refuter\nmode: subagent\nmodel: opus\n---\nRefute claims.");
  writeFileSync(profilesFile, JSON.stringify(PROFILES));
  setSessionProfile(undefined);
});

afterEach(async () => {
  setSessionProfile(undefined);
  rmSync(profilesFile, { force: true });
  rmSync(agentsDir, { recursive: true, force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("/profile in a session", () => {
  test("without arguments it shows the routing in force with the source of each value", async () => {
    await openSession();
    setSessionProfile("claudeish");
    await run("/profile");
    const text = frame();
    expect(text).toContain("Model Profile");
    expect(text).toContain("Session profile: claudeish");
    expect(text).toContain("Main turn (primary): sonnet (session profile claudeish, route primary)");
    expect(text).toContain("refuter: haiku (session profile claudeish, route *)");
  });

  test("use sets the session's profile and switches the model to its primary route: the next turn runs on it, with its fallback and routed subagents", async () => {
    await openSession();
    await run("/profile use claudeish");
    expect(getSessionProfile()).toBe("claudeish");
    expect(frame()).toContain("Profile claudeish is in use for this session. Model: sonnet.");

    await type("hello");
    await press("RETURN");
    await settle(120);
    expect(calls).toHaveLength(1);
    const options = calls[0]!.options;
    expect(options.model).toBe("sonnet");
    // The first fallback that is a Claude model.
    expect(options.fallbackModel).toBe("haiku");
    // The subagent's own file says opus; the profile's `*` route wins.
    expect(options.agents.refuter.model).toBe("haiku");
  });

  test("the model can be changed after use, and that choice wins for the turn; the routes still apply", async () => {
    await openSession();
    await run("/profile use claudeish");
    await run("/models");
    // The picker: choose haiku (opus, sonnet, haiku in order; the dialog starts on the current model).
    await type("haiku");
    await press("RETURN");
    await settle(120);

    await type("hello");
    await press("RETURN");
    await settle(120);
    expect(calls[0]!.options.model).toBe("haiku");
    // The chain skips the turn's own model.
    expect(calls[0]!.options.fallbackModel).toBeUndefined();
    expect(calls[0]!.options.agents.refuter.model).toBe("haiku");
  });

  test("a profile for pi changes nothing on a Claude session, and says so", async () => {
    await openSession();
    await run("/profile use pionly");
    expect(frame()).toContain("no primary route fits claude");
    await type("hello");
    await press("RETURN");
    await settle(120);
    expect(calls[0]!.options.model).toBe("opus");
    expect("fallbackModel" in calls[0]!.options).toBe(false);
    expect(calls[0]!.options.agents.refuter.model).toBe("opus");
  });

  test("an unknown name is an error and changes nothing", async () => {
    await openSession();
    await run("/profile use nope");
    expect(frame()).toContain('There is no profile "nope"');
    expect(getSessionProfile()).toBeUndefined();
  });

  test("default writes the file, and a later turn without a session profile uses it", async () => {
    await openSession();
    await run("/profile default claudeish");
    expect(JSON.parse(readFileSync(profilesFile, "utf8")).default).toBe("claudeish");
    expect(getSessionProfile()).toBeUndefined();

    await type("hello");
    await press("RETURN");
    await settle(120);
    // The default's routes apply; its primary model is not applied until /profile use.
    expect(calls[0]!.options.model).toBe("opus");
    expect(calls[0]!.options.agents.refuter.model).toBe("haiku");
  });

  test("clear drops the session's profile", async () => {
    await openSession();
    await run("/profile use claudeish");
    await run("/profile clear");
    expect(getSessionProfile()).toBeUndefined();
    expect(frame()).toContain("Session profile cleared");
  });

  test("a profiles file that is not valid warns once, does not crash, and the turn runs without profiles", async () => {
    writeFileSync(profilesFile, "{ not json");
    await openSession();
    await type("hello");
    await press("RETURN");
    await settle(120);
    expect(frame()).toContain("Warning:");
    expect(frame()).toContain("profiles.json");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.model).toBe("opus");
    expect(calls[0]!.options.agents.refuter.model).toBe("opus");
  });
});
