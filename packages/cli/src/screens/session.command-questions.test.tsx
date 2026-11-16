import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

setDefaultTimeout(60_000);

// A command with question forms (T10): typing it opens a flow of dialogs (one per question, then a review with Start, Edit answers and
// Cancel); only Start sends, as one message, through the usual turn path. Esc anywhere sends nothing.

const work = mkdtempSync(join(tmpdir(), "marcsh-session-command-questions-"));
const savedPacksDir = process.env.MARCSH_PACKS_DIR!;
process.env.MARCSH_DB_PATH = ":memory:";
process.env.MARCSH_PREFERENCES_PATH = join(work, "prefs", "preferences.json");
process.env.MARCSH_AGENTS_DIR = join(work, "agents");
process.env.MARCSH_PACKS_DIR = join(work, "packs");

let calls: { prompt: string; options: any }[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: any) => {
    calls.push({ prompt, options });
    const messages = (async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-1", model: options.model };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 1, total_cost_usd: 0 };
    })();
    return Object.assign(messages, { interrupt: async () => {}, supportedCommands: async () => [] });
  },
}));

const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { Home } = await import("./home");
const { NewSession } = await import("./new-session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { preferencesPath, setAgentId, setDefaultEngine } = await import("../lib/preferences");
const { installPack } = await import("../lib/packs");

beforeAll(() => engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} }));
afterAll(() => engines.set("pi", undefined));

const START = [
  "---",
  "description: Start a task",
  'argument-hint: "[what]"',
  "questions:",
  "  - id: what",
  "    label: What to build?",
  "    kind: text",
  "    required: true",
  "  - id: area",
  "    label: Area",
  "    kind: text",
  "  - id: size",
  "    label: Size",
  "    kind: choice",
  "    options: [Small, Large]",
  "---",
  "Build this: {{what}}",
  "Area: {{area}}",
  "Size: {{size}}",
  "Typed: $ARGUMENTS",
].join("\n");

beforeAll(async () => {
  const repo = join(work, "fixtures", "acme", "flows");
  const files: Record<string, string> = {
    "agents/asdd.md": "---\nname: ASDD\npermission: build\n---\nSpec first.",
    "commands/start.md": START,
    "commands/spec.md": "---\nagent: asdd\nquestions:\n  - id: idea\n    label: The idea\n    kind: long\n    required: true\n---\nSpec: {{idea}}",
    "commands/broken.md": "---\nquestions: nope\n---\nBroken {{x}}",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
      cwd: repo,
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "c");
  const result = await installPack("acme/flows", { confirm: () => true, urlBase: `file://${join(work, "fixtures")}` });
  expect(result.status).toBe("installed");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  process.env.MARCSH_PACKS_DIR = savedPacksDir;
});

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function until(condition: () => boolean, what: string, timeoutMs = 3000) {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited >= timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await settle(10);
  }
}
const frameText = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(60);
};
const escape = async () => {
  await act(async () => screen!.mockInput.pressEscape());
  await settle(60);
};
const down = async () => {
  await act(async () => screen!.mockInput.pressArrow("down"));
  await settle(30);
};

async function openIdle(selected: string) {
  calls = [];
  setAgentId(selected);
  const session = getStorage().createSession({ title: "t", cwd: "/tmp/marcsh-cwd", engine: "claude" });
  const router = createMemoryRouter([{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }], {
    initialEntries: [`/sessions/${session.id}`],
  });
  screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 40 });
  await settle();
}

beforeEach(() => {
  mkdirSync(process.env.MARCSH_AGENTS_DIR!, { recursive: true });
  setDefaultEngine("claude");
  getStorage().saveClaudeCommands([]);
});

afterEach(async () => {
  rmSync(preferencesPath(), { force: true });
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
});

const COMPOSED = "Build this: fix login\nArea: src/a\nSize: Small\nTyped: fix login";

/** Answers /start's three questions the usual way: the typed text is accepted, an area typed, the first size taken. */
async function answerStart() {
  await until(() => frameText().includes("What to build?"), "the first question");
  await enter();
  await until(() => frameText().includes("Area"), "the area question");
  await type("src/a");
  await enter();
  await until(() => frameText().includes("Size"), "the size question");
  await enter();
  await until(() => frameText().includes("Edit answers"), "the review");
}

