import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const dir = mkdtempSync(join(tmpdir(), "marcsh-input-selection-"));
process.env.MARCSH_PREFERENCES_PATH = join(dir, "preferences.json");
process.env.MARCSH_HISTORY_PATH = join(dir, "history.jsonl");
process.env.MARCSH_AGENTS_DIR = join(dir, "agents");
process.env.MARCSH_COMMANDS_DIR = join(dir, "commands");

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { InputBar } = await import("./input-bar");

// A keyboard selection covers exactly what the Shift+keys moved over, from where it started, whichever way it goes. OpenTUI 0.9 takes
// the cell under its start too (both ends inclusive), so typing over it deleted one character of the user's text more.

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let sent: string[] = [];
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  sent = [];
});

const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");

async function open() {
  const router = createMemoryRouter([
    { path: "/", element: <RootLayout />, children: [{ index: true, element: <InputBar cwd={dir} onSubmit={(text) => sent.push(text)} /> }] },
  ]);
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 30, kittyKeyboard: true });
  await settle(150);
}
type Modifiers = { shift?: boolean; ctrl?: boolean; meta?: boolean; super?: boolean };
const key = async (name: string, modifiers: Modifiers = {}, times = 1) => {
  for (let i = 0; i < times; i++) {
    await act(async () => screen!.mockInput.pressKey(name, modifiers));
    await settle(20);
  }
};
const type = async (value: string) => {
  await act(() => screen!.mockInput.typeText(value));
  await settle(40);
};
const paste = async (value: string) => {
  await act(() => screen!.mockInput.pasteBracketedText(value));
  await settle(80);
};
const send = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(80);
  return sent.at(-1);
};
const shift = { shift: true };
const LINES = "one\ntwo\nthree\nfour\nfive";

describe("Shift+Left and Shift+Right", () => {
  test("backward over 3 characters, then typing replaces just those", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 2);
    await key("ARROW_LEFT", shift, 3);

    await type("Q");

    expect(await send()).toBe("abQcd");
  });

  test("backward over 1 character, then typing replaces just it", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 2);
    await key("ARROW_LEFT", shift);

    await type("Q");

    expect(await send()).toBe("abXYQcd");
  });

  test("forward over 3 characters, then typing replaces just those", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 5);
    await key("ARROW_RIGHT", shift, 3);

    await type("Q");

    expect(await send()).toBe("abQcd");
  });

  test("forward over 1 character, then typing replaces just it", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 5);
    await key("ARROW_RIGHT", shift);

    await type("Q");

    expect(await send()).toBe("abQYZcd");
  });

  test("going back past where it started selects the other side", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 2);
    await key("ARROW_LEFT", shift, 2);
    await key("ARROW_RIGHT", shift, 3);

    await type("Q");

    expect(await send()).toBe("abXYZQd");
  });

  test("a large paste over a backward selection replaces just it with the placeholder", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 2);
    await key("ARROW_LEFT", shift, 3);

    await paste(LINES);
    expect(frame()).toContain("ab[Pasted ~5 lines");

    expect(await send()).toBe(`ab${LINES} cd`);
  });

  test("a large paste over a forward selection replaces just it with the placeholder", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 5);
    await key("ARROW_RIGHT", shift, 3);

    await paste(LINES);

    expect(await send()).toBe(`ab${LINES} cd`);
  });

  test("a short paste over a selection replaces just it", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 2);
    await key("ARROW_LEFT", shift, 3);

    await paste("pasted");

    expect(await send()).toBe("abpastedcd");
  });

  test("Backspace deletes just a forward selection", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 5);
    await key("ARROW_RIGHT", shift, 3);

    await key("BACKSPACE");

    expect(await send()).toBe("abcd");
  });

  test("Backspace deletes just a backward selection", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 2);
    await key("ARROW_LEFT", shift, 3);

    await key("BACKSPACE");

    expect(await send()).toBe("abcd");
  });

  test("Delete deletes just the selection", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 2);
    await key("ARROW_LEFT", shift, 3);

    await key("DELETE");

    expect(await send()).toBe("abcd");
  });

  test("plain Left ends the selection at its start", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 2);
    await key("ARROW_LEFT", shift, 3);

    await key("ARROW_LEFT");
    await type("Q");

    expect(await send()).toBe("abQXYZcd");
  });

  test("plain Right ends the selection at its end", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 2);
    await key("ARROW_LEFT", shift, 3);

    await key("ARROW_RIGHT");
    await type("Q");

    expect(await send()).toBe("abXYZQcd");
  });

  test("a new selection after the last one ended starts at the cursor", async () => {
    await open();
    await type("abXYZcd");
    await key("ARROW_LEFT", {}, 2);
    await key("ARROW_LEFT", shift, 3);
    await key("ARROW_RIGHT");

    await key("ARROW_RIGHT", shift);
    await type("Q");

    expect(await send()).toBe("abXYZQd");
  });
});

