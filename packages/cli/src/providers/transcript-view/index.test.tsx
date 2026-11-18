import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-transcript-view-"));
process.env.MARCSH_PREFERENCES_PATH = join(dir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { createTranscriptViewStore, TranscriptViewProvider, useTranscriptView, transcriptViewKey } = await import("./index");
const { loadKeybinds, resetKeybinds } = await import("../../lib/keybinds");

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  resetKeybinds();
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("the store", () => {
  test("starts collapsed, toggles one switch at a time and tells the listeners", () => {
    const store = createTranscriptViewStore();
    expect(store.get()).toEqual({ details: false, thinking: false });
    let calls = 0;
    const off = store.subscribe(() => calls++);
    expect(store.toggle("details")).toBe(true);
    expect(store.get()).toEqual({ details: true, thinking: false });
    expect(store.toggle("details")).toBe(false);
    expect(calls).toBe(2);
    off();
    store.toggle("thinking");
    expect(calls).toBe(2);
    store.reset();
    expect(store.get()).toEqual({ details: false, thinking: false });
  });

  test("is not saved anywhere: a new store is collapsed again", () => {
    const first = createTranscriptViewStore();
    first.toggle("details");
    expect(createTranscriptViewStore().get().details).toBe(false);
  });
});

describe("useTranscriptView", () => {
  test("draws again when a switch flips", async () => {
    const store = createTranscriptViewStore();
    function Probe() {
      const view = useTranscriptView();
      return <text>{`details=${view.details} thinking=${view.thinking}`}</text>;
    }
    screen = await testRender(
      <TranscriptViewProvider store={store}>
        <Probe />
      </TranscriptViewProvider>,
      { width: 40, height: 3 },
    );
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("details=false thinking=false");
    await act(async () => void store.toggle("thinking"));
    await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("details=false thinking=true");
  });
});

describe("transcriptViewKey", () => {
  test("is the default before the keybinds are read", () => {
    resetKeybinds();
    expect(transcriptViewKey("details")).toBe("ctrl+x o");
    expect(transcriptViewKey("thinking")).toBe("ctrl+x h");
  });

  test("follows the user's own binding, and is empty when unbound", () => {
    const file = join(dir, "keybinds.json");
    writeFileSync(file, JSON.stringify({ details: ["alt+o"], thinking: [] }));
    process.env.MARCSH_KEYBINDS_PATH = file;
    try {
      resetKeybinds();
      loadKeybinds(["details", "thinking"]);
      expect(transcriptViewKey("details")).toBe("alt+o");
      expect(transcriptViewKey("thinking")).toBe("");
    } finally {
      delete process.env.MARCSH_KEYBINDS_PATH;
    }
  });
});