describe("a command with questions, typed in a session", () => {
  test("asks each question (the typed text prefilled), shows the request, and Start sends it as one message", async () => {
    await openIdle("build");
    await type("/start fix login");
    await enter();

    await until(() => frameText().includes("What to build?"), "the first question");
    // The typed arguments are the offered answer, and nothing was sent while asking.
    expect(frameText()).toContain("fix login");
    expect(calls).toEqual([]);

    await answerStart();
    for (const line of COMPOSED.split("\n")) expect(frameText()).toContain(line);
    expect(frameText()).toContain("Start");
    expect(frameText()).toContain("Cancel");
    expect(calls).toEqual([]);

    await enter();
    await until(() => calls.length > 0, "the turn");
    expect(calls[0]!.prompt).toBe(COMPOSED);
    // The raw template never goes out.
    expect(calls.every((call) => !call.prompt.includes("{{"))).toBe(true);
    expect(frameText()).not.toContain("Edit answers");
  });

  test("Esc on a question sends nothing and closes the flow", async () => {
    await openIdle("build");
    await type("/start fix login");
    await enter();
    await until(() => frameText().includes("What to build?"), "the first question");
    await escape();
    await settle(100);
    expect(frameText()).not.toContain("What to build?");
    expect(calls).toEqual([]);
  });

  test("Cancel on the review sends nothing", async () => {
    await openIdle("build");
    await type("/start fix login");
    await enter();
    await answerStart();
    await down();
    await down();
    await enter();
    await settle(100);
    expect(frameText()).not.toContain("Edit answers");
    expect(calls).toEqual([]);
  });

  test("Edit answers asks again with the earlier answers offered, and Start sends the edited request", async () => {
    await openIdle("build");
    await type("/start fix login");
    await enter();
    await answerStart();
    await down();
    await enter();

    await until(() => frameText().includes("What to build?"), "the questions again");
    await enter();
    await until(() => frameText().includes("Area"), "the area again");
    // The earlier answer is what the empty field accepts.
    expect(frameText()).toContain("src/a");
    await enter();
    await until(() => frameText().includes("Size"), "the size again");
    await down();
    await enter();
    await until(() => frameText().includes("Edit answers"), "the review again");
    expect(frameText()).toContain("Size: Large");
    await enter();
    await until(() => calls.length > 0, "the turn");
    expect(calls[0]!.prompt).toBe("Build this: fix login\nArea: src/a\nSize: Large\nTyped: fix login");
  });

  test("a required question left empty is asked once more, then the flow is cancelled", async () => {
    await openIdle("build");
    await type("/start ");
    await enter();
    await until(() => frameText().includes("What to build?"), "the first question");
    await enter();
    await until(() => frameText().includes("cannot be empty"), "the second ask");
    await enter();
    await settle(100);
    expect(frameText()).not.toContain("What to build?");
    expect(calls).toEqual([]);
  });

  test("from Plan, a form command that names an agent runs read-only, and says so", async () => {
    await openIdle("plan");
    await type("/spec offline mode");
    await enter();
    await until(() => frameText().includes("The idea"), "the question");
    await enter();
    await until(() => frameText().includes("Edit answers"), "the review");
    await enter();
    await until(() => calls.length > 0, "the turn");
    expect(calls[0]!.prompt).toBe("Spec: offline mode");
    expect(calls[0]!.options.permissionMode).toBe("plan");
    expect(calls[0]!.options.systemPrompt.append).toContain("Spec first.");
    expect(frameText()).toContain("/spec runs as ASDD in Plan (read-only)");
  });

  test("a command with invalid questions says why in an error and sends nothing", async () => {
    await openIdle("build");
    await type("/broken ");
    await enter();
    await until(() => frameText().includes("nothing was sent"), "the error");
    expect(frameText()).toContain("/broken: questions must be a list; nothing was sent.");
    expect(calls).toEqual([]);
  });
});

describe("a command with questions, typed on the home screen", () => {
  test("the flow runs there, and only Start opens the session, whose first turn is the composed request", async () => {
    calls = [];
    setAgentId("build");
    const router = createMemoryRouter(
      [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }, { path: "sessions/new", element: <NewSession /> }, { path: "sessions/:id", element: <Session /> }] }],
      { initialEntries: ["/"] },
    );
    screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 40 });
    await settle();
    await type("/start fix login");
    await enter();
    await answerStart();
    // Still on the home screen: no session yet, nothing sent.
    expect(calls).toEqual([]);
    expect(router.state.location.pathname).toBe("/");

    await enter();
    await until(() => calls.length > 0, "the first turn");
    expect(calls[0]!.prompt).toBe(COMPOSED);
    expect(calls.every((call) => !call.prompt.includes("{{"))).toBe(true);
    expect(router.state.location.pathname).toMatch(/^\/sessions\//);
  });

  test("Esc there leaves the home screen as it was", async () => {
    calls = [];
    setAgentId("build");
    const router = createMemoryRouter(
      [{ path: "/", element: <RootLayout />, children: [{ index: true, element: <Home /> }, { path: "sessions/new", element: <NewSession /> }, { path: "sessions/:id", element: <Session /> }] }],
      { initialEntries: ["/"] },
    );
    screen = await testRender(<RouterProvider router={router} />, { width: 120, height: 40 });
    await settle();
    await type("/start fix login");
    await enter();
    await until(() => frameText().includes("What to build?"), "the first question");
    await escape();
    await settle(100);
    expect(calls).toEqual([]);
    expect(router.state.location.pathname).toBe("/");
  });
});
