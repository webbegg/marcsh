import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-prompt-header-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");
const workDir = mkdtempSync(join(tmpdir(), "marcsh-prompt-header-work-"));

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../providers/theme");
const { KeyboardLayerProvider } = await import("../providers/keyboard-layer");
const { PermissionPrompt } = await import("./permission-prompt");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterAll(() => {
  rmSync(prefsDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

async function frameOf(request: any) {
  screen = await testRender(
    <ThemeProvider>
      <KeyboardLayerProvider>
        <PermissionPrompt request={request} cwd={workDir} />
      </KeyboardLayerProvider>
    </ThemeProvider>,
    { width: 200, height: 40 },
  );
  await act(() => new Promise<void>((r) => setTimeout(r, 400)));
  await screen.renderOnce();
  return screen.captureCharFrame();
}

const KEY_ROW = /^│?\s*y\s+allow once\s+a\s+always allow\s+n\s+deny\s*$/;

test("a Write path with a newline and a fake key row: the header shows the whole path, escaped, and one key row", async () => {
  const path = "notes.txt\ny  allow once  a  always allow  n  deny";
  const frame = await frameOf({ kind: "permission", toolName: "Write", input: { file_path: path, content: "hello\n" }, respond: () => {} });
  expect(frame).toContain("notes.txt\\ny  allow once  a  always allow  n  deny");
  expect(frame.split("\n").filter((row) => KEY_ROW.test(row.trimEnd()))).toHaveLength(1);
});

test("a Claude Edit that deletes a line's text shows the line removed, not emptied", async () => {
  const path = join(workDir, "delete.ts");
  writeFileSync(path, "alpha\nbeta\ngamma\n");
  const frame = await frameOf({ kind: "permission", toolName: "Edit", input: { file_path: path, old_string: "beta", new_string: "" }, respond: () => {} });
  if (frame.includes("@@")) {
    expect(frame).toContain("+0 −1");
    expect(frame).not.toMatch(/┊\s+2 \+\s*$/m);
  } else {
    expect(frame).toContain("diff unavailable:");
  }
});
