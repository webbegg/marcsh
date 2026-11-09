import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-ui-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxProvider, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { createPiEngine } = await import("../lib/engine/pi");

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-ui-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
// The prompts ignore keys until the keyboard has been quiet for 300 ms.
const QUIET_MS = 350;
let lastActivityAt = 0;
const pressNow = async (key: string, modifiers?: { ctrl?: boolean; shift?: boolean }) => {
  lastActivityAt = Date.now();
  await act(async () => screen!.mockInput.pressKey(key as never, modifiers));
  await settle(10);
};
// Like a user who pauses before answering: waits out the quiet window since the last key or prompt.
const press = async (key: string, modifiers?: { ctrl?: boolean; shift?: boolean }) => {
  const wait = QUIET_MS - (Date.now() - lastActivityAt);
  if (wait > 0) await settle(wait);
  await pressNow(key, modifiers);
  await settle();
};
const arrowDown = async () => {
  const wait = QUIET_MS - (Date.now() - lastActivityAt);
  if (wait > 0) await settle(wait);
  lastActivityAt = Date.now();
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle();
};
const type = async (text: string) => {
  lastActivityAt = Date.now();
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
// Joins word-wrapped lines (and the prompt's and toast's borders) back into one string.
const collapse = (frame: string) => frame.replace(/[│┃\s]+/g, " ");
// A real pi turn runs asynchronously: wait for the expected text instead of racing it.
const frameContaining = async (text: string, timeoutMs = 8000) => {
  const start = Date.now();
  let frame = collapse(screen!.captureCharFrame());
  while (!frame.includes(text) && Date.now() - start < timeoutMs) {
    await settle(25);
    frame = collapse(screen!.captureCharFrame());
  }
  lastActivityAt = Date.now();
  return frame;
};
const frame = () => collapse(screen!.captureCharFrame());

// A command that asks, then shows what it got as a toast (`got=<answer>`).
function writeCommand(name: string, body: string) {
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", `${name}.ts`),
    `export default function (pi) {\n  pi.registerCommand(${JSON.stringify(name)}, { description: "probe", handler: async (_args, ctx) => {\n${body}\n  } });\n}\n`,
  );
}

// A real pi engine on pi's faux provider (no network); the slash command is the session's first prompt.
async function openPiSession(command: string) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("faux", "faux-1")!;
  modelRuntime.getAvailable = async () => [model];
  engines.set("pi", createPiEngine({ agentDir, modelRuntime }));

  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: command, mode: "BUILD", model: "opus" } } }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 40 });
  await settle();
  return session;
}

describe("select from a pi extension (S7)", () => {
  const command = () =>
    writeCommand("pick", `    const choice = await ctx.ui.select("Pick a color", ["Red", "Green", "Blue"]);\n    ctx.ui.notify("got=" + choice);`);

  test("shows the title and the options, and Enter answers the highlighted one", async () => {
    command();
    await openPiSession("/pick");

    const prompt = await frameContaining("Pick a color");

    for (const [i, option] of ["Red", "Green", "Blue"].entries()) expect(prompt).toContain(`${i + 1} ${option}`);
    await arrowDown();
    await press("RETURN");
    expect(await frameContaining("got=Green")).toContain("got=Green");
    expect(frame()).not.toContain("Pick a color");
  }, 30000);

  test("a number picks that option", async () => {
    command();
    await openPiSession("/pick");
    await frameContaining("Pick a color");

    await press("3");

    expect(await frameContaining("got=Blue")).toContain("got=Blue");
  }, 30000);

  test("typing while the prompt appears answers nothing, and the keys are not lost to the main input", async () => {
    command();
    await openPiSession("/pick");
    await frameContaining("Pick a color");

    await pressNow("2");
    await pressNow("RETURN");
    await settle(100);

    expect(frame()).toContain("Pick a color");
    expect(frame()).not.toContain("got=");
    await press("2");
    expect(await frameContaining("got=Green")).toContain("got=Green");
  }, 30000);

  test("Esc cancels the select (the extension gets undefined) and interrupts the turn: its next ask is cancelled unseen", async () => {
    writeCommand(
      "pick",
      `    const choice = await ctx.ui.select("Pick a color", ["Red", "Green"]);\n    const again = await ctx.ui.input("Still running?");\n    ctx.ui.notify("got=" + choice + " again=" + again);`,
    );
    await openPiSession("/pick");
    await frameContaining("Pick a color");

    await press("ESCAPE");

    expect(await frameContaining("got=undefined again=undefined")).toContain("got=undefined again=undefined");
    expect(frame()).not.toContain("Still running?");
  }, 30000);

  test("many options scroll with the highlight: the last one can be chosen", async () => {
    const options = Array.from({ length: 20 }, (_, i) => `Option ${i + 1}`);
    writeCommand("pick", `    const choice = await ctx.ui.select("Pick one", ${JSON.stringify(options)});\n    ctx.ui.notify("got=" + choice);`);
    await openPiSession("/pick");
    const prompt = await frameContaining("Pick one");
    expect(prompt).toContain("Option 1");
    expect(prompt).not.toContain("Option 20");

    for (let i = 0; i < 19; i++) await arrowDown();

    expect(frame()).toContain("Option 20");
    await press("RETURN");
    expect(await frameContaining("got=Option 20")).toContain("got=Option 20");
  }, 60000);
});