describe("other selection keys", () => {
  test("Shift+Home selects back to the start", async () => {
    await open();
    await type("hello world");
    await key("ARROW_LEFT", {}, 6);

    await key("HOME", shift);
    await type("Q");

    expect(await send()).toBe("Q world");
  });

  test("Shift+End selects on to the end", async () => {
    await open();
    await type("hello world");
    await key("ARROW_LEFT", {}, 6);

    await key("END", shift);
    await type("Q");

    expect(await send()).toBe("helloQ");
  });

  test("Shift+Alt+Left selects the word before the cursor", async () => {
    await open();
    await type("one two three");

    await key("ARROW_LEFT", { meta: true, shift: true });
    await type("Q");

    expect(await send()).toBe("one two Q");
  });

  test("Shift+Alt+Right selects what Alt+Right moves over", async () => {
    await open();
    await type("one two three");
    await key("ARROW_LEFT", {}, 13);
    await key("ARROW_RIGHT", { meta: true });
    await type("|");
    const moved = (await send())!.indexOf("|");
    await type("one two three");
    await key("ARROW_LEFT", {}, 13);

    await key("ARROW_RIGHT", { meta: true, shift: true });
    await type("Q");

    expect(await send()).toBe(`Q${"one two three".slice(moved)}`);
  });

  test("Cmd+A selects everything, and typing replaces it", async () => {
    await open();
    await type("replace me");
    await key("ARROW_LEFT", {}, 3);

    await key("a", { super: true });
    await type("Q");

    expect(await send()).toBe("Q");
  });

  test("Shift+Left after Cmd+A keeps the selection's start", async () => {
    await open();
    await type("abcdef");
    await key("a", { super: true });

    await key("ARROW_LEFT", shift);
    await type("Q");

    expect(await send()).toBe("Qf");
  });
});

describe("selections over wide characters", () => {
  test("backward over two CJK characters", async () => {
    await open();
    await type("日本語abc");
    await key("ARROW_LEFT", {}, 3);
    await key("ARROW_LEFT", shift, 2);

    await type("Q");

    expect(await send()).toBe("日Qabc");
  });

  test("forward over two CJK characters", async () => {
    await open();
    await type("日本語abc");
    await key("ARROW_LEFT", {}, 6);
    await key("ARROW_RIGHT", shift, 2);

    await type("Q");

    expect(await send()).toBe("Q語abc");
  });

  test("Backspace on a selection after CJK characters", async () => {
    await open();
    await type("日本語abc");
    await key("ARROW_LEFT", {}, 3);
    await key("ARROW_LEFT", shift, 1);

    await key("BACKSPACE");

    expect(await send()).toBe("日本abc");
  });

  test("a large paste over a selection after CJK characters", async () => {
    await open();
    await type("日本語abc");
    await key("ARROW_LEFT", {}, 1);
    await key("ARROW_LEFT", shift, 2);

    await paste(LINES);

    expect(await send()).toBe(`日本語${LINES} c`);
  });
});

