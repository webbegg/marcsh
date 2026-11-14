import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
// Never the real ~/.marcsh: preferences, agents and commands all live in tmp.
process.env.MARCSH_PREFERENCES_PATH = join(tmpdir(), `marcsh-user-commands-prefs-${process.pid}`, "preferences.json");
const agentsDir = join(tmpdir(), `marcsh-user-commands-agents-${process.pid}`);
process.env.MARCSH_AGENTS_DIR = agentsDir;

let calls: { prompt: string; options: any }[] = [];

// Fake query(): records what marcsh passes, then init → result. It offers no commands of its own.
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
const { Home } = await import("./home");
const { NewSession } = await import("./new-session");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { DEFAULT_CHAT_MODEL_ID } = await import("../lib/models");
const { preferencesPath, setDefaultEngine } = await import("../lib/preferences");

// pi is the default engine and its status line asks the pi runtime: a stand-in without one keeps the real pi engine from loading.
beforeAll(() => engines.set("pi", { id: "pi", startTurn: () => ({ done: Promise.resolve(), interrupt() {} }), warmUpCommands: async () => {} }));
afterAll(() => engines.set("pi", undefined));

let screen: Awaited<ReturnType<typeof testRender>> | null = null;
let root: string;
let project: string;
let startedIn: string;

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const type = async (text: string) => {
  await act(() => screen!.mockInput.typeText(text));
  await settle(60);
};
const enter = async () => {
  await act(async () => screen!.mockInput.pressEnter());
  await settle(120);
};
const frame = () => screen!.captureCharFrame().replace(/[│\s]+/g, " ");

const write = (dir: string, file: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
};
const personalFile = (file: string, text: string) => write(process.env.MARCSH_COMMANDS_DIR!, file, text);
const projectFile = (file: string, text: string) => write(join(project, ".marcsh", "commands"), file, text);

const routes = [
  {
    path: "/",
    element: <RootLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: "sessions/new", element: <NewSession /> },
      { path: "sessions/:id", element: <Session /> },
    ],
  },
];

async function render(initialEntries: any[]) {
  screen = await testRender(<RouterProvider router={createMemoryRouter(routes, { initialEntries })} />, { width: 100, height: 30 });
  await settle();
}

const openHome = () => render(["/"]);

// A session whose folder is the project; `initialPrompt` is what the home screen sends.
async function openSession(initialPrompt?: Record<string, unknown>) {
  const session = getStorage().createSession({ title: "t", cwd: project, engine: "claude" });
  await render([{ pathname: `/sessions/${session.id}`, state: initialPrompt ? { initialPrompt: { mode: "BUILD", model: "sonnet", ...initialPrompt } } : undefined }]);
  await settle(80);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "marcsh-user-commands-screen-")));
  project = join(root, "project");
  mkdirSync(project, { recursive: true });
  process.env.MARCSH_COMMANDS_DIR = join(root, "personal");
  startedIn = process.cwd();
  // The home screen works in the folder marcsh was started in.
  process.chdir(project);
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "reviewer.md"), "---\nname: Reviewer\npermission: read-only\n---\nReview only.");
  calls = [];
  setDefaultEngine("claude");
});

