import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-guard-prefs-"));
process.env.MARCSH_PREFERENCES_PATH = join(prefsDir, "preferences.json");

const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { testRender } = await import("@opentui/react/test-utils");
const { createMemoryRouter, RouterProvider } = await import("react-router");
const { RootLayout } = await import("../layouts/root-layout");
const { Session } = await import("./session");
const { getStorage } = await import("../lib/storage");
const { engines } = await import("../lib/engine");
const { createPiEngine } = await import("../lib/engine/pi");
type FauxResponseStep = import("@earendil-works/pi-ai").FauxResponseStep;
type Message = import("@earendil-works/pi-ai").Message;

const REASON_PUSH = "marcsh: git push needs your approval";
const REASON_COMMIT = "marcsh: commits on main are blocked; create a branch first (git switch -c <type>/<description>)";

let dir: string;
let agentDir: string;
let cwd: string;
let toolResults: string[];
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

const bashCall = (command: string) =>
  fauxAssistantMessage([fauxToolCall("bash", { command }, { id: "call-1" })], { stopReason: "toolUse" });

// The model's next request after the tool call: records what the tool result said, then ends the turn.
const afterTool: FauxResponseStep = (context) => {
  toolResults.push(
    ...(context.messages as Message[]).flatMap((m) =>
      m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : [],
    ),
  );
  return fauxAssistantMessage([fauxText("all done")]);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-guard-screen-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
  toolResults = [];
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

const repo = (branch: string) => {
  const git = Bun.spawnSync(["git", "init", "-q", "-b", branch], { cwd, stdout: "ignore", stderr: "pipe" });
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
};

const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
// The prompt ignores keys until the keyboard has been quiet for 300 ms.
const QUIET_MS = 350;
let lastActivityAt = 0;
const press = async (key: string) => {
  const wait = QUIET_MS - (Date.now() - lastActivityAt);
  if (wait > 0) await settle(wait);
  lastActivityAt = Date.now();
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle();
};
const collapse = (frame: string) => frame.replace(/[│\s]+/g, " ");
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

// A real pi engine on pi's faux provider (no network), which the session's engine registry hands to the screen.
async function openPiSession(responses: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  // The machine's own environment (API keys) must not add models: the picker offers only the faux one.
  const model = modelRuntime.getModel("faux", "faux-1")!;
  modelRuntime.getAvailable = async () => [model];
  faux.setResponses(responses);
  engines.set("pi", createPiEngine({ agentDir, modelRuntime }));

  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode: "BUILD", model: "opus" } } }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 40 });
  await settle();
  return session;
}

describe("the branch/ship guard on a pi session (S10)", () => {
  test("a push shows the guard's reason in the approval prompt without the always key, even with a stored always rule", async () => {
    repo("feat/x");
    const ran = join(dir, "ran.txt");
    const command = `git push; touch ${ran}`;
    getStorage().addPermissionRule({ cwd, toolName: "bash", command });
    await openPiSession([bashCall(command), afterTool]);

    await frameContaining("Allow bash?");
    // The keys are listed once the keyboard has been quiet.
    await settle(QUIET_MS + 100);
    const prompt = frame();

    expect(prompt).toContain("Allow bash?");
    expect(prompt).toContain(`Reason: ${REASON_PUSH}`);
    expect(prompt).toContain("y allow once");
    expect(prompt).toContain("n deny");
    expect(prompt).not.toContain("always allow");
    expect(existsSync(ran)).toBe(false);

    // The always key does nothing here: the prompt stays.
    await press("a");
    expect(frame()).toContain(`Reason: ${REASON_PUSH}`);
    expect(existsSync(ran)).toBe(false);

    await press("y");
    expect(await frameContaining("all done")).toContain("all done");
    expect(existsSync(ran)).toBe(true);
  }, 30000);

  test("denying the push keeps it from running and tells the model", async () => {
    repo("feat/x");
    const ran = join(dir, "ran.txt");
    await openPiSession([bashCall(`git push; touch ${ran}`), afterTool]);
    await frameContaining(`Reason: ${REASON_PUSH}`);

    await press("n");

    expect(await frameContaining("all done")).toContain("all done");
    expect(existsSync(ran)).toBe(false);
    expect(toolResults[0]).toContain("The user denied this tool call.");
  }, 30000);

  test("a commit on the default branch is blocked with the guard's reason and never prompts", async () => {
    repo("main");
    const ran = join(dir, "ran.txt");
    const command = `git commit -m x; touch ${ran}`;
    getStorage().addPermissionRule({ cwd, toolName: "bash", command });
    await openPiSession([bashCall(command), afterTool]);

    // A prompt would wait for a key: the turn finishing on its own means none was shown.
    const done = await frameContaining("all done");

    expect(done).toContain("all done");
    expect(done).not.toContain("Allow bash?");
    expect(existsSync(ran)).toBe(false);
    expect(toolResults[0]).toContain(REASON_COMMIT);
    // The frame wraps long lines.
    expect(done.replace(/\s/g, "")).toContain(REASON_COMMIT.replace(/\s/g, ""));
  }, 30000);

  test("an ordinary command gets the normal prompt: no guard reason, and the always key is offered", async () => {
    repo("main");
    await openPiSession([bashCall("echo hi"), afterTool]);

    await frameContaining("Allow bash?");
    await settle(QUIET_MS + 100);
    const prompt = frame();

    expect(prompt).toContain("Allow bash?");
    expect(prompt).not.toContain("Reason:");
    expect(prompt).toContain("a always allow");
    await press("y");
    expect(await frameContaining("all done")).toContain("all done");
  }, 30000);
});
