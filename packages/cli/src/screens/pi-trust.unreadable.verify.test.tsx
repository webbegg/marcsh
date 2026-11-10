import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-trust-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
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

const marker = () => join(cwd, "marker-written.txt");
const REPLY = "turn finished";
const TITLE = "Trust this project's pi files?";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-trust-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  // An extension that writes a marker file the moment pi loads it, and an MCP server config with a command to read.
  writeFileSync(join(cwd, ".pi", "extensions", "marker.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker())}, "loaded");\nexport default function () {}\n`);
  writeFileSync(
    join(cwd, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { command: "fixture-mcp-server", args: ["--stdio", "\u001b]0;pwned\u0007--flag"] } } }),
  );
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
// The prompt ignores answer keys until the keyboard has been quiet for 300 ms.
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
// Joins word-wrapped lines (and the prompt's borders) back into one string.
const collapse = (frame: string) => frame.replace(/[│┃\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());
// A real pi turn runs asynchronously: wait for the expected text instead of racing it.
const frameContaining = async (text: string, timeoutMs = 8000) => {
  const start = Date.now();
  let current = frame();
  while (!current.includes(text) && Date.now() - start < timeoutMs) {
    await settle(25);
    current = frame();
  }
  lastActivityAt = Date.now();
  return current;
};

// A real pi engine on pi's faux provider (no network). With a prompt it is the session's first turn; without one the session just opens.
async function openPiSession(prompt?: string, size = { width: 110, height: 40 }) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText(REPLY)])]);
  const model = modelRuntime.getModel("faux", "faux-1")!;
  modelRuntime.getAvailable = async () => [model];
  engines.set("pi", createPiEngine({ agentDir, modelRuntime, pluginPath: null }));

  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    {
      initialEntries: [
        { pathname: `/sessions/${session.id}`, state: prompt ? { initialPrompt: { message: prompt, mode: "BUILD", model: "opus" } } : undefined },
      ],
    },
  );
  screen = await testRender(<RouterProvider router={router} />, size);
  await settle();
  return session;
}

// Verifier regression (S18, hardening B1): a project file marcsh cannot read is never trusted from the turn prompt, by
// typeahead, paste or a short terminal, and `/trust` refuses when the file stopped being readable after it opened.
describe("a project file marcsh cannot read is never trusted (verify)", () => {
  const TOO_BIG = ".pi/mcp.json — could not be read: larger than 1 MB";
  const pad = () =>
    writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh", args: ["-c", "touch pwned"] } }, pad: " ".repeat(1100 * 1024) }));

  test("turn prompt: t/Enter typed ahead, t then Enter, and a pasted t+Enter neither arm nor trust; Esc runs the turn untrusted", async () => {
    pad();
    await openPiSession("hello");
    for (let i = 0; i < 4; i++) {
      await pressNow("t");
      await pressNow("RETURN");
    }
    const shown = await frameContaining(TITLE);
    expect(shown).toContain(TOO_BIG);
    expect(shown).toContain("trusting is not offered");
    await press("t");
    expect(frame()).not.toContain("press Enter to trust");
    await press("RETURN");
    await act(async () => screen!.mockInput.pasteBracketedText("t\r"));
    await settle(100);
    expect(frame()).toContain(TITLE);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    await press("ESCAPE");
    await frameContaining(REPLY);
    expect(frame()).toContain(REPLY);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("a terminal too short for the list says why trust is not offered, and t then Enter trusts nothing", async () => {
    pad();
    await openPiSession("hello", { width: 80, height: 8 });
    const shown = await frameContaining(TITLE);
    expect(shown).toContain("trusting is not offered");
    await press("t");
    await press("RETURN");
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    await press("d");
    await frameContaining(REPLY);
    expect(getStorage().getProjectTrust(cwd)).toBe("untrusted");
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("/trust: a file that grows past 1 MB after the dialog opened makes Trust refuse with an error and store nothing", async () => {
    await openPiSession();
    await type("/trust");
    await press("RETURN");
    expect(await frameContaining("Project Trust")).toContain("pi loads this project's files");
    pad();
    await type("loads");
    await press("RETURN");
    const shown = await frameContaining("could not read some of this project's pi files");
    expect(shown).toContain("cannot show what trusting would run");
    expect(shown).not.toContain(TITLE);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    expect(existsSync(marker())).toBe(false);
  }, 30000);
});
