import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

setDefaultTimeout(60_000);

const work = mkdtempSync(join(tmpdir(), "marcsh-home-pack-hooks-"));
const savedPacksDir = process.env.MARCSH_PACKS_DIR!;
process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: preferences, agents and packs all live in tmp, and packs come from a local file:// fixture.
process.env.MARCSH_PREFERENCES_PATH = join(work, "prefs", "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(work, "agents");
process.env.MARCSH_PACKS_DIR = join(work, "packs");
process.env.MARCSH_PACK_URL_BASE = `file://${join(work, "fixtures")}`;

// S16 / R item 4: the hooks review must keep the commit line and the choices on screen however many commands the pack declares,
// and Enable must not be chosen before the user has scrolled through all of them. The home screen starts no turn.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    throw new Error("query() must not be called by the home screen");
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { preferencesPath, setDefaultEngine } = await import("../lib/preferences");
const { listPacks } = await import("../lib/packs");

const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });

// 30 groups, one command each: within the documented limits (100 commands). The first and the last are the ones a pack would hide.
const MANY = Array.from({ length: 30 }, (_, i) => (i === 0 ? "sh -c FIRST_COMMAND_X" : i === 29 ? "sh -c LAST_COMMAND_X" : `echo check-${i}`));
// 7 groups: enough to push the commit line and the choices off an 80×24 terminal when nothing scrolls.
const FEW = Array.from({ length: 7 }, (_, i) => (i === 0 ? "sh -c FIRST_SMALL_X" : i === 6 ? "sh -c LAST_SMALL_X" : `echo small-${i}`));
const hooksJson = (commands: string[]) => JSON.stringify({ hooks: { PreToolUse: commands.map((command) => ({ matcher: "Bash", hooks: [{ type: "command", command }] })) } });

function createFixture(name: string, commands: string[]) {
  const repo = join(work, "fixtures", "acme", name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  const files = {
    "agents/ftd.md": "---\nname: FTD\ndescription: Test first\npermission: build\n---\nWork test-first.",
    "hooks/hooks.json": hooksJson(commands),
    "hooks/guard.sh": "exit 0\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c");
}

beforeAll(() => {
  createFixture("flows", MANY);
  createFixture("small", FEW);
});

// The file:// base and the packs dir must not leak into the next test file (they share this process).
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  delete process.env.MARCSH_PACK_URL_BASE;
  process.env.MARCSH_PACKS_DIR = savedPacksDir;
});

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
// Toasts and dialogs wrap long lines inside their border, so the border goes too.
const frame = () => screen!.captureCharFrame().replace(/[│┃█▀▄▌▐░▒▓\s]+/g, " ");
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const press = async (key: string, ms = 80) => {
  await act(async () => screen!.mockInput.pressKey(key));
  await settle(ms);
};
const enter = () => press("\r");
const down = (ms?: number) => press("\u001B[B", ms);
const up = () => press("\u001B[A");
const pageDown = () => press("\u001B[6~");
const pageUp = () => press("\u001B[5~");
// Where `text` is on the screen (row and column), for the mouse.
function findText(text: string): { x: number; y: number } {
  const lines = screen!.captureCharFrame().split("\n");
  for (let y = 0; y < lines.length; y++) {
    const x = lines[y]!.indexOf(text);
    if (x >= 0) return { x, y };
  }
  throw new Error(`"${text}" is not on the screen:\n${screen!.captureCharFrame()}`);
}
async function click(text: string) {
  const { x, y } = findText(text);
  await act(async () => screen!.mockMouse.click(x + 1, y));
  await settle(150);
}
async function waitForFrame(text: string, ms = 40_000) {
  const until = Date.now() + ms;
  while (!frame().includes(text)) {
    if (Date.now() > until) throw new Error(`"${text}" never appeared. Last frame:\n${screen!.captureCharFrame()}`);
    await settle(100);
  }
}

