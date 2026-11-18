// From the tier 4 recheck: the real /sessions dialog (width "wide") keeps a pi row's title start and whole time at 80 and 120 columns.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, useEffect } from "react";

const dir = mkdtempSync(join(tmpdir(), "marcsh-sessions-wide-"));
process.env.MARCSH_DB_PATH = join(dir, "marcsh.db");
process.env.MARCSH_PREFERENCES_PATH = join(dir, "preferences.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../../providers/theme");
const { KeyboardLayerProvider } = await import("../../providers/keyboard-layer");
const { DialogProvider, useDialog } = await import("../../providers/dialog");
const { ToastProvider } = await import("../../providers/toast");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { COMMANDS } = await import("../command-menu/commands");
const { getStorage } = await import("../../lib/storage");

const session = getStorage().createSession({ title: "Fix the login flow", cwd: "/work", engine: "pi" });
getStorage().saveMessages(
  session.id,
  Array.from({ length: 12 }, (_, k) => ({
    id: `m${k}`,
    role: k % 2 ? "assistant" : "user",
    parts: [{ type: "text", text: "x" }],
    metadata: { model: "anthropic/claude-opus-5-5" },
  })) as never,
);
const sessions = COMMANDS.find((c) => c.name === "sessions")!;

function Open() {
  const dialog = useDialog();
  useEffect(() => {
    (sessions.action as (ctx: unknown) => void)({ dialog });
  }, []);
  return null;
}

async function row(width: number) {
  const router = createMemoryRouter(
    [{ path: "/", element: <ToastProvider><DialogProvider><Open /></DialogProvider></ToastProvider> }],
    { initialEntries: ["/"] },
  );
  const screen = await testRender(
    <ThemeProvider><KeyboardLayerProvider><RouterProvider router={router} /></KeyboardLayerProvider></ThemeProvider>,
    { width, height: 30 },
  );
  try {
    await act(() => new Promise<void>((r) => setTimeout(r, 200)));
    await screen.renderOnce();
    return screen.captureCharFrame().split("\n").find((l) => l.includes("12 messages")) ?? "";
  } finally {
    await act(async () => screen.renderer.destroy());
  }
}

for (const [width, rowCells] of [[80, 68], [120, 92]] as const) {
  test(`at ${width} columns the row fits its ${rowCells} cells with the title start and the whole time`, async () => {
    const line = (await row(width)).replace(/│/g, "").trim();
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(rowCells);
    expect(line.startsWith("Fix the login f")).toBe(true);
    expect(line.endsWith("12 messages · just now")).toBe(true);
  });
}
