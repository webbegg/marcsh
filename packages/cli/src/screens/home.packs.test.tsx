import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

setDefaultTimeout(60_000);

const work = mkdtempSync(join(tmpdir(), "marcsh-home-packs-"));
const savedPacksDir = process.env.MARCSH_PACKS_DIR!;
process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: preferences, agents and packs all live in tmp, and packs come from a local file:// fixture.
process.env.MARCSH_PREFERENCES_PATH = join(work, "prefs", "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(work, "agents");
process.env.MARCSH_PACKS_DIR = join(work, "packs");
process.env.MARCSH_PACK_URL_BASE = `file://${join(work, "fixtures")}`;

// The home screen starts no turn.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    throw new Error("query() must not be called by the home screen");
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { getAgentId, preferencesPath, setDefaultEngine } = await import("../lib/preferences");
const { listPacks } = await import("../lib/packs");

const repo = join(work, "fixtures", "acme", "flows");
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });

beforeAll(() => {
  const files: Record<string, string> = {
    "agents/ftd.md": "---\nname: FTD\ndescription: Test first\npermission: build\n---\nWork test-first.",
    "skills/tdd/SKILL.md": "---\nname: tdd\ndescription: Test first\n---\nRED then GREEN.",
    "commands/ship.md": "---\ndescription: Ship\n---\nShip it.",
    "hooks/hooks.json": "{}",
    ".mcp.json": "{}",
  };
  mkdirSync(repo, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "c");
});

// The file:// base and the packs dir must not leak into the next test file (they share this process).
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  delete process.env.MARCSH_PACK_URL_BASE;
  process.env.MARCSH_PACKS_DIR = savedPacksDir;
});

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const frame = () => screen!.captureCharFrame().replace(/[│\s]+/g, " ");
const tab = async () => {
  await act(async () => screen!.mockInput.pressTab());
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(60);
};
const down = async () => {
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle(60);
};
const escape = async () => {
  await act(async () => screen!.mockInput.pressEscape());
  await settle(60);
};
// git is slow on a busy machine: poll for what the screen should show instead of sleeping.
async function waitForFrame(text: string, ms = 40_000) {
  const until = Date.now() + ms;
  while (!frame().includes(text)) {
    if (Date.now() > until) throw new Error(`"${text}" never appeared. Last frame:\n${screen!.captureCharFrame()}`);
    await settle(100);
  }
}

async function openHome() {
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }] }],
    { initialEntries: ["/"] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 40 });
  await settle();
}

// "/agents" → the action row whose label contains `row`.
async function openAction(row: string) {
  await type("/agents");
  await enter();
  await type(row);
  await enter();
}

async function installFixture() {
  await openAction("install");
  await type("acme/flows");
  await enter();
  await waitForFrame("Pack hooks and MCP servers are not run.");
  await down();
  await enter();
  await waitForFrame("Installed acme/flows");
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

describe("/agents installs packs from GitHub (S10)", () => {
  test("the list ends with the three pack actions", async () => {
    await openHome();
    await type("/agents");
    await enter();
    const text = frame();
    expect(text).toContain("Install from GitHub…");
    expect(text).toContain("Update packs…");
    expect(text).toContain("Remove a pack…");
  });

  test("install shows what the pack holds, installs on consent, and Tab reaches its agent", async () => {
    await openHome();
    await openAction("install");
    await type("acme/flows");
    await enter();
    await waitForFrame("Pack hooks and MCP servers are not run.");

    const preview = frame();
    expect(preview).toContain("acme/flows @ ");
    expect(preview).toContain("FTD (build)");
    expect(preview).toContain("Skills: tdd");
    expect(preview).toContain("Commands: ship");
    expect(preview).toContain("Not used: hooks/, .mcp.json");
    // Nothing is installed before the answer.
    expect(listPacks()).toEqual([]);

    // Cancel is the row selected at first; the next one installs.
    await down();
    await enter();
    await waitForFrame("Installed acme/flows (1 agent)");
    expect(listPacks().map((pack) => pack.id)).toEqual(["acme/flows"]);

    await tab();
    await tab();
    expect(frame()).toContain("FTD › ");
    expect(getAgentId()).toBe("acme/flows/ftd");
  });

  test("Enter on the preview's first row cancels and installs nothing", async () => {
    await openHome();
    await openAction("install");
    await type("acme/flows");
    await enter();
    await waitForFrame("Pack hooks and MCP servers are not run.");

    await enter();

    await waitForFrame("Install cancelled");
    expect(listPacks()).toEqual([]);
    expect(existsSync(join(process.env.MARCSH_PACKS_DIR!, "acme"))).toBe(false);
  });

  test("closing the preview with Esc installs nothing", async () => {
    await openHome();
    await openAction("install");
    await type("acme/flows");
    await enter();
    await waitForFrame("Pack hooks and MCP servers are not run.");

    await escape();
    await settle(300);

    expect(listPacks()).toEqual([]);
    expect(existsSync(join(process.env.MARCSH_PACKS_DIR!, "acme"))).toBe(false);
    // The fetched clone is deleted too: the closed dialog answered no.
    expect(readdirSync(join(process.env.MARCSH_PACKS_DIR!, ".staging"))).toEqual([]);
  });

  test("a bad spec is an error toast that names the accepted forms", async () => {
    await openHome();
    await openAction("install");
    await type("../evil");
    await enter();

    await waitForFrame("owner/repo");
    expect(frame()).toContain("Cannot install");
    expect(listPacks()).toEqual([]);
  });

  test("update says up to date; remove asks first, then the pack and its agent are gone", async () => {
    await openHome();
    await installFixture();

    await openAction("update");
    await enter();
    await waitForFrame("acme/flows is up to date");

    await openAction("remove");
    await enter();
    await waitForFrame("Remove acme/flows");
    // Cancel first: nothing is removed by a bare Enter.
    await enter();
    await settle(100);
    expect(listPacks()).toHaveLength(1);

    await openAction("remove");
    await enter();
    await waitForFrame("Remove acme/flows");
    await down();
    await enter();
    await waitForFrame("Removed acme/flows");
    expect(listPacks()).toEqual([]);
    expect(existsSync(join(process.env.MARCSH_PACKS_DIR!, "acme", "flows"))).toBe(false);

    // Back to Build and Plan only.
    await tab();
    await tab();
    expect(frame()).toContain("Build › ");
  });
});