// The text is on screen before the dialog is laid out and the list measured: wait until two polls show the same screen.
async function waitForStableFrame(ms = 40_000) {
  const until = Date.now() + ms;
  let previous = screen!.captureCharFrame();
  for (let same = 0; same < 2; ) {
    if (Date.now() > until) throw new Error(`The screen never settled. Last frame:\n${previous}`);
    await settle(50);
    const current = screen!.captureCharFrame();
    same = current === previous ? same + 1 : 0;
    previous = current;
  }
}

async function openHome(size: { width: number; height: number }) {
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }],
    { initialEntries: ["/"] },
  );
  screen = await testRender(<RouterProvider router={router} />, size);
  await settle();
}

async function runCommand(text: string) {
  await type(text);
  await enter();
}

async function installFixture(name: string) {
  await runCommand(`/agents install acme/${name}`);
  await waitForFrame("hooks: present, off");
  await down();
  await enter();
  await waitForFrame(`Installed acme/${name}`);
}

const lockEntry = (name: string) => listPacks().find((pack) => pack.id === `acme/${name}`)!;

// PageDown until the end of the list has been on screen (the "Scroll to the end" hint is gone).
async function scrollToEnd() {
  for (let i = 0; i < 80 && frame().includes("Scroll to the end to review"); i++) await pageDown();
}

beforeEach(() => {
  mkdirSync(process.env.MARCSH_AGENTS_DIR!, { recursive: true });
  setDefaultEngine("claude");
});

