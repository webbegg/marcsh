import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: preferences and agents both live in tmp.
process.env.MARCSH_PREFERENCES_PATH = join(tmpdir(), `marcsh-session-agent-prefs-${process.pid}`, "preferences.json");
const agentsDir = join(tmpdir(), `marcsh-session-agents-${process.pid}`);
process.env.MARCSH_AGENTS_DIR = agentsDir;

let calls: { prompt: string; options: any }[] = [];

// Fake query(): records what marcsh passes, then init → result.
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
const { preferencesPath, setAgentId, setDefaultEngine } = await import("../lib/preferences");

// pi is the default engine and its status line asks the pi runtime: a stand-in without one keeps the real pi engine from loading.
beforeAll(() => engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} }));
afterAll(() => engines.set("pi", undefined));

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│\s]+/g, " ");

const writeAgent = (file: string, text: string) => writeFileSync(join(agentsDir, file), text);

async function runTurn(selected: string, initialPrompt: Record<string, unknown> = {}) {
  calls = [];
  setAgentId(selected);
  const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd", engine: "claude" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    {
      initialEntries: [
        // What the home screen sends: the selected agent's ID next to its mode.
        { pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "sonnet", agent: selected, ...initialPrompt } } },
      ],
    },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 30 });
  await settle(80);
  expect(calls).toHaveLength(1);
  return calls[0]!.options;
}

beforeEach(() => {
  mkdirSync(agentsDir, { recursive: true });
  writeAgent("ftd.md", "---\nname: FTD\npermission: build\nmodel: haiku\n---\nWork test-first.");
  writeAgent("reviewer.md", "---\nname: Reviewer\npermission: read-only\nmodel: openai/gpt-5\n---\nReview only.");
  // Claude needs no runtime check for the status line.
  setDefaultEngine("claude");
});

afterEach(async () => {
  rmSync(preferencesPath(), { force: true });
  rmSync(agentsDir, { recursive: true, force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("a Claude turn with the selected agent (S4, S5, S6)", () => {
  test("the agent prompt is appended to the Claude Code preset, never in place of it", async () => {
    const options = await runTurn("user/ftd");

    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Work test-first." });
  });

  test("a read-only agent runs in plan permission mode", async () => {
    const options = await runTurn("user/reviewer");

    expect(options.permissionMode).toBe("plan");
  });

  test("the agent's model is used when Claude can use it; otherwise the session model", async () => {
    expect((await runTurn("user/ftd")).model).toBe("haiku");
    await act(async () => screen!.renderer.destroy());

    expect((await runTurn("user/reviewer")).model).toBe("sonnet");
  });

  test("a Build turn sends the same options as before: no append key", async () => {
    const options = await runTurn("build");

    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect("append" in options.systemPrompt).toBe(false);
    expect(options.permissionMode).toBe("default");
    expect(options.model).toBe("sonnet");
  });

  test("a new session starts with the agent chosen on the home screen", async () => {
    const options = await runTurn("build", { agent: "user/ftd" });

    expect(options.systemPrompt.append).toBe("Work test-first.");
  });

  test("switching agent keeps the conversation and applies the new agent from the next turn (S5)", async () => {
    const first = await runTurn("build");
    expect(first.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });

    // Build → Plan → FTD
    for (let i = 0; i < 2; i++) await act(async () => screen!.mockInput.pressTab());
    await settle(60);
    await act(() => screen!.mockInput.typeText("again"));
    await act(async () => screen!.mockInput.pressEnter());
    await settle(80);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.options.resume).toBe("claude-1");
    expect(calls[1]!.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Work test-first." });
    expect(calls[1]!.options.model).toBe("haiku");
    expect(frame()).toContain("FTD › ");
    expect(frame()).toContain("Build › ");
  });

  test("the reply is labelled with the agent's name", async () => {
    await runTurn("user/ftd");

    expect(frame()).toContain("FTD › ");
  });

  test("a Build reply is labelled Build", async () => {
    await runTurn("build");

    expect(frame()).toContain("Build › ");
  });
});
