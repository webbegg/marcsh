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

// Verifier regression (S18 / D-R1-001): `/trust` never stores "trusted" from typeahead; only the full listing, read to
// the end, then `t` and Enter after the quiet window do.
describe("/trust cannot trust by typeahead (verify)", () => {
  const typeNow = async (text: string) => {
    for (const ch of text) await pressNow(ch);
  };

  test("`/trust` Enter Enter typed ahead never stores trusted", async () => {
    await openPiSession();
    await typeNow("/trust");
    await pressNow("RETURN");
    await pressNow("RETURN");
    await settle(400);
    expect(getStorage().getProjectTrust(cwd)).not.toBe("trusted");
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("`/trust` Enter ↓ Enter t Enter typed ahead stores nothing and leaves the listing open", async () => {
    await openPiSession();
    await typeNow("/trust");
    await pressNow("RETURN");
    await frameContaining("Project Trust");
    await act(async () => screen!.mockInput.pressArrow("down"));
    await pressNow("RETURN");
    await pressNow("t");
    await pressNow("RETURN");
    await settle(100);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    expect(frame()).toContain(TITLE);
  }, 30000);

  test("t typed again and again faster than the quiet window never arms", async () => {
    await openPiSession();
    await type("/trust");
    await press("RETURN");
    await frameContaining("Project Trust");
    await arrowDown();
    await press("RETURN");
    await frameContaining(TITLE);
    for (let i = 0; i < 8; i++) {
      await pressNow("t");
      await settle(100);
    }
    await pressNow("RETURN");
    await settle(100);
    expect(frame()).not.toContain("press Enter to trust");
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
  }, 30000);

  // Corrected design (D-R1-003): a file marcsh cannot read cannot be shown, so Trust is not offered at all.
  test("an .pi/mcp.json padded past 1 MB: /trust offers no Trust, says why, and trusts nothing", async () => {
    writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh", args: ["-c", "touch pwned"] } }, pad: " ".repeat(1100 * 1024) }));
    await openPiSession();
    await type("/trust");
    await press("RETURN");
    const shown = await frameContaining("Project Trust");
    expect(shown).toContain("Trust is not offered");
    expect(shown).toContain(".pi/mcp.json — could not be read: larger than 1 MB");
    expect(shown).toContain("Don't trust");
    expect(shown).not.toContain("pi loads this project's files");
    // The choice under the cursor is the first one, Don't trust: Enter saves that, never a trust.
    await arrowDown();
    await press("RETURN");
    await settle(100);
    expect(getStorage().getProjectTrust(cwd)).not.toBe("trusted");
    expect(existsSync(marker())).toBe(false);
  }, 30000);
});
