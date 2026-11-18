import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const root = mkdtempSync(join(tmpdir(), "marcsh-trust-marks-"));
process.env.MARCSH_PREFERENCES_PATH = join(root, "preferences.json");
writeFileSync(process.env.MARCSH_PREFERENCES_PATH, JSON.stringify({ defaultEngine: "claude" }), "utf8");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { getStorage } = await import("../lib/storage");
const { reviewProject } = await import("../lib/engine/pi-trust");

// /trust of a project with nothing in it: the choices and the marks are what is under test, not the review.
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

// OpenTUI 0.9 paints a committed update on a later frame (and a frame cannot be read mid-paint): draw it before it is read.
const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};
const pressDown = async () => {
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
/** The frame as the screen draws it, one string per row (borders and trailing space trimmed). */
const rows = () => screen!.captureCharFrame().split("\n").map((row) => row.replace(/^[\s│┃]+/, "").replace(/[\s│┃]+$/, ""));
const rowOf = (needle: RegExp) => rows().find((row) => needle.test(row)) ?? "";

async function openTrust(width = 120) {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }]);
  screen = await testRender(<RouterProvider router={router} />, { width, height: 36 });
  await settle(120);
  await type("/trust");
  await press("RETURN");
}

const DONT = /^Don't trust\b/;
const TRUST = /^Trust\s+(•\s+current\s+)?use its/;
const FORGET = /^Forget\b/;

describe("/trust marks the state in force, not the cursor (S17)", () => {
  test("a stored 'trusted' is marked on Trust, and moving the cursor does not move the mark", async () => {
    getStorage().setProjectTrust(project, "trusted", reviewProject(project).record);
    await openTrust();

    expect(rowOf(TRUST)).toContain("• current");
    expect(rowOf(DONT)).not.toContain("current");
    expect(rowOf(FORGET)).not.toContain("current");

    await pressDown();
    await pressDown();
    expect(rowOf(TRUST)).toContain("• current");
    expect(rowOf(FORGET)).not.toContain("current");
    // The mark is a separate word: no row begins with the old bullet that looked like the selection.
    expect(rows().filter((row) => row.startsWith("•"))).toEqual([]);
  });

  test("a stored 'untrusted' is marked on Don't trust, also after the cursor left it", async () => {
    getStorage().setProjectTrust(project, "untrusted");
    await openTrust();
    expect(rowOf(DONT)).toContain("• current");

    await pressDown();
    expect(rowOf(DONT)).toContain("• current");
    expect(rowOf(TRUST)).not.toContain("current");
  });

  test("with no decision the mark is on Forget (undecided), and nowhere else", async () => {
    await openTrust();

    expect(rowOf(FORGET)).toContain("• current");
    expect(rowOf(DONT)).not.toContain("current");
    expect(rowOf(TRUST)).not.toContain("current");
  });
});

describe("/trust layout (S17)", () => {
  test("the labels sit in one column and the hints start at the same column", async () => {
    getStorage().setProjectTrust(project, "trusted", reviewProject(project).record);
    await openTrust();

    const dont = rowOf(DONT);
    const trust = rowOf(TRUST);
    const forget = rowOf(FORGET);
    const hintColumn = (row: string, hint: string) => row.indexOf(hint);
    expect(hintColumn(dont, "don't use its pi files, commands or git status")).toBeGreaterThan(0);
    const column = hintColumn(dont, "don't use its pi files, commands or git status");
    expect(hintColumn(trust, "use its pi files, commands and git status")).toBe(column);
    expect(hintColumn(forget, "back to undecided")).toBe(column);
    // Nothing is clipped on a wide enough terminal.
    expect(dont.endsWith("git status")).toBe(true);
    expect(trust.endsWith("git status")).toBe(true);
  });

  test("on a narrow terminal a hint that does not fit ends with an ellipsis, never a cut word", async () => {
    await openTrust(80);

    const dont = rowOf(DONT);
    expect(dont).toContain("…");
    expect(dont.endsWith("…")).toBe(true);
    // The labels stay whole.
    expect(rowOf(TRUST)).toMatch(/^Trust\s/);
    expect(rowOf(FORGET)).toMatch(/^Forget\s+•\s+current/);
  });

  test("Don't trust is the first row and the one Enter picks: Enter stores 'untrusted' and never trusts", async () => {
    await openTrust();
    const labels = rows().filter((row) => DONT.test(row) || TRUST.test(row) || FORGET.test(row));
    expect(labels.map((row) => row.split(/\s/)[0])).toEqual(["Don't", "Trust", "Forget"]);

    await press("RETURN");
    expect(getStorage().getProjectTrust(project)).toBe("untrusted");
  });
});
