import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-subagent-prefs-"));
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

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-subagent-screen-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

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
// Joins word-wrapped lines (and the line's left border) back into one string.
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
async function openPiSession(responses: FauxResponseStep[], mode: "BUILD" | "PLAN" = "BUILD") {
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
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: "hi", mode, model: "opus" } } }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 110, height: 40 });
  await settle();
  return session;
}

const taskCall = (description: string, prompt: string, id = "task-1") =>
  fauxToolCall("Task", { description, prompt }, { id });
const calling = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

// A child response that stays open until the test lets it go, as a slow subagent would.
function gated(text: string) {
  let open: () => void = () => {};
  const released = new Promise<void>((resolve) => (open = resolve));
  const step: FauxResponseStep = async () => {
    await released;
    return fauxAssistantMessage([fauxText(text)]);
  };
  return { step, open };
}

describe("subagent task line on a pi session (S13)", () => {
  test("shows the task line while the child works, then finishes it with the summary", async () => {
    const child = gated("Found three modules");
    await openPiSession([calling(taskCall("Survey the code", "go")), child.step, fauxAssistantMessage([fauxText("parent done")])]);

    const running = await frameContaining("Survey the code · running");
    expect(running).toContain("Task: Survey the code · running");
    expect(running).not.toContain("completed");

    child.open();
    const finished = await frameContaining("parent done");

    expect(finished).toContain("Task: Survey the code · completed");
    expect(finished).toContain("Found three modules");
    expect(finished).not.toContain("running");
  }, 30000);

  test("shows the child's last tool and counts, but never the child's own tool lines", async () => {
    writeFileSync(join(cwd, "inner-secret-notes.txt"), "contents");
    const reads = calling(fauxToolCall("read", { path: join(cwd, "inner-secret-notes.txt") }, { id: "child-read" }));
    await openPiSession([calling(taskCall("Read the notes", "go")), reads, fauxAssistantMessage([fauxText("Read it")]), fauxAssistantMessage([fauxText("parent done")])]);

    const finished = await frameContaining("parent done");

    expect(finished).toMatch(/Task: Read the notes · completed · read · 1 tool · \d+ tok/);
    expect(finished).not.toContain("inner-secret-notes");
    expect(finished).not.toContain("Read:");
  }, 30000);

  test("parallel tasks each get a task line", async () => {
    const answer: FauxResponseStep = (context) => {
      const last = context.messages.at(-1);
      const prompt = last && last.role === "user" ? (typeof last.content === "string" ? last.content : last.content.map((b) => ("text" in b ? b.text : "")).join("")) : "";
      return fauxAssistantMessage([fauxText(`result of ${prompt}`)]);
    };
    await openPiSession([
      calling(taskCall("First job", "one", "task-a"), taskCall("Second job", "two", "task-b")),
      answer,
      answer,
      fauxAssistantMessage([fauxText("parent done")]),
    ]);

    const finished = await frameContaining("parent done");

    expect(finished).toContain("Task: First job · completed");
    expect(finished).toContain("Task: Second job · completed");
    expect(finished).toContain("result of one");
    expect(finished).toContain("result of two");
  }, 30000);

  test("a child's command asks through marcsh's approval prompt, and the line finishes after the answer", async () => {
    const ran = join(dir, "ran.txt");
    const bash = calling(fauxToolCall("bash", { command: `touch ${ran}` }, { id: "child-bash" }));
    await openPiSession([calling(taskCall("Make a file", "go")), bash, fauxAssistantMessage([fauxText("made it")]), fauxAssistantMessage([fauxText("parent done")])]);

    const prompt = await frameContaining("Allow bash?");
    expect(prompt).toContain("Allow bash?");
    expect(prompt).toContain("Task: Make a file · running");
    expect(existsSync(ran)).toBe(false);
    await press("y");

    const finished = await frameContaining("parent done");
    expect(existsSync(ran)).toBe(true);
    expect(finished).toContain("Task: Make a file · completed");
  }, 30000);

  test("a failed child shows the task as failed with its error", async () => {
    const failing = fauxAssistantMessage([], { stopReason: "error", errorMessage: "child exploded" });
    await openPiSession([calling(taskCall("Doomed work", "go")), failing, fauxAssistantMessage([fauxText("parent done")])]);

    const finished = await frameContaining("parent done");

    expect(finished).toContain("Task: Doomed work · failed");
    expect(finished).toContain("child exploded");
  }, 30000);
});
