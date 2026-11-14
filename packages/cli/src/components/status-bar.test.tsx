import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-status-bar-"));
const prefsPath = join(prefsDir, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { usePromptConfig } = await import("../providers/prompt-config");
const { StatusBar } = await import("./status-bar");
type PromptConfig = ReturnType<typeof usePromptConfig>;

let config: PromptConfig;
function Probe() {
  config = usePromptConfig();
  return <StatusBar engine="claude" />;
}

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│\s]+/g, " ");

async function open() {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Probe /> }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width: 80, height: 10 });
  await settle(60);
}

afterEach(async () => {
  rmSync(prefsPath, { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

describe("status bar approval mode (S6)", () => {
  test("normal mode leaves the bar as it was", async () => {
    await open();
    expect(frame()).toContain("Build › opus · claude");
    expect(frame()).not.toContain("auto");
    expect(frame()).not.toContain("yolo");
  });

  test("auto and yolo are named after the engine, and normal removes the label again", async () => {
    await open();

    await act(async () => config.setApprovalMode("auto"));
    await settle();
    expect(frame()).toContain("Build › opus · claude · auto");

    await act(async () => config.setApprovalMode("yolo"));
    await settle();
    expect(frame()).toContain("Build › opus · claude · yolo");
    expect(frame()).not.toContain("auto");

    await act(async () => config.setApprovalMode("normal"));
    await settle();
    expect(frame()).not.toContain("yolo");
    expect(frame()).toContain("Build › opus · claude");
  });

  test("a session starts in the saved default", async () => {
    writeFileSync(prefsPath, JSON.stringify({ approvalMode: "yolo" }), "utf8");
    await open();
    expect(config.approvalMode).toBe("yolo");
    expect(frame()).toContain("Build › opus · claude · yolo");
  });

  test("the mode follows no other setting: Plan/Build stays as it is", async () => {
    await open();
    await act(async () => config.setApprovalMode("yolo"));
    await settle();
    expect(config.mode).toBe("BUILD");
    expect(frame()).toContain("Build");
  });
});