afterEach(async () => {
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  process.chdir(startedIn);
  getStorage().setProjectTrust(project, null);
  delete process.env.MARCSH_COMMANDS_DIR;
  rmSync(preferencesPath(), { force: true });
  rmSync(agentsDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("custom commands in the / menu (S7)", () => {
  test("a personal command is listed with its description and where it comes from", async () => {
    personalFile("review.md", "---\ndescription: Review the changes\n---\nReview $ARGUMENTS");
    await openHome();

    await type("/rev");

    const text = frame();
    expect(text).toContain("/review");
    expect(text).toContain("Review the changes");
    expect(text).toContain("personal");
  });

  test("a project command is listed only once the project is trusted", async () => {
    projectFile("deploy.md", "---\ndescription: Ship it\n---\nDeploy");
    await openHome();
    await type("/dep");
    expect(frame()).not.toContain("Ship it");
    await act(async () => screen!.mockInput.pressKey("ESCAPE" as never));
    await settle(60);

    getStorage().setProjectTrust(project, "trusted");
    await act(async () => screen!.mockInput.pressBackspace());
    await settle(60);
    await type("p");

    const text = frame();
    expect(text).toContain("/deploy");
    expect(text).toContain("Ship it");
    expect(text).toContain("project");
  });

  test("a command named like a marcsh command is not listed twice: the marcsh one stays", async () => {
    personalFile("new.md", "---\ndescription: Shadow of new\n---\nx");
    await openHome();

    await type("/new");

    const text = frame();
    expect(text).toContain("Start a new conversation");
    expect(text).not.toContain("Shadow of new");
  });
});

describe("running a custom command (S7)", () => {
  test("a session shows the expanded prompt as the user's message and sends it to the engine", async () => {
    personalFile("review.md", "Review $1 for $ARGUMENTS");
    await openSession();

    await type("/review src/a.ts bugs");
    await enter();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe("Review src/a.ts for src/a.ts bugs");
    expect(frame()).toContain("Review src/a.ts for src/a.ts bugs");
    expect(frame()).not.toContain("/review");
  });

  test("from the home screen the new session's first turn is the expanded prompt", async () => {
    personalFile("review.md", "Review $ARGUMENTS");
    await openHome();

    await type("/review the parser");
    await enter();
    await settle(200);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe("Review the parser");
  });

  test("an unknown /name is still sent as typed", async () => {
    await openSession();

    await type("/nothing here");
    await enter();

    expect(calls[0]!.prompt).toBe("/nothing here");
  });

  test("a project command runs only in a trusted project", async () => {
    projectFile("deploy.md", "Deploy $ARGUMENTS");
    await openSession();
    await type("/deploy now");
    await enter();
    expect(calls[0]!.prompt).toBe("/deploy now");

    await act(async () => screen!.renderer.destroy());
    getStorage().setProjectTrust(project, "trusted");
    calls = [];
    await openSession();
    await type("/deploy now");
    await enter();

    expect(calls[0]!.prompt).toBe("Deploy now");
  });

  test("the agent in the frontmatter runs that turn only", async () => {
    personalFile("audit.md", "---\nagent: user/reviewer\n---\nAudit $ARGUMENTS");
    await openSession();

    await type("/audit auth");
    await enter();
    await type("plain follow-up");
    await enter();

    expect(calls).toHaveLength(2);
    expect(calls[0]!.options.permissionMode).toBe("plan");
    expect(calls[0]!.options.systemPrompt.append).toBe("Review only.");
    expect(calls[1]!.options.permissionMode).toBe("default");
    expect("append" in calls[1]!.options.systemPrompt).toBe(false);
  });

  test("the model in the frontmatter runs that turn only", async () => {
    personalFile("fast.md", "---\nmodel: haiku\n---\nQuick: $ARGUMENTS");
    await openSession();

    await type("/fast status");
    await enter();
    await type("plain follow-up");
    await enter();

    // The follow-up runs on the session's model (the default, not the command's).
    expect(calls.map((call) => call.options.model)).toEqual(["haiku", DEFAULT_CHAT_MODEL_ID]);
  });

  test("a model the engine cannot use is reported and the session model is used", async () => {
    personalFile("other.md", "---\nmodel: openai/gpt-5\n---\nHi");
    await openSession();

    await type("/other x");
    await enter();

    expect(calls[0]!.options.model).toBe(DEFAULT_CHAT_MODEL_ID);
    expect(frame()).toContain("openai/gpt-5” does not fit");
  });

  test("a first prompt from the home screen can carry a model for that turn", async () => {
    await openSession({ message: "Quick: status", agentModel: "haiku" });

    expect(calls[0]!.options.model).toBe("haiku");
  });
});
