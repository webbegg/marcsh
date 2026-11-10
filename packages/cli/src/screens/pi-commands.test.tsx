import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-commands-"));
const prefsPath = join(prefsDir, "preferences.json");
process.env.MARCSH_PREFERENCES_PATH = prefsPath;

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Home } = await import("./home");
const { NewSession } = await import("./new-session");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
type Engine = import("../lib/engine/types").Engine;
type TurnRequest = import("../lib/engine/types").TurnRequest;
type ClaudeCommand = import("../lib/claude-commands").ClaudeCommand;

const PI_LIST: ClaudeCommand[] = [
  { name: "deploy", description: "Ship it to staging", argumentHint: "", source: "extension" },
  { name: "review", description: "Review a file", argumentHint: "", source: "prompt" },
  { name: "skill:pdf", description: "Read PDFs", argumentHint: "", source: "skill" },
];
const CLAUDE_LIST: ClaudeCommand[] = [{ name: "claude-only", description: "From Claude Code", argumentHint: "" }];

let piRequests: TurnRequest[] = [];
let warmUps: string[] = [];
// What the fake pi engine lists when warmed up: the menu shows it once saved.
let warmList: ClaudeCommand[] | null = null;
const fakePi: Engine = {
  id: "pi",
  startTurn: (request, host) => {
    piRequests.push(request);
    host.emit({ type: "reply", update: (reply) => ({ ...reply, parts: [...reply.parts, { type: "text", text: "pi answered" }] }) });
    return { done: Promise.resolve(), interrupt() {} };
  },
  warmUpCommands: async ({ cwd, save }) => {
    warmUps.push(cwd);
    if (warmList) save(warmList);
  },
};

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const press = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(60);
};
const pressDown = async () => {
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle(60);
};
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const collapse = (frame: string) => frame.replace(/[│┃\s]+/g, " ");
const frame = () => collapse(screen!.captureCharFrame());

