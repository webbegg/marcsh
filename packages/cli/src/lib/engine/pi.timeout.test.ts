import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import type { ChatMessage } from "../chat-types";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { toolTimeoutMessage } from "./pi-tool-timeout";
import { trustEveryProject } from "./test-trust";
import type { EngineEvent, PermissionDecision, TurnHost } from "./types";

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-timeout-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A short timeout, so no test waits the real 3 minutes.
const TIMEOUT_MS = 400;

async function setup(responses: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject, toolTimeoutMs: TIMEOUT_MS });
  return { engine, model: "faux/faux-1" };
}

// Answers each approval in turn (the last answer repeats). Keeps a copy of each input as it was when asked, and the input itself as the host got it.
async function runTurn(engine: Awaited<ReturnType<typeof setup>>["engine"], model: string, decisions: PermissionDecision[] = ["allow"]) {
  const events: EngineEvent[] = [];
  const asked: Record<string, unknown>[] = [];
  const held: Record<string, unknown>[] = [];
  const host: TurnHost = {
    emit: (event) => events.push(event),
    askPermission: async (ask) => {
      asked.push(structuredClone(ask.input));
      held.push(ask.input);
      return decisions[Math.min(asked.length, decisions.length) - 1]!;
    },
    askQuestions: async () => null,
  };
  const startedAt = Date.now();
  await engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model, signal: new AbortController().signal }, host).done;
  let reply: ChatMessage = { id: "reply", role: "assistant", parts: [] };
  for (const event of events) if (event.type === "reply") reply = event.update(reply);
  return { reply, asked, held, elapsed: Date.now() - startedAt, errors: events.flatMap((e) => (e.type === "error" ? [e.message] : [])) };
}

const toolResultTexts = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((block) => ("text" in block ? block.text : "")).join("")] : []));

// What the model reads after the tool calls, from a step that ends the turn.
function reading() {
  const seen: string[][] = [];
  const step: FauxResponseStep = (context) => {
    seen.push(toolResultTexts(context.messages));
    return fauxAssistantMessage([fauxText("ok")]);
  };
  return { seen, step };
}

const bashCall = (input: { command: string; timeout?: number }, id = "call-1") => fauxAssistantMessage([fauxToolCall("bash", input, { id })], { stopReason: "toolUse" });
const toolParts = (reply: ChatMessage) => reply.parts.flatMap((p) => (p.type === "tool" ? [p] : []));

describe("pi engine tool-call timeouts (S5)", () => {
  test("a bash call that runs past the timeout is stopped and the model reads that it timed out, with bg_start suggested", async () => {
    const { seen, step } = reading();
    const { engine, model } = await setup([bashCall({ command: "sleep 30" }), step]);

    const { reply, asked, held, elapsed, errors } = await runTurn(engine, model);

    expect(errors).toEqual([]);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0]![0]).toContain(toolTimeoutMessage("bash", TIMEOUT_MS));
    expect(seen[0]![0]).toContain("bg_start");
    expect(seen[0]![0]).not.toContain("Command timed out after");
    expect(elapsed).toBeLessThan(10_000);
    // Approval and the transcript see the command as the model sent it, without the timeout marcsh added.
    expect(asked).toEqual([{ command: "sleep 30" }]);
    expect(held).toEqual([{ command: "sleep 30" }]);
    expect(toolParts(reply).map((part) => [part.input, part.state])).toEqual([[{ command: "sleep 30" }, "error"]]);
  });

  test("a longer timeout the call passes wins over the default", async () => {
    const { seen, step } = reading();
    const { engine, model } = await setup([bashCall({ command: "sleep 1; echo finished", timeout: 5 }), step]);

    const { asked } = await runTurn(engine, model);

    expect(seen[0]![0]).toContain("finished");
    expect(asked).toEqual([{ command: "sleep 1; echo finished", timeout: 5 }]);
  });

  test("a shorter timeout the call passes ends it with pi's own message", async () => {
    const { seen, step } = reading();
    const { engine, model } = await setup([bashCall({ command: "sleep 30", timeout: 0.2 }), step]);

    await runTurn(engine, model);

    expect(seen[0]![0]).toContain("Command timed out after 0.2 seconds");
    expect(seen[0]![0]).not.toContain("bg_start");
  });

  test("a denied call leaves nothing behind: a later call with the same id and its own timeout keeps pi's message", async () => {
    const { seen, step } = reading();
    const { engine, model } = await setup([bashCall({ command: "sleep 30" }), bashCall({ command: "sleep 30", timeout: 0.2 }), step]);

    const { asked } = await runTurn(engine, model, ["deny", "allow"]);

    expect(asked).toEqual([{ command: "sleep 30" }, { command: "sleep 30", timeout: 0.2 }]);
    expect(seen[0]).toHaveLength(2);
    expect(seen[0]![1]).toContain("Command timed out after 0.2 seconds");
    expect(seen[0]![1]).not.toContain("bg_start");
  });

  test("a Task whose subagent runs past the timeout fails with the timeout message", async () => {
    // The subagent's model never answers until its request is aborted.
    const child: FauxResponseStep = (_context, options) =>
      new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage([], { stopReason: "aborted" })), { once: true }));
    const { seen, step } = reading();
    const { engine, model } = await setup([
      fauxAssistantMessage([fauxToolCall("Task", { description: "Slow work", prompt: "go" }, { id: "task-1" })], { stopReason: "toolUse" }),
      child,
      step,
    ]);

    const { reply, elapsed } = await runTurn(engine, model);

    expect(seen[0]).toEqual([toolTimeoutMessage("Task", TIMEOUT_MS)]);
    expect(reply.parts.flatMap((p) => (p.type === "task" ? [[p.status, p.error]] : []))).toEqual([["failed", toolTimeoutMessage("Task", TIMEOUT_MS)]]);
    expect(elapsed).toBeLessThan(10_000);
  });
});
