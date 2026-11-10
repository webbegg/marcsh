import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "verify-s13-screen-prefs-"));
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
  dir = mkdtempSync(join(tmpdir(), "verify-s13-screen-screen-"));
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
// Routes by the conversation's first user text; the step is the number of assistant messages so far.
const firstUserText = (messages: any[]) => {
  const m = messages.find((x) => x.role === "user");
  return !m ? "" : typeof m.content === "string" ? m.content : m.content.map((b: any) => b.text ?? "").join("");
};
function routed(script: Record<string, FauxResponseStep[]>): FauxResponseStep[] {
  const step: FauxResponseStep = async (context, ...rest) => {
    const steps = script[firstUserText(context.messages)] ?? [];
    const s = steps[context.messages.filter((m) => m.role === "assistant").length] ?? fauxAssistantMessage([fauxText("(end)")]);
    return typeof s === "function" ? (s as any)(context, ...rest) : s;
  };
  return Array.from({ length: 30 }, () => step);
}
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
// The approved command runs in a child process: under load it can finish after the next prompt is drawn.
const eventually = async (check: () => boolean, timeoutMs = 8000) => {
  const start = Date.now();
  while (!check() && Date.now() - start < timeoutMs) await settle(25);
  return check();
};

describe("S13 verifier: subagent approvals on screen", () => {
  test("parallel children's approvals show one at a time; each answer applies to its own child", async () => {
    const a = join(dir, "a.txt"), b = join(dir, "b.txt");
    await openPiSession(routed({
      hi: [calling(taskCall("First job", "childA", "task-a"), taskCall("Second job", "childB", "task-b")), fauxAssistantMessage([fauxText("parent done")])],
      childA: [calling(fauxToolCall("bash", { command: `touch ${a}` }, { id: "a1" })), fauxAssistantMessage([fauxText("A finished")])],
      childB: [calling(fauxToolCall("bash", { command: `touch ${b}` }, { id: "b1" })), fauxAssistantMessage([fauxText("B finished")])],
    }));
    const first = await frameContaining("Allow bash?");
    expect(count(first, "Allow bash?")).toBe(1);
    expect(first).toContain("Task: First job · running");
    expect(first).toContain("Task: Second job · running");
    const firstIsA = first.includes("a.txt");
    await press("y");
    // Wait for the other child's prompt itself, not just any "Allow bash?" (the first one can still be on screen).
    const otherFile = firstIsA ? "b.txt" : "a.txt";
    await eventually(() => frame().includes("Allow bash?") && frame().includes(otherFile) && !frame().includes(firstIsA ? "a.txt" : "b.txt"));
    const second = await frameContaining("Allow bash?");
    expect(count(second, "Allow bash?")).toBe(1);
    expect(second.includes(otherFile)).toBe(true);
    expect(await eventually(() => existsSync(firstIsA ? a : b))).toBe(true);
    expect(existsSync(firstIsA ? b : a)).toBe(false);
    await press("n");
    const finished = await frameContaining("parent done");
    expect(existsSync(firstIsA ? b : a)).toBe(false);
    expect(finished).toContain("Task: First job · completed");
    expect(finished).toContain("Task: Second job · completed");
    expect(finished).not.toContain("touch ");
  }, 30000);

  test("Esc while a child's approval is open stops the turn: command never runs, task stopped", async () => {
    const a = join(dir, "esc.txt");
    await openPiSession(routed({
      hi: [calling(taskCall("Esc job", "childA")), fauxAssistantMessage([fauxText("parent done")])],
      childA: [calling(fauxToolCall("bash", { command: `touch ${a}` }, { id: "a1" })), fauxAssistantMessage([fauxText("A finished")])],
    }));
    await frameContaining("Allow bash?");
    await press("ESCAPE");
    await settle(300);
    let f = frame();
    if (f.includes("Allow bash?")) {
      // Esc in the approval prompt is the prompt's own key; a second Esc interrupts.
      await press("ESCAPE");
      await settle(300);
      f = frame();
    }
    const end = await frameContaining("stopped", 5000);
    console.log("ESC frame", end.slice(0, 600));
    expect(existsSync(a)).toBe(false);
    expect(end).toContain("Task: Esc job · stopped");
    expect(end).not.toContain("Allow bash?");
  }, 30000);
});
