import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

setDefaultTimeout(60_000);

// M2: a pack command that names its agent (`/spec` → the pack's ASDD) runs that one turn as that agent, from any selected agent, with the
// pack's view (its skills) loaded because the turn's agent is the pack's; the next turn is the selected agent's again.

const work = mkdtempSync(join(tmpdir(), "marcsh-session-pack-commands-"));
const savedPacksDir = process.env.MARCSH_PACKS_DIR!;
process.env.MARCSH_DB_PATH = ":memory:";
process.env.MARCSH_PREFERENCES_PATH = join(work, "prefs", "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(work, "agents");
process.env.MARCSH_PACKS_DIR = join(work, "packs");

let calls: { prompt: string; options: any }[] = [];
// What Claude reports as its commands after a turn (the menu's cache is refreshed from it).
let supported: { name: string; description: string; argumentHint: string }[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    calls.push({ prompt, options });
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0 };
    })();
    return Object.assign(messages, { interrupt: async () => {}, supportedCommands: async () => supported });
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { preferencesPath, setAgentId, setDefaultEngine } = await import("../lib/preferences");
const { disablePackHooks, enablePackHooks, inspectPackHooks, installPack, packPluginDir } = await import("../lib/packs");
const { marcshPluginPath } = await import("../lib/plugin");
const { NORMAL_MODE_LINE } = await import("../lib/approval-policy");
const { loadMenuCommands } = await import("../components/command-menu/use-command-menu");

beforeAll(() => engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} }));
afterAll(() => engines.set("pi", undefined));

beforeAll(async () => {
  const repo = join(work, "fixtures", "acme", "flows");
  const files: Record<string, string> = {
    "agents/asdd.md": "---\nname: ASDD\npermission: build\n---\nSpec first.",
    "agents/ftd.md": "---\nname: FTD\npermission: build\n---\nTest first.",
    "skills/specify/SKILL.md": "---\nname: specify\ndescription: Write a spec\n---\nAsk, then write.",
    "commands/spec.md": '---\ndescription: Write a spec for an idea\nagent: asdd\nargument-hint: "[idea]"\n---\nLoad the specify skill for: $ARGUMENTS',
    "commands/ship.md": "---\ndescription: Ship\n---\nShip it.",
    "commands/review.md": "---\ndescription: Review the spec\nagent: asdd\n---\nReview the spec: $ARGUMENTS",
    "hooks/hooks.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] } }),
  };
  mkdirSync(repo, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
      cwd: repo,
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "c");
  const result = await installPack("acme/flows", { confirm: () => true, urlBase: `file://${join(work, "fixtures")}` });
  expect(result.status).toBe("installed");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  process.env.MARCSH_PACKS_DIR = savedPacksDir;
});

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(condition: () => boolean, what: string, timeoutMs = 3000) {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited >= timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await settle(10);
  }
}
const frameText = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(60);
};

async function openIdle(selected: string) {
  calls = [];
  setAgentId(selected);
  const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd", engine: "claude" });
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }], {
    initialEntries: [`/sessions/${session.id}`],
  });
  screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 30 });
  await settle();
}

beforeEach(() => {
  supported = [];
  mkdirSync(process.env.MARCSH_AGENTS_DIR!, { recursive: true });
  setDefaultEngine("claude");
  getStorage().saveClaudeCommands([]);
});

