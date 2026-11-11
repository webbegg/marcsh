import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

// S1 f (verifier): changed-mode marks are right and cannot be spoofed by file names; t + Enter still gated.
process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-verify-marks-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../providers/theme");
const { KeyboardLayerProvider } = await import("../providers/keyboard-layer");
const { TrustPrompt } = await import("../components/trust-prompt");
const { reviewProject, diffReview } = await import("../lib/engine/pi-trust");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let dir = "";
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const rows = () => screen!.captureCharFrame().split("\n").map((r) => r.replace(/^[│┃\s]+/, "").replace(/^• /, "").trimEnd()).filter(Boolean);

async function render(cwd: string, changes: any, answers: string[], size = { width: 120, height: 40 }) {
  const { resources } = reviewProject(cwd);
  const request = { kind: "trust", id: "1", cwd, resources, changes, respond: (a: string) => answers.push(a) } as any;
  screen = await testRender(
    <ThemeProvider>
      <KeyboardLayerProvider>
        <TrustPrompt request={request} />
      </KeyboardLayerProvider>
    </ThemeProvider>,
    size,
  );
  await settle(450);
  await screen.renderOnce();
}

describe("changed-mode trust prompt (verifier)", () => {
  test("marks match the real changes; file names cannot fake a mark", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-verify-marks-")));
    const ext = join(dir, ".pi/extensions");
    mkdirSync(ext, { recursive: true });
    writeFileSync(join(ext, "keep.ts"), "1");
    writeFileSync(join(ext, "edit.ts"), "1");
    writeFileSync(join(ext, "gone.ts"), "1");
    const before = reviewProject(dir).record;
    writeFileSync(join(ext, "edit.ts"), "2");
    unlinkSync(join(ext, "gone.ts"));
    writeFileSync(join(ext, "[unchanged] fake.ts"), "x");
    writeFileSync(join(ext, "x.ts\n[unchanged] evil.ts"), "x");
    writeFileSync(join(ext, "‮[unchanged]st.ts"), "x");
    const changes = diffReview(before, reviewProject(dir).record);
    const answers: string[] = [];
    await render(dir, changes, answers);
    const r = rows();

    expect(r.some((row) => row.startsWith("This project's pi files changed since you trusted them. Trust them again?"))).toBe(true);
    const listed = r.filter((row) => /^\[(added|changed|unchanged|removed)\]/.test(row));
    // every row starts with exactly one real mark and only keep.ts is unchanged
    expect(listed.filter((row) => row.startsWith("[unchanged]"))).toEqual(["[unchanged] .pi/extensions/keep.ts"]);
    expect(listed).toContain("[changed] .pi/extensions/edit.ts");
    expect(listed).toContain("[removed] .pi/extensions/gone.ts");
    expect(listed).toContain("[added] .pi/extensions/[unchanged] fake.ts");
    expect(listed).toContain("[added] .pi/extensions/x.ts\\n[unchanged] evil.ts");
    expect(listed).toContain("[added] .pi/extensions/\\u202e[unchanged]st.ts");
    expect(r.some((row) => row.includes("6 items") || row.includes("5 items"))).toBe(true);
  }, 20000);

  test("no record: notice, no marks", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-verify-marks-")));
    mkdirSync(join(dir, ".pi/extensions"), { recursive: true });
    writeFileSync(join(dir, ".pi/extensions/a.ts"), "1");
    await render(dir, diffReview(null, reviewProject(dir).record), []);
    const r = rows();
    expect(r.some((row) => row.includes("No record of your earlier review"))).toBe(true);
    expect(r.some((row) => /^\[(added|changed|unchanged)\]/.test(row))).toBe(false);
    expect(r).toContain(".pi/extensions/a.ts");
  }, 20000);

  test("unreadable entry in changed mode: t + Enter never trusts", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-verify-marks-")));
    mkdirSync(join(dir, ".pi/skills/pdf"), { recursive: true });
    writeFileSync(join(dir, ".pi/skills/pdf/SKILL.md"), "x");
    const before = reviewProject(dir).record;
    writeFileSync(join(dir, ".pi/skills/pdf/big.bin"), Buffer.alloc(1024 * 1024 + 1));
    const answers: string[] = [];
    await render(dir, diffReview(before, reviewProject(dir).record), answers);

    for (const k of ["t", "RETURN", "t", "RETURN"]) {
      await act(async () => screen!.mockInput.pressKey(k as never));
      await settle(400);
    }
    expect(answers.includes("trust")).toBe(false);
  }, 20000);

  test("typeahead t+Enter right away does not trust; after quiet + end seen it does", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-verify-marks-")));
    mkdirSync(join(dir, ".pi/extensions"), { recursive: true });
    writeFileSync(join(dir, ".pi/extensions/a.ts"), "1");
    const before = reviewProject(dir).record;
    writeFileSync(join(dir, ".pi/extensions/a.ts"), "2");
    const answers: string[] = [];
    const { resources } = reviewProject(dir);
    const request = { kind: "trust", id: "1", cwd: dir, resources, changes: diffReview(before, reviewProject(dir).record), respond: (a: string) => answers.push(a) } as any;
    screen = await testRender(<ThemeProvider><KeyboardLayerProvider><TrustPrompt request={request} /></KeyboardLayerProvider></ThemeProvider>, { width: 100, height: 30 });
    await act(async () => screen!.mockInput.pressKey("t" as never));
    await act(async () => screen!.mockInput.pressKey("RETURN" as never));
    await settle(100);
    expect(answers).toEqual([]);
    await settle(450);
    await act(async () => screen!.mockInput.pressKey("t" as never));
    await settle(450);
    await act(async () => screen!.mockInput.pressKey("RETURN" as never));
    await settle(50);
    expect(answers).toEqual(["trust"]);
  }, 20000);
});
