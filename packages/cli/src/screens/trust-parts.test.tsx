import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-trust-parts-prefs-"));
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
const { reviewProject } = await import("../lib/engine/pi-trust");

// The review's three parts on screen: an upgraded project, the marks, unreadable commands, and the empty project's one step.

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

const marker = () => join(cwd, "marker-written.txt");
const commands = () => join(cwd, ".marcsh", "commands");
const REPLY = "turn finished";
const TITLE = "Trust this project's files?";
const CHANGED = "This project's files changed since you trusted them";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-trust-parts-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "extensions", "marker.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker())}, "loaded");\nexport default function () {}\n`);
  mkdirSync(commands(), { recursive: true });
  writeFileSync(join(commands(), "deploy.md"), "Deploy $ARGUMENTS\n");
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  getStorage().setProjectTrust(cwd, null);
  rmSync(dir, { recursive: true, force: true });
});

const settle = async (ms = 30) => {
  await act(() => new Promise<void>((r) => setTimeout(r, ms)));
  if (screen && !screen.renderer.isDestroyed) await screen.renderOnce();
};
const QUIET_MS = 350;
let lastActivityAt = 0;
const pressNow = async (key: string) => {
  lastActivityAt = Date.now();
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(10);
};
const press = async (key: string) => {
  const wait = QUIET_MS - (Date.now() - lastActivityAt);
  if (wait > 0) await settle(wait);
  await pressNow(key);
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
const collapse = (frame: string) => frame.replace(/[│┃\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());
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

const openTrust = async () => {
  await type("/trust");
  await press("RETURN");
  return frameContaining("Project Trust");
};

/** What marcsh stored before it reviewed commands and git settings: the pi entries, with no `kind`. */
const trustAsBeforeTheUpgrade = () =>
  getStorage().setProjectTrust(
    cwd,
    "trusted",
    reviewProject(cwd)
      .record.filter((entry) => entry.kind === "pi")
      .map(({ path, shown, content }) => ({ path, shown, content })),
  );

describe("a pi project trusted before marcsh reviewed its commands (R3-1, R3-2)", () => {
  test("the pi turn asks nothing and loads the pi files", async () => {
    trustAsBeforeTheUpgrade();
    await openPiSession("hello");

    const reply = await frameContaining(REPLY);

    expect(reply).toContain(REPLY);
    expect(reply).not.toContain(TITLE);
    expect(existsSync(marker())).toBe(true);
  }, 30000);

  test("/trust says the commands are not reviewed yet, and its list marks them so, not as changes", async () => {
    trustAsBeforeTheUpgrade();
    await openPiSession();

    const dialog = await openTrust();
    expect(dialog).toContain("Now: trusted, but not for project commands (not reviewed yet)");

    await arrowDown();
    await press("RETURN");
    const prompt = await frameContaining(TITLE);
    expect(prompt).not.toContain(CHANGED);
    expect(prompt).toContain("[unchanged] .pi/extensions/marker.ts");
    expect(prompt).toContain("[not reviewed before] .marcsh/commands/deploy.md — project command /deploy");
    expect(prompt).not.toContain("[added]");
  }, 30000);
});

describe("a command marcsh cannot read (R3-4)", () => {
  test("the pi turn still offers trust, and says the unreadable command stays off", async () => {
    writeFileSync(join(commands(), "locked.md"), "locked\n");
    chmodSync(join(commands(), "locked.md"), 0);
    try {
      await openPiSession("hello");
      const prompt = await frameContaining(TITLE);

      expect(prompt).toContain(".marcsh/commands/locked.md — could not be read");
      expect(prompt).toContain("the 1 unreadable stays off");
      expect(prompt).not.toContain("trusting is not offered");
    } finally {
      chmodSync(join(commands(), "locked.md"), 0o644);
    }
  }, 30000);
});

describe("the race path (R1-3)", () => {
  test("files that vanished while the list was open: the emptied list is shown, nothing is saved", async () => {
    rmSync(join(cwd, ".pi"), { recursive: true, force: true });
    await openPiSession();
    await openTrust();
    await arrowDown();
    await press("RETURN");
    await frameContaining(TITLE);

    rmSync(join(cwd, ".marcsh"), { recursive: true, force: true });
    await press("t");
    await press("RETURN");

    expect(await frameContaining("Nothing to review")).toContain("Nothing to review");
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
  }, 30000);
});
