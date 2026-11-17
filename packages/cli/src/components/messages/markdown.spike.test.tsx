import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-markdown-spike-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { testRender } = await import("@opentui/react/test-utils");
const { ThemeProvider } = await import("../../providers/theme");
const { useSyntaxStyle } = await import("../../hooks/use-syntax-style");

// Spike for S8: <markdown> renders in the test renderer with a SyntaxStyle built from the theme, without the tree-sitter
// highlight having to finish (it runs in a worker and lands on a later frame).

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});
const settle = async (ms = 60) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame();

function Md({ content, streaming }: { content: string; streaming?: boolean }) {
  const syntaxStyle = useSyntaxStyle();
  return <markdown content={content} syntaxStyle={syntaxStyle} streaming={streaming} />;
}

async function render(content: string, streaming?: boolean) {
  screen = await testRender(
    <ThemeProvider>
      <Md content={content} streaming={streaming} />
    </ThemeProvider>,
    { width: 80, height: 20 },
  );
  await settle();
}

describe("<markdown> in the test renderer", () => {
  test("shows bold text without the asterisks", async () => {
    await render("a **bold** word");
    expect(frame()).toContain("a bold word");
    expect(frame()).not.toContain("**");
  });

  test("shows a heading", async () => {
    await render("# Big Title\n\nbody");
    expect(frame()).toContain("Big Title");
    expect(frame()).toContain("body");
  });

  test("shows the code of a fenced block", async () => {
    await render("```ts\nconst answer = 42;\n```");
    expect(frame()).toContain("const answer = 42;");
  });

  test("asks the network for nothing when no tree-sitter client or parser URL is given", async () => {
    // Only the main thread can be watched here; the worker downloads only from http(s) sources, and the bundled parsers are local paths.
    const realFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args[0]);
      return Promise.reject(new Error("no network in tests"));
    }) as typeof fetch;
    try {
      await render("```ts\nconst answer = 42;\n```");
      await settle(200);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual([]);
  });

  test("renders streaming content with an unclosed emphasis without throwing", async () => {
    await render("so **bo", true);
    expect(frame()).toContain("bo");
  });

  test("an update of streaming content keeps rendering", async () => {
    await render("so **bo", true);
    await act(async () => screen!.renderer.root.requestRender());
    await settle();
    expect(frame()).toContain("so");
  });
});
