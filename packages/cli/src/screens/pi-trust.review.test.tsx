import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-review-prefs-"));
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
const { reviewProject, sameReview } = await import("../lib/engine/pi-trust");

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

const marker = () => join(cwd, "marker-written.txt");
const extension = (name: string) => join(cwd, ".pi", "extensions", name);
const REPLY = "turn finished";
const TITLE = "Trust this project's pi files?";
const CHANGED = "This project's pi files changed since you trusted them";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-review-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(extension("marker.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker())}, "loaded");\nexport default function () {}\n`);
  writeFileSync(extension("old.ts"), "export default function () {}\n");
  writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "fixture-mcp-server", args: ["--stdio"] } } }));
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
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

/** The project is trusted as it is now; then a file is edited, one is added and one is removed. */
const trustThenChange = () => {
  getStorage().setProjectTrust(cwd, "trusted", reviewProject(cwd).record);
  writeFileSync(extension("marker.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker())}, "loaded again");\nexport default function () {}\n`);
  writeFileSync(extension("new.ts"), "export default function () {}\n");
  rmSync(extension("old.ts"));
};

describe("the trust prompt after a trusted project changed (S1)", () => {
  test("it says the files changed, marks added / changed / unchanged entries and lists the removed path; nothing loads", async () => {
    trustThenChange();
    await openPiSession("hello");

    const prompt = await frameContaining(CHANGED);

    expect(prompt).toContain(CHANGED);
    expect(prompt).not.toContain(TITLE);
    expect(prompt).toContain("[changed] .pi/extensions/marker.ts");
    expect(prompt).toContain("[added] .pi/extensions/new.ts");
    expect(prompt).toContain("[unchanged] .pi/mcp.json — server fixture: fixture-mcp-server --stdio");
    expect(prompt).toContain("[removed] .pi/extensions/old.ts");
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("typeahead cannot trust: t and Enter typed as the prompt appears answer nothing", async () => {
    trustThenChange();
    await openPiSession("hello");
    await frameContaining(CHANGED);

    await pressNow("t");
    await pressNow("RETURN");
    await settle(100);

    expect(frame()).toContain(CHANGED);
    expect(frame()).toContain("waiting for typing to stop");
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("t then Enter trusts again: the files load, the new review is stored, and the next turn does not ask", async () => {
    trustThenChange();
    await openPiSession("hello");
    await frameContaining(CHANGED);

    await press("t");
    expect(frame()).toContain("press Enter to trust");
    await press("RETURN");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(existsSync(marker())).toBe(true);
    expect(getStorage().getProjectTrust(cwd)).toBe("trusted");
    expect(sameReview(getStorage().getProjectReview(cwd)!, reviewProject(cwd).record)).toBe(true);
  }, 30000);

  test("d stores untrusted and the turn goes on without loading the project", async () => {
    trustThenChange();
    await openPiSession("hello");
    await frameContaining(CHANGED);

    await press("d");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(existsSync(marker())).toBe(false);
    expect(getStorage().getProjectTrust(cwd)).toBe("untrusted");
  }, 30000);

  test("Esc is not now: the turn goes on untrusted and the stored review is left as it was", async () => {
    trustThenChange();
    const before = getStorage().getProjectReview(cwd)!;
    await openPiSession("hello");
    await frameContaining(CHANGED);

    await press("ESCAPE");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(existsSync(marker())).toBe(false);
    expect(getStorage().getProjectTrust(cwd)).toBe("trusted");
    expect(sameReview(getStorage().getProjectReview(cwd)!, before)).toBe(true);
  }, 30000);

  test("a trusted row stored before reviews existed asks the same way, and says it cannot tell what changed", async () => {
    getStorage().setProjectTrust(cwd, "trusted");
    await openPiSession("hello");

    const prompt = await frameContaining(CHANGED);

    expect(prompt).toContain("cannot tell which files changed");
    expect(prompt).not.toContain("[unchanged]");
    expect(prompt).toContain(".pi/extensions/marker.ts");
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("a project whose files did not change loads without asking", async () => {
    getStorage().setProjectTrust(cwd, "trusted", reviewProject(cwd).record);
    await openPiSession("hello");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(frame()).not.toContain(CHANGED);
    expect(existsSync(marker())).toBe(true);
  }, 30000);

  test("a stored untrusted stays untrusted without asking, though files changed", async () => {
    getStorage().setProjectTrust(cwd, "untrusted");
    writeFileSync(extension("new.ts"), "x");
    await openPiSession("hello");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(frame()).not.toContain(CHANGED);
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("the changed list is reviewed to the end like any other: on a short screen t waits for the last entry", async () => {
    for (let i = 0; i < 40; i++) writeFileSync(extension(`e${String(i).padStart(2, "0")}.ts`), "export default function () {}\n");
    getStorage().setProjectTrust(cwd, "trusted", reviewProject(cwd).record);
    writeFileSync(extension("e00.ts"), "changed");
    await openPiSession("hello", { width: 80, height: 24 });
    await frameContaining(CHANGED);
    await frameContaining("scroll to the end first");

    await press("t");
    await press("RETURN");
    expect(frame()).not.toContain("press Enter to trust");
    expect(existsSync(marker())).toBe(false);

    for (let i = 0; i < 20; i++) await pressNow("\u001b[6~");
    await press("t");
    expect(frame()).toContain("press Enter to trust");
  }, 30000);

  test("a path with a control character in the removed list is shown escaped", async () => {
    getStorage().setProjectTrust(cwd, "trusted", reviewProject(cwd).record);
    const weird = `bad${String.fromCodePoint(0x1b)}name.ts`;
    writeFileSync(extension(weird), "x");
    getStorage().setProjectTrust(cwd, "trusted", reviewProject(cwd).record);
    rmSync(extension(weird));
    await openPiSession("hello");

    const prompt = await frameContaining(CHANGED);

    expect(prompt).toContain("[removed] .pi/extensions/bad\\u001bname.ts");
    expect(prompt).not.toContain(String.fromCodePoint(0x1b));
  }, 30000);
});

describe("/trust after a trusted project changed (S1)", () => {
  const openTrust = async () => {
    await openPiSession();
    await type("/trust");
    await press("RETURN");
    return frameContaining("Project Trust");
  };
  const chooseTrust = async () => {
    await arrowDown();
    await press("RETURN");
    return frameContaining(CHANGED);
  };

  test("shows that the stored trust no longer applies because the files changed", async () => {
    trustThenChange();

    const dialog = await openTrust();

    expect(dialog).toContain("Now: not trusted (this project's pi files changed since you trusted them)");
  }, 30000);

  test("shows the plain 'Now: trusted' while the files are as reviewed", async () => {
    getStorage().setProjectTrust(cwd, "trusted", reviewProject(cwd).record);

    const dialog = await openTrust();

    expect(dialog).toContain("Now: trusted");
    expect(dialog).not.toContain("no longer");
  }, 30000);

  test("a trusted row without a review says the stored decision predates the review", async () => {
    getStorage().setProjectTrust(cwd, "trusted");

    const dialog = await openTrust();

    expect(dialog).toContain("Now: not trusted (the stored trust predates reviews: trust again to review the files)");
  }, 30000);

  test("choosing Trust lists the changes; t then Enter stores the new review and nothing loads yet", async () => {
    trustThenChange();
    await openTrust();

    const prompt = await chooseTrust();
    expect(prompt).toContain("[changed] .pi/extensions/marker.ts");
    expect(prompt).toContain("[added] .pi/extensions/new.ts");
    expect(prompt).toContain("[removed] .pi/extensions/old.ts");
    expect(sameReview(getStorage().getProjectReview(cwd)!, reviewProject(cwd).record)).toBe(false);

    await press("t");
    await press("RETURN");

    expect(sameReview(getStorage().getProjectReview(cwd)!, reviewProject(cwd).record)).toBe(true);
    expect(getStorage().getProjectTrust(cwd)).toBe("trusted");
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("Esc in the changed listing stores nothing", async () => {
    trustThenChange();
    const before = getStorage().getProjectReview(cwd)!;
    await openTrust();
    await chooseTrust();

    await press("ESCAPE");
    await settle(100);

    expect(sameReview(getStorage().getProjectReview(cwd)!, before)).toBe(true);
  }, 30000);

  test("a project that never had a stored decision still gets the plain prompt from /trust", async () => {
    await openTrust();
    await arrowDown();
    await press("RETURN");

    const prompt = await frameContaining(TITLE);

    expect(prompt).toContain(TITLE);
    expect(prompt).not.toContain(CHANGED);
  }, 30000);
});
