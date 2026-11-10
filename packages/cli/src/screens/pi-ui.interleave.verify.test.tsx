import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-interleave-prefs-"));
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
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-interleave-"));
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

describe("approvals and extension dialogs in one queue (S7, S8)", () => {
  test("after approving with y, a fast y and Enter do not confirm the extension's confirm that comes next", async () => {
    const marker = join(cwd, "confirmed.txt");
    writeExtension(
      "danger",
      `pi.registerTool({ name: "danger", label: "d", description: "d", parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) {
          const ok = await ctx.ui.confirm("Really wipe?", "second gate");
          if (ok) require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");
          ctx.ui.notify("got=" + ok);
          return { content: [{ type: "text", text: String(ok) }] };
        } });`,
    );
    await openPiSession("go", [fauxAssistantMessage([fauxToolCall("danger", {}, { id: "d1" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("end")])]);
    await frameContaining("Allow danger?");

    await press("y");
    await pressNow("y");
    await pressNow("RETURN");
    await frameContaining("Really wipe?");
    await settle(100);

    expect(frame()).toContain("Really wipe?");
    expect(existsSync(marker)).toBe(false);
    await press("ESCAPE");
    expect(await frameContaining("got=false")).toContain("got=false");
  }, 30000);

  test("after confirming an extension's gate, a fast y does not approve marcsh's bash prompt that comes next", async () => {
    const marker = join(cwd, "bash.txt");
    writeExtension(
      "gate",
      `pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return;
        if (!(await ctx.ui.confirm("Extension gate: run it?", event.input.command))) return { block: true, reason: "no" };
      });`,
    );
    await openPiSession("go", [fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` }, { id: "b1" })], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("end")])]);
    await frameContaining("Extension gate: run it?");

    await press("y");
    await pressNow("RETURN");
    await frameContaining("Allow bash?");
    await pressNow("y");
    await settle(100);

    expect(frame()).toContain("Allow bash?");
    expect(existsSync(marker)).toBe(false);
    await press("n");
    await frameContaining("end");
    expect(existsSync(marker)).toBe(false);
  }, 30000);
});

describe("Esc in extension dialogs (S7)", () => {
  test("Esc cancels the dialog and stops the turn (the next dialog is cancelled unseen), and the session then runs the next prompt", async () => {
    writeExtension(
      "two",
      `pi.registerCommand("two", { description: "t", handler: async (_args, ctx) => {
        ctx.ui.notify("first=" + (await ctx.ui.confirm("First?", "m")));
        ctx.ui.notify("second=" + (await ctx.ui.select("Second?", ["a", "b"])));
      } });`,
    );
    await openPiSession("/two", [fauxAssistantMessage([fauxText("SECOND TURN REPLY")])]);
    await frameContaining("First?");

    await press("ESCAPE");
    // One toast shows at a time, so "first=false" is replaced by "second=undefined" as soon as the second ask is cancelled.
    expect(await frameContaining("second=undefined")).toContain("second=undefined");
    expect(frame()).not.toContain("Second?");

    await settle(300);
    await act(() => screen!.mockInput.typeText("hello again"));
    await press("RETURN");
    expect(await frameContaining("SECOND TURN REPLY")).toContain("SECOND TURN REPLY");
  }, 40000);

  test("text typed into an input dialog goes to the extension only, not into the main input", async () => {
    writeExtension(
      "secret",
      `pi.registerCommand("secret", { description: "t", handler: async (_args, ctx) => {
        ctx.ui.notify("len=" + ((await ctx.ui.input("Secret token")) ?? "").length);
      } });`,
    );
    await openPiSession("/secret");
    await frameContaining("Secret token");
    await settle(QUIET_MS);

    await act(() => screen!.mockInput.typeText("hunter2zz"));
    await press("RETURN");

    expect(await frameContaining("len=9")).toContain("len=9");
    await settle(200);
    expect(frame()).not.toContain("hunter2zz");
  }, 30000);
});
