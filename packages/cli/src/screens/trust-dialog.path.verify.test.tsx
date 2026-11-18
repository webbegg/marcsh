import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const root = mkdtempSync(join(tmpdir(), "marcsh-trust-path-verify-"));
process.env.MARCSH_PREFERENCES_PATH = join(root, "preferences.json");
process.env.MARCSH_HISTORY_PATH = join(root, "history.jsonl");
writeFileSync(process.env.MARCSH_PREFERENCES_PATH, JSON.stringify({ defaultEngine: "claude" }), "utf8");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { getStorage } = await import("../lib/storage");

// S17: the new layout of /trust leaves the one way to trust as it was: the Trust row, then `t`, then Enter.
const startDir = process.cwd();
let project: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(root, "project-")));
  process.chdir(project);
});
afterEach(async () => {
  process.chdir(startDir);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};
const down = async () => {
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
async function openTrust(width = 120) {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width, height: 36 });
  await settle(120);
  await type("/trust");
  await press("RETURN");
}

describe("/trust: only the Trust row, `t` and Enter trust (verify)", () => {
  test("Enter on Trust stores nothing; Enter, `?` or `t ?` Enter do not trust; `t` Enter does", async () => {
    await openTrust();
    await down();
    await press("RETURN");
    expect(getStorage().getProjectTrust(project)).toBe(null);
    await type("?");
    await press("RETURN");
    expect(getStorage().getProjectTrust(project)).toBe(null);
    await type("t");
    await type("?");
    await press("RETURN");
    expect(getStorage().getProjectTrust(project)).toBe(null);
    await type("t");
    await press("RETURN");
    expect(getStorage().getProjectTrust(project)).toBe("trusted");
  });

  test("`?` in the list filters and opens no help; the filtered Enter does not trust", async () => {
    await openTrust();
    await type("?");
    expect(screen!.captureCharFrame()).not.toMatch(/\bHelp\b/);
    await press("RETURN");
    expect(getStorage().getProjectTrust(project)).not.toBe("trusted");
  });

  test("filtering to `trust` keeps Don't trust first: Enter stores untrusted", async () => {
    await openTrust();
    await type("trust");
    await press("RETURN");
    expect(getStorage().getProjectTrust(project)).toBe("untrusted");
  });

  test("with a pi file, Enter on Trust opens the listing and a second Enter stores nothing", async () => {
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "settings.json"), "{}");
    await openTrust();
    await down();
    await press("RETURN");
    await press("RETURN");
    expect(getStorage().getProjectTrust(project)).toBe(null);
  });

  for (const width of [80, 140]) {
    test(`at ${width} columns the labels are whole and the mark sits on the stored state`, async () => {
      getStorage().setProjectTrust(project, "untrusted");
      await openTrust(width);
      const rows = screen!.captureCharFrame().split("\n");
      const dont = rows.find((row) => /Don't trust/.test(row)) ?? "";
      expect(dont).toContain("• current");
      expect(rows.find((row) => /\bForget\b/.test(row)) ?? "").not.toContain("current");
    });
  }
});
