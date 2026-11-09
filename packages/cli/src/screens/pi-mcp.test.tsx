import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";

process.env.MARCSH_DB_PATH = ":memory:";
const prefsDir = mkdtempSync(join(tmpdir(), "marcsh-pi-mcp-prefs-"));
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

const TOOL = "mcp__fixture__echo";

// A stdio MCP server in one small Bun script: newline-delimited JSON-RPC, one tool `echo`, a log of its calls.
const SERVER = `import { appendFileSync } from "node:fs";
const [callsPath] = process.argv.slice(2);
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
function handle(request) {
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      return send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
    case "tools/list":
      return send({ id: request.id, result: { tools: [{ name: "echo", description: "Echoes the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
    case "tools/call":
      appendFileSync(callsPath, JSON.stringify(request.params.arguments) + "\\n");
      return send({ id: request.id, result: { content: [{ type: "text", text: "echo: " + request.params.arguments.text }] } });
    default:
      return send({ id: request.id, result: {} });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`;

let dir: string;
let agentDir: string;
let cwd: string;
let calls: string;
// What the model read after each tool call, one entry per model request that followed one.
let toolResults: string[];
let screen: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-mcp-screen-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  calls = join(dir, "calls.log");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  toolResults = [];
  const script = join(dir, "server.ts");
  writeFileSync(script, SERVER);
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [script, calls], exposure: "direct" } } }));
});

afterAll(() => rmSync(prefsDir, { recursive: true, force: true }));

afterEach(async () => {
  engines.set("pi", undefined);
  if (screen && !(screen.renderer as any).isDestroyed) await act(async () => screen!.renderer.destroy());
  screen = null;
  rmSync(dir, { recursive: true, force: true });
});

const callsMade = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

const echoCall = fauxAssistantMessage([fauxToolCall(TOOL, { text: "hello from the model" }, { id: "mcp-1" })], { stopReason: "toolUse" });

// The model's next request after the tool call: records what the tool result said, then ends the turn.
const afterTool: FauxResponseStep = (context) => {
  toolResults.push(
    ...(context.messages as Message[]).flatMap((m) =>
      m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : [],
    ),
  );
  return fauxAssistantMessage([fauxText("all done")]);
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
const frameContaining = async (text: string, timeoutMs = 10000) => {
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
  screen = await testRender(<RouterProvider router={router} />, { width: 100, height: 40 });
  await settle();
  return session;
}

describe("an MCP tool on a pi session (S14)", () => {
  test("asks through marcsh's approval prompt with the tool and its input, and runs on allow", async () => {
    await openPiSession([echoCall, afterTool]);

    const prompt = await frameContaining(`Allow ${TOOL}?`);
    expect(prompt).toContain(`Allow ${TOOL}?`);
    expect(prompt).toContain("hello from the model");
    expect(callsMade()).toEqual([]);
    await press("y");

    expect(await frameContaining("all done")).toContain("all done");
    expect(callsMade()).toEqual([{ text: "hello from the model" }]);
    expect(toolResults[0]).toBe("echo: hello from the model");
  }, 30000);

  test("denying keeps the server from being called and tells the model", async () => {
    await openPiSession([echoCall, afterTool]);
    await frameContaining(`Allow ${TOOL}?`);

    await press("n");

    expect(await frameContaining("all done")).toContain("all done");
    expect(callsMade()).toEqual([]);
    expect(toolResults[0]).toContain("The user denied this tool call.");
  }, 30000);

  test("plan mode blocks it without a prompt", async () => {
    await openPiSession([echoCall, afterTool], "PLAN");

    // A prompt would wait for a key: the turn finishing on its own means none was shown.
    const done = await frameContaining("all done");

    expect(done).toContain("all done");
    expect(done).not.toContain(`Allow ${TOOL}?`);
    expect(callsMade()).toEqual([]);
  }, 30000);
});