async function open(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <RootLayout />,
        children: [
          { index: true, element: <Home /> },
          { path: "sessions/new", element: <NewSession /> },
          { path: "sessions/:id", element: <Session /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
  await settle();
}

const openSession = (engine: string) => {
  const session = getStorage().createSession({ title: "chat", cwd: "/tmp/marcsh-cwd", engine });
  return open(`/sessions/${session.id}`).then(() => session);
};

beforeAll(() => engines.set("pi", fakePi));
afterAll(() => {
  engines.set("pi", undefined);
  rmSync(prefsDir, { recursive: true, force: true });
});

beforeEach(() => {
  getStorage().saveClaudeCommands([]);
  getStorage().saveCommands("pi", []);
  warmList = null;
});

afterEach(async () => {
  piRequests = [];
  warmUps = [];
  rmSync(prefsPath, { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

describe("the / menu on a pi session (S11)", () => {
  test("on a fresh database it lists the plugin's marcsh:feature (template) and marcsh:workflow (skill) after marcsh's own commands", async () => {
    expect(getStorage().getCommands("pi")).toEqual([]);
    getStorage().saveClaudeCommands(CLAUDE_LIST);
    await openSession("pi");

    await type("/");
    const all = frame();
    expect(all.indexOf("/new")).toBeGreaterThan(-1);

    await type("marc");
    const text = frame();
    expect(text).not.toContain("No matching commands");
    expect(text).toContain("/marcsh:feature");
    expect(text).toContain("Create or resume the feature");
    expect(text).toContain("prompt");
    expect(text).toContain("/marcsh:workflow");
    expect(text).toContain("skill");
    expect(text).not.toContain("claude-only");
  });

  test("lists pi's cached commands with their source", async () => {
    getStorage().saveCommands("pi", PI_LIST);
    await openSession("pi");

    await type("/dep");

    const text = frame();
    expect(text).toContain("/deploy");
    expect(text).toContain("Ship it to staging");
    expect(text).toContain("extension");
  });

  test("lists a skill under pi's name, /skill:<name>", async () => {
    getStorage().saveCommands("pi", PI_LIST);
    await openSession("pi");

    await type("/skill");

    expect(frame()).toContain("/skill:pdf");
    expect(frame()).toContain("Read PDFs");
  });

  test("does not list Claude's cached commands", async () => {
    getStorage().saveCommands("pi", PI_LIST);
    getStorage().saveClaudeCommands(CLAUDE_LIST);
    await openSession("pi");

    await type("/claude-o");

    expect(frame()).not.toContain("/claude-only");
    expect(frame()).not.toContain("From Claude Code");
  });

  test("a pi command named like one of marcsh's own is hidden behind it", async () => {
    getStorage().saveCommands("pi", [{ name: "new", description: "pi's own new", argumentHint: "", source: "prompt" }, ...PI_LIST]);
    await openSession("pi");

    await type("/new");

    const text = frame();
    expect(text).toContain("Start a new conversation");
    expect(text).not.toContain("pi's own new");
  });

  test("a command picked from the menu is sent to pi verbatim with its arguments, not run by marcsh", async () => {
    getStorage().saveCommands("pi", PI_LIST);
    await openSession("pi");

    await type("/dep");
    await press("RETURN");
    await type("prod --fast");
    await press("RETURN");
    await settle(100);

    expect(piRequests.map((r) => r.prompt)).toEqual(["/deploy prod --fast"]);
  });

  test("an unknown /name args is sent to pi as typed", async () => {
    await openSession("pi");

    await type("/not-listed some args");
    await press("RETURN");
    await settle(100);

    expect(piRequests.map((r) => r.prompt)).toEqual(["/not-listed some args"]);
  });

  test("/marcsh:feature <name> reaches pi as typed (pi's engine maps it to the template)", async () => {
    await openSession("pi");

    await type("/marcsh:feature my-feature");
    await press("RETURN");
    await settle(100);

    expect(piRequests.map((r) => r.prompt)).toEqual(["/marcsh:feature my-feature"]);
  });

  test("marcsh's own /new is still marcsh's: it does not reach pi", async () => {
    await openSession("pi");

    await type("/new");
    await press("RETURN");
    await settle(100);

    expect(piRequests).toEqual([]);
  });
});

describe("the / menu on a Claude session is unchanged (S11)", () => {
  test("lists Claude's cached commands, tagged claude, and none of pi's", async () => {
    getStorage().saveClaudeCommands(CLAUDE_LIST);
    getStorage().saveCommands("pi", PI_LIST);
    await openSession("claude");

    await type("/claude");
    const claude = frame();
    expect(claude).toContain("/claude-only");
    expect(claude).toContain("From Claude Code");
    expect(claude).toContain("claude");
    expect(claude).not.toContain("/deploy");
  });

  test("lists the plugin's marcsh:feature as a Claude command, not as a pi template", async () => {
    getStorage().saveCommands("pi", PI_LIST);
    await openSession("claude");

    await type("/marc");

    const text = frame();
    expect(text).toContain("/marcsh:feature");
    expect(text).toContain("/marcsh:workflow");
    expect(text).toContain("claude");
    expect(text).not.toContain("prompt");
    expect(text).not.toContain("skill");
  });
});

describe("the / menu on the home screen follows the default engine (S11)", () => {
  test("with pi as the default it lists pi's commands", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "pi" }), "utf8");
    getStorage().saveCommands("pi", PI_LIST);
    getStorage().saveClaudeCommands(CLAUDE_LIST);
    await open("/");

    await type("/dep");

    expect(frame()).toContain("/deploy");
    expect(frame()).not.toContain("claude-only");
  });

  test("with no stored preference it lists pi's commands (pi is the default)", async () => {
    getStorage().saveCommands("pi", PI_LIST);
    getStorage().saveClaudeCommands(CLAUDE_LIST);
    await open("/");

    await type("/dep");

    expect(frame()).toContain("/deploy");
    expect(frame()).not.toContain("claude-only");
  });

  test("with Claude as the default it lists Claude's commands", async () => {
    writeFileSync(prefsPath, JSON.stringify({ defaultEngine: "claude" }), "utf8");
    getStorage().saveCommands("pi", PI_LIST);
    getStorage().saveClaudeCommands(CLAUDE_LIST);
    await open("/");

    await type("/claude");

    expect(frame()).toContain("/claude-only");
    expect(frame()).not.toContain("/deploy");
  });
});

describe("pi's command list is warmed up only when pi is in play (S11)", () => {
  test("opening a pi session warms it up with the session's directory, and the menu then shows what it listed", async () => {
    warmList = PI_LIST;
    await openSession("pi");
    await settle(100);

    expect(warmUps).toEqual(["/tmp/marcsh-cwd"]);
    expect(getStorage().getCommands("pi")).toEqual(PI_LIST);
    await type("/rev");
    expect(frame()).toContain("/review");
  });

  test("opening a Claude session or the home screen never touches pi", async () => {
    await openSession("claude");
    await settle(100);
    expect(warmUps).toEqual([]);

    await act(async () => screen!.renderer.destroy());
    await open("/");
    await settle(100);
    expect(warmUps).toEqual([]);
  });

  test("switching the default engine to pi warms it up; switching to Claude does not", async () => {
    warmList = PI_LIST;
    await open("/");

    await type("/engine");
    await press("RETURN");
    await pressDown();
    await press("RETURN");
    await settle(100);

    expect(warmUps).toHaveLength(1);
    expect(getStorage().getCommands("pi")).toEqual(PI_LIST);

    warmUps = [];
    await type("/engine");
    await press("RETURN");
    await press("RETURN");
    await settle(100);

    expect(warmUps).toEqual([]);
  });
});