describe("confirm from a pi extension (S7)", () => {
  const command = () =>
    writeCommand("wipe", `    const yes = await ctx.ui.confirm("Delete everything?", "This cannot be undone");\n    ctx.ui.notify("got=" + yes);`);

  test("shows the title and the message; y then Enter confirms", async () => {
    command();
    await openPiSession("/wipe");

    const prompt = await frameContaining("Delete everything?");

    expect(prompt).toContain("This cannot be undone");
    await press("y");
    expect(frame()).toContain("press Enter to confirm");
    await press("RETURN");
    expect(await frameContaining("got=true")).toContain("got=true");
  }, 30000);

  test("n cancels", async () => {
    command();
    await openPiSession("/wipe");
    await frameContaining("Delete everything?");

    await press("n");

    expect(await frameContaining("got=false")).toContain("got=false");
  }, 30000);

  test("Esc cancels", async () => {
    command();
    await openPiSession("/wipe");
    await frameContaining("Delete everything?");

    await press("ESCAPE");

    expect(await frameContaining("got=false")).toContain("got=false");
  }, 30000);

  test("typeahead during the quiet window does not confirm: y and Enter typed as the prompt appears are ignored", async () => {
    command();
    await openPiSession("/wipe");
    await frameContaining("Delete everything?");

    await pressNow("y");
    await pressNow("RETURN");
    await settle(100);

    expect(frame()).toContain("Delete everything?");
    expect(frame()).toContain("waiting for typing to stop");
    expect(frame()).not.toContain("got=");
  }, 30000);

  test("one key is not enough: y alone does not confirm, and any other key disarms it", async () => {
    command();
    await openPiSession("/wipe");
    await frameContaining("Delete everything?");

    await press("y");
    await settle(100);
    expect(frame()).not.toContain("got=");
    await press("x");
    expect(frame()).not.toContain("press Enter to confirm");
    await press("RETURN");

    expect(frame()).toContain("Delete everything?");
    expect(frame()).not.toContain("got=");
  }, 30000);

  test("Ctrl+y is ignored", async () => {
    command();
    await openPiSession("/wipe");
    await frameContaining("Delete everything?");

    await press("y", { ctrl: true });
    await press("RETURN");

    expect(frame()).toContain("Delete everything?");
    expect(frame()).not.toContain("got=");
  }, 30000);
});

