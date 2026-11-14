import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import type { GitStatus } from "../lib/git-status";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-status-git-"));
process.env.MARCSH_PREFERENCES_PATH = join(dir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { StatusBar } = await import("./status-bar");

// S6: the status bar shows the git branch and changed files after the usage; S7: the usage ends with the latest reply's tok/s.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeAll(() => {
  writeFileSync(process.env.MARCSH_PREFERENCES_PATH!, JSON.stringify({ defaultEngine: "claude" }), "utf8");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const reply = (metadata: object) => ({ id: "a", role: "assistant" as const, parts: [], metadata });
const usage = reply({ usage: { contextTokens: 42_100, contextWindow: 200_000, costUsd: 0.34 } });
const gitOf = (status: GitStatus | null) => async () => status;

async function render(element: React.ReactNode, width = 110) {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width, height: 6 });
  await act(() => new Promise<void>((r) => setTimeout(r, 150)));
  await screen.renderOnce();
  return screen.captureCharFrame();
}

describe("StatusBar git", () => {
  test("shows the branch and changed files after the usage and before the hint", async () => {
    const frame = await render(
      <StatusBar cwd="/repo" readGit={gitOf({ branch: "main", changed: 3 })} messages={[usage]} hint="enter steers" />,
    );

    expect(frame).toContain("42.1k/200k (21%) · $0.34 · main · 3 files changed · enter steers");
  });

  test("shows nothing for git outside a repo or without a folder", async () => {
    const bare = await render(<StatusBar />);
    const outside = await render(<StatusBar cwd="/elsewhere" readGit={gitOf(null)} />);
    let asked = false;
    const noFolder = await render(<StatusBar readGit={async () => ((asked = true), { branch: "main", changed: 0 })} />);

    expect(outside).toBe(bare);
    expect(noFolder).toBe(bare);
    expect(asked).toBe(false);
  });

  test("drops the usage first, then git, and keeps the engine label", async () => {
    const props = { cwd: "/repo", readGit: gitOf({ branch: "main", changed: 3 }), messages: [usage] };
    const medium = await render(<StatusBar {...props} />, 60);
    const narrow = await render(<StatusBar {...props} />, 30);

    expect(medium).toContain("main · 3 files changed");
    expect(medium).not.toContain("42.1k");
    expect(narrow).not.toContain("main");
    expect(narrow).toContain("claude");
  });
});

describe("StatusBar tokens per second", () => {
  test("shows the latest reply's output rate after the cost", async () => {
    const frame = await render(
      <StatusBar messages={[reply({ durationMs: 10_000, usage: { contextTokens: 42_100, contextWindow: 200_000, costUsd: 0.34, outputTokens: 420 } })]} />,
    );

    expect(frame).toContain("42.1k/200k (21%) · $0.34 · 42 tok/s");
  });
});
