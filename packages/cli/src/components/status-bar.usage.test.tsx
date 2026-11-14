import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-status-usage-"));
process.env.MARCSH_PREFERENCES_PATH = join(dir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { StatusBar } = await import("./status-bar");

// S5: the status bar shows tokens in context, context % of the window and session cost, each when the engine reports it.

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

async function render(element: React.ReactNode, width = 110) {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width, height: 6 });
  await act(() => new Promise<void>((r) => setTimeout(r, 150)));
  await screen.renderOnce();
  return screen.captureCharFrame();
}

describe("StatusBar usage", () => {
  test("shows context, percent and cost from the messages", async () => {
    const frame = await render(<StatusBar messages={[reply({ usage: { contextTokens: 42_100, contextWindow: 200_000, costUsd: 0.34 } })]} />);

    expect(frame).toContain("42.1k/200k (21%) · $0.34");
  });

  test("is unchanged when no usage is reported", async () => {
    const bare = await render(<StatusBar />);
    const none = await render(<StatusBar messages={[reply({ model: "opus" })]} />);

    expect(none).toBe(bare);
    expect(bare).not.toContain("$");
  });

  test("shows the approval mode and the usage together (permission modes S6, usage S5)", async () => {
    const prefs = process.env.MARCSH_PREFERENCES_PATH!;
    writeFileSync(prefs, JSON.stringify({ defaultEngine: "claude", approvalMode: "yolo" }), "utf8");
    try {
      const usage = { contextTokens: 42_100, contextWindow: 200_000, costUsd: 0.34 };
      const wide = await render(<StatusBar messages={[reply({ usage })]} />);
      expect(wide).toContain("· yolo");
      expect(wide).toContain("42.1k/200k (21%) · $0.34");
      expect(wide.indexOf("yolo")).toBeLessThan(wide.indexOf("42.1k"));

      // Too narrow for both: the usage goes first, the approval mode (a safety signal) stays.
      const narrow = await render(<StatusBar messages={[reply({ usage })]} />, 36);
      expect(narrow).toContain("· yolo");
      expect(narrow).not.toContain("42.1k");
    } finally {
      writeFileSync(prefs, JSON.stringify({ defaultEngine: "claude" }), "utf8");
    }
  });

  test("drops the usage, not the engine label, when the row is too narrow for it", async () => {
    const frame = await render(<StatusBar messages={[reply({ usage: { contextTokens: 42_100, contextWindow: 200_000, costUsd: 0.34 } })]} />, 30);

    expect(frame).not.toContain("42.1k");
    expect(frame).toContain("claude");
  });
});