describe("input and editor from a pi extension (S7)", () => {
  test("input shows the title and placeholder, and Enter answers with the typed text", async () => {
    writeCommand("name", `    const text = await ctx.ui.input("Feature name", "kebab-case please");\n    ctx.ui.notify("got=" + text);`);
    await openPiSession("/name");

    const prompt = await frameContaining("Feature name");
    expect(prompt).toContain("kebab-case please");
    await settle(QUIET_MS);
    await type("my-feature");
    await press("RETURN");

    expect(await frameContaining("got=my-feature")).toContain("got=my-feature");
  }, 30000);

  test("Esc cancels the input: the extension gets undefined", async () => {
    writeCommand("name", `    const text = await ctx.ui.input("Feature name");\n    ctx.ui.notify("got=" + text);`);
    await openPiSession("/name");
    await frameContaining("Feature name");
    await settle(QUIET_MS);
    await type("half");

    await press("ESCAPE");

    expect(await frameContaining("got=undefined")).toContain("got=undefined");
  }, 30000);

  test("Enter typed as the prompt appears does not submit it", async () => {
    writeCommand("name", `    const text = await ctx.ui.input("Feature name");\n    ctx.ui.notify("got=" + JSON.stringify(text));`);
    await openPiSession("/name");
    await frameContaining("Feature name");

    await pressNow("RETURN");
    await settle(100);

    expect(frame()).toContain("Feature name");
    expect(frame()).not.toContain("got=");
  }, 30000);

  test("editor starts with the prefill; typing adds to it and Enter submits the whole text", async () => {
    writeCommand("note", `    const text = await ctx.ui.editor("Edit the note", "first line");\n    ctx.ui.notify("got=" + text);`);
    await openPiSession("/note");

    const prompt = await frameContaining("Edit the note");
    expect(prompt).toContain("first line");
    await settle(QUIET_MS);
    await type("!");
    await press("RETURN");

    expect(await frameContaining("got=first line!")).toContain("got=first line!");
  }, 30000);

  test("editor: Esc cancels", async () => {
    writeCommand("note", `    const text = await ctx.ui.editor("Edit the note", "first line");\n    ctx.ui.notify("got=" + text);`);
    await openPiSession("/note");
    await frameContaining("Edit the note");

    await press("ESCAPE");

    expect(await frameContaining("got=undefined")).toContain("got=undefined");
  }, 30000);
});

describe("Esc on an extension dialog stops the turn (S7)", () => {
  // An extension that asks again until it gets an answer (here up to 5 times) cannot trap the session.
  const reasking: Record<string, [string, string]> = {
    select: ["Pick again", `    for (let i = 0; i < 5 && !(await ctx.ui.select("Pick again", ["Red", "Green"])); i++) {}\n    ctx.ui.notify("left the loop");`],
    confirm: ["Sure?", `    for (let i = 0; i < 5 && !(await ctx.ui.confirm("Sure?", "m")); i++) {}\n    ctx.ui.notify("left the loop");`],
    input: ["Name?", `    for (let i = 0; i < 5 && !(await ctx.ui.input("Name?")); i++) {}\n    ctx.ui.notify("left the loop");`],
    editor: ["Note?", `    for (let i = 0; i < 5 && !(await ctx.ui.editor("Note?", "x")); i++) {}\n    ctx.ui.notify("left the loop");`],
  };

  for (const [kind, [title, body]] of Object.entries(reasking)) {
    test(`${kind}: one Esc ends the turn instead of showing the same ask again`, async () => {
      writeCommand("loop", body);
      await openPiSession("/loop");
      await frameContaining(title);

      await press("ESCAPE");
      await settle(300);

      expect(await frameContaining("left the loop")).toContain("left the loop");
      expect(frame()).not.toContain(title);
      expect(frame()).not.toContain("waiting for typing to stop");
    }, 30000);
  }
});

describe("extension dialogs are labelled as the extension's (S7)", () => {
  const LABEL = "pi extension asks";

  test("each dialog says that a pi extension is asking", async () => {
    for (const [name, call] of [
      ["label-select", `ctx.ui.select("Which?", ["a", "b"])`],
      ["label-confirm", `ctx.ui.confirm("Sure?", "m")`],
      ["label-input", `ctx.ui.input("Who?")`],
      ["label-editor", `ctx.ui.editor("Text?", "x")`],
    ] as const) {
      writeCommand(name, `    await ${call};`);
    }

    for (const [name, title] of [
      ["label-select", "Which?"],
      ["label-confirm", "Sure?"],
      ["label-input", "Who?"],
      ["label-editor", "Text?"],
    ] as const) {
      await openPiSession(`/${name}`);
      expect(await frameContaining(title)).toContain(LABEL);
      await act(async () => screen!.renderer.destroy());
      screen = null;
      engines.set("pi", undefined);
    }
  }, 60000);

  test("an extension's confirm titled like marcsh's approval prompt still carries the label", async () => {
    writeCommand("spoof", `    await ctx.ui.confirm("Allow bash?", "rm -rf ~");`);
    await openPiSession("/spoof");

    const prompt = await frameContaining("Allow bash?");

    expect(prompt).toContain(LABEL);
    expect(prompt.indexOf(LABEL)).toBeLessThan(prompt.indexOf("Allow bash?"));
  }, 30000);
});

