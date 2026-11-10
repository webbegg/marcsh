import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-question-prefs-"));
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

const COLOR = {
  question: "Which color do you prefer?",
  header: "Color",
  options: [
    { label: "Red", description: "A warm color" },
    { label: "Green", description: "A natural color" },
    { label: "Blue", description: "A cool color" },
  ],
  multiSelect: false,
};
const TOPPINGS = {
  question: "Which toppings?",
  header: "Toppings",
  options: [
    { label: "Cheese", description: "Melted" },
    { label: "Olives", description: "Salty" },
  ],
  multiSelect: true,
};

let dir: string;
let agentDir: string;
let cwd: string;
// What the model read after each tool call, one entry per model request that followed one.
let toolResults: string[];
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

const askCall = (questions: (typeof COLOR)[]) =>
  fauxAssistantMessage([fauxToolCall("AskUserQuestion", { questions }, { id: "ask-1" })], { stopReason: "toolUse" });

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
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-question-"));
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
// A real pi turn runs asynchronously: wait for the expected text instead of racing it.
const frameContaining = async (text: string, timeoutMs = 8000) => {
  const start = Date.now();
  let frame = collapse(screen!.captureCharFrame());
  while (!frame.includes(text) && Date.now() - start < timeoutMs) {
    await settle(25);
    frame = collapse(screen!.captureCharFrame());
  }
  lastActivityAt = Date.now();
  return frame;
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
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 40 });
  await settle();
  return session;
}

describe("AskUserQuestion on a pi session (S9)", () => {
  test("shows marcsh's question prompt, not the approval prompt, and the pick reaches the model keyed by question text", async () => {
    await openPiSession([askCall([COLOR]), afterTool]);

    const prompt = await frameContaining("Question 1/1");

    expect(prompt).toContain("Color");
    expect(prompt).toContain(COLOR.question);
    for (const [i, option] of COLOR.options.entries()) {
      expect(prompt).toContain(`${i + 1} ${option.label}`);
      expect(prompt).toContain(option.description);
    }
    expect(prompt).toContain("o Other (type an answer)");
    expect(prompt).not.toContain("Allow AskUserQuestion?");

    await press("2");

    expect(await frameContaining("all done")).toContain("all done");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toContain(`"${COLOR.question}"="Green"`);
  }, 30000);

  test("two questions are asked in turn and a multi-select answer is joined in option order", async () => {
    await openPiSession([askCall([COLOR, TOPPINGS]), afterTool]);

    expect(await frameContaining("Question 1/2")).toContain(COLOR.question);
    await press("3");
    expect(await frameContaining("Question 2/2")).toContain(TOPPINGS.question);
    await press("2");
    await press("1");
    await press("RETURN");

    expect(await frameContaining("all done")).toContain("all done");
    expect(toolResults[0]).toContain(`"${COLOR.question}"="Blue"`);
    expect(toolResults[0]).toContain(`"${TOPPINGS.question}"="Cheese, Olives"`);
  }, 30000);

  // Esc is the session's interrupt: it ends the turn, which declines the open question, so the model is not asked again.
  test("Esc interrupts the turn and declines the question: the prompt goes away and the tool shows The user declined to answer.", async () => {
    await openPiSession([askCall([COLOR]), afterTool]);
    await frameContaining("Question 1/1");

    await press("ESCAPE");

    const after = await frameContaining("The user declined to answer.");
    expect(after).toContain("The user declined to answer.");
    expect(after).not.toContain("Question 1/1");
    await settle(300);
    expect(toolResults).toEqual([]);
    expect(collapse(screen!.captureCharFrame())).not.toContain("all done");
  }, 30000);

  test("is available in plan mode with the same prompt", async () => {
    await openPiSession([askCall([COLOR]), afterTool], "PLAN");

    const prompt = await frameContaining("Question 1/1");
    expect(prompt).not.toContain("Allow AskUserQuestion?");
    await press("1");

    expect(await frameContaining("all done")).toContain("all done");
    expect(toolResults[0]).toContain(`"${COLOR.question}"="Red"`);
  }, 30000);

  test("an extension's tool named AskUserQuestion gets the approval prompt instead, and nothing is asked", async () => {
    const ran = join(dir, "extension-ran.txt");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "ask.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: "AskUserQuestion", label: "ask", description: "an extension's own tool", parameters: Type.Object({}),
    async execute() { require("node:fs").writeFileSync(${JSON.stringify(ran)}, "ran"); return { content: [{ type: "text", text: "ext ran" }] }; } });
}
`,
    );
    await openPiSession([askCall([COLOR]), afterTool]);

    const prompt = await frameContaining("Allow AskUserQuestion?");

    expect(prompt).toContain("Allow AskUserQuestion?");
    expect(prompt).not.toContain("Question 1/1");
    await press("n");
    expect(await frameContaining("all done")).toContain("all done");
    expect(existsSync(ran)).toBe(false);
    expect(toolResults[0]).toContain("The user denied this tool call.");
  }, 30000);
});
