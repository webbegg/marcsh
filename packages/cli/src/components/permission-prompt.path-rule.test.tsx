import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-prompt-path-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../providers/theme");
const { KeyboardLayerProvider } = await import("../providers/keyboard-layer");
const { PermissionPrompt } = await import("./permission-prompt");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let answers: unknown[] = [];

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  answers = [];
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** Renders the prompt and waits out its quiet window, so the real hint rows are showing. */
async function show(ask: Record<string, unknown>) {
  const request = {
    kind: "permission",
    toolName: "bash",
    input: { command: "rm -rf /tmp/x/a" },
    respond: (decision: unknown) => answers.push(decision),
    ...ask,
  } as any;
  screen = await testRender(
    <ThemeProvider>
      <KeyboardLayerProvider>
        <PermissionPrompt request={request} />
      </KeyboardLayerProvider>
    </ThemeProvider>,
    { width: 110, height: 40 },
  );
  await settle(400);
  await screen.renderOnce();
  return screen.captureCharFrame();
}

const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle();
};
const arrow = async (direction: "left" | "right") => {
  await act(async () => screen!.mockInput.pressArrow(direction));
  await settle();
  await screen!.renderOnce();
  return screen!.captureCharFrame();
};

/** The folder row: the `p` key and what it allows, without the border and trailing blanks. */
const folderRow = (frame: string) =>
  frame
    .split("\n")
    .map((row) => row.replace(/^[│\s]+/, "").trimEnd())
    .find((row) => row.startsWith("p "));

const pathRule = { program: "rm", dirs: ["/tmp/x/deep", "/tmp/x", "/tmp"] };

describe("PermissionPrompt: allow a program under a folder", () => {
  test("offers the narrowest folder, next to the usual keys", async () => {
    const frame = await show({ pathRule });

    expect(frame).toContain("p  allow `rm` under /tmp/x/deep");
    expect(frame).toContain("←/→ change folder");
    expect(frame).toMatch(/y\s+allow once\s+a\s+always allow\s+n\s+deny/);
  });

  test("p answers with the shown folder", async () => {
    await show({ pathRule });

    await press("p");

    expect(answers).toEqual(["path:/tmp/x/deep"]);
  });

  test("← widens to the parent folder and → narrows back, stopping at both ends", async () => {
    await show({ pathRule });

    expect(folderRow(await arrow("left"))).toBe("p  allow `rm` under /tmp/x");
    expect(folderRow(await arrow("left"))).toBe("p  allow `rm` under /tmp");
    expect(folderRow(await arrow("left"))).toBe("p  allow `rm` under /tmp");
    expect(folderRow(await arrow("right"))).toBe("p  allow `rm` under /tmp/x");
    await press("p");

    expect(answers).toEqual(["path:/tmp/x"]);
  });

  test("after the arrows, the other keys still answer", async () => {
    await show({ pathRule });

    await arrow("left");
    await press("y");

    expect(answers).toEqual(["allow"]);
  });

  test("a single folder shows no arrows hint, and the arrows do nothing", async () => {
    const frame = await show({ pathRule: { program: "mv", dirs: ["/tmp/x"] } });

    expect(frame).toContain("p  allow `mv` under /tmp/x");
    expect(frame).not.toContain("change folder");
    expect(folderRow(await arrow("left"))).toBe("p  allow `mv` under /tmp/x");
    await press("p");
    expect(answers).toEqual(["path:/tmp/x"]);
  });

  test("a floor ask offers the folder though it hides always-allow", async () => {
    const frame = await show({ pathRule, suppressAlwaysAllowRule: true, decisionReason: "rm recursive removal" });

    expect(frame).toContain("under /tmp/x/deep");
    expect(frame).not.toContain("always allow");
    await press("a");
    expect(answers).toEqual([]);
    // The ignored key restarted the quiet window.
    await settle(400);
    await press("p");
    expect(answers).toEqual(["path:/tmp/x/deep"]);
  });

  test("a confirm-first ask (defaultToNo) does not offer it, and p does nothing", async () => {
    const frame = await show({ pathRule, defaultToNo: true });

    expect(frame).not.toContain("allow `rm` under");
    await press("p");
    expect(answers).toEqual([]);
  });

  test("an ask without a path rule shows no folder row, and p does nothing", async () => {
    const frame = await show({ input: { command: "ls" } });

    expect(frame).not.toContain("under /");
    expect(frame).not.toContain("change folder");
    await press("p");
    expect(answers).toEqual([]);
  });

  test("a new request starts at its own narrowest folder", async () => {
    await show({ pathRule });
    await arrow("left");

    const frame = await show({ pathRule: { program: "rm", dirs: ["/srv/a", "/srv"] } });

    expect(folderRow(frame)).toBe("p  allow `rm` under /srv/a");
  });

  test("escapes the folder text and keeps the usual answers", async () => {
    const frame = await show({ pathRule: { program: "rm", dirs: ["/tmp/\u001b[31mx"] } });

    expect(frame).toContain("under /tmp/\\u001b[31mx");
    expect(frame).not.toContain("\u001b");
    await press("n");
    expect(answers).toEqual(["deny"]);
  });
});