describe("terminal control characters in extension text (S7)", () => {
  test("stripControlChars removes C0 (except newline and tab), ESC sequences and C1, and keeps the visible text", async () => {
    const { stripControlChars } = await import("../components/ui-prompts");

    expect(stripControlChars("plain text")).toBe("plain text");
    expect(stripControlChars("a\tb\nc")).toBe("a\tb\nc");
    expect(stripControlChars("a\u0000b\u0007c\u0008d\re\u007ff")).toBe("abcdef");
    expect(stripControlChars("\u001b[31mred\u001b[0m \u001b[2J\u001b[1;5Hgone")).toBe("red gone");
    expect(stripControlChars("x\u001b]0;evil title\u0007y\u001b]8;;http://e\u001b\\link")).toBe("xylink");
    expect(stripControlChars("a\u001bPdcs payload\u001b\\b\u001b_apc\u001b\\c")).toBe("abc");
    expect(stripControlChars("a\u001bcb\u001b7c")).toBe("abc");
    expect(stripControlChars("a\u009b31mb\u0085c\u009d0;t\u009cd")).toBe("abcd");
    expect(stripControlChars("lone \u001b")).toBe("lone ");
  });

  test("titles, messages, options, placeholders, prefills and notify text render without them; the extension still gets its own option back", async () => {
    writeCommand(
      "messy",
      [
        `    const choice = await ctx.ui.select("Pick\\u001b[31m one\\u0007", ["Re\\u001b[1md", "Gr\\u0000een"]);`,
        `    ctx.ui.notify("got=" + JSON.stringify(choice));`,
        `    await ctx.ui.confirm("Allow\\u001b[2J\\u001b]0;pwned\\u0007 files\\u009b2K now", "mess\\u0007age\\r\\u001b[31mred");`,
        `    await ctx.ui.input("Name", "hold\\u001b[31mer");`,
        `    await ctx.ui.editor("Text", "pre\\u0007fill\\u001b[2K");`,
        `    ctx.ui.notify("Done\\u001b[31m!\\u0007");`,
      ].join("\n"),
    );
    await openPiSession("/messy");

    const select = await frameContaining("Pick");
    expect(select).toContain("Pick one");
    expect(select).toContain("1 Red");
    expect(select).toContain("2 Green");
    await press("1");
    expect(await frameContaining("got=")).toContain('got="Re\\u001b[1md"');

    const confirm = await frameContaining("Allow");
    expect(confirm).toContain("Allow files now");
    expect(confirm).toContain("message");
    expect(confirm).toContain("red");
    expect(confirm).not.toContain("pwned");
    await press("n");

    const input = await frameContaining("Name");
    expect(input).toContain("holder");
    await press("ESCAPE");
  }, 60000);

  test("editor prefill and notify text render without them", async () => {
    writeCommand(
      "messy-editor",
      [`    ctx.ui.notify("Done\\u001b[31m!\\u0007");`, `    await ctx.ui.editor("Text", "pre\\u0007fill\\u001b[2K");`].join("\n"),
    );
    await openPiSession("/messy-editor");

    const editor = await frameContaining("Text");

    expect(editor).toContain("prefill");
    expect(editor).toContain("Done!");
  }, 30000);
});

describe("notify and custom components from a pi extension (S7)", () => {
  test("notify shows a toast with the message", async () => {
    writeCommand("hello", `    ctx.ui.notify("Deployed to staging", "info");`);
    await openPiSession("/hello");

    expect(await frameContaining("Deployed to staging")).toContain("Deployed to staging");
  }, 30000);

  test("a warning is marked as one and an error reads as the message", async () => {
    writeCommand("warn", `    ctx.ui.notify("Disk is almost full", "warning");`);
    await openPiSession("/warn");

    expect(await frameContaining("Warning: Disk is almost full")).toContain("Warning: Disk is almost full");
  }, 30000);

  test("custom() says that pi's own terminal UI is not supported and the extension carries on", async () => {
    writeCommand(
      "fancy",
      `    const result = await ctx.ui.custom(() => { throw new Error("never built"); });\n    await new Promise((resolve) => setTimeout(resolve, 100));\n    ctx.ui.notify("after=" + result);`,
    );
    await openPiSession("/fancy");

    expect(await frameContaining("which marcsh does not support")).toContain(
      "This extension needs pi's own terminal UI, which marcsh does not support",
    );
  }, 30000);
});
