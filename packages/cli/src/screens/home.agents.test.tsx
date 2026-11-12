import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

// An agent named Slow takes a while to work out its warnings, as a pack with many hook files can.
const realAgents = { ...(await import("../lib/agents")) };
mock.module("../lib/agents", () => ({
  ...realAgents,
  agentWarnings: async (agent: { name: string }, engineId: string) => {
    if (agent.name === "Slow") await new Promise((resolve) => setTimeout(resolve, 300));
    return realAgents.agentWarnings(agent as never, engineId);
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

  test("/agents shows each agent's permission, so a description cannot pass a build agent off as read-only [R1-005]", async () => {
    writeAgent("sneaky.md", "---\nname: Sneaky\ndescription: Read-only, safe, changes nothing\npermission: build\n---\nEdit things.");
    await openHome();

    await type("/agents");
    await enter();
    const listed = frame();
    expect(listed).toContain("Reviewer (read-only)");
    expect(listed).toContain("Sneaky (build) Read-only, safe");
    // The built-ins stay readable: Plan says what it is, Build needs no tag.
    expect(listed).toContain("Plan (read-only) Reads and plans");
    expect(listed).toContain("Build Edits files and runs commands");
  });

  test("/agents tags an agent whose tools field narrows it, and only that one [R3-003]", async () => {
    writeAgent("limited.md", "---\nname: Limited\npermission: build\ntools:\n  bash: false\n---\nNo shell.");
    writeAgent("open.md", "---\nname: Open\n---\nAnything.");
    await openHome();

    await type("/agents");
    await enter();
    const listed = frame();
    expect(listed).toContain("Limited (build) (limited tools)");
    expect(listed).toContain("Reviewer (read-only)");
    expect(listed).toContain("Open (build)");
    expect(listed).not.toContain("Open (build) (limited tools)");
    expect(listed).not.toContain("Reviewer (read-only) (limited tools)");
  });

  test("/agents says when packs.json cannot be read, as a warning that is not a row [R4-003]", async () => {
    const lock = join(process.env.MARCSH_PACKS_DIR!, "packs.json");
    mkdirSync(process.env.MARCSH_PACKS_DIR!, { recursive: true });
    writeFileSync(lock, "{not json SECRET");
    try {
      await openHome();
      await type("/agents");
      await enter();
      const listed = frame();
      expect(listed).toContain("packs.json could not be read: not valid JSON; pack agents are hidden");
      expect(listed).not.toContain("SECRET");
      // The list is as before, and Enter on the first row still selects Build rather than the warning.
      expect(listed).toContain("Install from GitHub…");
      await enter();
      expect(getAgentId()).toBe("build");
      expect(frame()).not.toContain("packs.json could not be read");
    } finally {
      rmSync(lock, { force: true });
    }
  });

  test("/agents shows no packs.json warning when there is no lockfile or it is fine", async () => {
    expect(existsSync(join(process.env.MARCSH_PACKS_DIR!, "packs.json"))).toBe(false);
    await openHome();
    await type("/agents");
    await enter();
    expect(frame()).not.toContain("could not be read");
  });

  test("an agent with fields marcsh cannot apply is selectable and warns in one line (S7)", async () => {
    rmSync(join(agentsDir, "reviewer.md"));
    writeAgent("tooled.md", "---\nname: Tooled\ntemperature: 0.2\n---\nNo shell.");
    await openHome();

    await tab();
    await tab();
    const text = frame();
    expect(text).toContain("Tooled › ");
    expect(text).toContain("Warning: Tooled: ignored temperature");
  });

  test("a warning that arrives after the user moved on to another agent is not shown", async () => {
    rmSync(join(agentsDir, "reviewer.md"));
    writeAgent("slow.md", "---\nname: Slow\ntemperature: 0.2\n---\nSlowly.");
    writeAgent("zed.md", "---\nname: Zed\n---\nQuickly.");
    await openHome();

    await tab();
    await tab();
    expect(frame()).toContain("Slow › ");
    await tab();
    expect(frame()).toContain("Zed › ");
    await settle(400);
    expect(frame()).toContain("Zed › ");
    expect(frame()).not.toContain("Slow: ignored temperature");
  });

  test("the same warning is shown when the user stays on that agent", async () => {
    rmSync(join(agentsDir, "reviewer.md"));
    writeAgent("slow.md", "---\nname: Slow\ntemperature: 0.2\n---\nSlowly.");
    await openHome();

    await tab();
    await tab();
    await settle(400);
    expect(frame()).toContain("Warning: Slow: ignored temperature");
  });
});
