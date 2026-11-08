import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentSessionEvent,
  createAgentSession,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-smoke-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// S4: pi runs in-process under Bun. The faux provider keeps this offline and deterministic.
test("pi runs a scripted text reply and tool call under Bun through session events", async () => {
  const faux = fauxProvider();
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);

  const echo = defineTool({
    name: "echo",
    label: "Echo",
    description: "Returns the given text.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async (_id, params) => ({ content: [{ type: "text", text: `echoed ${params.text}` }], details: {} }),
  });

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", { text: "ping" }, { id: "call-1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("all done")]),
  ]);

  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: join(dir, "agent"),
    modelRuntime,
    model: faux.getModel(),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    customTools: [echo],
  });

  const events: AgentSessionEvent[] = [];
  session.subscribe((event) => events.push(event));

  try {
    await session.prompt("say hi");
    // prompt() resolves with the run already settled: this is the signal a turn ends on.
    expect(events.at(-1)).toMatchObject({ type: "agent_settled", aborted: false });
    await session.waitForIdle();
  } finally {
    session.dispose();
  }

  const toolEnd = events.find((event) => event.type === "tool_execution_end");
  expect(toolEnd).toMatchObject({ toolCallId: "call-1", toolName: "echo", isError: false });

  const texts = events.flatMap((event) =>
    event.type === "message_end" && event.message.role === "assistant"
      ? event.message.content.filter((block) => block.type === "text").map((block) => block.text)
      : [],
  );
  expect(texts).toEqual(["all done"]);
  expect(events.at(-1)).toMatchObject({ type: "agent_settled" });
});
