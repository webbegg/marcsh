import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: preferences and agents both live in tmp.
process.env.MARCSH_PREFERENCES_PATH = join(tmpdir(), `marcsh-mode-toast-prefs-${process.pid}`, "preferences.json");
const agentsDir = join(tmpdir(), `marcsh-mode-toast-agents-${process.pid}`);
process.env.MARCSH_AGENTS_DIR = agentsDir;
process.env.MARCSH_COMMANDS_DIR = join(tmpdir(), `marcsh-mode-toast-commands-${process.pid}`);
process.env.MARCSH_KEYBINDS_PATH = join(tmpdir(), `marcsh-mode-toast-keys-${process.pid}`, "keybinds.json");

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
const { getAgentId, preferencesPath, setDefaultEngine } = await import("../lib/preferences");

// S17: switching between Build and Plan says in one toast what the mode does.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
// OpenTUI 0.9 paints a committed update on a later frame (and a frame cannot be read mid-paint): draw it before it is read.
const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const tab = async () => {
  await act(async () => screen!.mockInput.pressTab());
  await settle(80);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(80);
};

async function openHome() {
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }],
    { initialEntries: ["/"] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 30 });
  await settle();
}

const writeAgent = (file: string, text: string) => writeFileSync(join(agentsDir, file), text);
// Tests that let toasts run out take a few seconds each.
setDefaultTimeout(20_000);
// Lets a toast run out (3 s), so the next one is read on its own.
const outlast = () => settle(3300);

beforeEach(() => {
  mkdirSync(agentsDir, { recursive: true });
  writeAgent("builder.md", "---\nname: Builder\n---\nBuild things.");
  writeAgent("quirky.md", "---\nname: Quirky\ntemperature: 0.2\n---\nOdd.");
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

describe("the Build/Plan toast (S17)", () => {
  test("Build → Plan says what Plan does", async () => {
    await openHome();
    expect(frame()).not.toContain("changes nothing");

    await tab();

    expect(frame()).toContain("Plan › ");
    expect(frame()).toContain("Plan: reads and plans; changes nothing");
  });

  test("Plan → a build agent says what Build does, under the agent's name", async () => {
    await openHome();
    await tab();
    await outlast();
    expect(frame()).not.toContain("changes nothing");

    await tab();

    expect(frame()).toContain("Builder › ");
    expect(frame()).toContain("Builder: edits files and runs commands, asking first");
  });

  test("a switch that keeps the mode (Build → a build agent) shows no toast", async () => {
    await openHome();
    // Plan is the second agent: go to it and past it to the first build agent, then forward to the next one.
    await tab();
    await tab();
    await outlast();

    await tab();

    expect(frame()).toContain("Quirky › ");
    expect(frame()).not.toContain("edits files");
    expect(frame()).not.toContain("changes nothing");
  });

  test("a read-only agent runs as Plan: leaving it for Build (the list wraps) says what Build does", async () => {
    await openHome();
    // Build → Plan → Builder → Quirky → Reviewer
    for (let i = 0; i < 4; i++) await tab();
    await outlast();
    expect(frame()).toContain("Reviewer › ");

    // Reviewer → Build (the list wraps): the mode changes.
    await tab();
    expect(frame()).toContain("Build › ");
    expect(frame()).toContain("Build: edits files and runs commands, asking first");
  });

  test("the mode and the warnings of the agent are one toast, not two", async () => {
    await openHome();
    await tab();
    await outlast();

    // Plan → Builder (mode changes), then on to Quirky (same mode, a warning only).
    await tab();
    await outlast();
    await tab();
    expect(frame()).toContain("Warning: Quirky: ignored temperature");
    expect(frame()).not.toContain("edits files");
  });

  test("mode change and warnings together show in a single toast", async () => {
    // Plan first, then Quirky is a build agent: Plan → Quirky changes the mode and warns.
    rmSync(join(agentsDir, "builder.md"));
    await openHome();
    await tab();
    await outlast();

    await tab();

    // One toast: both lines are on screen together, and the warning is said once.
    const text = frame();
    expect(text).toContain("Quirky: edits files and runs commands, asking first ·");
    expect(text).toContain("Warning: Quirky: ignored temperature");
    expect(text.match(/Warning:/g)).toHaveLength(1);
  });

  test("/agents takes the same path: selecting Plan there shows the toast", async () => {
    await openHome();
    await type("/agents");
    await enter();
    await type("Plan");
    await enter();

    expect(getAgentId()).toBe("plan");
    expect(frame()).toContain("Plan: reads and plans; changes nothing");
  });
});