// A placeholder is one piece: the cursor stops at its ends only. OpenTUI 0.9 moved Left from just after one to a cell before it.
describe("moving over a paste placeholder", () => {
  // `ab[Pasted ~5 lines: one] cd`, the cursor at the end: Left 3 times puts it just after the placeholder, 4 times just before it.
  async function withPlaceholder(before = "ab") {
    await open();
    await type(before);
    await paste(LINES);
    await type("cd");
    expect(frame()).toContain(`${before}[Pasted ~5 lines: one] cd`);
  }

  test("Left from just after it lands just before it", async () => {
    await withPlaceholder();
    await key("ARROW_LEFT", {}, 4);

    await type("X");

    expect(await send()).toBe(`abX${LINES} cd`);
  });

  test("Left past it moves one character on", async () => {
    await withPlaceholder();
    await key("ARROW_LEFT", {}, 5);

    await type("X");

    expect(await send()).toBe(`aXb${LINES} cd`);
  });

  test("Left up to it stops just after it", async () => {
    await withPlaceholder();
    await key("ARROW_LEFT", {}, 3);

    await type("X");

    expect(await send()).toBe(`ab${LINES}X cd`);
  });

  test("Right from just before it lands just after it", async () => {
    await withPlaceholder();
    await key("HOME");
    await key("ARROW_RIGHT", {}, 3);

    await type("X");

    expect(await send()).toBe(`ab${LINES}X cd`);
  });

  test("Shift+Left from just after it selects just it", async () => {
    await withPlaceholder();
    await key("ARROW_LEFT", {}, 3);
    await key("ARROW_LEFT", shift);

    await type("Q");

    expect(await send()).toBe("abQ cd");
  });

  test("Shift+Left across it selects it and what was moved over", async () => {
    await withPlaceholder();
    await key("ARROW_LEFT", {}, 1);
    await key("ARROW_LEFT", shift, 4);

    await type("Q");

    expect(await send()).toBe("aQd");
  });

  test("Shift+Right from just before it selects just it", async () => {
    await withPlaceholder();
    await key("HOME");
    await key("ARROW_RIGHT", {}, 2);
    await key("ARROW_RIGHT", shift);

    await type("Q");

    expect(await send()).toBe("abQ cd");
  });

  test("Backspace just after it deletes just it", async () => {
    await withPlaceholder();
    await key("ARROW_LEFT", {}, 3);

    await key("BACKSPACE");

    expect(await send()).toBe("ab cd");
  });

  test("Delete just before it deletes just it", async () => {
    await withPlaceholder();
    await key("HOME");
    await key("ARROW_RIGHT", {}, 2);

    await key("DELETE");

    expect(await send()).toBe("ab cd");
  });

  test("Alt+Left from the word after it lands just before it", async () => {
    await withPlaceholder();
    await key("ARROW_LEFT", {}, 2);

    await key("ARROW_LEFT", { meta: true });
    await type("X");

    expect(await send()).toBe(`abX${LINES} cd`);
  });

  test("Alt+Right from just before it lands just after it", async () => {
    await withPlaceholder();
    await key("HOME");
    await key("ARROW_RIGHT", {}, 2);

    await key("ARROW_RIGHT", { meta: true });
    await type("X");

    expect(await send()).toBe(`ab${LINES}X cd`);
  });

  test("Left over it after CJK characters", async () => {
    await withPlaceholder("日本");
    await key("ARROW_LEFT", {}, 4);

    await type("X");

    expect(await send()).toBe(`日本X${LINES} cd`);
  });

  test("Shift+Left over it after CJK characters selects just it", async () => {
    await withPlaceholder("日本");
    await key("ARROW_LEFT", {}, 3);
    await key("ARROW_LEFT", shift);

    await type("Q");

    expect(await send()).toBe("日本Q cd");
  });

  test("Up from the line below does not land inside it", async () => {
    await withPlaceholder();
    await key("RETURN", shift);
    await type("xxxxxxxxxx");

    await key("ARROW_UP");
    await type("Q");

    expect([`abQ${LINES} cd\nxxxxxxxxxx`, `ab${LINES}Q cd\nxxxxxxxxxx`]).toContain((await send())!);
  });

  test("Down from the line above does not land inside it", async () => {
    await open();
    await type("xxxxxxxxxx");
    await key("RETURN", shift);
    await type("ab");
    await paste(LINES);
    await key("ARROW_UP");
    await key("HOME");
    await key("ARROW_RIGHT", {}, 10);

    await key("ARROW_DOWN");
    await type("Q");

    // What is sent is trimmed: the placeholder's trailing space goes.
    expect([`xxxxxxxxxx\nabQ${LINES}`, `xxxxxxxxxx\nab${LINES}Q`]).toContain((await send())!);
  });
});
