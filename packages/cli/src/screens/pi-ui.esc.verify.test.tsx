import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-esc-prefs-"));
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

// S7 with S8: extension dialogs share one queue with marcsh's approvals. A key meant for one prompt must never answer
// the next one, Esc cancels the dialog and stops the turn, and the session takes a new prompt afterwards.
// (Esc semantics changed after the verifier wrote this: an Esc on an extension dialog also interrupts the turn, so the
// extension's next dialog is cancelled unseen. Only the assertions of that test were updated.)

let dir: string;
let agentDir: string;
let cwd: string;
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-esc-"));
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
const QUIET_MS = 350;
const pressNow = async (key: string) => {
  await act(async () => screen!.mockInput.pressKey(key as never));
  await settle(5);
};
// Like a user who pauses before answering.
const press = async (key: string) => {
  await settle(QUIET_MS);
  await pressNow(key);
  await settle();
};
const frame = () => screen!.captureCharFrame().replace(/[│┃\s]+/g, " ");
const frameContaining = async (text: string, timeoutMs = 8000) => {
  const start = Date.now();
  while (!frame().includes(text) && Date.now() - start < timeoutMs) await settle(25);
  return frame();
};

function writeExtension(name: string, body: string) {
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", `${name}.ts`), `import { Type } from "typebox";\nexport default function (pi) {\n${body}\n}\n`);
}

async function openPiSession(prompt: string, responses: any[] = []) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const model = modelRuntime.getModel("faux", "faux-1")!;
  modelRuntime.getAvailable = async () => [model];
  engines.set("pi", createPiEngine({ agentDir, modelRuntime }));
  const session = getStorage().createSession({ title: "pi chat", cwd, engine: "pi" });
  const router = createMemoryRouter(
    [{ path: "/", element: <RootLayout />, children: [{ path: "sessions/:id", element: <Session /> }] }],
    { initialEntries: [{ pathname: `/sessions/${session.id}`, state: { initialPrompt: { message: prompt, mode: "BUILD", model: "opus" } } }] },
  );
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 40 });
  await settle();
}


const LABEL = "pi extension asks";
const log = (name: string, text: string) => console.log(`### ${name}\n${text}\n###`);

const COLOR = { question: "Which color?", header: "Color", options: [{ label: "Red", description: "r" }, { label: "Blue", description: "b" }], multiSelect: false };
async function nextPromptWorks(tag: string) {
  await settle(300);
  await act(() => screen!.mockInput.typeText("hello again"));
  await press("RETURN");
  const f = await frameContaining("SECOND TURN REPLY");
  log(tag + " next prompt", f.includes("SECOND TURN REPLY") ? "OK" : "STUCK " + f);
  expect(f).toContain("SECOND TURN REPLY");
}

test("approval prompt: no label; Esc behavior", async () => {
  const marker = join(cwd, "m.txt");
  await openPiSession("go", [fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` }, { id: "b1" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("SECOND TURN REPLY")])]);
  const p = await frameContaining("Allow bash?");
  log("approval label present", String(p.includes(LABEL)));
  await press("ESCAPE");
  await settle(500);
  log("approval after esc", frame().replace(/\/var\S+/g, "<p>"));
  log("marker", String(existsSync(marker)));
  await nextPromptWorks("approval");
}, 40000);

test("question prompt: no label; Esc behavior", async () => {
  await openPiSession("go", [fauxAssistantMessage([fauxToolCall("AskUserQuestion", { questions: [COLOR] }, { id: "a1" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("SECOND TURN REPLY")])]);
  const p = await frameContaining("Which color?");
  log("question label present", String(p.includes(LABEL)));
  await press("ESCAPE");
  await settle(500);
  log("question after esc", frame().replace(/\/var\S+/g, "<p>"));
  await nextPromptWorks("question");
}, 40000);

describe("extension dialogs: Esc, label, control characters (S7)", () => {

  for (const kind of ["confirm", "select", "input", "editor"]) {
    test(`tool_call gate re-asks ${kind} 50x without reading the signal; one Esc ends the turn`, async () => {
      const marker = join(cwd, "g.txt");
      const call = { confirm: `ctx.ui.confirm("Gate?", "m")`, select: `ctx.ui.select("Gate?", ["a","b"])`, input: `ctx.ui.input("Gate?")`, editor: `ctx.ui.editor("Gate?", "x")` }[kind];
      writeExtension("gate", `let n = 0; pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return;
        for (let i = 0; i < 50; i++) { n++; if (await ${call}) return; }
        require("node:fs").writeFileSync(${JSON.stringify(join(cwd, "count.txt"))}, String(n));
        return { block: true, reason: "no" };
      });`);
      await openPiSession("go", [fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` }, { id: "b1" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("SECOND TURN REPLY")])]);
      const p = await frameContaining("Gate?");
      expect(p).toContain(LABEL);
      await press("ESCAPE");
      await settle(500);
      const f = frame();
      log(kind + " gate after esc", f.replace(/\/var\S+/g, "<p>"));
      expect(f).not.toContain("Gate?");
      expect(f).not.toContain("Allow bash?");
      expect(existsSync(marker)).toBe(false);
      await nextPromptWorks(kind + " gate");
    }, 40000);
  }

  test("Esc inside the quiet window on an extension select", async () => {
    writeExtension("q", `pi.registerCommand("q", { description: "t", handler: async (_a, ctx) => { for (let i = 0; i < 20 && !(await ctx.ui.select("Quick?", ["a","b"])); i++) {} ctx.ui.notify("out"); } });`);
    await openPiSession("/q", [fauxAssistantMessage([fauxText("SECOND TURN REPLY")])]);
    await frameContaining("Quick?");
    await pressNow("ESCAPE");
    await settle(600);
    log("quiet esc", frame());
    expect(frame()).not.toContain("Quick?");
    await nextPromptWorks("quiet");
  }, 40000);

  test("control chars: duplicates after stripping keep the original option; warning notify; CR; OSC 8 placeholder", async () => {
    writeExtension("cc", `pi.registerCommand("cc", { description: "t", handler: async (_a, ctx) => {
      const c = await ctx.ui.select("Safe\\rEVIL\\u001b[8m hidden", ["A\\u0007", "A", "\\u001b]8;;http://x\\u0007L\\u001b]8;;\\u0007"]);
      ctx.ui.notify("got=" + JSON.stringify(c), "warning");
      await ctx.ui.input("T\\u009b2J", "\\u001b]8;;http://e\\u0007ph\\u001b]8;;\\u0007");
    } });`);
    await openPiSession("/cc", [fauxAssistantMessage([fauxText("SECOND TURN REPLY")])]);
    const s = await frameContaining("Safe");
    log("cc select", s);
    expect(s).toContain("SafeEVIL hidden");
    expect(s).toContain("1 A");
    expect(s).toContain("2 A");
    expect(s).toContain("3 L");
    await press("2");
    const n = await frameContaining("got=");
    log("cc notify", n);
    expect(n).toContain('Warning: got="A"');
    const i = await frameContaining("T");
    log("cc input", i);
    expect(i).toContain("ph");
    expect(i).not.toContain("http");
    await press("ESCAPE");
    await nextPromptWorks("cc");
  }, 40000);
});
