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

  test("Esc cancels the select (the extension gets undefined) without interrupting the turn", async () => {
    writeCommand(
      "pick",
      `    const choice = await ctx.ui.select("Pick a color", ["Red", "Green"]);\n    ctx.ui.notify("got=" + choice);\n    const again = await ctx.ui.input("Still running?");\n    ctx.ui.notify("again=" + again);`,
    );
    await openPiSession("/pick");
    await frameContaining("Pick a color");

    await press("ESCAPE");

    expect(await frameContaining("got=undefined")).toContain("got=undefined");
    expect(await frameContaining("Still running?")).toContain("Still running?");
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
