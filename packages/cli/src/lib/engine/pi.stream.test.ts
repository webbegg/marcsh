import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  InMemoryCredentialStore,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { ChatMessage } from "../chat-types";
import { Mode } from "../modes";
import { finishReply } from "../reply";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import type { EngineEvent, TurnHost } from "./types";

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-stream-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// The faux provider hands text out in 4-character chunks, one every 1000 / tokensPerSecond ms, so a reply streams for a while.
async function setup(responses: FauxResponseStep[], tokensPerSecond = 400) {
  const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: true }], tokensPerSecond, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });
  return { engine, faux, model: "faux/faux-1" };
}

type Stamped = { at: number; event: EngineEvent };

// Runs a turn, keeping every host emit with its time and the reply as it looked right after it.
function begin(engine: ReturnType<typeof createPiEngine>, model: string, hostOverrides: Partial<TurnHost> = {}) {
  const events: Stamped[] = [];
  const snapshots: ChatMessage[] = [];
  let reply: ChatMessage = { id: "reply", role: "assistant", parts: [] };
  const host: TurnHost = {
    emit: (event) => {
      events.push({ at: Date.now(), event });
      if (event.type === "reply") {
        reply = event.update(reply);
        snapshots.push(reply);
      }
    },
    askPermission: async () => "allow",
    askQuestions: async () => null,
    ...hostOverrides,
  };
  const controller = new AbortController();
  const turn = engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model, signal: controller.signal }, host);
  return { turn, events, snapshots, controller, reply: () => reply };
}

const textOf = (reply: ChatMessage) => reply.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, timeoutMs = 5000) => {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) await sleep(5);
};
const replyEvents = (events: Stamped[]) => events.filter((e) => e.event.type === "reply");

const LONG = "The quick brown fox jumps over the lazy dog. ".repeat(18);

describe("pi replies stream while they are generated", () => {
  test("text reaches the host before the message ends, growing in place", async () => {
    const { engine, model } = await setup([fauxAssistantMessage([fauxText(LONG)])]);

    const running = begin(engine, model);
    await until(() => textOf(running.reply()).length > 0);
    const early = textOf(running.reply());
    await running.turn.done;

    expect(early.length).toBeGreaterThan(0);
    expect(early.length).toBeLessThan(LONG.length);
    expect(LONG.startsWith(early)).toBe(true);
    // Every snapshot is one text part that only grows: no duplicated or restarted text.
    const texts = running.snapshots.map(textOf);
    for (let i = 1; i < texts.length; i++) expect(texts[i]!.startsWith(texts[i - 1]!)).toBe(true);
    expect(running.snapshots.every((r) => r.parts.filter((p) => p.type === "text").length <= 1)).toBe(true);
    expect(textOf(running.reply())).toBe(LONG);
  }, 20000);

  test("thinking streams as a reasoning part ahead of the text", async () => {
    const { engine, model } = await setup([fauxAssistantMessage([fauxThinking("considering the question carefully ".repeat(8)), fauxText("done")])]);

    const running = begin(engine, model);
    await until(() => running.reply().parts.some((p) => p.type === "reasoning"));
    const early = running.reply().parts.find((p) => p.type === "reasoning");
    await running.turn.done;

    expect(early?.text.length).toBeGreaterThan(0);
    expect(early?.text.length).toBeLessThan("considering the question carefully ".repeat(8).length);
    expect(running.reply().parts).toEqual([
      { type: "reasoning", text: "considering the question carefully ".repeat(8) },
      { type: "text", text: "done" },
    ]);
  }, 20000);

  test("coalesces host emits to about 30 per second", async () => {
    // 200 chunks at 2.5 ms each: far more deltas than the host should see.
    const { engine, model } = await setup([fauxAssistantMessage([fauxText("abcd".repeat(200))])]);

    const running = begin(engine, model);
    await running.turn.done;

    const times = replyEvents(running.events).map((e) => e.at);
    expect(times.length).toBeGreaterThan(2);
    expect(times.length).toBeLessThan(100);
    // No one-second window holds more than ~30 emits (plus the closing ones).
    for (const start of times) expect(times.filter((t) => t >= start && t < start + 1000).length).toBeLessThanOrEqual(34);
  }, 20000);

  test("saves the same parts a non-streaming turn would, tools in order", async () => {
    writeFileSync(join(cwd, "notes.txt"), "hello notes");
    const script = () => [
      fauxAssistantMessage([fauxThinking("plan"), fauxText("Reading it now."), fauxToolCall("read", { path: join(cwd, "notes.txt") }, { id: "r1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("It says hello.")]),
    ];

    const { engine, model } = await setup(script(), 2000);
    const running = begin(engine, model);
    await running.turn.done;
    const reply = finishReply(running.reply());

    expect(reply.parts).toEqual([
      { type: "reasoning", text: "plan" },
      { type: "text", text: "Reading it now." },
      { type: "tool", toolCallId: "r1", toolName: "read", input: { path: join(cwd, "notes.txt") }, state: "done" },
      { type: "text", text: "It says hello." },
    ]);
    expect(JSON.parse(JSON.stringify(reply.parts))).toEqual(reply.parts);
    expect(reply.parts.every((p) => Object.keys(p).every((key) => ["type", "text", "toolCallId", "toolName", "input", "state"].includes(key)))).toBe(true);
  }, 20000);

  test("leaves nothing queued or timed once the turn is done", async () => {
    const { engine, model } = await setup([fauxAssistantMessage([fauxText(LONG)])]);

    const running = begin(engine, model);
    await running.turn.done;
    const settled = running.events.length;
    const last = running.events.at(-1)!;
    await sleep(150);

    expect(running.events.length).toBe(settled);
    // The last emit is the duration; the text was complete before it.
    expect(last.event.type).toBe("reply");
    expect(textOf(running.reply())).toBe(LONG);
    expect(running.reply().metadata?.durationMs).toBeGreaterThanOrEqual(0);
  }, 20000);

  test("an interrupted turn keeps the text streamed so far", async () => {
    const { engine, model } = await setup([fauxAssistantMessage([fauxText(LONG)])], 100);

    const running = begin(engine, model);
    await until(() => textOf(running.reply()).length > 12);
    running.turn.interrupt();
    await running.turn.done;
    const kept = textOf(running.reply());
    await sleep(100);

    expect(kept.length).toBeGreaterThan(12);
    expect(kept.length).toBeLessThan(LONG.length);
    expect(LONG.startsWith(kept)).toBe(true);
    expect(textOf(running.reply())).toBe(kept);
    expect(running.reply().parts.filter((p) => p.type === "text")).toHaveLength(1);
  }, 20000);

  test("an abort signal keeps the streamed text and leaves the unanswered tool as an error, not running", async () => {
    const asked = Promise.withResolvers<void>();
    const { engine, model } = await setup(
      [fauxAssistantMessage([fauxText("Let me run it. "), fauxToolCall("bash", { command: "echo hi" }, { id: "b1" })], { stopReason: "toolUse" })],
      2000,
    );

    const running = begin(engine, model, {
      askPermission: (_ask, signal) =>
        new Promise((resolve) => {
          asked.resolve();
          signal.addEventListener("abort", () => resolve("deny"), { once: true });
        }),
    });
    await asked.promise;
    running.controller.abort();
    await running.turn.done;
    const reply = finishReply(running.reply());

    expect(reply.parts).toHaveLength(2);
    expect(reply.parts[0]).toEqual({ type: "text", text: "Let me run it. " });
    expect(reply.parts[1]).toMatchObject({ type: "tool", toolCallId: "b1", state: "error" });
  }, 20000);
});
