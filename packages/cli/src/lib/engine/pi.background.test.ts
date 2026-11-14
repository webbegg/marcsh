import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, InMemoryCredentialStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import { backgroundMessageText, createBackgroundHub, type BackgroundBatch, type BackgroundHub } from "../background/hub";
import { Mode } from "../modes";
import { openStorage } from "../storage";
import { createPiEngine } from "./pi";
import { trustEveryProject } from "./test-trust";
import type { EngineEvent, TurnHost, TurnRequest } from "./types";

let dir: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marcsh-pi-background-"));
  agentDir = join(dir, "agent");
  cwd = join(dir, "project");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!check() && Date.now() - start < timeoutMs) await wait(5);
  expect(check()).toBe(true);
}

async function setup(responses: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: 2000, tokenSize: { min: 1, max: 1 } });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const engine = createPiEngine({ agentDir, modelRuntime, permissionRules: openStorage(":memory:"), projectTrust: trustEveryProject });
  return { engine, faux, model: "faux/faux-1" };
}

function userTexts(messages: ReadonlyArray<{ role: string; content?: unknown }>): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""),
    );
}

function recording(text: string) {
  const contexts: string[][] = [];
  const step: FauxResponseStep = (context) => {
    contexts.push(userTexts(context.messages));
    return fauxAssistantMessage([fauxText(text)]);
  };
  return { step, contexts };
}

function begin(engine: ReturnType<typeof createPiEngine>, model: string, overrides: Partial<TurnRequest> = {}, onEvent?: (event: EngineEvent) => void) {
  const events: EngineEvent[] = [];
  const host: TurnHost = {
    emit: (event) => {
      events.push(event);
      onEvent?.(event);
    },
    askPermission: async () => "allow",
    askQuestions: async () => null,
  };
  const controller = new AbortController();
  const turn = engine.startTurn({ prompt: "hello", cwd, mode: Mode.BUILD, model, signal: controller.signal, ...overrides }, host);
  return { turn, events, controller };
}

const finished = (hub: BackgroundHub, id = "bg-1") => hub.finish({ id, kind: "terminal", title: "build", text: `${id} exited with code 0` });

function idleSink(hub: BackgroundHub) {
  const batches: BackgroundBatch[] = [];
  hub.setIdleSink((batch) => (batches.push(batch), true));
  return batches;
}

describe("background results in a pi turn (S2)", () => {
  test("a result that finishes mid-turn is sent as a follow-up of that turn, and the host hears it was delivered", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const idle = idleSink(hub);
    const first: FauxResponseStep = async () => {
      finished(hub);
      await wait(60);
      return fauxAssistantMessage([fauxText("first answer")]);
    };
    const second = recording("second answer");
    const { engine, faux, model } = await setup([first, second.step]);
    const { turn, events } = begin(engine, model, { background: hub });
    await turn.done;

    expect(faux.state.callCount).toBe(2);
    expect(second.contexts[0]).toEqual(["hello", "bg-1 exited with code 0"]);
    const delivered = events.filter((event) => event.type === "delivered");
    expect(delivered).toEqual([
      { type: "delivered", kind: "background", text: backgroundMessageText({ notice: "[background] build finished", text: "bg-1 exited with code 0" }) },
    ]);
    // Not a queued user message: the steer/follow-up queue never showed it.
    for (const event of events) if (event.type === "queue") expect([...event.steering, ...event.followUp]).toEqual([]);
    expect(idle).toEqual([]);
    expect(hub.pending()).toEqual([]);
    expect(hub.consume(["bg-1"])).toEqual([]);
  }, 20000);

  test("results that finish together mid-turn are one follow-up, delivered once, and none comes back after the turn", async () => {
    const hub = createBackgroundHub({ debounceMs: 20 });
    const idle = idleSink(hub);
    const first: FauxResponseStep = async () => {
      finished(hub, "bg-1");
      finished(hub, "bg-2");
      await wait(80);
      return fauxAssistantMessage([fauxText("first answer")]);
    };
    const second = recording("second answer");
    const { engine, faux, model } = await setup([first, second.step, fauxAssistantMessage([fauxText("never")])]);
    const { turn, events } = begin(engine, model, { background: hub });
    await turn.done;
    expect(faux.state.callCount).toBe(2);
    expect(second.contexts[0]).toEqual(["hello", "bg-1 exited with code 0\n\nbg-2 exited with code 0"]);
    expect(events.filter((event) => event.type === "delivered")).toHaveLength(1);
    hub.retry();
    await wait(30);
    expect(hub.pending()).toEqual([]);
    expect(idle).toEqual([]);
  }, 20000);

  test("a result that finishes after the turn settled goes to the idle path, not to the old turn", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const idle = idleSink(hub);
    const { engine, faux, model } = await setup([fauxAssistantMessage([fauxText("done")])]);
    const { turn, events } = begin(engine, model, { background: hub });
    await turn.done;
    finished(hub);
    await until(() => idle.length === 1);
    expect(idle[0]!.ids).toEqual(["bg-1"]);
    expect(faux.state.callCount).toBe(1);
    expect(events.some((event) => event.type === "delivered")).toBe(false);
  }, 20000);

  test("a result the turn took but never sent (the turn was interrupted) is requeued before the turn settles", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const started = Promise.withResolvers<void>();
    const hanging: FauxResponseStep = (_context, options) =>
      new Promise((resolve) => {
        finished(hub);
        started.resolve();
        options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage([], { stopReason: "aborted" })), { once: true });
      });
    const { engine, faux, model } = await setup([hanging, fauxAssistantMessage([fauxText("never")])]);
    // `input-closed` is the settle: by then the result must be back in the hub.
    let pendingWhenClosed: number | undefined;
    const { turn, events, controller } = begin(engine, model, { background: hub }, (event) => {
      if (event.type === "input-closed") pendingWhenClosed ??= hub.pending().length;
    });
    await started.promise;
    // The turn's sink took it: it is queued in pi, waiting for the response to end.
    await until(() => hub.pending().length === 0);
    controller.abort();
    await turn.done;
    expect(pendingWhenClosed).toBe(1);
    expect(events.some((event) => event.type === "delivered")).toBe(false);
    expect(faux.state.callCount).toBe(1);

    const idle = idleSink(hub);
    hub.retry();
    await until(() => idle.length === 1);
    expect(idle[0]!.ids).toEqual(["bg-1"]);
  }, 20000);

  test("a background turn's prompt goes to the model as it is: no plugin command or template is expanded", async () => {
    const hub = createBackgroundHub({ debounceMs: 5 });
    const reply = recording("ok");
    const { engine, model } = await setup([reply.step]);
    const { turn } = begin(engine, model, { background: hub, promptKind: "background", prompt: "/marcsh:feature results of bg-1" });
    await turn.done;
    expect(reply.contexts[0]).toEqual(["/marcsh:feature results of bg-1"]);
  }, 20000);
});