afterEach(async () => {
  rmSync(preferencesPath(), { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  await disablePackHooks("acme/flows");
});

describe("a pack command that names its agent (M2)", () => {
  test("from Build, /spec runs that turn as the pack's ASDD agent with the pack's view, then Build answers again", async () => {
    await openIdle("build");

    await type("/spec offline mode");
    await enter();
    await until(() => calls.length > 0, "the /spec turn");
    await settle(60);

    expect(calls[0]!.prompt).toBe("Load the specify skill for: offline mode");
    expect(calls[0]!.options.plugins).toEqual([
      { type: "local", path: marcshPluginPath() },
      { type: "local", path: packPluginDir("acme/flows") },
    ]);
    // The pack's agent prompt, then the mode line: the model is told it runs in normal mode.
    expect(calls[0]!.options.systemPrompt.append).toBe(`Spec first.\n\n${NORMAL_MODE_LINE}`);
    // The selected agent is still Build.
    expect(frameText()).toContain("Build ›");

    await type("again");
    await enter();
    await until(() => calls.length > 1, "the next turn");
    expect(calls[1]!.prompt).toBe("again");
    expect(calls[1]!.options.plugins).toEqual([{ type: "local", path: marcshPluginPath() }]);
    expect(calls[1]!.options.systemPrompt.append).toBe(NORMAL_MODE_LINE);
  });

  test("the / menu lists the pack's command while Build is selected, with its hint and pack, and not Claude's copy of it", async () => {
    getStorage().saveClaudeCommands([
      { name: "acme-flows:spec", description: "Write a spec for an idea", argumentHint: "" },
      { name: "acme-flows:ship", description: "Ship", argumentHint: "" },
    ]);
    await openIdle("build");

    await type("/spec");
    const text = frameText();
    expect(text).toContain("/spec");
    expect(text).toContain("[idea] Write a spec for an idea");
    expect(text).toContain("flows");
    expect(text).not.toContain("acme-flows:spec");

    // The command without an agent is the engine's, as before.
    await act(() => screen!.mockInput.pressBackspace());
    await act(() => screen!.mockInput.pressBackspace());
    await act(() => screen!.mockInput.pressBackspace());
    await act(() => screen!.mockInput.pressBackspace());
    await type("acme-flows:sh");
    expect(frameText()).toContain("/acme-flows:ship");
  });

  test("with the pack's hooks on, the Claude process (and so its hooks) is told the approval mode and the turn's agent", async () => {
    const info = await inspectPackHooks("acme/flows");
    if (info.state !== "off") throw new Error(`hooks are ${info.state}`);
    await enablePackHooks("acme/flows", { reviewed: { commit: info.commit, digest: info.digest } });
    await openIdle("build");

    await type("/spec x");
    await enter();
    await until(() => calls.length > 0, "the /spec turn");

    expect(calls[0]!.options.env).toMatchObject({ MARCSH_APPROVAL_MODE: "normal", MARCSH_AGENT: "acme/flows/asdd" });
  });

  test("Claude's built-in /review beats the pack's: /review goes to Claude as typed, the pack's runs as /flows:review (L5)", async () => {
    supported = [{ name: "review", description: "Review a pull request", argumentHint: "" }];
    getStorage().saveClaudeCommands(supported);
    await openIdle("build");

    await type("/flows:rev");
    expect(frameText()).toContain("/flows:review");
    for (let i = 0; i < "/flows:rev".length; i++) await act(() => screen!.mockInput.pressBackspace());

    await type("/review 12");
    await enter();
    await until(() => calls.length > 0, "the /review turn");
    expect(calls[0]!.prompt).toBe("/review 12");
    expect(calls[0]!.options.plugins).toEqual([{ type: "local", path: marcshPluginPath() }]);

    await type("/flows:review x");
    await enter();
    await until(() => calls.length > 1, "the /flows:review turn");
    expect(calls[1]!.prompt).toBe("Review the spec: x");
    expect(calls[1]!.options.plugins).toEqual([
      { type: "local", path: marcshPluginPath() },
      { type: "local", path: packPluginDir("acme/flows") },
    ]);
  });

  test("on pi, a prompt template named like a pack command keeps the name in the menu; a command without a clash is unchanged (L5)", () => {
    getStorage().saveCommands("pi", [{ name: "spec", description: "My pi template", argumentHint: "", source: "prompt" }]);
    try {
      const menu = loadMenuCommands("pi", "/tmp/marcsh-cwd", true);
      expect(menu.filter((command) => command.name === "spec")).toEqual([expect.objectContaining({ source: "prompt", description: "My pi template" })]);
      expect(menu.find((command) => command.name === "flows:spec")).toMatchObject({ source: "flows", argumentHint: "[idea]" });
      expect(menu.find((command) => command.name === "review")).toMatchObject({ source: "flows" });
    } finally {
      getStorage().saveCommands("pi", []);
    }
  });

  test("a Build turn has no hook environment", async () => {
    await openIdle("build");
    await type("hi");
    await enter();
    await until(() => calls.length > 0, "the turn");
    expect("env" in calls[0]!.options).toBe(false);
  });
});
