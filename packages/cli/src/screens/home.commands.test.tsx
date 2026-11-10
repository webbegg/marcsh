import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh/preferences.json: a missing file reads as no preferences, and writes land in tmp.
process.env.MARCSH_PREFERENCES_PATH = join(tmpdir(), `marcsh-screen-prefs-${process.pid}`, "preferences.json");

// The home screen must list Claude Code commands with no turn behind it, so query() must never run here.
let queryCalls = 0;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    queryCalls += 1;
    throw new Error("query() must not be called by the home screen");
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { getStorage } = await import("../lib/storage");
const { preferencesPath, setDefaultEngine } = await import("../lib/preferences");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());

async function openHome() {
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }],
    { initialEntries: ["/"] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 30 });
  await settle();
}

// These tests are about Claude's command cache, so the default engine is Claude explicitly (pi is the default).
beforeEach(() => setDefaultEngine("claude"));

afterEach(async () => {
  rmSync(preferencesPath(), { force: true });
  getStorage().saveClaudeCommands([]);
  queryCalls = 0;
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("slash menu on a fresh start (S13a)", () => {
  test("with an empty cache and no turn, /marc lists marcsh:feature and marcsh:workflow with their descriptions", async () => {
    expect(getStorage().getClaudeCommands()).toEqual([]);
    await openHome();

    await type("/marc");

    const text = frame();
    expect(text).not.toContain("No matching commands");
    expect(text).toContain("/marcsh:feature");
    expect(text).toContain("<feature-name>");
    // The row clips long descriptions, so only the start is checked.
    expect(text).toContain("Create or resume the feature");
    expect(text).toContain("/marcsh:workflow");
    expect(text).toContain("Use this for any request to change code");
    expect(queryCalls).toBe(0);
  });

  test("a menu opened after the warm-up cached the CLI's list shows the new entries without a restart", async () => {
    await openHome();
    await type("/");
    expect(frame()).not.toContain("From the warm-up");

    // Close the menu, let the warm-up save, reopen.
    await act(async () => screen!.mockInput.pressKey("ESCAPE" as never));
    await settle(60);
    getStorage().saveClaudeCommands([{ name: "warmed", description: "From the warm-up", argumentHint: "" }]);
    await act(async () => screen!.mockInput.pressBackspace());
    await settle(60);
    await type("/warm");

    expect(frame()).toContain("From the warm-up");
  });
});
