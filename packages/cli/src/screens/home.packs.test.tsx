import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    "hooks/hooks.json": JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo checked" }] }] } }),
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
// Toasts wrap long messages inside their `┃` border, so the border goes too.
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
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
  await waitForFrame("MCP servers are not run.");
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
    await waitForFrame("MCP servers are not run.");

    const preview = frame();
    expect(preview).toContain("acme/flows @ ");
    expect(preview).toContain("FTD (build)");
    expect(preview).toContain("Skills: tdd");
    expect(preview).toContain("Commands: ship");
    expect(preview).toContain("Not used: .mcp.json");
    // The pack's hooks are not run; they are off until the user reviews and enables them.
    expect(preview).toContain("hooks: present, off — enable with /agents hooks");
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
    await waitForFrame("MCP servers are not run.");

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
    await waitForFrame("MCP servers are not run.");

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
    // The working dialog that was open while the spec failed is closed.
    expect(frame()).not.toContain("Fetching");
    expect(listPacks()).toEqual([]);
  });

  test("Esc while git is fetching stops git, shows no error and installs nothing; a dialog opened afterwards stays open [R4-005]", async () => {
    // A git whose fetch hangs, like a stalled network; its child `sleep` writes its pid so the test can see it stopped.
    const bin = join(work, "bin");
    const pidFile = join(work, "sleep.pid");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = fetch ]; then sleep 30 & echo $! > '${pidFile}'; wait; exit 0; fi; done\nexit 0\n`);
    chmodSync(join(bin, "git"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      await openHome();
      await type("/agents install acme/flows");
      await enter();
      await waitForFrame("Fetching acme/flows");
      while (!existsSync(pidFile)) await settle(50);
      const pid = Number(readFileSync(pidFile, "utf8").trim());

      await escape();

      await waitForFrame("Install cancelled", 5000);
      const text = frame();
      expect(text).not.toContain("Installed");
      expect(text).not.toContain("git ");
      expect(listPacks()).toEqual([]);
      expect(readdirSync(join(process.env.MARCSH_PACKS_DIR!, ".staging"))).toEqual([]);
      let alive = true;
      for (let tries = 0; alive && tries < 50; tries++) {
        try {
          process.kill(pid, 0);
          await settle(100);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);

      // The finished flow closed nothing that is not its own: the dialog opened next is still there.
      await type("/agents");
      await enter();
      await settle(300);
      expect(frame()).toContain("Select Agent");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  test("a pack folder with no lock entry: install says how to clear it, and /agents remove clears it [R4-002]", async () => {
    const leftover = join(process.env.MARCSH_PACKS_DIR!, "acme", "flows");
    mkdirSync(join(leftover, "src"), { recursive: true });
    await openHome();

    await type("/agents install acme/flows");
    await enter();
    // The toast wraps inside its box, so only a part that fits one line is matched; packs.test.ts holds the full message.
    await waitForFrame("is not an installed pack");
    expect(existsSync(leftover)).toBe(true);
    await act(async () => screen!.renderer.destroy());

    await openHome();
    await type("/agents remove acme/flows");
    await enter();
    await waitForFrame("Remove the leftover folder of acme/flows?");
    await down();
    await enter();
    await waitForFrame("Removed the leftover folder of acme/flows");
    expect(existsSync(leftover)).toBe(false);
  });

  test("/agents install owner/repo, typed, installs after the preview instead of being ignored", async () => {
    await openHome();
    await type("/agents install acme/flows");
    await enter();
    await waitForFrame("MCP servers are not run.");
    expect(frame()).toContain("acme/flows @ ");
    // Nothing is installed before the answer.
    expect(listPacks()).toEqual([]);
    await down();
    await enter();
    await waitForFrame("Installed acme/flows");
    expect(listPacks().map((pack) => pack.id)).toEqual(["acme/flows"]);
  });

  test("/agents install owner/repo@ref, typed, previews it, and cancelling installs nothing", async () => {
    await openHome();
    await type("/agents install acme/flows@main");
    await enter();
    await waitForFrame("MCP servers are not run.");
    await enter();
    await waitForFrame("Install cancelled");
    expect(listPacks()).toEqual([]);
  });

  test("/agents update and /agents remove, typed with a pack ID, reach their flows", async () => {
    await openHome();
    await installFixture();

    await type("/agents update acme/flows");
    await enter();
    await waitForFrame("acme/flows is up to date");

    await type("/agents remove acme/flows");
    await enter();
    await waitForFrame("Remove acme/flows");
    // Cancel is selected first: a bare Enter removes nothing.
    await enter();
    await settle(100);
    expect(listPacks()).toHaveLength(1);

    await type("/agents remove acme/flows");
    await enter();
    await waitForFrame("Remove acme/flows");
    await down();
    await enter();
    await waitForFrame("Removed acme/flows");
    expect(listPacks()).toEqual([]);
  });

  test("/agents update with no ID opens the same picker as the row; plain /agents is the dialog as before", async () => {
    await openHome();
    await installFixture();

    await type("/agents update");
    await enter();
    await waitForFrame("Search packs");
    expect(frame()).toContain("acme/flows");
    await escape();

    await type("/agents");
    await enter();
    expect(frame()).toContain("Install from GitHub…");
  });

  test("bad arguments are an error toast with the usage line, and nothing is fetched", async () => {
    for (const [args, message] of [
      ["install", "Usage: /agents install"],
      ["frobnicate acme/flows", "Usage: /agents install"],
      ["install acme/flows extra", "Usage: /agents install"],
      ["remove", "Usage: /agents install"],
      ["install ../evil", "Cannot install"],
      ["remove acme/flows", "acme/flows is not installed"],
    ] as const) {
      // A fresh screen per case: an error toast lasts 8 s, so on a shared one a case could pass on the previous case's toast.
      await openHome();
      await type(`/agents ${args}`);
      expect(frame()).not.toContain(message);
      await enter();
      await waitForFrame(message);
      await act(async () => screen!.renderer.destroy());
    }
    expect(listPacks()).toEqual([]);
    expect(existsSync(join(process.env.MARCSH_PACKS_DIR!, ".staging"))).toBe(false);
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
