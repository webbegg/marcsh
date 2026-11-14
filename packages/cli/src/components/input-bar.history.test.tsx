import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-input-history-"));
const prefsPath = join(dir, "preferences.json");
const historyFile = join(dir, "history.jsonl");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;
process.env.MARCSH_HISTORY_PATH = historyFile;

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { InputBar } = await import("./input-bar");
const { appendHistory, clearDrafts, readHistory } = await import("../lib/prompt-history");

// S9: Up on the first line and Down on the last line of the input walk the prompts sent before; the draft being typed comes back
// at the bottom. History is written when a prompt is sent. With a `draftKey`, unsent text survives the input unmounting.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let sent: string[] = [];

beforeAll(() => {
  writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude" }), "utf8");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  sent = [];
  rmSync(historyFile, { force: true });
  clearDrafts();
});
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const PLACEHOLDER = "Ask anything";

const seed = (...texts: string[]) => texts.forEach((text, i) => appendHistory({ text, cwd: "/p" }, historyFile, i + 1));

function Page({ draftKey }: { draftKey?: string }) {
  return <InputBar draftKey={draftKey} onSubmit={(text) => sent.push(text)} />;
}
// A different component type, so going from a page to this one unmounts the bar.
const OtherPage = () => <Page />;

async function open(routes: { path: string; element: React.ReactNode }[] = [{ path: "/", element: <Page /> }]) {
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: routes.map((r) => (r.path === "/" ? { index: true, element: r.element } : r)) }]);
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40, kittyKeyboard: true });
  await settle(150);
  return router;
}
const go = (router: Awaited<ReturnType<typeof open>>, to: string) =>
  act(async () => {
    await router.navigate(to);
  });
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const press = async (key: "up" | "down" | "left") => {
  await act(async () => screen!.mockInput.pressArrow(key));
  await settle(40);
};
const enter = async (modifiers?: { shift?: boolean; meta?: boolean }) => {
  await act(async () => screen!.mockInput.pressEnter(modifiers));
  await settle(60);
};

describe("Up and Down walk the prompts sent before", () => {
  test("Up recalls the newest prompt, then older ones, and stops at the oldest", async () => {
    seed("alpha one", "beta two", "gamma three");
    await open();

    await press("up");
    expect(frame()).toContain("gamma three");
    await press("up");
    expect(frame()).toContain("beta two");
    expect(frame()).not.toContain("gamma three");
    await press("up");
    await press("up");
    expect(frame()).toContain("alpha one");
  });

  test("Down goes newer, and past the newest it brings back the text that was being typed", async () => {
    seed("alpha one", "beta two");
    await open();
    await type("my draft");

    await press("up");
    expect(frame()).toContain("beta two");
    await press("up");
    expect(frame()).toContain("alpha one");
    await press("down");
    expect(frame()).toContain("beta two");
    await press("down");
    expect(frame()).toContain("my draft");
    expect(frame()).not.toContain("beta two");
    // Back on the draft, Down has nothing newer to go to.
    await press("down");
    expect(frame()).toContain("my draft");
  });

  test("with no history, Up changes nothing", async () => {
    await open();
    await press("up");
    expect(frame()).toContain(PLACEHOLDER);
  });

  test("a recalled multi-line prompt comes back whole", async () => {
    seed("first line\nsecond line");
    await open();
    await press("up");
    expect(frame()).toContain("first line second line");
  });

  test("Up only recalls on the first line: on a later line it moves the cursor", async () => {
    seed("old prompt");
    await open();
    await type("top");
    await enter({ shift: true });
    await type("bottom");

    await press("up");
    expect(frame()).toContain("top bottom");
    expect(frame()).not.toContain("old prompt");
    // Now on the first line, Up recalls.
    await press("up");
    expect(frame()).toContain("old prompt");
  });

  test("Down only goes newer on the last line", async () => {
    seed("newer", "older\nsecond");
    await open();
    await press("up");
    expect(frame()).toContain("older second");
    // The cursor is at the start (first line) of a two-line prompt: Down moves within it first.
    await press("down");
    expect(frame()).toContain("older second");
    expect(frame()).not.toContain("newer");
    await press("down");
    expect(frame()).not.toContain("older second");
  });

  test("typing after a recall leaves history navigation: the typed text is the new draft", async () => {
    seed("alpha one", "beta two");
    await open();

    await press("up");
    // A recalled prompt has the cursor at its start; Home/End are not arrows, so move to the end by key.
    await act(async () => screen!.mockInput.pressKey("END"));
    await type("!");
    expect(frame()).toContain("beta two!");

    // A fresh walk starts from the edited text, which Down brings back.
    await press("up");
    expect(frame()).toContain("beta two");
    expect(frame()).not.toContain("beta two!");
    await press("down");
    expect(frame()).toContain("beta two!");
  });

  test("Enter sends the recalled prompt as it is", async () => {
    seed("alpha one", "beta two");
    await open();
    await press("up");
    await press("up");
    await enter();

    expect(sent).toEqual(["alpha one"]);
    expect(frame()).toContain(PLACEHOLDER);
  });

  test("a recalled prompt that mentions a file does not open the @ menu over the arrow keys", async () => {
    seed("older", "@src check this");
    await open();
    await press("up");
    await press("up");
    expect(frame()).toContain("older");
    expect(frame()).not.toContain("Folder");
  });

  test("while the / menu is open, Up and Down belong to the menu", async () => {
    seed("alpha one");
    await open();
    await type("/");

    await press("up");
    await press("down");
    expect(frame()).not.toContain("alpha one");
  });
});

