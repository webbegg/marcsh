import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: preferences and agents both live in tmp.
process.env.MARCSH_PREFERENCES_PATH = join(tmpdir(), `marcsh-agents-prefs-${process.pid}`, "preferences.json");
const agentsDir = join(tmpdir(), `marcsh-agents-${process.pid}`);
process.env.MARCSH_AGENTS_DIR = agentsDir;

// The home screen starts no turn.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    throw new Error("query() must not be called by the home screen");
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { getAgentId, preferencesPath, setAgentId, setDefaultEngine } = await import("../lib/preferences");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│\s]+/g, " ");
const tab = async () => {
  await act(async () => screen!.mockInput.pressTab());
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(60);
};

async function openHome() {
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }],
    { initialEntries: ["/"] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 30 });
  await settle();
}

const writeAgent = (file: string, text: string) => writeFileSync(join(agentsDir, file), text);

beforeEach(() => {
  mkdirSync(agentsDir, { recursive: true });
  writeAgent("reviewer.md", "---\nname: Reviewer\npermission: read-only\n---\nReview only.");
  // Claude needs no runtime check for the status line.
  setDefaultEngine("claude");
});

afterEach(async () => {
  rmSync(preferencesPath(), { force: true });
  rmSync(agentsDir, { recursive: true, force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("selecting agents (S1, S9)", () => {
  test("Tab cycles Build, Plan and the user's agents, and the choice is kept", async () => {
    await openHome();
    expect(frame()).toContain("Build › ");

    await tab();
    expect(frame()).toContain("Plan › ");
    await tab();
    expect(frame()).toContain("Reviewer › ");
    expect(getAgentId()).toBe("user/reviewer");
    await tab();
    expect(frame()).toContain("Build › ");
    expect(getAgentId()).toBe("build");
  });

  test("the stored agent is selected at start; a stored agent that is gone falls back to Build", async () => {
    setAgentId("user/reviewer");
    await openHome();
    expect(frame()).toContain("Reviewer › ");
    await act(async () => screen!.renderer.destroy());

    setAgentId("user/gone");
    await openHome();
    expect(frame()).toContain("Build › ");
  });

  test("/agents lists every agent, including one added after start, and selects the chosen one", async () => {
    await openHome();
    writeAgent("writer.md", "---\nname: Writer\n---\nWrite docs.");

    await type("/agents");
    await enter();
    const listed = frame();
    expect(listed).toContain("Build");
    expect(listed).toContain("Plan");
    expect(listed).toContain("Reviewer");
    expect(listed).toContain("Writer");

    await type("writ");
    await enter();
    expect(frame()).toContain("Writer › ");
    expect(getAgentId()).toBe("user/writer");
  });

  test("an agent with fields marcsh cannot apply is selectable and warns in one line (S7)", async () => {
    rmSync(join(agentsDir, "reviewer.md"));
    writeAgent("tooled.md", "---\nname: Tooled\ntools:\n  bash: false\n---\nNo shell.");
    await openHome();

    await tab();
    await tab();
    const text = frame();
    expect(text).toContain("Tooled › ");
    expect(text).toContain("Warning: Tooled: ignored tools");
  });
});