afterEach(async () => {
  rmSync(preferencesPath(), { force: true });
  rmSync(process.env.MARCSH_AGENTS_DIR!, { recursive: true, force: true });
  rmSync(process.env.MARCSH_PACKS_DIR!, { recursive: true, force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("/agents hooks review with many commands (S16)", () => {
  test("110×50, 30 groups: the commit line and both choices stay on screen, the commands scroll, and Enable waits for the end", async () => {
    await openHome({ width: 110, height: 50 });
    await installFixture("flows");

    await runCommand("/agents hooks acme/flows");
    await waitForFrame("PreToolUse (matcher: Bash)");
    await waitForStableFrame();
    const first = frame();
    expect(first).toContain(`acme/flows @ ${lockEntry("flows").commit.slice(0, 7)}`);
    expect(first).toContain("Cancel");
    expect(first).toContain("Enable");
    expect(first).toContain("$ sh -c FIRST_COMMAND_X");
    expect(first).not.toContain("LAST_COMMAND_X");
    expect(first).toContain("Scroll to the end to review all 30 commands");

    // Down selects Enable; Enter before the end does nothing: the dialog stays and the hooks stay off.
    await down();
    await enter();
    expect(lockEntry("flows").hooks).toBeUndefined();
    expect(frame()).toContain("Scroll to the end to review all 30 commands");

    await scrollToEnd();
    const end = frame();
    expect(end).toContain("$ sh -c LAST_COMMAND_X");
    expect(end).toContain("These commands run on your machine");
    expect(end).toContain("Hooks may run any file of this pack; the whole pack is pinned to this commit");
    // The header and the choices never scrolled away.
    expect(end).toContain(`acme/flows @ ${lockEntry("flows").commit.slice(0, 7)}`);
    expect(end).toContain("Cancel");
    expect(end).toContain("Enable");
    expect(end).not.toContain("Scroll to the end to review all 30 commands");

    await enter();
    await waitForFrame("Enabled hooks of acme/flows");
    expect(lockEntry("flows").hooks).toBeDefined();
  });

  test("80×24, 7 groups: the commit line and the choices are visible; Enable does nothing before the end and works after it", async () => {
    await openHome({ width: 80, height: 24 });
    await installFixture("small");

    await runCommand("/agents hooks acme/small");
    await waitForFrame("PreToolUse (matcher: Bash)");
    await waitForStableFrame();
    const first = frame();
    expect(first).toContain(`acme/small @ ${lockEntry("small").commit.slice(0, 7)}`);
    expect(first).toContain("Cancel");
    expect(first).toContain("Enable");
    expect(first).toContain("Scroll to the end to review all 7 commands");

    await down();
    await enter();
    expect(lockEntry("small").hooks).toBeUndefined();

    await scrollToEnd();
    expect(frame()).toContain("$ sh -c LAST_SMALL_X");
    expect(frame()).toContain("Cancel");
    await enter();
    await waitForFrame("Enabled hooks of acme/small");
    expect(lockEntry("small").hooks).toBeDefined();
  });

  test("every command can be reached by scrolling a line at a time, and the header and choices stay on screen", async () => {
    await openHome({ width: 110, height: 50 });
    await installFixture("flows");
    await runCommand("/agents hooks acme/flows");
    await waitForFrame("PreToolUse (matcher: Bash)");
    await waitForStableFrame();

    const seen = new Set<string>();
    const collect = () => {
      const text = frame();
      // The trailing space keeps `check-1` from matching inside `check-10`.
      for (const command of MANY) if (text.includes(`$ ${command} `)) seen.add(command);
      expect(text).toContain(`acme/flows @ ${lockEntry("flows").commit.slice(0, 7)}`);
      expect(text).toContain("Cancel");
      expect(text).toContain("Enable");
    };
    collect();
    for (let i = 0; i < 400 && frame().includes("Scroll to the end to review"); i++) {
      await down(20);
      collect();
    }
    collect();
    expect(MANY.filter((command) => !seen.has(command))).toEqual([]);
    expect(lockEntry("flows").hooks).toBeUndefined();
  });

  test("a click on Enable before the end does nothing; the mouse wheel reaches the end and the click then enables", async () => {
    await openHome({ width: 80, height: 24 });
    await installFixture("small");
    await runCommand("/agents hooks acme/small");
    await waitForFrame("PreToolUse (matcher: Bash)");
    await waitForStableFrame();

    await click("   Enable");
    expect(lockEntry("small").hooks).toBeUndefined();
    expect(frame()).toContain("Scroll to the end to review all 7 commands");

    const { x, y } = findText("$ sh -c FIRST_SMALL_X");
    for (let i = 0; i < 60 && frame().includes("Scroll to the end to review"); i++) {
      await act(async () => screen!.mockMouse.scroll(x, y, "down"));
      await settle(40);
    }
    expect(frame()).toContain("$ sh -c LAST_SMALL_X");
    expect(frame()).not.toContain("Scroll to the end to review");
    await click("   Enable");
    await waitForFrame("Enabled hooks of acme/small");
    expect(lockEntry("small").hooks).toBeDefined();
  });

  test("Up and Down scroll the list a line at a time, PageUp goes back", async () => {
    await openHome({ width: 80, height: 24 });
    await installFixture("small");
    await runCommand("/agents hooks acme/small");
    await waitForFrame("PreToolUse (matcher: Bash)");
    await waitForStableFrame();
    expect(frame()).toContain("$ sh -c FIRST_SMALL_X");

    for (let i = 0; i < 8; i++) await down();
    expect(frame()).not.toContain("$ sh -c FIRST_SMALL_X");
    for (let i = 0; i < 8; i++) await up();
    expect(frame()).toContain("$ sh -c FIRST_SMALL_X");

    await scrollToEnd();
    await pageUp();
    await pageUp();
    await pageUp();
    expect(frame()).toContain("$ sh -c FIRST_SMALL_X");
  });

  test("turning hooks off never waits for the end of the list", async () => {
    await openHome({ width: 80, height: 24 });
    await installFixture("small");
    await runCommand("/agents hooks acme/small");
    await waitForFrame("PreToolUse (matcher: Bash)");
    await waitForStableFrame();
    await scrollToEnd();
    await down();
    await enter();
    await waitForFrame("Enabled hooks of acme/small");

    await runCommand("/agents hooks acme/small");
    await waitForFrame("Hooks are on");
    await waitForStableFrame();
    await down();
    await enter();
    await waitForFrame("Turned off hooks of acme/small");
    expect(lockEntry("small").hooks).toBeUndefined();
  });
});