describe("history is written when a prompt is sent", () => {
  test("a sent prompt is stored with its cwd and shows up on the next Up", async () => {
    await open();
    await type("ship it");
    await enter();

    expect(sent).toEqual(["ship it"]);
    expect(readHistory(historyFile).map((entry) => ({ text: entry.text, cwd: entry.cwd }))).toEqual([{ text: "ship it", cwd: process.cwd() }]);
    await press("up");
    expect(frame()).toContain("ship it");
  });

  test("an empty Enter and unsent text are not stored", async () => {
    await open();
    await enter();
    await type("never sent");

    expect(readHistory(historyFile)).toEqual([]);
  });

  test("sending the same prompt twice in a row stores it once", async () => {
    await open();
    await type("again");
    await enter();
    await type("again");
    await enter();

    expect(sent).toEqual(["again", "again"]);
    expect(readHistory(historyFile)).toHaveLength(1);
  });
});

describe("the draft is kept per key", () => {
  test("unsent text comes back when an input with the same key mounts again", async () => {
    const router = await open([
      { path: "/", element: <Page draftKey="s1" /> },
      { path: "away", element: <OtherPage /> },
    ]);
    await type("half a thought");
    await go(router, "/away");
    await settle(100);
    expect(frame()).not.toContain("half a thought");

    await go(router, "/");
    await settle(100);
    expect(frame()).toContain("half a thought");
    // The cursor is at the end: typing goes on from there.
    await type("!");
    expect(frame()).toContain("half a thought!");
  });

  test("another key does not get it, and the draft is not handed to the next screen's input", async () => {
    const router = await open([
      { path: "/", element: <Page draftKey="s1" /> },
      { path: "other", element: <OtherPage /> },
      { path: "s2", element: <Page draftKey="s2" /> },
    ]);
    await type("only for s1");
    await go(router, "/other");
    await settle(100);
    expect(frame()).toContain(PLACEHOLDER);

    await go(router, "/s2");
    await settle(100);
    expect(frame()).toContain(PLACEHOLDER);
    expect(frame()).not.toContain("only for s1");
  });

  test("text that was sent is not kept", async () => {
    const router = await open([
      { path: "/", element: <Page draftKey="s1" /> },
      { path: "away", element: <OtherPage /> },
    ]);
    await type("sent already");
    await enter();
    await go(router, "/away");
    await settle(100);
    await go(router, "/");
    await settle(100);

    expect(frame()).toContain(PLACEHOLDER);
  });
});
