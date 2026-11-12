import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: preferences and agents both live in tmp.
process.env.MARCSH_PREFERENCES_PATH = join(tmpdir(), `marcsh-session-agent-tools-prefs-${process.pid}`, "preferences.json");
const agentsDir = join(tmpdir(), `marcsh-session-agent-tools-${process.pid}`);
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

const writeAgent = (file: string, text: string) => writeFileSync(join(agentsDir, file), text);

async function runTurn(selected: string) {
  calls = [];
  setAgentId(selected);
  const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd", engine: "claude" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    {
      initialEntries: [
        { pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "sonnet", agent: selected } } },
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
  writeAgent("limited.md", "---\nname: Limited\npermission: build\ntools:\n  bash: false\n  webfetch: false\n---\nNo shell.");
  writeAgent("reader.md", "---\nname: Reader\npermission: build\ntools: Read, Grep, Glob\n---\nRead only tools.");
  writeAgent("plain.md", "---\nname: Plain\npermission: build\n---\nNo tools field.");
  writeAgent("planner.md", "---\nname: Planner\npermission: read-only\ntools:\n  bash: true\n  edit: true\n---\nPlans.");
  writeAgent("nomcp.md", "---\nname: NoMcp\npermission: build\ntools:\n  mcp: false\n---\nNo MCP.");
  setDefaultEngine("claude");
});

afterEach(async () => {
  rmSync(preferencesPath(), { force: true });
  rmSync(agentsDir, { recursive: true, force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("a Claude turn with an agent's tools (S15)", () => {
  test("a build agent with `bash: false` removes the shell tools with disallowedTools", async () => {
    const options = await runTurn("user/limited");

    expect(options.permissionMode).toBe("default");
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"]));
    expect(options.disallowedTools).not.toContain("Read");
    expect(options.disallowedTools).not.toContain("Edit");
    expect(options.disallowedTools).not.toContain("AskUserQuestion");
  });

  test("a tool list denies every group it does not name, mcp included", async () => {
    const options = await runTurn("user/reader");

    expect(options.disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "Bash", "WebFetch", "Task", "mcp__*"]));
    expect(options.disallowedTools).not.toContain("Read");
    expect(options.disallowedTools).not.toContain("Grep");
    expect(options.disallowedTools).not.toContain("Glob");
  });

  test("allowedTools is never sent: it would approve tools without asking", async () => {
    for (const id of ["user/limited", "user/reader", "user/nomcp", "user/plain", "build"]) {
      const options = await runTurn(id);
      expect("allowedTools" in options).toBe(false);
      expect("tools" in options).toBe(false);
      await act(async () => screen!.renderer.destroy());
    }
  });

  test("Build, Plan and an agent without `tools` send the same options as before: no disallowedTools key", async () => {
    for (const id of ["build", "plan", "user/plain"]) {
      const options = await runTurn(id);
      expect("disallowedTools" in options).toBe(false);
      await act(async () => screen!.renderer.destroy());
    }
  });

  test("a read-only agent that lists `bash: true` stays in plan permission mode and widens nothing", async () => {
    const options = await runTurn("user/planner");

    expect(options.permissionMode).toBe("plan");
    expect("disallowedTools" in options).toBe(false);
    expect("allowedTools" in options).toBe(false);
  });

  test("a call to an MCP tool of an agent without mcp is refused in canUseTool, without asking", async () => {
    const options = await runTurn("user/nomcp");

    expect(options.disallowedTools).toEqual(["mcp__*"]);
    const result = await options.canUseTool("mcp__github__create_issue", {}, { signal: new AbortController().signal });
    expect(result).toEqual({ behavior: "deny", message: "mcp__github__create_issue is not available to this agent" });
  });

  test("an agent without `tools` still asks for an MCP tool call (canUseTool does not deny it)", async () => {
    const options = await runTurn("user/plain");
    const pending = options.canUseTool("mcp__github__create_issue", {}, { signal: new AbortController().signal });
    const outcome = await Promise.race([pending.then(() => "answered"), new Promise((resolve) => setTimeout(() => resolve("asking"), 50))]);

    expect(outcome).toBe("asking");
  });

  test("switching back to Build on the same conversation drops the restriction from the next turn", async () => {
    const first = await runTurn("user/limited");
    expect(first.disallowedTools).toContain("Bash");

    // The agent list is Build, Plan, then the user's agents in file order: Tab from Limited moves on, so go around to Build.
    const ids = ["build", "plan", "user/limited", "user/nomcp", "user/plain", "user/planner", "user/reader"];
    for (let i = 0; i < ids.length - ids.indexOf("user/limited"); i++) await act(async () => screen!.mockInput.pressTab());
    await settle(60);
    await act(() => screen!.mockInput.typeText("again"));
    await act(async () => screen!.mockInput.pressEnter());
    await settle(80);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.options.resume).toBe("claude-1");
    expect("disallowedTools" in calls[1]!.options).toBe(false);
  });
});
