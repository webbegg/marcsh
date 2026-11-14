import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import type { GitStatus } from "../lib/git-status";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-status-background-"));
process.env.MARCSH_PREFERENCES_PATH = join(dir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { StatusBar } = await import("./status-bar");
const { runningTerminalsText } = await import("../lib/background/use-running-terminals");
const { runningBackgroundText } = await import("../lib/background/use-running-subagents");

// S3: while background terminals run, the status line says so and points at /ps; it is the first segment dropped when narrow.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeAll(() => {
  writeFileSync(process.env.MARCSH_PREFERENCES_PATH!, JSON.stringify({ defaultEngine: "claude" }), "utf8");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const usage = { id: "a", role: "assistant" as const, parts: [], metadata: { usage: { contextTokens: 42_100, contextWindow: 200_000, costUsd: 0.34 } } };
const git = async (): Promise<GitStatus | null> => ({ branch: "main", changed: 3 });

async function render(element: React.ReactNode, width: number) {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width, height: 6 });
  await act(() => new Promise<void>((r) => setTimeout(r, 150)));
  await screen.renderOnce();
  return screen.captureCharFrame();
}

describe("StatusBar background segment", () => {
  test("names how many run, after git and before the hint", async () => {
    const frame = await render(<StatusBar cwd="/repo" readGit={git} messages={[usage]} background={runningTerminalsText(2)} hint="enter" />, 140);
    expect(frame).toContain("$0.34 · main · 3 files changed · 2 background terminals running · /ps · enter");
  });

  test("says nothing when none runs", () => {
    expect(runningTerminalsText(0)).toBe("");
    expect(runningTerminalsText(1)).toBe("1 background terminal running · /ps");
  });

  test("counts background subagents too, and points at /subagents (S4a)", () => {
    expect(runningBackgroundText(0, 0)).toBe("");
    expect(runningBackgroundText(2, 0)).toBe("2 background terminals running · /ps");
    expect(runningBackgroundText(0, 1)).toBe("1 background subagent running · /subagents");
    expect(runningBackgroundText(0, 2)).toBe("2 background subagents running · /subagents");
    expect(runningBackgroundText(1, 2)).toBe("1 terminal, 2 subagents running · /ps /subagents");
    expect(runningBackgroundText(2, 1)).toBe("2 terminals, 1 subagent running · /ps /subagents");
  });

  test("shows terminals and subagents together", async () => {
    const frame = await render(<StatusBar cwd="/repo" readGit={git} messages={[usage]} background={runningBackgroundText(1, 2)} hint="enter" />, 140);
    expect(frame).toContain("3 files changed · 1 terminal, 2 subagents running · /ps /subagents · enter");
  });

  test("is dropped before the usage and git when the line is too narrow", async () => {
    const frame = await render(<StatusBar cwd="/repo" readGit={git} messages={[usage]} background={runningTerminalsText(2)} />, 90);
    expect(frame).toContain("42.1k/200k (21%) · $0.34 · main · 3 files changed");
    expect(frame).not.toContain("background");
  });
});
